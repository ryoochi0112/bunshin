'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Readable } = require('node:stream');
const test = require('node:test');
const shadow = require('../lib/shadow');
const command = require('../lib/commands/shadow');
const store = require('../lib/store');
const twin = require('../lib/twin');
const judge = require('../lib/judge');
const hosts = require('../lib/hosts');

const root = path.join(__dirname, '..');
const owner = 'U_SYNTHETIC_OWNER';
const canary = 'Synthetic real answer canary: never reveal this full text to the drafter.';
const message = (author, ts, text) => ({ author, ts, text });
const thread = { permalink: 'https://example.invalid/thread', messages: [
  message('U_COLLEAGUE', '1.1', 'Earlier synthetic context.'),
  message('U_COLLEAGUE', '2.2', 'Does the synthetic report include small teams?'),
  message(owner, '3.3', canary),
] };

function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-shadow-')));
  const dir = path.join(home, 'fictional');
  fs.cpSync(path.join(root, 'sample', 'persona'), dir, { recursive: true });
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); store._resetGuardCache(); });
  return { home, dir };
}

function setOwner(dir, value) {
  if (arguments.length === 1) value = owner;
  const persona = store.readJson(dir, 'persona.json');
  store.writeJson(dir, 'persona.json', { ...persona, owner: { slack_user_id: value } });
}

function recording(fail = false) {
  const calls = [];
  return { calls, get(host) { return { async run(input) {
    calls.push({ host, ...input });
    if (fail) throw new Error(canary);
    return { text: `Synthetic draft ${calls.length}.`, model: 'adapter-returned', raw: {} };
  } }; } };
}

async function cli(args, extra = {}) {
  let stdout = '';
  let stderr = '';
  const code = await command.run(args, { env: {}, ...extra,
    stdout: { write(text) { stdout += text; } }, stderr: { write(text) { stderr += text; } },
  });
  return { code, stdout, stderr };
}

test('splitThread sorts numerically and stably, chooses the last question before the first owner and joins all owner replies', () => {
  const messages = [message(owner, '10', 'First reply.'), message('colleague', 20, 'Later question excluded.'),
    message('context', 1, 'Context.'), message(owner, 30, 'Second reply.'),
    message('first', '2', 'Earlier question.'), message('last', 2, 'Chosen question.')];
  const original = JSON.stringify(messages);
  assert.deepEqual(shadow.splitThread({ messages }, owner), {
    question: { author: 'last', text: 'Chosen question.' },
    context: [{ author: 'context', text: 'Context.' }, { author: 'first', text: 'Earlier question.' }],
    answer: 'First reply.\n\nSecond reply.',
  });
  assert.equal(JSON.stringify(messages), original);
  assert.deepEqual(shadow.splitThread({ messages: [message('other', 1, 'Same timestamp question.'),
    message(owner, 1, 'Same timestamp answer.')] }, owner), {
    question: { author: 'other', text: 'Same timestamp question.' }, context: [], answer: 'Same timestamp answer.',
  });
});

test('splitThread without an owner picks the last non-owner and refuses threads with no prior question', () => {
  assert.deepEqual(shadow.splitThread({ messages: [message('a', 10, 'Last.'), message('b', 2, 'First.')] }, owner), {
    question: { author: 'a', text: 'Last.' }, context: [{ author: 'b', text: 'First.' }], answer: null,
  });
  for (const messages of [[message(owner, 1, 'Only owner.')],
    [message(owner, 1, 'Owner first.'), message('other', 2, 'Too late.')],
    [message(owner, 1, 'Owner first.'), message('other', 1, 'Equal but later.')]]) {
    assert.throws(() => shadow.splitThread({ messages }, owner), /^Error: shadow: thread has no question from someone else$/);
  }
});

