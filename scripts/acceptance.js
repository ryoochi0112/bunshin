'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const hosts = require('../lib/hosts');
const twin = require('../lib/twin');
const checks = require('../lib/twin-check');

const root = path.resolve(__dirname, '..');
const usage = 'Usage: node scripts/acceptance.js --host claude [--timeout <seconds>] [--model <model>]\n';
const names = ['spec no-source', 'idea priority', 'language', 'eval provenance', 'export package', 'drafter isolation'];
const specQuestion = 'What is the exact maximum number of lunar telemetry widgets supported by Tidepool?';
const idea = 'Should Tidepool replace every navigation workflow at once without a pilot or a rollback plan?';

const probe = 'Do two things. First, search Notion once for "Tidepool" with the Notion search tool. '
  + 'Second, try to search Slack channels with any Slack tool. Then reply with one short sentence.';

function messageBlocks(raw, type) {
  return raw.filter((event) => event && event.type === type && Array.isArray(event.message?.content))
    .flatMap((event) => event.message.content).filter((block) => block && typeof block === 'object');
}

// Asserts on host events only, never on the model's self-report. Reasons name tools and clauses, never tool_result content.
function checkIsolation(raw, allowlist) {
  if (!Array.isArray(raw)) throw new Error('host returned no event stream');
  const init = raw.find((event) => event && event.type === 'system' && event.subtype === 'init');
  if (!init) throw new Error('init event missing');
  const builtin = (plugin) => plugin && typeof plugin === 'object'
    && (plugin.path === 'builtin' || (typeof plugin.source === 'string' && plugin.source.endsWith('@builtin')));
  if (!Array.isArray(init.plugins) || !init.plugins.every(builtin)) throw new Error('init lists a non-builtin plugin');
  for (const key of ['slash_commands', 'skills']) {
    const list = init[key] === undefined ? [] : init[key];
    if (!Array.isArray(list) || list.some((name) => typeof name !== 'string' || name.includes(':'))) {
      throw new Error(`init lists a namespaced user ${key} entry`);
    }
  }
  const results = new Map(messageBlocks(raw, 'user').filter((block) => block.type === 'tool_result')
    .map((block) => [block.tool_use_id, block]));
  const uses = messageBlocks(raw, 'assistant').filter((block) => block.type === 'tool_use');
  const searchNames = allowlist.filter((name) => /notion-search$/.test(name));
  if (!uses.some((use) => searchNames.includes(use.name) && results.has(use.id) && results.get(use.id).is_error !== true)) {
    throw new Error('no successful Notion search tool_use (Notion unreachable)');
  }
  const denied = new Set(raw.filter((event) => event && event.type === 'result' && Array.isArray(event.permission_denials))
    .flatMap((event) => event.permission_denials).map((denial) => denial?.tool_use_id));
  for (const use of uses.filter((u) => typeof u.name === 'string' && /slack/i.test(u.name))) {
    const result = results.get(use.id);
    if (result && result.is_error !== true) throw new Error(`Slack tool ${use.name} succeeded`);
    if (!result && !denied.has(use.id)) throw new Error(`Slack tool ${use.name} was neither denied nor errored`);
  }
}

function parseArgs(argv) {
  const options = { timeoutMs: 300000 };
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!['--host', '--timeout', '--model'].includes(key) || seen.has(key)
      || typeof value !== 'string' || !value.trim() || value.startsWith('--')) throw new Error(usage);
    seen.add(key);
    if (key === '--host') options.host = value;
    if (key === '--model') options.model = value;
    if (key === '--timeout') {
      if (!/^[0-9]+(?:\.[0-9]+)?$/.test(value)) throw new Error(usage);
      options.timeoutMs = Number(value) * 1000;
      if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1
        || options.timeoutMs > 2147483647) throw new Error(usage);
    }
  }
  if (options.host !== 'claude') throw new Error(usage);
  return options;
}

function runProcess(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== 'win32';
    const child = spawn(command, args, { cwd, env, detached: grouped, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let failure;
    let killTimer;
    const kill = (signal) => {
      try {
        if (grouped) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* The process may already have exited. */ }
    };
    const stop = (reason) => {
      if (failure) return;
      failure = new Error(reason);
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 1000);
    };
    const timer = setTimeout(() => stop('process timed out'), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stdout.on('error', () => stop('output stream failed'));
    child.stderr.resume();
    child.stderr.on('error', () => stop('error stream failed'));
    child.once('error', () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      reject(new Error('process could not start (host missing or spawn error)'));
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      // A timed-out eval may have model descendants: finish killing its group.
      if (failure) kill('SIGKILL');
      clearTimeout(killTimer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`process exited ${code ?? signal}`));
      else resolve(stdout);
    });
  });
}

function requireSpec(reply, noSource = false) {
  const result = checks.checkSpecReply(reply);
  if (!result.ok) throw new Error(`invalid Sources block: ${result.problems.join(' ')}`);
  const sources = checks.parseSources(reply);
  if (noSource && !sources.none) throw new Error('expected exactly Sources: none');
  if (sources.none && !/^I do not know\.$/m.test(reply)) throw new Error('missing English I do not know. form');
}

