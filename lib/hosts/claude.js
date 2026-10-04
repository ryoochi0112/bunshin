'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const defaultTools = [
  'mcp__claude_ai_Notion__notion-search',
  'mcp__claude_ai_Notion__notion-fetch',
];
// Keep these fragments aligned with the outbound-tool guard in test/skills.test.js.
const deniedFragments = [
  'send_message', 'schedule_message', 'send_message_draft', 'add_reaction',
  'create_canvas', 'update_canvas', 'notion-create', 'notion-update',
  'notion-move', 'notion-duplicate',
];
const defaultTimeoutMs = 180000;
const killGraceMs = 1000;

function validateAllowedTools(value) {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) return [...defaultTools];
  if (!Array.isArray(value)) throw new Error('claude host: allowed tools must be an array');
  for (const name of value) {
    const match = typeof name === 'string' && name.match(/^mcp__([A-Za-z0-9_-]+?)__([A-Za-z0-9_-]+)$/);
    if (!match || /slack/i.test(name) || deniedFragments.some((fragment) => name.toLowerCase().includes(fragment))
      || /create|update|delete|move|upload|comment|send/i.test(match[2])) {
      throw new Error('claude host: allowed tools must name MCP read tools without Slack or outbound actions');
    }
  }
  return [...value];
}

function childEnv() {
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => !name.startsWith('CLAUDE') && !name.startsWith('MCP_')));
  env.MCP_CONNECTION_NONBLOCKING = 'false';
  return env;
}

function parseOutput(stdout) {
  if (!stdout.trim()) throw new Error('claude host: empty output');
  let raw;
  try {
    raw = stdout.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
    if (raw.some((event) => !event || typeof event !== 'object' || Array.isArray(event))) throw new Error();
  } catch {
    throw new Error('claude host: invalid stream output');
  }
  const init = raw.find((event) => event.type === 'system' && event.subtype === 'init');
  const result = raw.findLast((event) => event.type === 'result');
  if (!result) throw new Error('claude host: no result event');
  if (result.is_error === true) throw new Error('claude host: result reported an error');
  if (typeof result.result !== 'string' || !result.result.trim()) throw new Error('claude host: empty output');
  return { text: result.result, model: typeof init?.model === 'string' ? init.model : null, raw };
}

function runChild(spawn, argv, options, prompt, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn('claude', argv, options); } catch {
      reject(new Error('claude host: could not start'));
      return;
    }
    let stdout = '';
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
    child.once('error', () => finish(failure || new Error('claude host: could not start')));
    child.once('close', (code, signal) => {
      if (failure) { finish(failure); return; }
      if (code !== 0) {
        finish(new Error(Number.isInteger(code)
          ? `claude host: exited with code ${code}`
          : `claude host: terminated${signal ? ' by signal' : ''}`));
        return;
      }
      try { finish(null, parseOutput(stdout)); } catch (error) { finish(error); }
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stdout.on('error', () => stop(new Error('claude host: output stream failed')));
    // Drain stderr without retaining diagnostics that might contain either prompt.
    child.stderr.resume();
    child.stderr.on('error', () => stop(new Error('claude host: error stream failed')));
    child.stdin.on('error', () => stop(new Error('claude host: could not write prompt')));
    timeout = setTimeout(() => stop(new Error(`claude host: timed out after ${timeoutMs / 1000} s`)), timeoutMs);
    try { child.stdin.end(prompt, 'utf8'); } catch { stop(new Error('claude host: could not write prompt')); }
  });
}

function create({ spawn = childProcess.spawn } = {}) {
  return {
    async run({ system, prompt, tools, model, outputSchema, allowedTools, timeoutMs = defaultTimeoutMs, cwd } = {}) {
      if (typeof system !== 'string' || typeof prompt !== 'string') throw new Error('claude host: system and prompt must be strings');
      if (!['notion-read', 'none'].includes(tools)) throw new Error('claude host: tools must be notion-read or none');
      if (model !== undefined && (typeof model !== 'string' || !model.trim())) throw new Error('claude host: model must be a non-empty string');
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new Error('claude host: timeoutMs must be a positive timer duration');
      const allowlist = validateAllowedTools(allowedTools);
      let systemText = system;
      if (outputSchema !== undefined) {
        try {
          const schema = JSON.stringify(outputSchema);
          if (schema === undefined) throw new Error();
          systemText += `\n\nReply with JSON only matching this schema:\n${schema}\n`;
        } catch { throw new Error('claude host: output schema must be JSON serializable'); }
      }
      // cwd is accepted for the shared host interface; Claude always uses isolation.
      void cwd;
      let dir;
      try {
        try {
          dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-host-'));
          fs.writeFileSync(path.join(dir, 'system.md'), systemText, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        } catch { throw new Error('claude host: could not prepare temporary directory'); }
        const argv = ['-p'];
        if (model !== undefined) argv.push('--model', model);
        argv.push('--output-format', 'stream-json', '--verbose', '--setting-sources', '');
        if (tools === 'none') argv.push('--strict-mcp-config');
        argv.push('--tools', tools === 'none' ? '' : 'ToolSearch', '--permission-mode', 'dontAsk');
        if (tools === 'notion-read') argv.push('--allowedTools', allowlist.join(','));
        argv.push('--system-prompt-file', path.join(dir, 'system.md'));
        return await runChild(spawn, argv, { cwd: dir, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] }, prompt, timeoutMs);
      } finally {
        if (dir) {
          try { fs.rmSync(dir, { recursive: true, force: true }); } catch {
            throw new Error('claude host: could not remove temporary directory');
          }
        }
      }
    },
  };
}

module.exports = { ...create(), create, validateAllowedTools };