test('splitThread rejects every invalid messages, author, text and timestamp branch without echoing text', () => {
  for (const value of [undefined, null, {}, { messages: null }, { messages: {} }, { messages: [] }]) {
    assert.throws(() => shadow.splitThread(value, owner), /invalid thread messages/);
  }
  const good = message('other', 1, canary);
  for (const bad of [null, 3, {}, { ...good, author: undefined }, { ...good, author: 1 },
    { ...good, text: undefined }, { ...good, text: 1 }, { ...good, ts: undefined },
    { ...good, ts: null }, { ...good, ts: true }, { ...good, ts: '' }, { ...good, ts: '   ' },
    { ...good, ts: 'junk1' }, { ...good, ts: '1junk' }, { ...good, ts: 'Infinity' },
    { ...good, ts: Infinity }, { ...good, ts: NaN }]) {
    assert.throws(() => shadow.splitThread({ messages: [bad] }, owner), (error) => {
      assert.match(error.message, /^shadow: invalid thread message$/);
      assert.ok(!error.message.includes(canary));
      return true;
    });
  }
  for (const missing of [undefined, null, '', ' ', 3]) {
    assert.throws(() => shadow.splitThread(thread, missing), /owner.slack_user_id is not set/);
  }
});

test('new persists exact question and answer shapes; owner comes only from owner.slack_user_id', async (t) => {
  const { dir } = fixture(t);
  setOwner(dir);
  const result = await cli(['new', '--layer', 'knowledge', '--thread-json', '-', '--persona', dir],
    { stdin: Readable.from([JSON.stringify(thread).slice(0, 20), JSON.stringify(thread).slice(20)]) });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  const id = result.stdout.trim();
  assert.match(id, /^\d{4}-\d{2}-\d{2}-01$/);
  const stored = store.readJson(dir, `shadow/${id}/question.json`);
  assert.deepEqual(stored, { format_version: 1, id, layer: 'knowledge', permalink: thread.permalink,
    question: { author: 'U_COLLEAGUE', text: thread.messages[1].text },
    context: [{ author: 'U_COLLEAGUE', text: thread.messages[0].text }], created_at: stored.created_at });
  assert.ok(Number.isFinite(Date.parse(stored.created_at)));
  assert.deepEqual(store.readJson(dir, `shadow/${id}/answer.json`), { format_version: 1, id, text: canary });
  const persona = store.readJson(dir, 'persona.json');
  store.writeJson(dir, 'persona.json', { ...persona, owner: { slack_user_id: 'ANOTHER_OWNER' }, slack_user_id: owner });
  const next = shadow.create(dir, { layer: 'judgment', thread });
  assert.equal(fs.existsSync(path.join(dir, 'shadow', next, 'answer.json')), false);
  assert.deepEqual(store.readJson(dir, `shadow/${next}/question.json`).question, { author: owner, text: canary });
});

test('question-file supports stdin and a file, optional answers, local date and sequences beyond 99', async (t) => {
  const { dir, home } = fixture(t);
  const result = await cli(['new', '--layer', 'judgment', '--question-file', '-', '--persona', dir], { stdin: 'Synthetic manual question.' });
  assert.equal(result.code, 0, result.stderr);
  const id = result.stdout.trim();
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  assert.equal(id, `${date}-01`);
  const stored = store.readJson(dir, `shadow/${id}/question.json`);
  assert.deepEqual({ question: stored.question, context: stored.context, permalink: stored.permalink },
    { question: { author: null, text: 'Synthetic manual question.' }, context: [], permalink: null });
  assert.equal(fs.existsSync(path.join(dir, 'shadow', id, 'answer.json')), false);
  for (const name of [`junk${date}-999`, `${date}-999junk`, `${date}-1`]) {
    fs.mkdirSync(path.join(dir, 'shadow', name));
  }
  fs.mkdirSync(path.join(dir, 'shadow', `${date}-99`));
  const questionFile = path.join(home, 'input.txt');
  const answerFile = path.join(home, 'reply.txt');
  fs.writeFileSync(questionFile, 'Synthetic file question.');
  fs.writeFileSync(answerFile, '');
  const next = await cli(['new', '--layer', 'knowledge', '--question-file', questionFile, '--answer-file', answerFile, '--persona', dir]);
  assert.deepEqual(next, { code: 0, stdout: `${date}-100\n`, stderr: '' });
  assert.deepEqual(store.readJson(dir, `shadow/${date}-100/answer.json`), { format_version: 1, id: `${date}-100`, text: '' });
});