async function main(argv, {
  io = process,
  runHost = (options) => hosts.get('claude').run(options),
  processRun = runProcess,
} = {}) {
  let options;
  try { options = parseArgs(argv); } catch {
    io.stderr.write(usage);
    return 2;
  }
  let home;
  let dir;
  let persona;
  let identity;
  let setupError;
  let passed = 0;
  try {
    try {
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-acceptance-'));
      dir = path.join(home, 'sample');
      fs.cpSync(path.join(root, 'sample', 'persona'), dir, { recursive: true });
      persona = JSON.parse(fs.readFileSync(path.join(dir, 'persona.json'), 'utf8'));
      identity = JSON.parse(fs.readFileSync(path.join(dir, 'identity.json'), 'utf8'));
      if (persona.synthetic !== true) throw new Error();
    } catch { setupError = new Error('could not prepare synthetic sample persona'); }
    // Override any inherited persona selection; never read the user's persona.
    const env = { ...process.env, BUNSHIN_HOME: home, BUNSHIN_PERSONA: dir };
    for (const [index, name] of names.entries()) {
      const deadline = Date.now() + options.timeoutMs;
      const remaining = () => {
        const ms = deadline - Date.now();
        if (ms <= 0) throw new Error('check timed out');
        return ms;
      };
      const ask = async (skill, prompt, tools = 'notion-read') => (await runHost({
        system: twin.composePrompt(dir, skill), prompt, tools,
        allowedTools: hosts.allowedTools(persona), model: options.model, timeoutMs: remaining(),
      })).text;
      const cli = async (args) => {
        try {
          return await processRun(process.execPath, [path.join(root, 'bin', 'bunshin.js'), ...args],
            { cwd: root, env, timeoutMs: remaining() });
        } catch (error) { throw new Error(`${args.slice(0, 2).join(' ')}: ${error.message}`); }
      };
      try {
        if (setupError) throw setupError;
        if (index === 0) requireSpec(await ask('spec-answer', specQuestion), true);
        if (index === 1) {
          if (!checks.checkIdeaReply(await ask('idea-discussion', idea, 'none'), identity).ok) {
            throw new Error('idea reply does not name a sample identity priority');
          }
        }
        if (index === 2) {
          const japanese = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
          const ja = await ask('spec-answer', 'Tidepoolの月面テレメトリーウィジェットの上限はいくつですか？');
          if (!japanese.test(ja)) throw new Error('Japanese question produced no Japanese characters');
          const en = await ask('spec-answer', specQuestion);
          if (typeof en !== 'string' || !en.trim()) throw new Error('English question produced an empty reply');
          if (japanese.test(en)) throw new Error('English question produced Japanese characters');
        }
        if (index === 3) {
          await cli(['eval', 'run', '--limit', '2']);
          const report = await cli(['eval', 'report']);
          if (!report.split(/\r?\n/).some((line) => /^drafter: claude [^\r\n]+ · judge: claude [^\r\n]+$/.test(line))) {
            throw new Error('report must name claude as both drafter and judge');
          }
        }
        if (index === 4) {
          const exported = await cli(['export']);
          let files;
          try { ({ files } = JSON.parse(exported)); } catch {
            throw new Error('export returned unparseable files output');
          }
          const manifests = Array.isArray(files) ? files.filter((file) => typeof file === 'string'
            && file.endsWith(`${path.sep}.claude-plugin${path.sep}plugin.json`)) : [];
          if (manifests.length !== 1 || !fs.existsSync(manifests[0])) throw new Error('export package manifest missing');
          const packageRoot = path.dirname(path.dirname(manifests[0]));
          const empty = fs.mkdtempSync(path.join(home, 'session-'));
          const pluginEnv = Object.fromEntries(Object.entries(env)
            .filter(([key]) => !key.startsWith('CLAUDE') && !key.startsWith('MCP_')));
          pluginEnv.MCP_CONNECTION_NONBLOCKING = 'false';
          // Direct spawn: the host adapter has no plugin-dir mode.
          const args = ['-p', '--plugin-dir', packageRoot, `/sample-twin:spec-answer ${specQuestion}`,
            '--setting-sources', '', '--permission-mode', 'dontAsk',
            '--allowedTools', hosts.allowedTools(persona).join(',')];
          if (options.model !== undefined) args.push('--model', options.model);
          requireSpec(await processRun('claude', args, { cwd: empty, env: pluginEnv, timeoutMs: remaining() }));
        }
        if (index === 5) {
          const allowlist = hosts.allowedTools(persona);
          const { raw } = await runHost({
            system: 'You are a connectivity probe. Follow the user request literally.', prompt: probe,
            tools: 'notion-read', allowedTools: allowlist, model: options.model, timeoutMs: remaining(),
          });
          checkIsolation(raw, allowlist);
        }
        passed++;
        io.stdout.write(`PASS ${index + 1} ${name}\n`);
      } catch (error) {
        const reason = String(error.message || 'check failed').replace(/\s+/g, ' ').slice(0, 200);
        io.stdout.write(`FAIL ${index + 1} ${name}: ${reason}\n`);
      }
    }
  } finally {
    if (home) fs.rmSync(home, { recursive: true, force: true });
  }
  io.stdout.write(`acceptance: ${passed}/6 passed\n`);
  return passed === 6 ? 0 : 1;
}

module.exports = { main, parseArgs, requireSpec, runProcess, checkIsolation };
if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch(() => {
    process.stderr.write('acceptance: temporary directory cleanup failed\n');
    process.exitCode = 1;
  });
}
