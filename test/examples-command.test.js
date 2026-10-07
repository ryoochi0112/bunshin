'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const store = require('../lib/store');
const twin = require('../lib/twin');
const judge = require('../lib/judge');
const examples = require('../lib/examples');
const command = require('../lib/commands/examples');

const root = path.join(__dirname, '..');

function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-examples-cmd-')));
  const dir = path.join(home, 'fictional');
  fs.cpSync(path.join(root, 'sample', 'persona'), dir, { recursive: true });
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); store._resetGuardCache(); });
  return { home, dir };
}

function recording({ failOn } = {}) {
  const calls = [];
  return { calls, get(host) { return { async run(input) {
    calls.push({ host, ...input });
    if (failOn === calls.length) throw new Error('synthetic host failure');
    return { text: `Synthetic draft ${calls.length}.`, model: `${host}-model` };
  } }; } };
}

async function exec(home, argv, adapters) {
  const out = { stdout: '', stderr: '' };
  const io = { env: { BUNSHIN_HOME: home }, hosts: adapters,
    stdout: { write(text) { out.stdout += text; } }, stderr: { write(text) { out.stderr += text; } } };
  const code = await command.run(argv, io);
  return { code, ...out };
}

const exists = (dir) => fs.existsSync(path.join(dir, examples.DIR));

test('module metadata', () => {
  assert.equal(command.name, 'examples');
  assert.equal(command.summary, 'Draft and rate judge examples from build pairs');
});

test('sample drafts 12 rows, 6 per layer, with the twin system and notion-read tools', async (t) => {
  const { home, dir } = fixture(t);
  const adapters = recording();
  const result = await exec(home, ['sample', '--drafter', 'fake'], adapters);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^examples: drafted 12 of 12 \(knowledge 6, judgment 6\); skipped \d+ oversized pairs\n/);
  const state = examples.readSet(dir);
  assert.equal(state.examples.length, 12);
  assert.equal(state.examples.filter((row) => row.layer === 'knowledge').length, 6);
  assert.match(state.set.seed, /^[a-f0-9]{16}$/);
  assert.deepEqual(state.set.drafter, { host: 'fake', model: null });
  assert.equal(adapters.calls.length, 12);
  for (const call of adapters.calls) assert.equal(call.tools, 'notion-read');
  state.examples.forEach((row, i) => {
    const call = adapters.calls[i];
    assert.equal(call.system, twin.composePrompt(dir, twin.skillForLayer(row.layer)));
    assert.equal(call.prompt, judge.questionPrompt({ question: row.question, context: row.context }));
    assert.deepEqual(call.allowedTools, require('../lib/hosts').allowedTools(store.readJson(dir, 'persona.json')));
    assert.deepEqual(row.drafter, { host: 'fake', model: 'fake-model' });
    assert.equal(row.draft, `Synthetic draft ${i + 1}.`);
  });
});

test('a second sample makes no calls and reports the existing set', async (t) => {
  const { home } = fixture(t);
  await exec(home, ['sample', '--drafter', 'fake'], recording());
  const adapters = recording();
  const result = await exec(home, ['sample', '--n', '3', '--drafter', 'codex'], adapters);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(adapters.calls.length, 0);
  assert.match(result.stdout, /examples: set exists \(12 drafted, 0 rated\)\n$/);
});

test('model from the drafter spec is passed to the host and stored as null when absent', async (t) => {
  const { home, dir } = fixture(t);
  const adapters = recording();
  assert.equal((await exec(home, ['sample', '--n', '2', '--drafter', 'fake:abc.json'], adapters)).code, 0);
  assert.equal(examples.readSet(dir).set.drafter.model, 'abc.json');
  assert.ok(adapters.calls.every((call) => call.model === 'abc.json'));
  const plain = recording();
  const second = fixture(t);
  await exec(second.home, ['sample', '--n', '2', '--drafter', 'fake'], plain);
  assert.ok(plain.calls.every((call) => call.model === undefined));
});

