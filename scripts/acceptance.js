'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const hosts = require('../lib/hosts');
const twin = require('../lib/twin');
const checks = require('../lib/twin-check');

const root = path.resolve(__dirname, '..');
const usage = 'Usage: node scripts/acceptance.js --host claude|codex [--timeout <seconds>] [--model <model>]\n';
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
  if (!['claude', 'codex'].includes(options.host)) throw new Error(usage);
  return options;
}

// The acceptance owner installs signal handlers before creating its workspace.
// Child groups are stopped before that workspace is removed or the parent exits.
function interruptions(signalSource, exit, cleanup, io) {
  const stops = new Set();
  const handlers = new Map();
  let interrupted = false;
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
    const handler = () => {
      if (interrupted) return;
      interrupted = true;
      for (const stop of stops) stop(signal);
      try { cleanup(); } finally {
        io.stderr.write(`acceptance: interrupted by ${signal}; child groups stopped and temporary workspace removed\n`);
        exit(code);
      }
    };
    handlers.set(signal, handler);
    signalSource.on(signal, handler);
  }
  return {
    get interrupted() { return interrupted; },
    register(stop) { stops.add(stop); return () => stops.delete(stop); },
    dispose() { for (const [signal, handler] of handlers) signalSource.removeListener(signal, handler); },
  };
}

