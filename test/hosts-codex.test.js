'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough, Writable } = require('node:stream');
const test = require('node:test');

// Installed before the registry loads, so the default adapters capture this stub.
// This file must never start a real model process: an unexpected spawn throws.
let spawnImpl = null;
childProcess.spawn = (...args) => {
  if (!spawnImpl) throw new Error('unexpected spawn in test');
  return spawnImpl(...args);
};

const hosts = require('../lib/hosts');
const codex = require('../lib/hosts/codex');
const claude = require('../lib/hosts/claude');
const store = require('../lib/store');
const evalCommand = require('../lib/commands/eval');
const evalRun = require('../lib/eval-run');
const judge = require('../lib/judge');

const root = path.resolve(__dirname, '..');
const system = 'Synthetic system instructions private to the drafter, exceeding twenty-four characters.';
const prompt = 'Synthetic confidential question text exceeding the twenty-four character leak floor.';
const inputs = { system, prompt, tools: 'notion-read', model: 'requested-model' };
const removal = ['--ignore-user-config', '--ignore-rules', '--disable', 'apps', '--disable', 'plugins', '--disable', 'remote_plugin'];
// Built-in tools that read files, run a shell, search the web or handle images, plus the deferred
// multi-agent tools behind tool_search (measured in docs/hosts.md).
const toolRemoval = ['--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'view_image',
  '--disable', 'image_generation', '--disable', 'goals', '--disable', 'sleep_tool', '--disable', 'multi_agent',
  '-c', 'web_search="disabled"'];
const envAllowlist = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'CODEX_HOME'];
const header = (model = 'reported-model', sandbox = 'read-only') => [
  'OpenAI Codex v0.159.0', '--------', 'workdir: /fictional/work', `model: ${model}`, 'provider: openai',
  'approval: never', `sandbox: ${sandbox}`, 'reasoning effort: none', 'session id: fictional-session', '--------',
  'user', prompt, 'codex', 'A fictional final answer.', 'tokens used', '1,000', '',
].join('\n');
const validJudgment = { rating: 'send_as_is', reason: 'Synthetic reason.', claims: [], wrong_uncited: 0, language_match: true };

function flagValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

function instructionsPath(argv) {
  const value = argv.find((arg) => arg.startsWith('model_instructions_file='));
  return value === undefined ? undefined : JSON.parse(value.slice('model_instructions_file='.length));
}

function reply(child, call, { text = 'A fictional final answer.\nSources: none', stderr = header(), code = 0 } = {}) {
  if (text !== null) fs.writeFileSync(flagValue(call.argv, '-o'), text);
  // Deliberately split the header across chunks.
  child.stderr.write(stderr.slice(0, 40));
  child.stderr.end(stderr.slice(40));
  child.stdout.end(text ?? '');
  child.emit('close', code, null);
}

function makeChild(call, behavior, closeOnKill) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({
    write(chunk, encoding, callback) { call.stdin += chunk.toString('utf8'); callback(); },
    final(callback) { callback(); queueMicrotask(() => behavior(child, call)); },
  });
  child.kill = (signal) => {
    call.signals.push(signal);
    if (closeOnKill) queueMicrotask(() => child.emit('close', null, signal));
    return true;
  };
  return child;
}

function stubSpawn({ behavior = (child, call) => reply(child, call), closeOnKill = true } = {}) {
  const calls = [];
  function spawn(command, argv, options) {
    const systemPath = instructionsPath(argv);
    const schemaPath = flagValue(argv, '--output-schema');
    const call = {
      command, argv, options, stdin: '', signals: [],
      entries: fs.readdirSync(options.cwd),
      dirMode: fs.statSync(path.dirname(options.cwd)).mode & 0o777,
      system: systemPath && fs.readFileSync(systemPath, 'utf8'),
      mode: systemPath && fs.statSync(systemPath).mode & 0o777,
      schema: schemaPath && fs.readFileSync(schemaPath, 'utf8'),
    };
    calls.push(call);
    return makeChild(call, behavior, closeOnKill);
  }
  return { calls, host: codex.create({ spawn }) };
}