test('a host error keeps earlier rows and a rerun drafts only the rest', async (t) => {
  const { home, dir } = fixture(t);
  const failing = await exec(home, ['sample', '--drafter', 'fake'], recording({ failOn: 5 }));
  assert.equal(failing.code, 1);
  assert.match(failing.stderr, /^examples: host error on pair \S+ \(fake\); rerun examples sample to resume\n$/);
  assert.equal(store.readJsonl(dir, 'judge-examples/examples.jsonl').length, 4);
  const fifth = examples.selectSet(dir, { seed: store.readJson(dir, 'judge-examples/set.json').seed, n: 12 })[4].id;
  assert.ok(failing.stderr.includes(fifth));
  const adapters = recording();
  const rerun = await exec(home, ['sample', '--drafter', 'codex'], adapters);
  assert.equal(rerun.code, 0, rerun.stderr);
  assert.equal(adapters.calls.length, 8);
  assert.equal(adapters.calls[0].model, undefined);
  assert.equal(adapters.calls[0].host, 'fake');
  assert.equal(examples.readSet(dir).examples.length, 12);
});

function growBuildPool(dir, count) {
  const all = store.readJsonl(dir, 'pairs.jsonl');
  const assignments = store.readJson(dir, 'split.json');
  const extra = Array.from({ length: count }, (_, i) => {
    const source = all[i % 2 ? 0 : 1];
    return { ...source, id: `sample-9${i}`, layer: i % 2 ? 'knowledge' : 'judgment' };
  });
  store.writeJsonl(dir, 'pairs.jsonl', [...all, ...extra]);
  for (const pair of extra) assignments.assignments[pair.id] = 'build';
  store.writeJson(dir, 'split.json', assignments);
  return extra;
}

test('a rerun after new build pairs arrive drafts the pinned ids at the pending positions only', async (t) => {
  const { home, dir } = fixture(t);
  const failing = await exec(home, ['sample', '--drafter', 'fake'], recording({ failOn: 5 }));
  assert.equal(failing.code, 1);
  const set = store.readJson(dir, 'judge-examples/set.json');
  assert.equal(set.pair_ids.length, 12);
  assert.equal(new Set(set.pair_ids).size, 12);
  assert.equal(store.readJsonl(dir, 'judge-examples/examples.jsonl').length, 4);
  growBuildPool(dir, 6);
  const regrown = examples.selectSet(dir, { seed: set.seed, n: 12 }).map((pair) => pair.id);
  const moved = regrown.map((id, index) => index >= 4 && id !== set.pair_ids[index]);
  assert.ok(moved.some(Boolean), 'precondition: re-selection over the grown pool differs at a pending position');
  const adapters = recording();
  const rerun = await exec(home, ['sample', '--drafter', 'fake'], adapters);
  assert.equal(rerun.code, 0, rerun.stderr);
  assert.equal(adapters.calls.length, 8);
  const rows = store.readJsonl(dir, 'judge-examples/examples.jsonl');
  assert.deepEqual(rows.map((row) => row.position), Array.from({ length: 12 }, (_, i) => i + 1));
  assert.deepEqual(rows.map((row) => row.pair_id), set.pair_ids);
  assert.equal(new Set(rows.map((row) => row.pair_id)).size, 12);
  assert.deepEqual(store.readJson(dir, 'judge-examples/set.json'), set);
  assert.equal(examples.readSet(dir).examples.length, 12);
  assert.equal((await exec(home, ['status'])).stdout, 'examples: 12/12 drafted · 0/12 rated (send_as_is 0 · needs_edits 0 · wrong 0)\n');
});

test('a rerun whose pinned pair left the build split fails and writes no row', async (t) => {
  const { home, dir } = fixture(t);
  await exec(home, ['sample', '--drafter', 'fake'], recording({ failOn: 5 }));
  const set = store.readJson(dir, 'judge-examples/set.json');
  const split = store.readJson(dir, 'split.json');
  split.assignments[set.pair_ids[6]] = 'heldout';
  store.writeJson(dir, 'split.json', split);
  const adapters = recording();
  const rerun = await exec(home, ['sample', '--drafter', 'fake'], adapters);
  assert.equal(rerun.code, 1);
  assert.equal(rerun.stderr, `examples: pair ${set.pair_ids[6]} is not in the build split\n`);
  assert.equal(adapters.calls.length, 0);
  assert.equal(store.readJsonl(dir, 'judge-examples/examples.jsonl').length, 4);
});

