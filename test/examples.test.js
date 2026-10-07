'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const store = require('../lib/store');
const judge = require('../lib/judge');
const examples = require('../lib/examples');
const root = path.join(__dirname, '..');
const seed = '0123456789abcdef';
const at = '2026-10-07T00:00:00.000Z';

function setup(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-examples-')));
  const dir = path.join(home, 'fictional');
  fs.cpSync(path.join(root, 'sample/persona'), dir, { recursive: true });
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); store._resetGuardCache(); });
  return { home, dir };
}
function row(pair, position) {
  return { pair_id: pair.id, layer: pair.layer, position, question: pair.question, context: pair.context, reference_answer: pair.answer.text, draft: `Draft for ${pair.id}.`, drafter: { host: 'fake', model: null }, drafted_at: at };
}
function writeSet(dir, n = 12) {
  const chosen = examples.selectSet(dir, { seed, n });
  store.writeJson(dir, 'judge-examples/set.json', { format_version: 1, seed, n, pair_ids: chosen.map((pair) => pair.id), drafter: { host: 'fake', model: null }, created_at: at });
  store.writeJsonl(dir, 'judge-examples/examples.jsonl', chosen.map((pair, i) => row(pair, i + 1)));
  return chosen;
}
function rate(dir, ids, rating = 'send_as_is') {
  for (const id of ids) store.appendJsonl(dir, 'judge-examples/ratings.jsonl', { pair_id: id, rating, rated_at: at });
}

test('constants and pairChars count question, context text and author, and answer', () => {
  assert.equal(examples.DEFAULT_N, 12);
  assert.equal(examples.MAX_PAIR_CHARS, 4000);
  assert.equal(examples.DIR, 'judge-examples');
  assert.equal(examples.pairChars({ question: { author: 'zzzzzzzzzz', text: 'abc' }, context: [{ author: 'de', text: 'fgh' }, { author: 'i', text: '' }], answer: { text: 'jklm' } }), 3 + 2 + 3 + 1 + 0 + 4);
});

test('selectSet picks build pairs only, interleaves layers, and refuses a shortfall', (t) => {
  const { dir } = setup(t);
  const assignments = store.readJson(dir, 'split.json').assignments;
  const twelve = examples.selectSet(dir, { seed, n: 12 });
  assert.equal(twelve.length, 12);
  assert.equal(twelve.filter((p) => p.layer === 'knowledge').length, 6);
  assert.equal(twelve.filter((p) => p.layer === 'judgment').length, 6);
  for (const pair of twelve) assert.equal(assignments[pair.id], 'build');
  for (const id of ['sample-10', 'sample-12', 'sample-13']) assert.ok(!twelve.some((p) => p.id === id), id);
  assert.deepEqual(twelve.map((p) => p.layer), Array.from({ length: 12 }, (_, i) => (i % 2 ? 'judgment' : 'knowledge')));
  assert.ok(twelve[0].question && twelve[0].answer, 'returns full pairs');
  assert.deepEqual(examples.selectSet(dir, { seed, n: 12 }), twelve);
  assert.notDeepEqual(examples.selectSet(dir, { seed: 'fedcba9876543210', n: 12 }).map((p) => p.id), twelve.map((p) => p.id));
  const thirteen = examples.selectSet(dir, { seed, n: 13 });
  assert.equal(thirteen.filter((p) => p.layer === 'knowledge').length, 7);
  assert.equal(thirteen.filter((p) => p.layer === 'judgment').length, 6);
  assert.throws(() => examples.selectSet(dir, { seed, n: 14 }), { message: 'examples: only 13 eligible build pairs; need 14' });
});

test('eligible excludes oversized pairs and counts them in skipped', (t) => {
  const { dir } = setup(t);
  assert.equal(examples.eligible(dir).skipped, 0);
  assert.equal(examples.eligible(dir).pairs.length, 13);
  const pairs = store.readJsonl(dir, 'pairs.jsonl');
  const exact = pairs.find((p) => p.id === 'sample-01');
  exact.answer.text += 'x'.repeat(examples.MAX_PAIR_CHARS - examples.pairChars(exact));
  const over = pairs.find((p) => p.id === 'sample-02');
  over.context[0].author += 'y'.repeat(examples.MAX_PAIR_CHARS - examples.pairChars(over) + 1);
  const held = pairs.find((p) => p.id === 'sample-10');
  held.answer.text += 'z'.repeat(examples.MAX_PAIR_CHARS);
  store.writeJsonl(dir, 'pairs.jsonl', pairs);
  const result = examples.eligible(dir);
  assert.equal(result.skipped, 1);
  assert.equal(result.pairs.length, 12);
  assert.ok(result.pairs.some((p) => p.id === 'sample-01'));
  assert.ok(!result.pairs.some((p) => p.id === 'sample-02'));
  assert.ok(!examples.selectSet(dir, { seed, n: 12 }).some((p) => p.id === 'sample-02'));
  assert.throws(() => examples.selectSet(dir, { seed, n: 13 }), { message: 'examples: only 12 eligible build pairs; need 13' });
});