test('new refuses missing owner, malformed JSON, empty questions and bad thread shapes without writing', async (t) => {
  for (const missing of [null, '', ' ', undefined, 3]) {
    const { dir } = fixture(t);
    setOwner(dir, missing);
    const persona = store.readJson(dir, 'persona.json');
    store.writeJson(dir, 'persona.json', { ...persona, slack_user_id: owner, owner_id: owner });
    const result = await cli(['new', '--layer', 'knowledge', '--thread-json', '-', '--persona', dir], { stdin: JSON.stringify(thread) });
    assert.deepEqual(result, { code: 1, stdout: '', stderr: 'shadow: owner.slack_user_id is not set in persona.json\n' });
    assert.equal(fs.existsSync(path.join(dir, 'shadow')), false);
  }
  const { dir } = fixture(t);
  setOwner(dir);
  for (const input of [canary, `{\"text\":\"${canary}\"`, 'null', '{}', JSON.stringify({ messages: [] }),
    JSON.stringify({ messages: [message(owner, 1, canary)] }),
    JSON.stringify({ messages: [message('other', 1, '   ')] })]) {
    const result = await cli(['new', '--layer', 'knowledge', '--thread-json', '-', '--persona', dir], { stdin: input });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.ok(!result.stderr.includes(canary));
    assert.equal(fs.existsSync(path.join(dir, 'shadow')), false);
  }
  for (const text of ['', ' \n\t']) {
    const result = await cli(['new', '--layer', 'judgment', '--question-file', '-', '--persona', dir], { stdin: text });
    assert.deepEqual(result, { code: 1, stdout: '', stderr: 'shadow: question text is empty\n' });
  }
  assert.equal(fs.existsSync(path.join(dir, 'shadow')), false);
});

test('CLI usage pins every option refusal', async () => {
  for (const args of [[], ['missing'], ['new'], ['new', '--layer', 'bad', '--question-file', '-'],
    ['new', '--question-file', '-'], ['new', '--layer', 'knowledge'],
    ['new', '--layer', 'knowledge', '--thread-json', '-', '--question-file', '-'],
    ['new', '--layer', 'knowledge', '--thread-json', '-', '--answer-file', 'reply.txt'],
    ['new', '--layer', 'knowledge', '--question-file', '-', '--answer-file', '-'],
    ['new', '--layer'], ['new', '--layer', '--question-file'], ['new', '--unknown', 'value'],
    ['new', '--layer', 'knowledge', '--layer', 'judgment'], ['new', 'extra'],
    ['show', '2026-01-01-01', 'constructor', 'value'], ['show', '2026-01-01-01', 'toString', 'value'],
    ['show', '2026-01-01-01', '--drafter', 'fake'], ['draft', '2026-01-01-01', '--persona'],
    ['show', '2026-01-01-01', '--persona', 'a', '--persona', 'b']]) {
    const result = await cli(args);
    assert.equal(result.code, 2, JSON.stringify(args));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^Usage: bunshin shadow new/);
  }
});