function runProcess(command, args, { cwd, env, timeoutMs, interrupt,
  spawnProcess = spawn, killProcess = process.kill }) {
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== 'win32';
    let child;
    const startError = () => new Error(command === 'codex'
      ? 'codex unavailable / over quota: executable could not start (check installation)'
      : 'process could not start (host missing or spawn error)');
    try { child = spawnProcess(command, args, { cwd, env, detached: grouped, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { reject(startError()); return; }
    let stdout = '';
    let failure;
    let finished = false;
    let timer;
    let killTimer;
    let unregister;
    const kill = (signal) => {
      try {
        if (grouped) killProcess(-child.pid, signal);
        else child.kill(signal);
      } catch { /* The process may already have exited. */ }
    };
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      unregister?.();
      if (error) reject(error);
      else resolve(stdout);
    };
    unregister = interrupt?.register((signal) => {
      kill('SIGKILL');
      finish(new Error(`interrupted by ${signal}`));
    });
    const stop = (reason) => {
      if (failure || finished) return;
      failure = new Error(reason);
      kill('SIGTERM');
      killTimer = setTimeout(() => { kill('SIGKILL'); finish(failure); }, 1000);
    };
    timer = setTimeout(() => stop('process timed out'), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stdout.on('error', () => stop('output stream failed'));
    child.stderr.resume();
    child.stderr.on('error', () => stop('error stream failed'));
    child.once('error', () => finish(failure || startError()));
    child.once('close', (code, signal) => {
      // A timed-out eval may have model descendants: finish killing its group.
      if (failure) kill('SIGKILL');
      finish(failure || (code !== 0 ? new Error(`process exited ${code ?? signal}`) : undefined));
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

// This build agent is separate from the tool-less drafter adapter. It gets a
// copied engine and a synthetic persona in one temporary writable workspace.
async function buildSample(home, dir, options, processRun, timeoutMs, interrupt) {
  const engine = path.join(home, 'engine');
  for (const name of ['bin', 'lib', 'templates', 'docs', 'skills', 'package.json']) {
    fs.cpSync(path.join(root, name), path.join(engine, name), { recursive: true });
  }
  const instructions = path.join(home, 'build-instructions.md');
  const skill = fs.readFileSync(path.join(engine, 'skills/build/SKILL.md'), 'utf8');
  fs.writeFileSync(instructions, 'Work only inside this temporary workspace on the synthetic sample persona. '
    + 'Do not read user config, authentication files, other personas, or anything outside this workspace. '
    + 'Use the bunshin CLI for all persona writes. Do not delegate. Follow this build skill:\n\n' + skill);
  const env = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE']) if (process.env[key] !== undefined) env[key] = process.env[key];
  Object.assign(env, { HOME: home, TMPDIR: home, CODEX_HOME: process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    BUNSHIN_HOME: home, BUNSHIN_PERSONA: dir, CLAUDE_PLUGIN_ROOT: engine });
  const args = ['exec', '-s', 'workspace-write', '--skip-git-repo-check', '--ephemeral', '--strict-config',
    ...require('../lib/hosts/codex').connectorRemoval,
    '--disable', 'view_image', '--disable', 'image_generation', '--disable', 'goals',
    '--disable', 'sleep_tool', '--disable', 'multi_agent', '-c', 'web_search="disabled"',
    '-C', home, '-c', 'sandbox_workspace_write.exclude_slash_tmp=true',
    '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true', '-c', `model_instructions_file=${JSON.stringify(instructions)}`];
  if (options.model !== undefined) args.push('-m', options.model);
  args.push('Build and commit a new identity for the synthetic sample persona using the supplied build skill. '
    + 'Read only the permitted build evidence. Pipe the generated draft to identity commit - and run check.');
  await processRun('codex', args, { cwd: home, env, timeoutMs, interrupt });
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function readRows(file) { return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); }

async function codexAcceptance(options, { io, runHost, processRun, signalSource, exit }) {
  const labels = ['build identity commit', 'codex drafter / claude judge', 'claude drafter / codex judge',
    'shadow pasted text', 'export and check', 'spec no-source'];
  let home;
  let passed = 0;
  const cleanup = () => { if (home) fs.rmSync(home, { recursive: true, force: true }); };
  const interrupt = interruptions(signalSource, exit, cleanup, io);
  try {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-acceptance-codex-'));
    const dir = path.join(home, 'sample');
    fs.cpSync(path.join(root, 'sample/persona'), dir, { recursive: true });
    const before = readJson(path.join(dir, 'persona.json'));
    if (before.synthetic !== true || before.name !== 'sample') throw new Error('synthetic sample required');
    const originalIdentity = fs.readFileSync(path.join(dir, 'identity.json'), 'utf8');
    const env = { ...process.env, BUNSHIN_HOME: home, BUNSHIN_PERSONA: dir };
    const codexSpec = options.model ? `codex:${options.model}` : 'codex';
    for (const [index, label] of labels.entries()) {
      const deadline = Date.now() + options.timeoutMs;
      const remaining = () => {
        const ms = deadline - Date.now();
        if (ms <= 0) throw new Error('check timed out');
        return ms;
      };
      const cli = (args) => processRun(process.execPath, [path.join(root, 'bin/bunshin.js'), ...args],
        { cwd: root, env, timeoutMs: remaining(), interrupt });
      const green = async () => {
        if ((await cli(['check'])).trim() !== 'Held-out checks passed.') throw new Error('check is not green');
      };
      try {
        if (index === 0) {
          await buildSample(home, dir, options, processRun, remaining(), interrupt);
          const manifest = readJson(path.join(dir, 'persona.json'));
          const identity = readJson(path.join(dir, 'identity.json'));
          if (manifest.version !== before.version + 1 || identity.version !== manifest.version
            || fs.readFileSync(path.join(dir, 'identity.json'), 'utf8') === originalIdentity
            || !['voice', 'priorities', 'objections', 'context_rules'].some(key => identity[key]?.length)) {
            throw new Error('no new evidenced identity committed');
          }
          if ((await cli(['identity', 'validate', path.join(dir, 'identity.json')])).trim() !== 'Identity is valid.') {
            throw new Error('committed identity is invalid');
          }
          await green();
        }
        if (index === 1 || index === 2) {
          const drafter = index === 1 ? codexSpec : 'claude';
          const judge = index === 1 ? 'claude' : codexSpec;
          const prior = new Set(fs.existsSync(path.join(dir, 'evals')) ? fs.readdirSync(path.join(dir, 'evals')) : []);
          await cli(['eval', 'run', '--drafter', drafter, '--judge', judge, '--limit', '2']);
          const reportText = await cli(['eval', 'report']);
          const runs = fs.readdirSync(path.join(dir, 'evals')).filter(id => !prior.has(id));
          if (runs.length !== 1) throw new Error('expected one new eval run');
          const base = path.join(dir, 'evals', runs[0]);
          const report = readJson(path.join(base, 'report.json'));
          const drafts = readRows(path.join(base, 'drafts.jsonl'));
          const judgments = readRows(path.join(base, 'judgments.jsonl'));
          if (drafts.length !== 2 || judgments.length !== 2 || report.judge_errors !== 0
            || judgments.some(row => row.rating === 'judge_error')) throw new Error('eval must draft and judge two cases without errors');
          for (const [role, spec] of [['drafter', drafter], ['judge', judge]]) {
            const value = report[role];
            if (value?.host !== hosts.parseSpec(spec).host || !Array.isArray(value.models) || value.models.length === 0
              || value.models.some(model => typeof model !== 'string' || !model.trim() || model === 'default')) throw new Error(`report missing measured ${role} model`);
          }
          const expected = `drafter: ${report.drafter.host} ${report.drafter.models.join(', ')} · judge: ${report.judge.host} ${report.judge.models.join(', ')}`;
          if (!reportText.split(/\r?\n/).includes(expected)) throw new Error('eval report must name both measured models');
          await green();
        }
        if (index === 3) {
          const questionFile = path.join(home, 'pasted-question.txt');
          fs.writeFileSync(questionFile, idea);
          const id = (await cli(['shadow', 'new', '--layer', 'judgment', '--question-file', questionFile])).trim();
          require('../lib/shadow').validateId(id);
          const draftText = await cli(['shadow', 'draft', id, '--drafter', codexSpec]);
          const shown = await cli(['shadow', 'show', id]);
          const draft = readJson(path.join(dir, 'shadow', id, 'draft.json'));
          if (draft.drafter?.host !== 'codex' || !draft.drafter.model || !draft.draft?.trim()
            || draftText.trim() !== draft.draft.trim() || !shown.includes(idea) || !shown.includes(draft.draft)) {
            throw new Error('shadow output missing pasted question or Codex draft');
          }
        }
        if (index === 4) {
          const { files } = JSON.parse(await cli(['export']));
          if (!Array.isArray(files) || files.length === 0 || files.some(file => typeof file !== 'string'
            || !fs.existsSync(file) || !fs.realpathSync(file).startsWith(path.join(fs.realpathSync(dir), 'export') + path.sep))
            || !files.some(file => file.endsWith(`${path.sep}.claude-plugin${path.sep}plugin.json`))) {
            throw new Error('export package files missing');
          }
          await green();
        }
        if (index === 5) {
          requireSpec((await runHost({ system: twin.composePrompt(dir, 'spec-answer'), prompt: specQuestion,
            tools: 'notion-read', model: options.model, timeoutMs: remaining() })).text, true);
        }
        passed++;
        io.stdout.write(`PASS ${index + 1} ${label}\n`);
      } catch (error) {
        if (interrupt.interrupted) return 1;
        let reason = String(error.message || 'check failed').replace(/\s+/g, ' ').slice(0, 180);
        if (reason === 'codex host: could not start') reason = 'codex unavailable / over quota: executable could not start (check installation)';
        // Nonzero exits alone do not establish an authentication or quota cause.
        if (/^(?:process exited|codex host: exited)/.test(reason)) reason += '; cause not reported; check authentication, quota and flags';
        io.stdout.write(`FAIL ${index + 1} ${label}: ${reason}\n`);
      }
    }
  } catch {
    if (interrupt.interrupted) return 1;
    for (const [index, label] of labels.entries()) io.stdout.write(`FAIL ${index + 1} ${label}: could not prepare synthetic sample persona\n`);
  } finally {
    try { cleanup(); } finally { interrupt.dispose(); }
  }
  io.stdout.write(`acceptance: ${passed}/6 passed\n`);
  return passed === 6 ? 0 : 1;
}

async function main(argv, {
  io = process,
  runHost,
  processRun = runProcess,
  signalSource = process,
  exit = code => process.exit(code),
} = {}) {
  let options;
  try { options = parseArgs(argv); } catch {
    io.stderr.write(usage);
    return 2;
  }
  runHost ??= (input) => hosts.get(options.host).run(input);
  if (options.host === 'codex') return codexAcceptance(options, { io, runHost, processRun, signalSource, exit });
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