test('readSet is null when absent and reports status', (t) => {
  const { dir } = setup(t);
  assert.equal(examples.readSet(dir), null);
  assert.equal(examples.ready(dir), null);
  const chosen = writeSet(dir);
  rate(dir, [chosen[0].id], 'wrong');
  rate(dir, [chosen[0].id, chosen[1].id], 'needs_edits');
  const state = examples.readSet(dir);
  assert.equal(state.set.n, 12);
  assert.deepEqual(state.examples.map((e) => e.position), Array.from({ length: 12 }, (_, i) => i + 1));
  assert.equal(state.ratings[chosen[0].id].rating, 'needs_edits');
  assert.deepEqual(state.status, { n: 12, drafted: 12, rated: 2, unrated: chosen.slice(2).map((p) => p.id), labels: { send_as_is: 0, needs_edits: 2, wrong: 0 } });
});

test('readSet sorts examples by position', (t) => {
  const { dir } = setup(t);
  const chosen = writeSet(dir);
  store.writeJsonl(dir, 'judge-examples/examples.jsonl', chosen.map((pair, i) => row(pair, i + 1)).reverse());
  assert.deepEqual(examples.readSet(dir).examples.map((e) => e.pair_id), chosen.map((p) => p.id));
});

test('readSet rejects held-out and unassigned example ids', (t) => {
  const { dir } = setup(t);
  const chosen = writeSet(dir);
  const pairs = store.readJsonl(dir, 'pairs.jsonl');
  const rows = chosen.map((pair, i) => row(pair, i + 1));
  const good = store.readJson(dir, 'judge-examples/set.json');
  // The set pins the id, so only the build-split check can reject it.
  const pin = (id) => store.writeJson(dir, 'judge-examples/set.json', { ...good, pair_ids: [...good.pair_ids.slice(0, 11), id] });
  pin('sample-10');
  rows[11] = row(pairs.find((p) => p.id === 'sample-10'), 12);
  store.writeJsonl(dir, 'judge-examples/examples.jsonl', rows);
  assert.throws(() => examples.readSet(dir), { message: 'examples: pair sample-10 is not in the build split' });
  pin('sample-99');
  rows[11] = { ...row(chosen[11], 12), pair_id: 'sample-99' };
  store.writeJsonl(dir, 'judge-examples/examples.jsonl', rows);
  assert.throws(() => examples.readSet(dir), { message: 'examples: pair sample-99 is not in the build split' });
});

test('readSet rejects invalid sets, examples and ratings', (t) => {
  const { dir } = setup(t);
  const chosen = writeSet(dir);
  const good = store.readJson(dir, 'judge-examples/set.json');
  for (const bad of [{ format_version: 2 }, { seed: 'xyz' }, { n: 0 }, { n: 1.5 }, { drafter: { host: 'fake' } }, { created_at: 'yesterday' }]) {
    store.writeJson(dir, 'judge-examples/set.json', { ...good, ...bad });
    assert.throws(() => examples.readSet(dir), { message: 'examples: invalid example set' }, JSON.stringify(bad));
  }
  store.writeJson(dir, 'judge-examples/set.json', good);
  const base = row(chosen[0], 1);
  for (const bad of [{ pair_id: 'Bad Id' }, { position: 0 }, { position: 13 }, { layer: 'other' }, { question: { author: 'a', text: '' } }, { context: 'x' }, { reference_answer: '' }, { draft: '' }, { drafter: null }, { drafted_at: 'soon' }]) {
    assert.ok(examples.validateExample({ ...base, ...bad }).length || bad.position === 13, JSON.stringify(bad));
    store.writeJsonl(dir, 'judge-examples/examples.jsonl', [{ ...base, ...bad }]);
    assert.throws(() => examples.readSet(dir), { message: 'examples: invalid example' }, JSON.stringify(bad));
  }
  assert.deepEqual(examples.validateExample(base), []);
  store.writeJsonl(dir, 'judge-examples/examples.jsonl', [base, { ...row(chosen[1], 1) }]);
  assert.throws(() => examples.readSet(dir), { message: 'examples: invalid example' });
  store.writeJsonl(dir, 'judge-examples/examples.jsonl', [base, { ...base, position: 2 }]);
  assert.throws(() => examples.readSet(dir), { message: 'examples: invalid example' });
  store.writeJsonl(dir, 'judge-examples/examples.jsonl', [base]);
  assert.deepEqual(examples.validateRating({ pair_id: base.pair_id, rating: 'wrong', rated_at: at }), []);
  for (const bad of [{ rating: 'judge_error' }, { rated_at: 'now' }, { pair_id: chosen[1].id }]) {
    store.writeJsonl(dir, 'judge-examples/ratings.jsonl', [{ pair_id: base.pair_id, rating: 'wrong', rated_at: at, ...bad }]);
    assert.throws(() => examples.readSet(dir), { message: 'examples: invalid example rating' }, JSON.stringify(bad));
  }
});