test('a rerun whose pinned pair was removed from the pairs fails and writes no row', async (t) => {
  const { home, dir } = fixture(t);
  await exec(home, ['sample', '--drafter', 'fake'], recording({ failOn: 5 }));
  const set = store.readJson(dir, 'judge-examples/set.json');
  store.writeJsonl(dir, 'pairs.jsonl', store.readJsonl(dir, 'pairs.jsonl').filter((pair) => pair.id !== set.pair_ids[9]));
  const adapters = recording();
  const rerun = await exec(home, ['sample', '--drafter', 'fake'], adapters);
  assert.equal(rerun.code, 1);
  assert.equal(rerun.stderr, `examples: pair ${set.pair_ids[9]} is not in the build split\n`);
  assert.equal(adapters.calls.length, 0);
  assert.equal(store.readJsonl(dir, 'judge-examples/examples.jsonl').length, 4);
});

test('sample --n 14 fails on the eligible count and writes nothing', async (t) => {
  const { home, dir } = fixture(t);
  const adapters = recording();
  const result = await exec(home, ['sample', '--n', '14', '--drafter', 'fake'], adapters);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /examples: only \d+ eligible build pairs; need 14/);
  assert.equal(exists(dir), false);
  assert.equal(adapters.calls.length, 0);
});

test('sample with an uncommitted identity writes nothing and spends no call', async (t) => {
  const { home, dir } = fixture(t);
  fs.rmSync(path.join(dir, 'identity.json'));
  const adapters = recording();
  const result = await exec(home, ['sample', '--drafter', 'fake'], adapters);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Twin prompt requires a committed identity/);
  assert.equal(exists(dir), false);
  assert.equal(adapters.calls.length, 0);
});

test('sample fails when the rendered block is over the limit and names the longest pairs', async (t) => {
  const { home, dir } = fixture(t);
  const huge = 'x'.repeat(judge.MAX_BLOCK_CHARS);
  const big = { ...recording(), get() { return { async run() { return { text: huge, model: 'm' }; } }; } };
  const result = await exec(home, ['sample', '--n', '2', '--drafter', 'fake'], big);
  assert.equal(result.code, 1);
  assert.match(result.stderr, new RegExp(`^examples: rendered examples exceed ${judge.MAX_BLOCK_CHARS} chars; longest: \\S+, \\S+\\n$`));
  assert.equal(store.readJsonl(dir, 'judge-examples/examples.jsonl').length, 2);
});

test('next and rate loop through the set, then status and held-out rejection', async (t) => {
  const { home, dir } = fixture(t);
  assert.deepEqual((await exec(home, ['next'])), { code: 1, stdout: '', stderr: 'examples: no set — run examples sample\n' });
  assert.equal((await exec(home, ['status'])).stdout, 'examples: no set\n');
  assert.equal((await exec(home, ['rate', 'sample-01', 'wrong'])).code, 1);
  await exec(home, ['sample', '--drafter', 'fake'], recording());
  const rows = examples.readSet(dir).examples;
  const first = await exec(home, ['next']);
  assert.equal(first.stdout, `item 1/12 — ${rows[0].pair_id} (${rows[0].layer})\n\n## Question\n${rows[0].question.text}\n\n## Twin draft\n${rows[0].draft}\n\n## Reference answer\n${rows[0].reference_answer}\n`);
  assert.equal((await exec(home, ['rate', 'sample-10', 'wrong'])).stderr, 'examples: sample-10 is not in the example set\n');
  assert.equal((await exec(home, ['rate', rows[0].pair_id, 'great'])).stderr, 'examples: invalid rating\n');
  assert.equal((await exec(home, ['rate', 'Bad Id', 'wrong'])).code, 1);
  const labels = ['send_as_is', 'needs_edits', 'wrong'];
  for (let i = 0; i < 12; i++) {
    const next = await exec(home, ['next']);
    assert.match(next.stdout, new RegExp(`^item ${i + 1}/12 — ${rows[i].pair_id} `));
    const rated = await exec(home, ['rate', rows[i].pair_id, labels[i % 3]]);
    assert.equal(rated.stdout, `examples: rated ${rows[i].pair_id} (${i + 1}/12)\n`);
    if (i === 5) assert.equal((await exec(home, ['status'])).stdout, 'examples: 12/12 drafted · 6/12 rated (send_as_is 2 · needs_edits 2 · wrong 2)\n');
  }
  assert.match((await exec(home, ['next'])).stdout, new RegExp(`^item 1/12 — ${rows[0].pair_id} `));
  assert.equal((await exec(home, ['status'])).stdout, 'examples: 12/12 drafted · 12/12 rated (send_as_is 4 · needs_edits 4 · wrong 4)\n');
  const ratings = store.readJsonl(dir, 'judge-examples/ratings.jsonl');
  assert.equal(ratings.length, 12);
  assert.deepEqual(Object.keys(ratings[0]).sort(), ['pair_id', 'rated_at', 'rating']);
});