function assertCleaned(calls) {
  for (const call of calls) assert.equal(fs.existsSync(path.dirname(call.options.cwd)), false, 'Run directory must be removed.');
}

function safeError(message) {
  return (error) => {
    assert.equal(error.message, message);
    assert.ok(!error.stack.includes(prompt));
    assert.ok(!error.stack.includes(system));
    assert.equal(error.cause, undefined);
    return true;
  };
}

function expectedArgv(call, { model, schema = false } = {}) {
  const dir = path.dirname(call.options.cwd);
  return [
    'exec', '-s', 'read-only', '--skip-git-repo-check', '--ephemeral', '--strict-config', ...removal, ...toolRemoval,
    '-C', call.options.cwd, '--color', 'never',
    '-c', `model_instructions_file=${JSON.stringify(path.join(dir, 'system.md'))}`,
    '-o', path.join(dir, 'last-message.txt'),
    ...(model === undefined ? [] : ['-m', model]),
    ...(schema ? ['--output-schema', path.join(dir, 'schema.json')] : []),
    '-',
  ];
}

function assertSandboxNeverWidened(argv) {
  assert.equal(argv.filter((arg) => arg === '-s' || arg === '--sandbox').length, 1);
  assert.equal(flagValue(argv, '-s'), 'read-only');
  for (const flag of ['--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust', '--approve-for-me',
    '--add-dir', '--full-auto', '--enable', '-p', '--profile', '--worktree', '--oss', '--sandbox']) {
    assert.equal(argv.includes(flag), false, flag);
  }
  assert.doesNotMatch(argv.join(' '), /workspace-write|danger-full-access|sandbox_mode|sandbox_permissions|features\.[a-z_]+=true/);
  // Exact -c allowlist: web search off and the private system file; nothing reconfigures the sandbox or enables a feature.
  const overrides = argv.flatMap((arg, index) => (arg === '-c' ? [argv[index + 1]] : []));
  assert.equal(overrides.length, 2);
  assert.equal(overrides[0], 'web_search="disabled"');
  assert.match(overrides[1], /^model_instructions_file="[^"]+system\.md"$/);
  // An unknown -c key fails closed instead of being ignored.
  assert.ok(argv.includes('--strict-config'));
}

function assertToolsRemoved(argv) {
  for (let index = 0; index < toolRemoval.length; index += 2) {
    const [flag, value] = toolRemoval.slice(index, index + 2);
    assert.ok(argv.some((arg, at) => arg === flag && argv[at + 1] === value), `${flag} ${value}`);
  }
  assert.equal(argv.includes('--enable'), false);
}

function assertMinimalEnv(env) {
  for (const key of Object.keys(env)) assert.ok(envAllowlist.includes(key), `unexpected env ${key}`);
  for (const key of ['PATH', 'HOME']) if (process.env[key] !== undefined) assert.equal(env[key], process.env[key]);
}

function assertConnectorsRemoved(argv) {
  for (let index = 0; index < removal.length; index++) {
    if (removal[index] === '--disable') {
      assert.ok(argv.some((arg, at) => arg === '--disable' && argv[at + 1] === removal[index + 1]), removal[index + 1]);
    } else if (removal[index - 1] !== '--disable') {
      assert.ok(argv.includes(removal[index]), removal[index]);
    }
  }
}

test('registry resolves codex and codex:<model> to the codex adapter', () => {
  assert.deepEqual(hosts.parseSpec('codex'), { host: 'codex', model: undefined });
  assert.deepEqual(hosts.parseSpec('codex:gpt-fictional'), { host: 'codex', model: 'gpt-fictional' });
  assert.equal(hosts.get('codex'), codex);
  assert.equal(hosts.get('claude'), claude);
  assert.throws(() => hosts.parseSpec('codex:  '), /Host spec/);
  assert.throws(() => hosts.parseSpec('unknown'), /Unknown host.*claude, codex or fake/);
});

