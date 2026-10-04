'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const defaultTimeoutMs = 180000;
const killGraceMs = 1000;
const headerLimit = 65536;
const separator = '--------';
// Measured 2026-10-05 on codex-cli 0.159.0 (docs/hosts.md): this set removes every
// codex_apps connector (Slack, Notion, Drive, GitHub...) and user MCP servers.
// Codex exits non-zero on an unknown feature name, so a renamed feature fails closed.
const connectorRemoval = Object.freeze([
  '--ignore-user-config', '--ignore-rules',
  '--disable', 'apps', '--disable', 'plugins', '--disable', 'remote_plugin',
]);
// Measured the same day (docs/hosts.md): this set removes the shell (exec_command,
// write_stdin), view_image, image generation, the goal tools, sleep and web search
// (web__run); clock__curr_time stays. multi_agent removes the deferred multi-agent
// tools behind tool_search (models without code mode). On code-mode models the
// collaboration tools stay (set by model metadata), and a spawned sub-agent was
// measured to get the same removed tool list. Without this set the read-only sandbox
// still lets the shell read any file, including held-out reference answers.
// --strict-config makes a renamed -c key fail closed; an invalid web_search value
// also exits non-zero.
const toolRemoval = Object.freeze([
  '--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'view_image',
  '--disable', 'image_generation', '--disable', 'goals', '--disable', 'sleep_tool',
  '--disable', 'multi_agent', '-c', 'web_search="disabled"',
]);
// The child gets only what Codex needs to start and authenticate (measured), so no
// BUNSHIN_* variable points at persona data.
const envAllowlist = Object.freeze(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'CODEX_HOME']);

function childEnv() {
  const env = {};
  for (const key of envAllowlist) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

// Reads only the `codex exec` banner on stderr (between the first two separator
// lines). Everything after it can echo the prompt and is drained, never kept.
function headerReader() {
  let buffer = '';
  let done = false;
  let header = null;
  return {
    push(chunk) {
      if (done) return;
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      const first = lines.indexOf(separator);
      const second = first === -1 ? -1 : lines.indexOf(separator, first + 1);
      if (second !== -1) {
        header = {};
        for (const line of lines.slice(first + 1, second)) {
          const match = line.match(/^([a-z][a-z ]*):\s(.*)$/);
          if (match) header[match[1]] = match[2].trim();
        }
        done = true;
        buffer = '';
      } else if (buffer.length > headerLimit) {
        done = true;
        buffer = '';
      }
    },
    get header() { return header; },
  };
}

function runChild(spawn, argv, options, prompt, timeoutMs, lastMessagePath) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn('codex', argv, options); } catch {
      reject(new Error('codex host: could not start'));
      return;
    }
    const reader = headerReader();
    let finished = false;
    let failure;
    let timeout;
    let killTimer;
    function finish(error, value) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      if (error) reject(error);
      else resolve(value);
    }
    function stop(error) {
      if (finished || failure) return;
      failure = error;
      // A CLI that ignores SIGTERM must not keep the caller waiting indefinitely.
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* Still reject without child diagnostics. */ }
        finish(failure);
      }, killGraceMs);
      try { child.kill('SIGTERM'); } catch { /* SIGKILL follows after the grace period. */ }
    }
    function result() {
      const header = reader.header;
      if (!header || header.sandbox === undefined) throw new Error('codex host: sandbox not reported');
      if (header.sandbox !== 'read-only') throw new Error('codex host: sandbox is not read-only');
      let text;
      try { text = fs.readFileSync(lastMessagePath, 'utf8'); } catch { text = ''; }
      if (!text.trim()) throw new Error('codex host: empty output');
      return { text, model: typeof header?.model === 'string' && header.model ? header.model : null, raw: { header } };
    }
    child.once('error', () => finish(failure || new Error('codex host: could not start')));
    child.once('close', (code, signal) => {
      if (failure) { finish(failure); return; }
      if (code !== 0) {
        finish(new Error(Number.isInteger(code)
          ? `codex host: exited with code ${code}`
          : `codex host: terminated${signal ? ' by signal' : ''}`));
        return;
      }
      try { finish(null, result()); } catch (error) { finish(error); }
    });
    // The final message is read from the -o file; stdout is drained and discarded.
    child.stdout.resume();
    child.stdout.on('error', () => stop(new Error('codex host: output stream failed')));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => reader.push(chunk));
    child.stderr.on('error', () => stop(new Error('codex host: error stream failed')));
    child.stdin.on('error', () => stop(new Error('codex host: could not write prompt')));
    timeout = setTimeout(() => stop(new Error(`codex host: timed out after ${timeoutMs / 1000} s`)), timeoutMs);
    try { child.stdin.end(prompt, 'utf8'); } catch { stop(new Error('codex host: could not write prompt')); }
  });
}

function create({ spawn = childProcess.spawn } = {}) {
  return {
    async run({ system, prompt, tools, model, outputSchema, timeoutMs = defaultTimeoutMs, cwd } = {}) {
      if (typeof system !== 'string' || typeof prompt !== 'string') throw new Error('codex host: system and prompt must be strings');
      if (!['notion-read', 'none'].includes(tools)) throw new Error('codex host: tools must be notion-read or none');
      if (model !== undefined && (typeof model !== 'string' || !model.trim() || model.startsWith('-'))) {
        throw new Error('codex host: model must be a non-empty string that does not start with "-"');
      }
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new Error('codex host: timeoutMs must be a positive timer duration');
      let schemaText;
      if (outputSchema !== undefined) {
        try {
          schemaText = JSON.stringify(outputSchema);
          if (schemaText === undefined) throw new Error();
        } catch { throw new Error('codex host: output schema must be JSON serializable'); }
      }
      // cwd is accepted for the shared host interface; Codex always runs in an empty temp directory.
      // tools: both values run with every connector and every shell, file, web and image tool removed,
      // so notion-read reaches no source on Codex.
      // allowedTools (a Claude allowlist) is ignored: Codex gets no connector allowlist from bunshin.
      void cwd;
      let dir;
      try {
        let work;
        try {
          dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-codex-'));
          work = path.join(dir, 'work');
          fs.mkdirSync(work, { mode: 0o700 });
          fs.writeFileSync(path.join(dir, 'system.md'), system, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
          if (schemaText !== undefined) {
            fs.writeFileSync(path.join(dir, 'schema.json'), schemaText, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
          }
        } catch { throw new Error('codex host: could not prepare temporary directory'); }
        const lastMessagePath = path.join(dir, 'last-message.txt');
        const argv = [
          'exec', '-s', 'read-only', '--skip-git-repo-check', '--ephemeral', '--strict-config',
          ...connectorRemoval, ...toolRemoval,
          '-C', work, '--color', 'never',
          '-c', `model_instructions_file=${JSON.stringify(path.join(dir, 'system.md'))}`,
          '-o', lastMessagePath,
        ];
        if (model !== undefined) argv.push('-m', model);
        if (schemaText !== undefined) argv.push('--output-schema', path.join(dir, 'schema.json'));
        argv.push('-');
        return await runChild(spawn, argv, { cwd: work, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] },
          prompt, timeoutMs, lastMessagePath);
      } finally {
        if (dir) {
          try { fs.rmSync(dir, { recursive: true, force: true }); } catch {
            throw new Error('codex host: could not remove temporary directory');
          }
        }
      }
    },
  };
}

module.exports = { ...create(), create, connectorRemoval, toolRemoval, envAllowlist };
