'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');
const { main } = require('../bin/bunshin');
const pairs = require('../lib/pairs');
const split = require('../lib/split');
const store = require('../lib/store');

function pair(id = 'sample-1', overrides = {}) {
  return {
    id, source: 'manual', permalink: 'https://chat.example.invalid/thread/sample',
    channel: 'fictional-channel', asked_at: '2026-01-01T00:00:00Z',
    layer: 'knowledge', layer_source: 'auto',
    question: { author: 'fictional-colleague', text: 'What is the sample feature?' },
    context: [{ author: 'fictional-owner', text: 'A fictional context.' }],
    answer: { text: '架空の回答です。' }, harvested_at: '2026-01-02T00:00:00Z',
    ...overrides,
  };
}

async function command(dir, args, stdin = '') {
  let stdout = '';
  let stderr = '';
  const code = await main([...args, '--persona', dir], {
    env: { BUNSHIN_HOME: dir }, stdin,
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
  });
  return { code, stdout, stderr };
}

async function persona(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-pairs-'));
  t.after(() => { store._resetGuardCache(); fs.rmSync(root, { recursive: true, force: true }); });
  const previous = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  for (const key of Object.keys(previous)) {
    process.env[key] = path.join(root, key);
    fs.mkdirSync(process.env[key]);
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const io = { env: { BUNSHIN_HOME: root }, stdout: { write() {} }, stderr: { write() {} } };
  assert.equal(await main(['init', 'fictional-person'], io), 0);
  return path.join(root, 'fictional-person');
}

test('validatePair checks required shapes and enums without echoing content', () => {
  assert.deepEqual(pairs.validatePair(pair()), []);
  assert.deepEqual(pairs.validatePair(pair('slack-c123-123-456', { source: 'slack', format_version: 1 })), []);
  for (const value of [null, [], 'PRIVATE_TEXT', 1]) assert.ok(pairs.validatePair(value).length);
  for (const field of Object.keys(pair())) {
    const invalid = pair();
    delete invalid[field];
    assert.ok(pairs.validatePair(invalid).length, field);
  }
  for (const overrides of [
    { id: 'Bad_ID' }, { source: 'other' }, { layer: 'other' }, { layer_source: 'other' },
    { format_version: 2 }, { asked_at: 'invalid' }, { harvested_at: 42 },
    { question: { text: 'PRIVATE_TEXT' } }, { answer: { text: '' } },
    { context: [{}] }, { context: {} }, { channel: 1 },
  ]) {
    const errors = pairs.validatePair(pair('sample', overrides));
    assert.ok(errors.length);
    assert.ok(!errors.join(' ').includes('PRIVATE_TEXT'));
  }
});

test('add upserts and keeps manual labels while refreshing other fields', async (t) => {
  const dir = await persona(t);
  assert.deepEqual(pairs.addPairs(dir, [pair()]), { added: 1, updated: 0, kept_manual: 0 });
  assert.equal((await command(dir, ['pairs', 'label', 'sample-1', 'judgment'])).code, 0);
  const corrected = pairs.listPairs(dir, { set: 'all' })[0];
  assert.equal(corrected.layer, 'judgment');
  assert.equal(corrected.layer_source, 'manual');
  assert.deepEqual(pairs.addPairs(dir, [pair('sample-1', { answer: { text: 'New fictional answer' } }), pair('sample-2')]),
    { added: 1, updated: 1, kept_manual: 1 });
  assert.deepEqual(pairs.listPairs(dir, { set: 'all' })[0], {
    ...pair(), layer: 'judgment', layer_source: 'manual', answer: { text: 'New fictional answer' },
  });
  const before = store.readJsonl(dir, 'pairs.jsonl');
  assert.equal((await command(dir, ['pairs', 'label', 'missing', 'knowledge'])).code, 1);
  assert.deepEqual(store.readJsonl(dir, 'pairs.jsonl'), before);
});

test('add validates all lines, reports physical line numbers, and writes nothing on any error', async (t) => {
  const dir = await persona(t);
  pairs.addPairs(dir, [pair()]);
  const before = fs.readFileSync(path.join(dir, 'pairs.jsonl'), 'utf8');
  for (const invalid of ['PRIVATE_TEXT', JSON.stringify(pair('bad', { answer: { text: '' } }))]) {
    const output = await command(dir, ['pairs', 'add'], `${JSON.stringify(pair('sample-2'))}\n\n${invalid}\n`);
    assert.equal(output.code, 1);
    assert.match(output.stderr, /Line 3:/);
    assert.ok(!output.stderr.includes('PRIVATE_TEXT'));
    assert.equal(output.stdout, '');
    assert.equal(fs.readFileSync(path.join(dir, 'pairs.jsonl'), 'utf8'), before);
  }
  assert.throws(() => pairs.addPairs(dir, [pair('sample-2'), {}]), /item 2/);
  assert.equal(fs.readFileSync(path.join(dir, 'pairs.jsonl'), 'utf8'), before);
  const result = await command(dir, ['pairs', 'add'], Readable.from([Buffer.from(`${JSON.stringify(pair('sample-2'))}\n`)]));
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { added: 1, updated: 0, kept_manual: 0 });
  assert.equal(pairs.listPairs(dir, { set: 'all' })[1].answer.text, pair().answer.text);
});