test('option parsing: duplicates and unknown options exit 1, bad usage exits 2', async (t) => {
  const { home } = fixture(t);
  for (const argv of [['sample', '--n', '3', '--n', '4'], ['sample', '--bogus', 'x'], ['status', '--n', '3'], ['rate', 'sample-01', 'wrong', '--wrong-uncited-fact', 'yes'], ['sample', '--n']]) {
    const result = await exec(home, argv, recording());
    assert.equal(result.code, 1, argv.join(' '));
    assert.equal(result.stderr, 'examples: invalid options\n');
  }
  for (const argv of [[], ['bogus']]) {
    const result = await exec(home, argv);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /^Usage: bunshin examples sample/);
  }
  assert.equal((await exec(home, ['sample', '--n', '0'], recording())).code, 1);
});

test('rate stores reason, null or no key; status counts all as rated', async (t) => {
  const { home, dir } = fixture(t);
  await exec(home, ['sample', '--drafter', 'fake'], recording());
  const ids = examples.readSet(dir).examples.map((row) => row.pair_id);
  assert.equal((await exec(home, ['rate', ids[0], 'wrong', '--reason', 'tone ok, facts match'])).code, 0);
  assert.equal((await exec(home, ['rate', ids[1], 'wrong', '--no-reason'])).code, 0);
  assert.equal((await exec(home, ['rate', ids[2], 'wrong'])).code, 0);
  assert.equal((await exec(home, ['rate', ids[3], 'wrong', '--persona', dir, '--reason', ' 日本語 '])).code, 0);
  const rows = store.readJsonl(dir, 'judge-examples/ratings.jsonl');
  assert.equal(rows[0].reason, 'tone ok, facts match');
  assert.ok(Object.hasOwn(rows[1], 'reason') && rows[1].reason === null);
  assert.equal(Object.hasOwn(rows[2], 'reason'), false);
  assert.equal(rows[3].reason, ' 日本語 ');
  assert.match((await exec(home, ['status'])).stdout, /· 4\/12 rated/);
  const dashed = await exec(home, ['rate', ids[4], 'wrong', '--reason', '--odd']);
  assert.equal(dashed.code, 0);
  assert.equal(store.readJsonl(dir, 'judge-examples/ratings.jsonl')[4].reason, '--odd');
});