test('Codex argv is read-only with every connector removed for both tool values, prompt on stdin', async () => {
  for (const tools of ['notion-read', 'none']) {
    for (const model of ['requested-model', undefined]) {
      const stub = stubSpawn();
      const result = await stub.host.run({ ...inputs, tools, model, cwd: process.cwd(),
        allowedTools: ['mcp__claude_ai_Notion__notion-search', 'mcp__claude_ai_Notion__notion-fetch'] });
      assert.equal(result.text, 'A fictional final answer.\nSources: none');
      const [call] = stub.calls;
      assert.equal(call.command, 'codex');
      assert.deepEqual(call.argv, expectedArgv(call, { model }));
      assertSandboxNeverWidened(call.argv);
      assertConnectorsRemoved(call.argv);
      assertToolsRemoved(call.argv);
      assertMinimalEnv(call.options.env);
      assert.notEqual(call.options.cwd, process.cwd());
      assert.deepEqual(call.entries, [], 'The working directory must be empty.');
      assert.equal(call.dirMode, 0o700);
      assert.equal(call.system, system);
      assert.equal(call.mode, 0o600);
      assert.equal(call.stdin, prompt);
      assert.deepEqual(call.options.stdio, ['pipe', 'pipe', 'pipe']);
      assert.ok(call.argv.every((arg) => !arg.includes(prompt) && !arg.includes(system)));
      // Codex gets no connector allowlist from bunshin.
      assert.doesNotMatch(call.argv.join(' '), /notion|slack|mcp__/i);
      assertCleaned(stub.calls);
    }
  }
});

test('Codex passes outputSchema as a private schema file and keeps the sandbox read-only', async () => {
  const stub = stubSpawn({ behavior: (child, call) => reply(child, call, { text: JSON.stringify(validJudgment) }) });
  const result = await stub.host.run({ ...inputs, tools: 'none', outputSchema: judge.outputSchema });
  const [call] = stub.calls;
  assert.deepEqual(call.argv, expectedArgv(call, { model: 'requested-model', schema: true }));
  assert.deepEqual(JSON.parse(call.schema), judge.outputSchema);
  assertSandboxNeverWidened(call.argv);
  assertConnectorsRemoved(call.argv);
  assertToolsRemoved(call.argv);
  assert.deepEqual(judge.parse(result.text), validJudgment);
  assertCleaned(stub.calls);
});

test('Codex reports the model from the stderr header and returns the last message bytes', async () => {
  const text = '  最終の架空回答。\n\n';
  const stub = stubSpawn({ behavior: (child, call) => reply(child, call, { text, stderr: header('gpt-fictional-9') }) });
  const result = await stub.host.run({ ...inputs, model: undefined });
  assert.equal(result.text, text);
  assert.equal(result.model, 'gpt-fictional-9');
  assert.equal(result.raw.header.model, 'gpt-fictional-9');
  assert.equal(result.raw.header.sandbox, 'read-only');
  assert.ok(!JSON.stringify(result.raw).includes(prompt), 'raw keeps only the header');
  const noModel = stubSpawn({ behavior: (child, call) => reply(child, call, { stderr: header().replace(/^model: .*\n/m, '') }) });
  const bare = await noModel.host.run(inputs);
  assert.equal(bare.model, null);
  assert.equal(bare.raw.header.sandbox, 'read-only');
  assertCleaned([...stub.calls, ...noModel.calls]);
});

test('Codex fails closed when the banner or its sandbox line is missing', async () => {
  for (const stderr of [prompt, header().replace(/^sandbox: .*\n/m, ''), '']) {
    const stub = stubSpawn({ behavior: (child, call) => reply(child, call, { stderr }) });
    await assert.rejects(stub.host.run(inputs), safeError('codex host: sandbox not reported'));
    assertCleaned(stub.calls);
  }
});

test('Codex child env is a minimal allowlist without BUNSHIN_* or other variables', async (t) => {
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  Object.assign(process.env, { BUNSHIN_PERSONA: 'sample', BUNSHIN_HOME: '/fictional/home', OPENAI_FICTIONAL: 'x',
    CODEX_HOME: '/fictional/codex-home', LANG: 'en_US.UTF-8' });
  const stub = stubSpawn();
  await stub.host.run(inputs);
  const { env } = stub.calls[0].options;
  assertMinimalEnv(env);
  assert.equal(env.CODEX_HOME, '/fictional/codex-home');
  assert.equal(env.LANG, 'en_US.UTF-8');
  assert.ok(!Object.keys(env).some((key) => key.startsWith('BUNSHIN_')));
  assert.equal(env.OPENAI_FICTIONAL, undefined);
  assertCleaned(stub.calls);
});

