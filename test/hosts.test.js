'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough, Writable } = require('node:stream');
const test = require('node:test');
const hosts = require('../lib/hosts');
const claude = require('../lib/hosts/claude');

const root = path.resolve(__dirname, '..');
const fixturePath = path.join(__dirname, 'fixtures', 'hosts', 'fake-replies.json');
const defaultTools = ['mcp__claude_ai_Notion__notion-search', 'mcp__claude_ai_Notion__notion-fetch'];
const system = 'Synthetic system instructions private to the drafter, exceeding twenty-four characters.';
const prompt = 'Synthetic confidential question text exceeding the twenty-four character leak floor.';
const inputs = { system, prompt, tools: 'notion-read', model: 'requested-model' };
const events = [
  { type: 'system', subtype: 'init', model: 'reported-model' },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Intermediate content is not the final answer.' }] } },
  { type: 'result', is_error: false, result: 'A fictional final answer.\nSources: none' },
];

function emitOutput(child, values = events) {
  const text = values.map((event) => JSON.stringify(event)).join('\r\n');
  // Deliberately split within JSON and leave the final line without a newline.
  child.stdout.write(text.slice(0, 17));
  child.stdout.end(text.slice(17));
  child.stderr.end();
  child.emit('close', 0, null);
}

function stubSpawn({ behavior = (child) => emitOutput(child), closeOnKill = true } = {}) {
  const calls = [];
  function spawn(command, argv, options) {
    const child = new EventEmitter();
    const call = {
      command, argv, options, stdin: '', signals: [],
      entries: fs.readdirSync(options.cwd),
      system: fs.readFileSync(path.join(options.cwd, 'system.md'), 'utf8'),
      mode: fs.statSync(path.join(options.cwd, 'system.md')).mode & 0o777,
      dirMode: fs.statSync(options.cwd).mode & 0o777,
    };
    calls.push(call);
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
  return { calls, host: claude.create({ spawn }) };
}

function temporaryDirectory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-host-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function assertCleaned(calls) {
  for (const call of calls) assert.equal(fs.existsSync(call.options.cwd), false, 'Run directory must be removed.');
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

test('host registry parses only supported hosts and keeps the full fixture suffix', () => {
  assert.deepEqual(hosts.parseSpec('claude'), { host: 'claude', model: undefined });
  assert.deepEqual(hosts.parseSpec('claude:haiku'), { host: 'claude', model: 'haiku' });
  assert.deepEqual(hosts.parseSpec('fake'), { host: 'fake', model: undefined });
  assert.deepEqual(hosts.parseSpec('fake:./fixtures/replies:one.json'), { host: 'fake', model: './fixtures/replies:one.json' });
  for (const host of ['claude', 'fake']) assert.equal(typeof hosts.get(host).run, 'function');
  for (const name of ['codex', 'codex:model', 'unknown', '__proto__', 'constructor']) {
    assert.throws(() => hosts.parseSpec(name), /Unknown host.*claude or fake.*codex/);
    assert.throws(() => hosts.get(name), /Unknown host/);
  }
  for (const spec of ['', undefined, null, 'claude:', 'fake:  ']) assert.throws(() => hosts.parseSpec(spec), /Host spec/);
});

test('fake uses a built-in default, first fixture match and fallback, with no schema constraint', async () => {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const host = hosts.get('fake');
  assert.deepEqual(await host.run({ ...inputs, model: undefined }), { text: fixture.default, model: 'fake', raw: { matched: null } });
  const spec = hosts.parseSpec(`fake:${path.relative(process.cwd(), fixturePath)}`);
  for (const [question, matched] of [
    ['What is the preview duration?', 'preview duration'],
    ['What is the preview?', 'preview'],
    ['Discuss a new idea.', 'new idea'],
    ['An unmatched question.', null],
  ]) {
    assert.deepEqual(await hosts.get(spec.host).run({
      ...inputs, prompt: question, model: spec.model, outputSchema: { type: 'number' }, cwd: '/fictional/ignored',
    }), { text: matched === null ? fixture.default : fixture.replies[matched], model: 'fake', raw: { matched } });
  }
});

test('fake reports fixture read and format errors without echoing file content', async (t) => {
  const dir = temporaryDirectory(t);
  const file = path.join(dir, 'bad-replies.json');
  await assert.rejects(hosts.get('fake').run({ prompt, model: file }), /fake host: could not read fixture JSON/);
  fs.writeFileSync(file, prompt);
  await assert.rejects(hosts.get('fake').run({ prompt, model: file }), safeError('fake host: could not read fixture JSON'));
  for (const value of [null, {}, { default: 1, replies: {} }, { default: prompt, replies: [] },
    { default: prompt, replies: { question: 1 } }]) {
    fs.writeFileSync(file, JSON.stringify(value));
    await assert.rejects(hosts.get('fake').run({ prompt, model: file }), /fake host: invalid fixture/);
  }
});

test('fake host consumes a composed prompt from the CLI using only a temp sample home', async (t) => {
  const home = temporaryDirectory(t);
  const dir = path.join(home, 'sample');
  fs.cpSync(path.join(root, 'sample', 'persona'), dir, { recursive: true });
  const result = childProcess.spawnSync(process.execPath, [path.join(root, 'bin', 'bunshin.js'), 'twin', 'prompt', '--skill', 'spec-answer'], {
    cwd: root, env: { ...process.env, BUNSHIN_HOME: home, BUNSHIN_PERSONA: dir }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^# Twin behaviour/);
  assert.doesNotMatch(result.stdout, /^(?:name|description):/m);
  const spec = hosts.parseSpec(`fake:${fixturePath}`);
  const reply = await hosts.get(spec.host).run({ system: result.stdout, prompt: 'What is the preview duration?', tools: 'notion-read', model: spec.model });
  assert.equal(reply.model, 'fake');
  assert.match(reply.text, /seven days/);
  assert.deepEqual(reply.raw, { matched: 'preview duration' });
});

test('persona allowlist defaults and configured read tools are copied without mutation', () => {
  for (const persona of [undefined, {}, { hosts: {} }, { hosts: { claude: {} } },
    JSON.parse(fs.readFileSync(path.join(root, 'sample', 'persona', 'persona.json'), 'utf8'))]) {
    assert.deepEqual(hosts.allowedTools(persona), defaultTools);
  }
  const configured = ['mcp__notion__search', 'mcp__notion__fetch'];
  const result = hosts.allowedTools({ hosts: { claude: { allowed_tools: configured } } });
  assert.deepEqual(result, configured);
  assert.notEqual(result, configured);
  result.push('mcp__notion__read');
  assert.deepEqual(configured, ['mcp__notion__search', 'mcp__notion__fetch']);
  hosts.allowedTools({})[0] = 'changed';
  assert.deepEqual(hosts.allowedTools({}), defaultTools);
});

test('Claude notion-read argv isolates context, sends only approved tools and uses stdin', async (t) => {
  const suppliedCwd = temporaryDirectory(t);
  const stub = stubSpawn();
  assert.deepEqual(await stub.host.run({ ...inputs, cwd: suppliedCwd }), { text: events[2].result, model: 'reported-model', raw: events });
  const [call] = stub.calls;
  assert.equal(call.command, 'claude');
  assert.deepEqual(call.argv, [
    '-p', '--model', 'requested-model', '--output-format', 'stream-json', '--verbose', '--setting-sources', '',
    '--tools', 'ToolSearch', '--permission-mode', 'dontAsk', '--allowedTools', defaultTools.join(','),
    '--system-prompt-file', path.join(call.options.cwd, 'system.md'),
  ]);
  assert.notEqual(call.options.cwd, suppliedCwd);
  assert.notEqual(call.options.cwd, process.cwd());
  assert.deepEqual(call.entries, ['system.md']);
  assert.equal(call.system, system);
  assert.equal(call.stdin, prompt);
  assert.equal(call.mode, 0o600);
  assert.equal(call.dirMode, 0o700);
  assert.deepEqual(call.options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.ok(call.argv.every((arg) => !arg.includes(prompt) && !arg.includes(system)));
  assert.doesNotMatch(call.argv.join(' '), /slack|send_message|create|update|delete|move|upload|comment/i);
  assert.deepEqual(call.signals, []);
  assertCleaned(stub.calls);
});

test('Claude none argv disables MCP and all built-ins, and omits an unspecified model', async () => {
  const stub = stubSpawn();
  await stub.host.run({ ...inputs, tools: 'none', model: undefined });
  const [call] = stub.calls;
  assert.deepEqual(call.argv, [
    '-p', '--output-format', 'stream-json', '--verbose', '--setting-sources', '', '--strict-mcp-config',
    '--tools', '', '--permission-mode', 'dontAsk', '--system-prompt-file', path.join(call.options.cwd, 'system.md'),
  ]);
  assert.equal(call.argv.includes('--allowedTools'), false);
  assert.ok(call.argv.every((arg) => !arg.includes(prompt) && !arg.includes(system)));
  assertCleaned(stub.calls);
});

test('Claude child env removes every CLAUDE and MCP_ prefix and forces blocking connections', async (t) => {
  const values = {
    CLAUDE: 'private', CLAUDE_CODE_SESSION: 'private', CLAUDEX_TEST: 'private',
    MCP_CONNECTION_NONBLOCKING: 'true', MCP_PRIVATE_TEST: 'private', BUNSHIN_HOST_TEST: 'preserved',
  };
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  Object.assign(process.env, values);
  const parentEnv = { ...process.env };
  const stub = stubSpawn();
  await stub.host.run(inputs);
  const env = stub.calls[0].options.env;
  const expected = Object.fromEntries(Object.entries(parentEnv).filter(([key]) => !key.startsWith('CLAUDE') && !key.startsWith('MCP_')));
  assert.deepEqual(env, { ...expected, MCP_CONNECTION_NONBLOCKING: 'false' });
  assert.deepEqual({ ...process.env }, parentEnv);
  assertCleaned(stub.calls);
});

test('Claude validates direct allowlists before spawning and passes configured read tools exactly', async () => {
  const stub = stubSpawn();
  const deniedFragments = [
    'send_message', 'schedule_message', 'send_message_draft', 'add_reaction', 'create_canvas', 'update_canvas',
    'notion-create', 'notion-update', 'notion-move', 'notion-duplicate',
    'create', 'update', 'delete', 'move', 'upload', 'comment', 'send',
  ];
  const invalidLists = [null, 'mcp__notion__read', [null], ['Read'], ['mcp__notion'], ['mcp__notion__*'],
    ['mcp__notion__read,Read'], ['mcp__notion__read Write'], ['mcp__Slack__search'], ['mcp__notion__slack_search'],
    ...deniedFragments.map((fragment) => [`mcp__notion__prefix_${fragment.toUpperCase()}_suffix`])];
  for (const allowedTools of invalidLists) {
    assert.throws(() => hosts.allowedTools({ hosts: { claude: { allowed_tools: allowedTools } } }), /claude host: allowed tools/);
    for (const tools of ['notion-read', 'none']) {
      await assert.rejects(stub.host.run({ ...inputs, allowedTools, tools }), /claude host: allowed tools/);
    }
  }
  assert.equal(stub.calls.length, 0);
  const configured = ['mcp__notion__search', 'mcp__notion__fetch'];
  await stub.host.run({ ...inputs, allowedTools: configured });
  assert.equal(stub.calls[0].argv[stub.calls[0].argv.indexOf('--allowedTools') + 1], configured.join(','));
  await stub.host.run({ ...inputs, allowedTools: [] });
  assert.equal(stub.calls[1].argv[stub.calls[1].argv.indexOf('--allowedTools') + 1], defaultTools.join(','));
  assertCleaned(stub.calls);
});

test('Claude appends only the schema instruction to the private system file', async () => {
  const stub = stubSpawn();
  const outputSchema = { type: 'object', properties: { rating: { type: 'string' } }, required: ['rating'] };
  await stub.host.run({ ...inputs, outputSchema });
  const [call] = stub.calls;
  assert.equal(call.system, `${system}\n\nReply with JSON only matching this schema:\n${JSON.stringify(outputSchema)}\n`);
  assert.ok(call.argv.every((arg) => !arg.includes(system) && !arg.includes(prompt) && !arg.includes(JSON.stringify(outputSchema))));
  assertCleaned(stub.calls);
});

test('Claude preserves final result bytes and reports only the CLI init model', async () => {
  const values = [events[0], { type: 'result', result: 'Superseded reply.' }, { type: 'result', result: '  最終の架空回答。\n\n' }];
  const stub = stubSpawn({ behavior: (child) => emitOutput(child, values) });
  assert.deepEqual(await stub.host.run(inputs), { text: values[2].result, model: 'reported-model', raw: values });
  const noInit = stubSpawn({ behavior: (child) => emitOutput(child, [events[2]]) });
  assert.equal((await noInit.host.run(inputs)).model, null);
  assertCleaned([...stub.calls, ...noInit.calls]);
});

test('Claude rejects non-zero exit, signal and stream errors without exposing either prompt', async () => {
  const scenarios = [
    [(child) => { child.stdout.end(prompt); child.stderr.end(system); child.emit('close', 1); }, 'claude host: exited with code 1'],
    [(child) => { child.stderr.end(prompt); child.emit('close', null, system); }, 'claude host: terminated by signal'],
    [(child) => child.emit('error', new Error(prompt + system)), 'claude host: could not start'],
    [(child) => child.stdin.emit('error', new Error(prompt + system)), 'claude host: could not write prompt'],
    [(child) => child.stdout.emit('error', new Error(prompt + system)), 'claude host: output stream failed'],
    [(child) => child.stderr.emit('error', new Error(prompt + system)), 'claude host: error stream failed'],
  ];
  for (const [behavior, message] of scenarios) {
    const stub = stubSpawn({ behavior });
    await assert.rejects(stub.host.run(inputs), safeError(message));
    assertCleaned(stub.calls);
  }
  let dir;
  const host = claude.create({ spawn(command, argv, options) { dir = options.cwd; throw new Error(prompt + system); } });
  await assert.rejects(host.run(inputs), safeError('claude host: could not start'));
  assert.equal(fs.existsSync(dir), false);
});

test('Claude rejects missing, malformed, failed and empty final output safely', async () => {
  const scenarios = [
    ['', 'claude host: empty output'], [' \n\t', 'claude host: empty output'],
    [prompt + system, 'claude host: invalid stream output'], ['null\n', 'claude host: invalid stream output'],
    [JSON.stringify(events[0]), 'claude host: no result event'],
    [JSON.stringify({ type: 'result', is_error: true, result: prompt + system }), 'claude host: result reported an error'],
    [JSON.stringify({ type: 'result', result: ' \n\t' }), 'claude host: empty output'],
    [JSON.stringify({ type: 'result' }), 'claude host: empty output'],
  ];
  for (const [stdout, message] of scenarios) {
    const stub = stubSpawn({ behavior(child) { child.stdout.end(stdout); child.stderr.end(prompt + system); child.emit('close', 0); } });
    await assert.rejects(stub.host.run(inputs), safeError(message));
    assertCleaned(stub.calls);
  }
});

test('Claude defaults to 180 seconds and cleans up a child that closes on SIGTERM', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stub = stubSpawn({ behavior() {} });
  const pending = stub.host.run(inputs);
  const checked = assert.rejects(pending, safeError('claude host: timed out after 180 s'));
  t.mock.timers.tick(179999);
  assert.deepEqual(stub.calls[0].signals, []);
  t.mock.timers.tick(1);
  await checked;
  assert.deepEqual(stub.calls[0].signals, ['SIGTERM']);
  assertCleaned(stub.calls);
});

test('Claude timeout override escalates to SIGKILL when SIGTERM is ignored', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stub = stubSpawn({ behavior() {}, closeOnKill: false });
  const pending = stub.host.run({ ...inputs, timeoutMs: 50 });
  const checked = assert.rejects(pending, safeError('claude host: timed out after 0.05 s'));
  t.mock.timers.tick(50);
  assert.deepEqual(stub.calls[0].signals, ['SIGTERM']);
  t.mock.timers.tick(999);
  assert.deepEqual(stub.calls[0].signals, ['SIGTERM']);
  t.mock.timers.tick(1);
  await checked;
  assert.deepEqual(stub.calls[0].signals, ['SIGTERM', 'SIGKILL']);
  assertCleaned(stub.calls);
});

test('Claude refuses invalid tools, timeouts, prompts and schemas before spawning', async () => {
  const stub = stubSpawn();
  const circular = {}; circular.self = circular;
  for (const changed of [
    { tools: 'all' }, { tools: undefined }, { model: '' }, { system: null }, { prompt: null },
    ...[0, -1, NaN, Infinity, 2147483648, '50'].map((timeoutMs) => ({ timeoutMs })),
    { outputSchema: circular }, { outputSchema: 1n },
  ]) await assert.rejects(stub.host.run({ ...inputs, ...changed }), /claude host:/);
  assert.equal(stub.calls.length, 0);
});