test('rate refuses an invalid reason without writing; 200 code points pass', async (t) => {
  const { home, dir } = fixture(t);
  await exec(home, ['sample', '--drafter', 'fake'], recording());
  const ids = examples.readSet(dir).examples.map((row) => row.pair_id);
  const file = path.join(dir, 'judge-examples', 'ratings.jsonl');
  assert.equal((await exec(home, ['rate', ids[0], 'wrong', '--no-reason'])).code, 0);
  const before = fs.readFileSync(file);
  for (const reason of ['', '   ', 'a\nb', 'a\rb', '日'.repeat(201)]) {
    const result = await exec(home, ['rate', ids[1], 'wrong', '--reason', reason]);
    assert.equal(result.code, 1, JSON.stringify(reason));
    assert.equal(result.stderr, 'examples: invalid reason\n');
    assert.deepEqual(fs.readFileSync(file), before);
  }
  const ok = await exec(home, ['rate', ids[1], 'wrong', '--reason', '日'.repeat(200)]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(store.readJsonl(dir, 'judge-examples/ratings.jsonl')[1].reason, '日'.repeat(200));
});

test('reason flag-shape errors exit 2 with usage', async (t) => {
  const { home, dir } = fixture(t);
  await exec(home, ['sample', '--drafter', 'fake'], recording());
  const id = examples.readSet(dir).examples[0].pair_id;
  const file = path.join(dir, 'judge-examples', 'ratings.jsonl');
  const argvs = [
    ['rate', id, 'wrong', '--reason', 'x', '--no-reason'], ['rate', id, 'wrong', '--no-reason', '--reason', 'x'],
    ['rate', id, 'wrong', '--reason'], ['rate', id, 'wrong', '--persona', dir, '--reason'],
    ['rate', id, 'wrong', '--reason', 'a', '--reason', 'b'], ['rate', id, 'wrong', '--no-reason', '--no-reason'],
    ['next', '--reason', 'x'], ['next', '--no-reason'], ['status', '--reason', 'x'], ['status', '--no-reason'],
    ['sample', '--reason', 'x'], ['sample', '--no-reason'],
  ];
  for (const argv of argvs) {
    const result = await exec(home, argv, recording());
    assert.equal(result.code, 2, argv.join(' '));
    assert.match(result.stderr, /^Usage: bunshin examples sample/);
    assert.match(result.stderr, /rate <pair_id> <rating> \[--reason <text> \| --no-reason\] \[--persona <dir>\]/);
  }
  assert.equal(fs.existsSync(file), false);
});

test('next re-offers rated items lacking a reason decision, byte-identical to the first offer', async (t) => {
  const { home, dir } = fixture(t);
  await exec(home, ['sample', '--drafter', 'fake'], recording());
  const rows = examples.readSet(dir).examples;
  const first = [];
  for (let i = 0; i < 12; i++) {
    first.push((await exec(home, ['next'])).stdout);
    await exec(home, ['rate', rows[i].pair_id, 'needs_edits']);
  }
  for (let i = 0; i < 12; i++) {
    const next = await exec(home, ['next']);
    assert.equal(next.stdout, first[i]);
    assert.ok(!next.stdout.includes('needs_edits'));
    const flag = i === 0 ? ['--reason', 'marker-zq'] : i === 1 ? ['--no-reason'] : i % 2 ? ['--reason', 'why'] : ['--no-reason'];
    await exec(home, ['rate', rows[i].pair_id, 'wrong', ...flag]);
    if (i === 1) assert.match((await exec(home, ['status'])).stdout, /12\/12 rated/);
    assert.ok(!(await exec(home, ['next'])).stdout.includes('marker-zq'));
  }
  assert.equal((await exec(home, ['next'])).stdout, 'examples: all 12 items rated — run eval run\n');
});

test('next serves unrated items before re-passes, and a bare re-rating needs the step again', async (t) => {
  const { home, dir } = fixture(t);
  await exec(home, ['sample', '--drafter', 'fake'], recording());
  const rows = examples.readSet(dir).examples;
  for (let i = 0; i < 12; i++) {
    if (i === 4 || i === 5) continue;
    await exec(home, ['rate', rows[i].pair_id, 'wrong', ...(i < 8 ? [] : ['--no-reason'])]);
  }
  // unrated 5, 6 (positions) come before the needing 1..8
  assert.match((await exec(home, ['next'])).stdout, new RegExp(`^item 5/12 `));
  await exec(home, ['rate', rows[4].pair_id, 'wrong', '--no-reason']);
  assert.match((await exec(home, ['next'])).stdout, new RegExp(`^item 6/12 `));
  await exec(home, ['rate', rows[5].pair_id, 'wrong', '--no-reason']);
  assert.match((await exec(home, ['next'])).stdout, new RegExp(`^item 1/12 `));
  for (let i = 0; i < 4; i++) await exec(home, ['rate', rows[i].pair_id, 'wrong', '--no-reason']);
  for (const i of [6, 7]) await exec(home, ['rate', rows[i].pair_id, 'wrong', '--no-reason']);
  assert.equal((await exec(home, ['next'])).stdout, 'examples: all 12 items rated — run eval run\n');
  await exec(home, ['rate', rows[2].pair_id, 'wrong']);
  assert.match((await exec(home, ['next'])).stdout, new RegExp(`^item 3/12 `));
});

// ---- balance ----
const OLD = '2026-01-01T00:00:00.000Z';
const body = (row) => `\n\n## Question\n${row.question.text}\n\n## Twin draft\n${row.draft}\n\n## Reference answer\n${row.reference_answer}\n`;
const setFile = (dir, name) => path.join(dir, examples.DIR, name);
const snapshot = (dir) => Object.fromEntries(fs.readdirSync(path.join(dir, examples.DIR)).sort()
  .map((name) => [name, fs.readFileSync(setFile(dir, name)).toString()]));

// spec: 12 entries [rating, reason]; reason null = --no-reason row, string = reasoned row.
async function ratedSet(t, spec, pool = 0) {
  const ctx = fixture(t);
  if (pool) growBuildPool(ctx.dir, pool);
  await exec(ctx.home, ['sample', '--drafter', 'fake'], recording());
  const rows = examples.readSet(ctx.dir).examples;
  spec.forEach(([rating, reason], i) => store.appendJsonl(ctx.dir, `${examples.DIR}/ratings.jsonl`,
    { pair_id: rows[i].pair_id, rating, reason, rated_at: OLD }));
  return { ...ctx, rows };
}
const plain = (rating, reason = null) => [rating, reason];
const S0 = plain('send_as_is');

test('balance refuses an unrated or undrafted set and writes no file', async (t) => {
  const { home, dir } = fixture(t);
  await exec(home, ['sample', '--n', '2', '--drafter', 'fake'], recording());
  let result = await exec(home, ['balance']);
  assert.deepEqual([result.code, result.stdout, result.stderr], [1, '', 'examples: rate all items before balance\n']);
  assert.equal(fs.existsSync(setFile(dir, 'balance.json')), false);
  const second = fixture(t);
  await exec(second.home, ['sample', '--drafter', 'fake'], recording());
  result = await exec(second.home, ['balance']);
  assert.equal(result.stderr, 'examples: rate all items before balance\n');
  assert.equal(fs.existsSync(setFile(second.dir, 'balance.json')), false);
});

test('balance creates balance.json once, prints the status line, and is idempotent', async (t) => {
  const { home, dir } = await ratedSet(t, Array(12).fill(S0), 4);
  const first = await exec(home, ['balance']);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.stdout, 'examples: balancing — extras 0 of 24 rated · needs_edits with reason 0 of 6 · send_as_is with reason 0\n');
  const balance = store.readJson(dir, 'judge-examples/balance.json');
  assert.deepEqual(Object.keys(balance), ['format_version', 'seed', 'started_at']);
  assert.match(balance.seed, /^[a-f0-9]{16}$/);
  const before = snapshot(dir);
  const second = await exec(home, ['balance']);
  assert.equal(second.stdout, first.stdout);
  assert.deepEqual(snapshot(dir), before);
  assert.equal((await exec(home, ['status'])).stdout, first.stdout);
});