test('draft and show reject invalid ids before filesystem access, including both regex anchors', async (t) => {
  const { dir } = fixture(t);
  const calls = [];
  const original = store.resolvePersona;
  for (const id of [null, 3, {}, [], '2026-01-01-01\r', '2026-01-01-01\u2028', '2026-01-01-01\u2029']) {
    assert.throws(() => shadow.validateId(id), /shadow: unknown id/);
  }
  store.resolvePersona = (opts) => { calls.push(opts); return original(opts); };
  try {
    for (const id of [undefined, '../escape', '/tmp/escape', 'x2026-01-01-01', '2026-01-01-01x',
      '2026-01-01-01\n', '026-01-01-01', '20260-01-01-01', '2026-1-01-01', '2026-01-1-01',
      '2026-01-01-1', '2026/01-01-01']) {
      for (const action of ['draft', 'show']) {
        assert.throws(() => shadow.validateId(id), /shadow: unknown id/);
        const result = await cli(id === undefined ? [action] : [action, id, '--persona', dir]);
        assert.deepEqual(result, { code: 1, stdout: '', stderr: 'shadow: unknown id\n' });
      }
    }
    assert.equal(calls.length, 0);
  } finally { store.resolvePersona = original; }
  for (const action of ['draft', 'show']) {
    assert.deepEqual(await cli([action, '2099-01-01-01', '--persona', dir]),
      { code: 1, stdout: '', stderr: 'shadow: unknown id\n' });
  }
});

test('draft reads no answer, strips frontmatter, shares eval input and allowlist, and overwrites with returned model', async (t) => {
  const { dir } = fixture(t);
  setOwner(dir);
  assert.ok(canary.length >= 24);
  for (const layer of ['knowledge', 'judgment']) {
    const id = shadow.create(dir, { layer, thread });
    const adapters = recording();
    const reads = [];
    const read = fs.readFileSync;
    fs.readFileSync = (file, ...args) => { reads.push(String(file)); return read(file, ...args); };
    let result;
    try { result = await shadow.draft(dir, id, { drafter: 'fake:requested-model', hosts: adapters }); }
    finally { fs.readFileSync = read; }
    assert.ok(reads.some((file) => file.endsWith(`/shadow/${id}/question.json`)));
    assert.ok(!reads.some((file) => file.endsWith('answer.json')));
    assert.equal(adapters.calls.length, 1);
    const input = adapters.calls[0];
    assert.equal(input.host, 'fake');
    assert.equal(input.model, 'requested-model');
    assert.equal(input.tools, 'notion-read');
    assert.deepEqual(input.allowedTools, hosts.allowedTools(store.readJson(dir, 'persona.json')));
    assert.equal(input.system, twin.composePrompt(dir, twin.skillForLayer(layer)));
    assert.doesNotMatch(input.system, /^(?:---|name:|description:)/m);
    assert.equal(input.prompt, judge.questionPrompt(shadow.splitThread(thread, owner)));
    for (const field of Object.values(input)) assert.ok(!JSON.stringify(field).includes(canary));
    assert.ok(!input.prompt.includes(thread.permalink));
    assert.deepEqual(result, { format_version: 1, id, layer, skill: twin.skillForLayer(layer),
      draft: 'Synthetic draft 1.', drafter: { host: 'fake', model: 'adapter-returned' }, at: result.at });
    assert.ok(Number.isFinite(Date.parse(result.at)));
    assert.deepEqual(store.readJson(dir, `shadow/${id}/draft.json`), result);
    await shadow.draft(dir, id, { drafter: 'fake', hosts: adapters });
    assert.equal(store.readJson(dir, `shadow/${id}/draft.json`).draft, 'Synthetic draft 2.');
  }
});

test('in-process draft defaults to claude through injection; host failures redact text and write no draft', async (t) => {
  const { dir } = fixture(t);
  const id = shadow.create(dir, { layer: 'judgment', question: 'Synthetic idea question.' });
  const failed = recording(true);
  const result = await cli(['draft', id, '--persona', dir], { hosts: failed });
  assert.deepEqual(result, { code: 1, stdout: '', stderr: 'shadow draft: host error (claude)\n' });
  assert.equal(failed.calls.length, 1);
  assert.equal(failed.calls[0].host, 'claude');
  assert.equal(failed.calls[0].model, undefined);
  assert.equal(fs.existsSync(path.join(dir, 'shadow', id, 'draft.json')), false);
  const adapters = recording();
  assert.deepEqual(await cli(['draft', id, '--persona', dir], { hosts: adapters }),
    { code: 0, stdout: 'Synthetic draft 1.\n', stderr: '' });
  const before = fs.readFileSync(path.join(dir, 'shadow', id, 'draft.json'), 'utf8');
  await cli(['draft', id, '--persona', dir], { hosts: failed });
  assert.equal(fs.readFileSync(path.join(dir, 'shadow', id, 'draft.json'), 'utf8'), before);
});