test('Codex fails closed when the reported sandbox is not read-only', async () => {
  const stub = stubSpawn({ behavior: (child, call) => reply(child, call, { stderr: header('m', 'workspace-write') }) });
  await assert.rejects(stub.host.run(inputs), safeError('codex host: sandbox is not read-only'));
  assertCleaned(stub.calls);
});

test('Codex rejects non-zero exit, signal, stream errors and empty output without exposing either prompt', async () => {
  const scenarios = [
    [(child) => { child.stdout.end(prompt); child.stderr.end(system); child.emit('close', 1); }, 'codex host: exited with code 1'],
    [(child) => { child.stderr.end(prompt); child.emit('close', null, system); }, 'codex host: terminated by signal'],
    [(child) => child.emit('error', new Error(prompt + system)), 'codex host: could not start'],
    [(child) => child.stdin.emit('error', new Error(prompt + system)), 'codex host: could not write prompt'],
    [(child) => child.stdout.emit('error', new Error(prompt + system)), 'codex host: output stream failed'],
    [(child) => child.stderr.emit('error', new Error(prompt + system)), 'codex host: error stream failed'],
    [(child, call) => reply(child, call, { text: null }), 'codex host: empty output'],
    [(child, call) => reply(child, call, { text: '' }), 'codex host: empty output'],
    [(child, call) => reply(child, call, { text: ' \n\t' }), 'codex host: empty output'],
  ];
  for (const [behavior, message] of scenarios) {
    const stub = stubSpawn({ behavior });
    await assert.rejects(stub.host.run(inputs), safeError(message));
    assertCleaned(stub.calls);
  }
  let dir;
  const host = codex.create({ spawn(command, argv, options) { dir = path.dirname(options.cwd); throw new Error(prompt + system); } });
  await assert.rejects(host.run(inputs), safeError('codex host: could not start'));
  assert.equal(fs.existsSync(dir), false);
});

test('Codex defaults to 180 seconds and escalates to SIGKILL when SIGTERM is ignored', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stub = stubSpawn({ behavior() {} });
  const checked = assert.rejects(stub.host.run(inputs), safeError('codex host: timed out after 180 s'));
  t.mock.timers.tick(179999);
  assert.deepEqual(stub.calls[0].signals, []);
  t.mock.timers.tick(1);
  await checked;
  assert.deepEqual(stub.calls[0].signals, ['SIGTERM']);
  const stuck = stubSpawn({ behavior() {}, closeOnKill: false });
  const pending = assert.rejects(stuck.host.run({ ...inputs, timeoutMs: 50 }), safeError('codex host: timed out after 0.05 s'));
  t.mock.timers.tick(50);
  assert.deepEqual(stuck.calls[0].signals, ['SIGTERM']);
  t.mock.timers.tick(1000);
  await pending;
  assert.deepEqual(stuck.calls[0].signals, ['SIGTERM', 'SIGKILL']);
  assertCleaned([...stub.calls, ...stuck.calls]);
});

test('Codex refuses invalid tools, models, timeouts, prompts and schemas before spawning', async () => {
  const stub = stubSpawn();
  const circular = {}; circular.self = circular;
  for (const changed of [
    { tools: 'all' }, { tools: undefined }, { model: '' }, { model: '  ' }, { model: '--dangerously-bypass-approvals-and-sandbox' },
    { model: 7 }, { system: null }, { prompt: null },
    ...[0, -1, NaN, Infinity, 2147483648, '50'].map((timeoutMs) => ({ timeoutMs })),
    { outputSchema: circular }, { outputSchema: 1n },
  ]) await assert.rejects(stub.host.run({ ...inputs, ...changed }), /Error: codex host:/);
  assert.equal(stub.calls.length, 0);
});

// Cross-host judge (criterion 15).

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-codex-eval-')));
  fs.cpSync(path.join(root, 'sample', 'persona'), dir, { recursive: true });
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); store._resetGuardCache(); });
  return dir;
}