test('status without a balance keeps today\'s line', async (t) => {
  const { home } = await ratedSet(t, Array(12).fill(S0));
  assert.equal((await exec(home, ['status'])).stdout, 'examples: 12/12 drafted · 12/12 rated (send_as_is 12 · needs_edits 0 · wrong 0)\n');
  assert.equal((await exec(home, ['next'])).stdout, 'examples: all 12 items rated — run eval run\n');
});

test('next drafts extras on demand, re-serves unrated ones without a call, and rate accepts extra ids', async (t) => {
  const { home, dir } = await ratedSet(t, Array(12).fill(S0), 8);
  await exec(home, ['balance']);
  const adapters = recording();
  const outs = [];
  for (let i = 0; i < 3; i++) {
    const result = await exec(home, ['next'], adapters);
    assert.equal(result.code, 0, result.stderr);
    const row = examples.readSet(dir).extras[i];
    assert.equal(result.stdout, `item ${13 + i} — ${row.pair_id} (${row.layer})${body(row)}`);
    outs.push(result.stdout);
    assert.equal(adapters.calls.length, i + 1);
    if (i < 2) {
      const rated = await exec(home, ['rate', row.pair_id, 'needs_edits', '--reason', 'r'], adapters);
      assert.equal(rated.code, 0, rated.stderr);
    }
  }
  assert.equal(adapters.calls.length, 3);
  assert.equal((await exec(home, ['next'], adapters)).stdout, outs[2]);
  assert.equal(adapters.calls.length, 3);
  const state = examples.readSet(dir);
  const ids = state.extras.map((row) => row.pair_id);
  assert.equal(new Set(ids).size, 3);
  for (const id of ids) {
    assert.ok(!state.set.pair_ids.includes(id));
    assert.equal(store.readJson(dir, 'split.json').assignments[id], 'build');
  }
  for (const call of adapters.calls) assert.equal(call.tools, 'notion-read');
  state.extras.forEach((row, i) => {
    assert.equal(adapters.calls[i].system, twin.composePrompt(dir, twin.skillForLayer(row.layer)));
    assert.equal(adapters.calls[i].prompt, judge.questionPrompt({ question: row.question, context: row.context }));
  });
  assert.equal((await exec(home, ['rate', 'sample-10', 'wrong'])).stderr, 'examples: sample-10 is not in the example set\n');
});