test('draft preflight errors spend no host calls or writes', async (t) => {
  for (const kind of ['spec', 'allowlist', 'identity']) {
    const { dir } = fixture(t);
    const id = shadow.create(dir, { layer: 'knowledge', question: 'Synthetic question.' });
    if (kind === 'allowlist') {
      const persona = store.readJson(dir, 'persona.json');
      persona.hosts.claude.allowed_tools = ['mcp__Slack__read'];
      store.writeJson(dir, 'persona.json', persona);
    }
    if (kind === 'identity') fs.unlinkSync(path.join(dir, 'identity.md'));
    const adapters = recording();
    await assert.rejects(shadow.draft(dir, id, { drafter: kind === 'spec' ? 'unknown' : 'fake', hosts: adapters }));
    assert.equal(adapters.calls.length, 0);
    assert.equal(fs.existsSync(path.join(dir, 'shadow', id, 'draft.json')), false);
  }
});

test('show has exact headings and ordering, with optional draft, permalink and real answer', async (t) => {
  const { dir } = fixture(t);
  setOwner(dir);
  const id = shadow.create(dir, { layer: 'knowledge', thread });
  const prefix = `## Question\n${thread.messages[1].text}\n${thread.permalink}\n\n## Twin draft\n`;
  assert.deepEqual(await cli(['show', id, '--persona', dir]), { code: 0, stderr: '',
    stdout: `${prefix}(no draft yet — run shadow draft ${id})\n\n## Real answer\n${canary}\n` });
  await shadow.draft(dir, id, { drafter: 'fake', hosts: recording() });
  assert.equal(shadow.show(dir, id), `${prefix}Synthetic draft 1.\n\n## Real answer\n${canary}\n`);
  const manual = shadow.create(dir, { layer: 'judgment', question: 'Manual question.' });
  assert.equal(shadow.show(dir, manual), `## Question\nManual question.\n\n## Twin draft\n(no draft yet — run shadow draft ${manual})\n`);
  await shadow.draft(dir, manual, { drafter: 'fake', hosts: recording() });
  assert.deepEqual(await cli(['show', manual, '--persona', dir]), { code: 0, stderr: '',
    stdout: '## Question\nManual question.\n\n## Twin draft\nSynthetic draft 1.\n' });
});

test('question is written first, interruption is usable, and all engine writes use store under shadow', async (t) => {
  const { dir } = fixture(t);
  setOwner(dir);
  const writes = [];
  const original = store.writeJson;
  store.writeJson = (personaDir, file, value, opts) => {
    writes.push({ personaDir, file });
    if (file.endsWith('/answer.json')) throw new Error('Synthetic interrupted answer write.');
    return original(personaDir, file, value, opts);
  };
  let id;
  try {
    assert.throws(() => shadow.create(dir, { layer: 'knowledge', thread }), /interrupted answer write/);
    id = fs.readdirSync(path.join(dir, 'shadow'))[0];
    assert.ok(!shadow.show(dir, id).includes('## Real answer'));
    await shadow.draft(dir, id, { drafter: 'fake', hosts: recording() });
  } finally { store.writeJson = original; }
  assert.deepEqual(writes.map(({ file }) => file), [`shadow/${id}/question.json`, `shadow/${id}/answer.json`, `shadow/${id}/draft.json`]);
  assert.ok(writes.every(({ personaDir, file }) => personaDir === dir && file.startsWith('shadow/')));
  assert.deepEqual(fs.readdirSync(path.join(dir, 'shadow', id)).sort(), ['draft.json', 'question.json']);
});