async function cli(args) {
  let stdout = '';
  let stderr = '';
  const code = await evalCommand.run(args, { env: {},
    stdout: { write(text) { stdout += text; } }, stderr: { write(text) { stderr += text; } } });
  return { code, stdout, stderr };
}

function reportMarkdown(dir) {
  const runId = fs.readdirSync(path.join(dir, 'evals')).sort().at(-1);
  return { runId, markdown: fs.readFileSync(path.join(dir, 'evals', runId, 'report.md'), 'utf8') };
}

test('report names both hosts and models for drafter fake:a and judge fake:b', async (t) => {
  const dir = fixture(t);
  const adapters = { get(host) { return { async run(input) {
    const model = `${host}-model-${input.model}`;
    return { text: input.tools === 'none' ? JSON.stringify(validJudgment) : 'Synthetic draft.', model, raw: {} };
  } }; } };
  await evalRun.run(dir, { drafter: 'fake:a', judge: 'fake:b', hosts: adapters });
  assert.equal((await cli(['report', '--persona', dir])).code, 0);
  const { runId, markdown } = reportMarkdown(dir);
  assert.deepEqual(store.readJson(dir, `evals/${runId}/run.json`).drafter, { host: 'fake', model: 'a' });
  assert.deepEqual(store.readJson(dir, `evals/${runId}/run.json`).judge, { host: 'fake', model: 'b' });
  assert.match(markdown, /^drafter: fake fake-model-a · judge: fake fake-model-b$/m);
});

function crossHostSpawn() {
  const calls = [];
  spawnImpl = (command, argv, options) => {
    const call = { command, argv, options, stdin: '', signals: [], tools: argv.includes('--output-schema') || argv.includes('--strict-mcp-config') ? 'none' : 'notion-read' };
    calls.push(call);
    return makeChild(call, (child) => {
      const text = call.tools === 'none' ? JSON.stringify(validJudgment) : 'Synthetic cross-host draft.';
      if (command === 'codex') {
        reply(child, call, { text, stderr: header('gpt-fictional-judge') });
      } else {
        assert.equal(command, 'claude');
        const events = [{ type: 'system', subtype: 'init', model: 'claude-fictional' }, { type: 'result', is_error: false, result: text }];
        child.stdout.end(events.map((event) => JSON.stringify(event)).join('\n'));
        child.stderr.end();
        child.emit('close', 0, null);
      }
    }, true);
  };
  return calls;
}

test('--drafter claude --judge codex and the reverse resolve to the right adapters', async (t) => {
  t.after(() => { spawnImpl = null; });
  for (const [drafterHost, judgeHost] of [['claude', 'codex'], ['codex', 'claude']]) {
    const dir = fixture(t);
    const calls = crossHostSpawn();
    const result = await cli(['run', '--persona', dir, '--drafter', drafterHost, '--judge', judgeHost]);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(calls.length > 0);
    for (const call of calls) assert.equal(call.command, call.tools === 'none' ? judgeHost : drafterHost);
    assert.ok(calls.some((call) => call.tools === 'none') && calls.some((call) => call.tools === 'notion-read'));
    for (const call of calls.filter((value) => value.command === 'codex')) {
      assertSandboxNeverWidened(call.argv);
      assertConnectorsRemoved(call.argv);
      assertToolsRemoved(call.argv);
      assertMinimalEnv(call.options.env);
    }
    const { runId, markdown } = reportMarkdown(dir);
    const models = { claude: 'claude-fictional', codex: 'gpt-fictional-judge' };
    for (const row of store.readJsonl(dir, `evals/${runId}/drafts.jsonl`)) assert.deepEqual(row.drafter, { host: drafterHost, model: models[drafterHost] });
    for (const row of store.readJsonl(dir, `evals/${runId}/judgments.jsonl`)) assert.deepEqual(row.judge, { host: judgeHost, model: models[judgeHost] });
    assert.match(markdown, new RegExp(`^drafter: ${drafterHost} ${models[drafterHost]} · judge: ${judgeHost} ${models[judgeHost]}$`, 'm'));
  }
});