test('a host error while drafting an extra appends nothing and prints the resume hint', async (t) => {
  const { home, dir } = await ratedSet(t, Array(12).fill(S0), 4);
  await exec(home, ['balance']);
  const failing = await exec(home, ['next'], recording({ failOn: 1 }));
  assert.equal(failing.code, 1);
  assert.equal(fs.existsSync(setFile(dir, 'extras.jsonl')), false);
  const pairId = examples.readSet(dir).balance.serve.pair.id;
  assert.equal(failing.stderr, `examples: host error on pair ${pairId} (fake); rerun examples next to resume\n`);
  await exec(home, ['next'], recording());
  const before = fs.readFileSync(setFile(dir, 'extras.jsonl'));
  const second = await exec(home, ['rate', pairId, 'wrong', '--no-reason']);
  assert.equal(second.code, 0);
  const again = await exec(home, ['next'], recording({ failOn: 1 }));
  assert.equal(again.code, 1);
  assert.deepEqual(fs.readFileSync(setFile(dir, 'extras.jsonl')), before);
});

async function serveExtras(home, count, ratingFor) {
  const adapters = recording();
  for (let i = 0; i < count; i++) {
    const result = await exec(home, ['next'], adapters);
    assert.match(result.stdout, new RegExp(`^item ${13 + i} — `), `extra ${i + 1}: ${result.stdout.slice(0, 60)}`);
    const id = result.stdout.match(/^item \d+ — (\S+) /)[1];
    const [rating, reason] = ratingFor(i);
    await exec(home, ['rate', id, rating, ...(reason ? ['--reason', reason] : ['--no-reason'])], adapters);
  }
  return adapters;
}

test('quota stop: the rating that makes the 6th N ends extras and next serves a top-up item', async (t) => {
  const spec = [plain('needs_edits', 'a'), plain('needs_edits', 'b'), ...Array(10).fill(S0)];
  const { home, rows } = await ratedSet(t, spec, 26);
  await exec(home, ['balance']);
  const adapters = await serveExtras(home, 4, () => ['needs_edits', 'why']);
  assert.equal(adapters.calls.length, 4);
  const next = await exec(home, ['next'], adapters);
  assert.equal(next.stdout, `item 3/12 — ${rows[2].pair_id} (${rows[2].layer})${body(rows[2])}`);
  assert.equal(adapters.calls.length, 4);
});