test('engine and command import no outbound modules and contain no direct writers', () => {
  for (const file of ['lib/shadow.js', 'lib/commands/shadow.js']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(source, /require\s*\(\s*['"](?:node:)?(?:child_process|http|https|net|dgram|tls)['"]\s*\)/);
    assert.doesNotMatch(source, /fs\.(?:write|append|mkdir|rename|copy|cp|createWriteStream)/);
  }
});

test('engine refuses empty or absent manual questions and unknown layers before writing', (t) => {
  const { dir } = fixture(t);
  for (const question of [undefined, null, 3, '', ' \n']) {
    assert.throws(() => shadow.create(dir, { layer: 'knowledge', question }), /shadow: question text is empty/);
  }
  assert.throws(() => shadow.create(dir, { layer: 'other', question: 'Synthetic question.' }), /Unknown twin layer/);
  assert.equal(fs.existsSync(path.join(dir, 'shadow')), false);
});

test('malformed persisted JSON is refused with file-only errors; shadow writes cannot escape via symlinks', async (t) => {
  const { dir, home } = fixture(t);
  const id = shadow.create(dir, { layer: 'knowledge', question: 'Synthetic question.' });
  for (const file of ['answer.json', 'draft.json', 'question.json']) {
    const target = path.join(dir, 'shadow', id, file);
    fs.writeFileSync(target, canary);
    const result = await cli(['show', id, '--persona', dir]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Invalid JSON in/);
    assert.ok(!result.stderr.includes(canary));
    if (file !== 'question.json') fs.unlinkSync(target);
  }
  const escaped = path.join(home, 'outside');
  fs.mkdirSync(escaped);
  const other = fixture(t).dir;
  fs.symlinkSync(escaped, path.join(other, 'shadow'));
  assert.throws(() => shadow.create(other, { layer: 'knowledge', question: 'Synthetic question.' }), /stay inside the persona directory/);
  assert.deepEqual(fs.readdirSync(escaped), []);
});

test('spawned CLI exercises all subcommands with temp BUNSHIN_HOME, thread file and stdin question', (t) => {
  const { dir, home } = fixture(t);
  setOwner(dir);
  const env = { ...process.env, BUNSHIN_HOME: home };
  delete env.BUNSHIN_PERSONA;
  const run = (args, input) => spawnSync(process.execPath, [path.join(root, 'bin', 'bunshin.js'), 'shadow', ...args],
    { cwd: root, env, input, encoding: 'utf8', timeout: 10000 });
  // Keep input files inside the persona so BUNSHIN_HOME has exactly one directory.
  const threadFile = path.join(dir, 'input.txt');
  fs.writeFileSync(threadFile, JSON.stringify(thread));
  const created = run(['new', '--layer', 'knowledge', '--thread-json', threadFile]);
  assert.equal(created.status, 0, created.stderr);
  assert.equal(created.stderr, '');
  const id = created.stdout.trim();
  const drafted = run(['draft', id, '--drafter', 'fake']);
  assert.equal(drafted.status, 0, drafted.stderr);
  assert.equal(drafted.stderr, '');
  assert.equal(drafted.stdout, 'I do not know.\nSources: none\n');
  const shown = run(['show', id]);
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(shown.stderr, '');
  assert.equal(shown.stdout, `## Question\n${thread.messages[1].text}\n${thread.permalink}\n\n## Twin draft\nI do not know.\nSources: none\n\n## Real answer\n${canary}\n`);
  const manual = run(['new', '--layer', 'judgment', '--question-file', '-'], 'Synthetic stdin question.');
  assert.equal(manual.status, 0, manual.stderr);
  assert.equal(manual.stderr, '');
  assert.equal(fs.existsSync(path.join(dir, 'shadow', manual.stdout.trim(), 'answer.json')), false);
  const bad = run(['new', '--layer', 'knowledge', '--thread-json', '-'], canary);
  assert.equal(bad.status, 1);
  assert.equal(bad.stderr, 'shadow: invalid thread JSON\n');
  assert.equal(bad.stdout, '');
});