test('readSet rejects a set.json whose pair_ids are missing, short, long, duplicated or malformed', (t) => {
  const { dir } = setup(t);
  const chosen = writeSet(dir);
  const good = store.readJson(dir, 'judge-examples/set.json');
  assert.deepEqual(good.pair_ids, chosen.map((p) => p.id));
  const { pair_ids: _omitted, ...without } = good;
  const bads = {
    missing: without,
    short: { ...good, pair_ids: good.pair_ids.slice(0, 11) },
    long: { ...good, pair_ids: [...good.pair_ids, 'sample-16'] },
    duplicate: { ...good, pair_ids: [...good.pair_ids.slice(0, 11), good.pair_ids[0]] },
    'bad id': { ...good, pair_ids: [...good.pair_ids.slice(0, 11), 'Bad Id'] },
    'non-string id': { ...good, pair_ids: [...good.pair_ids.slice(0, 11), 7] },
    'not an array': { ...good, pair_ids: good.pair_ids.join(',') },
  };
  for (const [name, bad] of Object.entries(bads)) {
    store.writeJson(dir, 'judge-examples/set.json', bad);
    assert.throws(() => examples.readSet(dir), { message: 'examples: invalid example set' }, name);
  }
  store.writeJson(dir, 'judge-examples/set.json', good);
  assert.equal(examples.readSet(dir).examples.length, 12);
});

test('readSet rejects an example whose pair_id is not set.pair_ids[position - 1]', (t) => {
  const { dir } = setup(t);
  const chosen = writeSet(dir);
  const rows = chosen.map((pair, i) => row(pair, i + 1));
  const spare = examples.eligible(dir).pairs.find((p) => !chosen.some((c) => c.id === p.id));
  // A build pair that is not pinned at all.
  store.writeJsonl(dir, 'judge-examples/examples.jsonl', [...rows.slice(0, 11), row(spare, 12)]);
  assert.throws(() => examples.readSet(dir), { message: 'examples: invalid example' });
  // A pinned id at the wrong position (swap 1 and 2).
  store.writeJsonl(dir, 'judge-examples/examples.jsonl', [row(chosen[1], 1), row(chosen[0], 2)]);
  assert.throws(() => examples.readSet(dir), { message: 'examples: invalid example' });
  store.writeJsonl(dir, 'judge-examples/examples.jsonl', rows);
  assert.equal(examples.readSet(dir).examples.length, 12);
});

test('ready refuses incomplete sets and returns rated rows', (t) => {
  const { dir } = setup(t);
  const chosen = writeSet(dir);
  const all = store.readJsonl(dir, 'judge-examples/examples.jsonl');
  store.writeJsonl(dir, 'judge-examples/examples.jsonl', all.slice(0, 11));
  assert.throws(() => examples.ready(dir), { message: 'eval run: judge examples not ready — 11 of 12 drafted' });
  store.writeJsonl(dir, 'judge-examples/examples.jsonl', all);
  rate(dir, chosen.slice(0, 5).map((p) => p.id));
  rate(dir, chosen.slice(6).map((p) => p.id), 'needs_edits');
  assert.throws(() => examples.ready(dir), { message: `eval run: judge examples not ready — 1 of 12 unrated (${chosen[5].id})` });
  rate(dir, [chosen[5].id], 'wrong');
  const rows = examples.ready(dir);
  assert.equal(rows.length, 12);
  assert.deepEqual(rows.map((r) => r.pair_id), chosen.map((p) => p.id));
  assert.equal(rows[5].rating, 'wrong');
  assert.equal(rows[0].rating, 'send_as_is');
  assert.equal(rows[0].draft, all[0].draft);
  const summary = examples.summary(rows);
  assert.deepEqual(summary, { hash: judge.examplesHash(judge.examplesBlock(rows)), n: 12, labels: { send_as_is: 5, needs_edits: 6, wrong: 1 } });
  assert.equal(Object.values(summary.labels).reduce((a, b) => a + b, 0), 12);
  const drafted = rows.map((r, i) => (i === 3 ? { ...r, draft: 'Another draft.' } : r));
  assert.notEqual(examples.summary(drafted).hash, summary.hash);
  rate(dir, [chosen[0].id], 'wrong');
  assert.notEqual(examples.summary(examples.ready(dir)).hash, summary.hash);
  const extra = { ...rows[0], pair_id: 'sample-16', position: 13, draft: 'A thirteenth draft.' };
  const larger = examples.summary([...rows, extra]);
  assert.notEqual(larger.hash, summary.hash);
  assert.equal(larger.n, 13);
});

test('readSet honours the store path guard on a symlinked judge-examples', (t) => {
  const { dir, home } = setup(t);
  const outside = path.join(home, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'set.json'), '{}');
  fs.symlinkSync(outside, path.join(dir, 'judge-examples'), 'dir');
  assert.throws(() => examples.readSet(dir), { message: 'Persona file path must stay inside the persona directory.' });
});