test('cap stop: 24 rated extras with 4 N end extras; golden done line after the reasons', async (t) => {
  const spec = [plain('needs_edits', 'a'), plain('needs_edits', 'b'), ...Array(4).fill(plain('send_as_is', 'ok')), ...Array(6).fill(S0)];
  const { home, dir } = await ratedSet(t, spec, 26);
  await exec(home, ['balance']);
  await serveExtras(home, 24, (i) => (i < 2 ? ['needs_edits', 'why'] : ['wrong', null]));
  // S (4) already equals min(6, N=4), so top-up is not open and the set is done.
  const done = await exec(home, ['next'], recording());
  const line = 'examples: balanced set 4/4 (send_as_is 4 · needs_edits 4) — cap reached — run eval run\n';
  assert.equal(done.stdout, line);
  assert.equal((await exec(home, ['status'])).stdout, line);
  assert.equal((await exec(home, ['balance'])).stdout, line);
  assert.equal(examples.readSet(dir).extras.length, 24);
});

test('pool stop: 5 candidate pairs end extras after 5; golden line without suffix quota', async (t) => {
  const spec = [plain('needs_edits', 'a'), plain('needs_edits', 'b'), plain('send_as_is', 'x'), plain('send_as_is', 'y'), ...Array(8).fill(S0)];
  const { home } = await ratedSet(t, spec, 4);
  await exec(home, ['balance']);
  const adapters = await serveExtras(home, 5, () => ['wrong', null]);
  assert.equal(adapters.calls.length, 5);
  const done = await exec(home, ['next'], adapters);
  assert.equal(done.stdout, 'examples: balanced set 2/2 (send_as_is 2 · needs_edits 2) — no more build pairs — run eval run\n');
  assert.equal(adapters.calls.length, 5);
});

test('balanced 6/6 prints the golden done line from balance, status and next', async (t) => {
  const spec = [...Array(6).fill(plain('needs_edits', 'n')), ...Array(6).fill(plain('send_as_is', 's'))];
  const { home } = await ratedSet(t, spec);
  const line = 'examples: balanced set 6/6 (send_as_is 6 · needs_edits 6) — run eval run\n';
  assert.equal((await exec(home, ['balance'])).stdout, line);
  assert.equal((await exec(home, ['status'])).stdout, line);
  assert.equal((await exec(home, ['next'])).stdout, line);
});

test('top-up serves exactly the 6 blind items byte-identically, and a needs_edits re-rating keeps the pass going', async (t) => {
  const { home, dir, rows } = await ratedSet(t, [], 0);
  // rebuild: items 1-6 N with reason, 7-12 first shown unrated then rated send_as_is without reason
  const firsts = [];
  for (let i = 0; i < 12; i++) {
    if (i < 6) store.appendJsonl(dir, `${examples.DIR}/ratings.jsonl`, { pair_id: rows[i].pair_id, rating: 'needs_edits', reason: 'n', rated_at: OLD });
    else {
      const out = (await exec(home, ['next'])).stdout;
      assert.match(out, new RegExp(`^item ${i + 1}/12 `));
      firsts.push(out);
      store.appendJsonl(dir, `${examples.DIR}/ratings.jsonl`, { pair_id: rows[i].pair_id, rating: 'send_as_is', reason: null, rated_at: OLD });
    }
  }
  assert.match((await exec(home, ['balance'])).stdout, /^examples: balancing — extras 0 of 24 rated · needs_edits with reason 6 of 6 · send_as_is with reason 0\n$/);
  const served = [];
  for (let i = 0; i < 6; i++) {
    const out = (await exec(home, ['next'], recording())).stdout;
    served.push(out);
    assert.equal(out, firsts[i]);
    if (i === 2) {
      assert.equal((await exec(home, ['rate', rows[6 + i].pair_id, 'needs_edits', '--reason', 'now no'])).code, 0);
      assert.match(await (async () => (await exec(home, ['status'])).stdout)(), /needs_edits with reason 7 of 6/);
    } else {
      assert.equal((await exec(home, ['rate', rows[6 + i].pair_id, 'send_as_is', '--reason', 'fine'])).code, 0);
    }
  }
  // S reached 5; one N re-rated, so one more candidate is needed: the pass served items 7..12 and ends with no candidate left.
  assert.equal(served.length, 6);
  assert.equal((await exec(home, ['next'])).stdout, 'examples: balanced set 5/5 (send_as_is 5 · needs_edits 5) — too few send_as_is reasons — run eval run\n');
});
