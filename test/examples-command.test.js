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
  assert.equal((await exec(home, ['next'])).stdout, 'examples: all 12 items rated — run eval run\n');
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