test('split matches SHA-256 formula and retains assignments across repeats, additions and reharvest', async (t) => {
  const dir = await persona(t);
  const records = Array.from({ length: 60 }, (_, index) => pair(`sample-${index}`));
  pairs.addPairs(dir, records);
  const state = store.readJson(dir, 'split.json');
  state.salt = '0123456789abcdef';
  store.writeJson(dir, 'split.json', state);
  const result = split.assign(dir);
  assert.equal(result.new, records.length);
  assert.equal(result.build + result.heldout, records.length);
  assert.ok(result.build && result.heldout);
  const assigned = store.readJson(dir, 'split.json');
  for (const record of records) {
    const fraction = Number.parseInt(crypto.createHash('sha256').update(`${state.salt}:${record.id}`).digest('hex').slice(0, 8), 16) / 2 ** 32;
    assert.equal(split.setOf(dir, record.id), fraction < 0.3 ? 'heldout' : 'build');
  }
  assert.equal(split.setOf(dir, 'missing'), undefined);
  assert.deepEqual(split.assign(dir), { ...result, new: 0 });
  assert.deepEqual(store.readJson(dir, 'split.json'), assigned);
  pairs.addPairs(dir, [pair('sample-0'), pair('sample-new')]);
  assert.equal((await command(dir, ['split'])).code, 0);
  const later = store.readJson(dir, 'split.json');
  for (const [id, set] of Object.entries(assigned.assignments)) assert.equal(later.assignments[id], set);
  assert.equal(Object.keys(later.assignments).length, 61);
});

test('build list refuses unassigned pairs before any output and excludes held-out pairs', async (t) => {
  const dir = await persona(t);
  pairs.addPairs(dir, [pair('build-one'), pair('heldout-one')]);
  const state = store.readJson(dir, 'split.json');
  state.assignments = { 'build-one': 'build' };
  store.writeJson(dir, 'split.json', state);
  const missing = await command(dir, ['pairs', 'list', '--set', 'build', '--json']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /run `bunshin split` first/);
  assert.equal(missing.stdout, '');
  assert.equal((await command(dir, ['pairs', 'list', '--set', 'all', '--json'])).code, 0);
  state.assignments['heldout-one'] = 'heldout';
  store.writeJson(dir, 'split.json', state);
  for (const args of [['pairs', 'list'], ['pairs', 'list', '--set', 'build', '--json']]) {
    const output = await command(dir, args);
    assert.equal(output.code, 0);
    assert.match(output.stdout, /build-one/);
    assert.ok(!output.stdout.includes('heldout-one'));
  }
  assert.deepEqual(pairs.listPairs(dir, { set: 'heldout' }).map((entry) => entry.id), ['heldout-one']);
  const forbidden = await command(dir, ['pairs', 'list', '--set', 'heldout']);
  assert.equal(forbidden.code, 2);
  assert.equal(forbidden.stdout, '');
});

test('cases build writes exactly held-out cases sorted by id and regenerates corrected labels', async (t) => {
  const dir = await persona(t);
  const records = [pair('heldout-z'), pair('build-one'), pair('heldout-a')];
  pairs.addPairs(dir, records);
  assert.equal((await command(dir, ['cases', 'build'])).code, 1);
  assert.ok(!fs.existsSync(path.join(dir, 'cases.jsonl')));
  const state = store.readJson(dir, 'split.json');
  state.assignments = { 'heldout-z': 'heldout', 'build-one': 'build', 'heldout-a': 'heldout' };
  store.writeJson(dir, 'split.json', state);
  assert.equal((await command(dir, ['cases', 'build'])).code, 0);
  assert.deepEqual(store.readJsonl(dir, 'cases.jsonl'), [records[2], records[0]].map((entry) => ({
    id: entry.id, layer: entry.layer, question: entry.question, context: entry.context,
    reference_answer: entry.answer.text, permalink: entry.permalink,
  })));
  assert.equal((await command(dir, ['pairs', 'label', 'heldout-a', 'judgment'])).code, 0);
  assert.equal((await command(dir, ['cases', 'build'])).code, 0);
  assert.equal(store.readJsonl(dir, 'cases.jsonl')[0].layer, 'judgment');
  assert.deepEqual(store.readJson(dir, 'split.json'), state);
  state.assignments = Object.fromEntries(records.map((entry) => [entry.id, 'build']));
  store.writeJson(dir, 'split.json', state);
  assert.equal((await command(dir, ['cases', 'build'])).code, 0);
  assert.deepEqual(store.readJsonl(dir, 'cases.jsonl'), []);
});

test('malformed split refuses reads and assignments without changing files', async (t) => {
  const dir = await persona(t);
  pairs.addPairs(dir, [pair()]);
  const original = store.readJson(dir, 'split.json');
  for (const change of [{ assignments: { 'sample-1': 'unknown' } }, { heldout_ratio: 2 }, { salt: null }, { assignments: [] }, { format_version: 2 }]) {
    const invalid = { ...original, ...change };
    store.writeJson(dir, 'split.json', invalid);
    assert.throws(() => split.assign(dir), /Invalid split.json/);
    assert.throws(() => pairs.listPairs(dir, { set: 'build' }), /Invalid split.json/);
    assert.deepEqual(store.readJson(dir, 'split.json'), invalid);
  }
});

test('CLI rejects unsupported arguments without writes', async (t) => {
  const dir = await persona(t);
  for (const args of [
    ['pairs'], ['pairs', 'add', 'extra'], ['pairs', 'list', '--set'],
    ['pairs', 'list', '--json', '--json'], ['pairs', 'label', 'sample-1', 'other'],
    ['split', 'extra'], ['cases'], ['cases', 'build', 'extra'],
    ['split', '--persona'],
  ]) {
    const output = await command(dir, args);
    assert.equal(output.code, 2, args.join(' '));
    assert.equal(output.stdout, '');
  }
  assert.deepEqual(fs.readdirSync(dir).sort(), ['persona.json', 'split.json']);
});
