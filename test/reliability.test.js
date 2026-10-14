'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const reliability = require('../lib/reliability');
const coverage = require('../lib/coverage');
const store = require('../lib/store');
const kb = require('../lib/kb');
const evalRun = require('../lib/eval-run');
const support = require('../lib/support');
const command = require('../lib/commands/eval');

const root = path.join(__dirname, '..');
const ids = ['2026-10-14-01', '2026-10-14-02', '2026-10-14-03'];
const gates = { citation: true, resolves: true, current: true, scrub: true };

function input() {
  const cases = ['clean', 'broken', 'flips', 'missing', 'excluded'].map((id) => ({ id, layer: 'knowledge' }));
  const labels = Object.fromEntries(cases.map(({ id }) => [id, { coverage: id === 'excluded' ? 'X' : 'C', entries: [] }]));
  return {
    coverage: { format_version: 1, kb: 'demo', kb_digest_hash: 'a'.repeat(64),
      imported_at: '2026-10-14T00:00:00Z', cases: labels },
    runs: ids.map((id, index) => ({
      run: { run_id: id, kb: { name: 'demo', digest_hash: 'a'.repeat(64) }, persona_version: 1,
        drafter: { host: 'fake', model: null }, judge: { host: 'fake', model: 'judge' },
        judge_rubric: 'judge-hash', support_rubric: 'support-hash', judge_examples: { hash: 'examples-hash' }, limit: null },
      cases: structuredClone(cases),
      drafts: cases.map(({ id }) => ({ case_id: id, layer: 'knowledge', skill: 'spec-answer',
        kb: { digest_hash: 'a'.repeat(64) }, shape: { facts: 1, abstain: false, handback: false },
        gates: { ...gates, citation: id !== 'broken' && !(id === 'flips' && index === 1) },
        text: 'Synthetic draft text never belongs in a report.' })),
      support: cases.filter(({ id }) => id !== 'missing' || index !== 2)
        .map(({ id }) => ({ case_id: id, sentences: [{ index: 0, ids: ['demo.model.provider'], verdict: 'supported' }] })),
      judgments: [{ case_id: 'clean', rating: 'send_as_is' }, { case_id: 'broken', rating: 'wrong' },
        { case_id: 'missing', rating: 'judge_error' }],
    })),
  };
}

test('three runs classify stable passes, stable failures, unstable and incomplete cases without text', () => {
  const data = input();
  const before = structuredClone(data);
  const value = reliability.build(data);
  assert.deepEqual(value, {
    runs: ids,
    frozen: { kb_digest_hash: 'a'.repeat(64), persona_version: 1,
      drafter: { host: 'fake', model: null }, judge: { host: 'fake', model: 'judge' },
      judge_rubric: 'judge-hash', support_rubric: 'support-hash', judge_examples_hash: 'examples-hash',
      coverage_hash: coverage.hash(data.coverage) },
    per_run: ids.map((run_id, index) => ({ run_id, kb_gates_status: index === 2 ? 'incomplete' : 'fail', send_as_is_rate: 0.5 })),
    cases: [
      { id: 'clean', label: 'C', results: ['pass', 'pass', 'pass'], verdict: 'stable_pass' },
      { id: 'broken', label: 'C', results: ['fail', 'fail', 'fail'], verdict: 'stable_fail' },
      { id: 'flips', label: 'C', results: ['pass', 'fail', 'pass'], verdict: 'unstable' },
      { id: 'missing', label: 'C', results: ['pass', 'pass', 'incomplete'], verdict: 'incomplete' },
    ],
    counts: { stable_pass: 1, stable_fail: 1, unstable: 1, incomplete: 1 }, status: 'incomplete',
  });
  const markdown = reliability.renderMarkdown(value);
  assert.match(markdown, /^bunshin eval reliability/);
  assert.match(markdown, /frozen: .*kb_digest_hash/);
  assert.match(markdown, /2026-10-14-01 · fail · send as-is 50%/);
  assert.match(markdown, /unstable: flips/);
  assert.match(markdown, /incomplete: missing/);
  assert.doesNotMatch(JSON.stringify(value) + markdown, /Synthetic draft text/);
  assert.deepEqual(data, before);
});

test('status requires every labelled case to pass every run; misses fail and absent evidence is incomplete', () => {
  for (const [change, expected] of [
    [() => {}, 'pass'],
    [(data) => { data.runs[0].drafts[0].gates.scrub = false; }, 'fail'],
    [(data) => { for (const row of data.runs) row.drafts[0].shape = { facts: 0, abstain: true, handback: false }; }, 'fail'],
    [(data) => { data.runs[0].drafts = []; }, 'incomplete'],
    [(data) => { data.runs[0].support = []; }, 'incomplete'],
    [(data) => { delete data.runs[0].drafts[0].shape; }, 'incomplete'],
    [(data) => { data.runs[0].support[0].sentences[0].verdict = 'support_error'; }, 'incomplete'],
    [(data) => { delete data.coverage.cases.clean; }, 'incomplete'],
    [(data) => { data.coverage = null; }, 'incomplete'],
    [(data) => { data.coverage.kb_digest_hash = 'b'.repeat(64); }, 'incomplete'],
    [(data) => { for (const row of data.runs) delete row.run.kb; }, 'incomplete'],
    [(data) => { for (const row of data.runs) row.run.limit = 1; }, 'incomplete'],
  ]) {
    const data = input();
    for (const row of data.runs) {
      row.cases = row.cases.slice(0, 1); row.drafts = row.drafts.slice(0, 1); row.support = row.support.slice(0, 1);
    }
    change(data);
    assert.equal(reliability.build(data).status, expected);
  }
  const data = input();
  for (const row of data.runs) {
    row.cases = row.cases.filter(({ id }) => id !== 'missing');
  }
  assert.equal(reliability.build(data).status, 'fail');
  data.runs[0].judgments = [{ rating: 'judge_error' }];
  assert.equal(reliability.build(data).per_run[0].send_as_is_rate, null);
});

const differences = [
  ['kb_digest_hash', (row) => { row.run.kb.digest_hash = 'b'.repeat(64); }],
  ['persona_version', (row) => { row.run.persona_version++; }],
  ['drafter', (row) => { row.run.drafter.model = 'other'; }],
  ['judge', (row) => { row.run.judge.model = 'other'; }],
  ['judge_rubric', (row) => { row.run.judge_rubric = 'other'; }],
  ['support_rubric', (row) => { delete row.run.support_rubric; }],
  ['judge_examples_hash', (row) => { row.run.judge_examples.hash = 'other'; }],
  ['coverage_hash', (row) => { row.run.coverage_hash = 'other'; }],
  ['cases', (row) => { row.cases = row.cases.slice(1); }],
  ['cases', (row) => { row.run.limit = 1; }],
];

test('frozen fields and selected case sets must match, independent of object or case order', () => {
  for (const [field, change] of differences) {
    const data = input(); change(data.runs[1]);
    assert.throws(() => reliability.build(data), { message: `eval report: runs differ in ${field}` });
  }
  const data = input();
  data.runs[1].cases.reverse();
  data.runs[1].run.judge = { model: 'judge', host: 'fake' };
  assert.equal(reliability.build(data).cases.length, 4);
});

function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-reliability-')));
  const dir = path.join(home, 'sample');
  fs.cpSync(path.join(root, 'sample', 'persona'), dir, { recursive: true });
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); store._resetGuardCache(); });
  store.writeJson(dir, 'persona.json', { ...store.readJson(dir, 'persona.json'), kb: 'demo' });
  const env = { BUNSHIN_HOME: home };
  const kbDir = kb.resolve({ name: 'demo', env });
  for (const file of ['kb.json', 'sources.jsonl', 'entries/model.md']) {
    store.writeText(kbDir, file, fs.readFileSync(path.join(root, 'sample', 'kb', 'demo', file), 'utf8'), { synthetic: true });
  }
  return { dir, env };
}

function writeRuns(dir, data) {
  store.writeJsonl(dir, 'cases.jsonl', data.runs[0].cases);
  store.writeJson(dir, 'coverage.json', data.coverage);
  for (const row of data.runs) {
    const base = `evals/${row.run.run_id}`;
    store.writeJson(dir, `${base}/run.json`, row.run);
    for (const file of ['drafts', 'support', 'judgments']) store.writeJsonl(dir, `${base}/${file}.jsonl`, row[file]);
  }
}

async function cli(args, env) {
  let stdout = '';
  let stderr = '';
  const code = await command.run(args, { env, stdout: { write(text) { stdout += text; } },
    stderr: { write(text) { stderr += text; } } });
  return { code, stdout, stderr };
}

function snapshot(dir) {
  return fs.readdirSync(dir, { recursive: true }).sort().map((file) => {
    const target = path.join(dir, file);
    return [file, fs.statSync(target).isFile() ? fs.readFileSync(target).toString('base64') : null];
  });
}

test('report --runs writes both files and prints the reliability markdown', async (t) => {
  const { dir, env } = fixture(t);
  const data = input(); writeRuns(dir, data);
  const result = await cli(['report', '--runs', ids.join(',')], env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  const base = `evals/reliability/${ids.join('+')}`;
  assert.deepEqual(store.readJson(dir, `${base}.json`), reliability.build(data));
  assert.equal(fs.readFileSync(path.join(dir, `${base}.md`), 'utf8'), result.stdout);
  assert.match(result.stdout, /unstable: flips/);
});

test('CLI frozen input and case set refusals write nothing, even over existing reports', async (t) => {
  const { dir, env } = fixture(t);
  for (const [field, change] of differences.filter(([field]) => field !== 'cases')) {
    const data = input(); writeRuns(dir, data);
    assert.equal((await cli(['report', '--runs', ids.join(',')], env)).code, 0);
    change(data.runs[1]); writeRuns(dir, data);
    const before = snapshot(dir);
    const result = await cli(['report', '--runs', ids.join(','), '--persona', dir], env);
    assert.deepEqual(result, { code: 1, stdout: '', stderr: `eval report: runs differ in ${field}\n` });
    assert.deepEqual(snapshot(dir), before);
  }
  const data = input(); data.runs[1].run.limit = 1; writeRuns(dir, data);
  const before = snapshot(dir);
  assert.deepEqual(await cli(['report', '--runs', ids.join(',')], env),
    { code: 1, stdout: '', stderr: 'eval report: runs differ in cases\n' });
  assert.deepEqual(snapshot(dir), before);
});

test('CLI rejects invalid lists, conflicting options, unknown options and unknown runs without writes', async (t) => {
  const { dir, env } = fixture(t); writeRuns(dir, input());
  for (const args of [
    ['--runs', ids[0]], ['--runs', `${ids[0]},${ids[0]}`], ['--runs', `${ids[0]},`], ['--runs'],
    ['--run', ids[0], '--runs', ids.join(',')], ['--runs', ids.join(','), '--run', ids[0]],
    ['--runs', ids.join(','), '--runs', ids.join(',')], ['--runs', ids.join(','), '--unknown', 'value'],
  ]) {
    const before = snapshot(dir);
    const result = await cli(['report', ...args], env);
    assert.equal(result.code, 2, JSON.stringify(args));
    assert.match(result.stderr, /^Usage:/); assert.equal(result.stdout, '');
    assert.deepEqual(snapshot(dir), before);
  }
  for (const id of ['2026-10-14-99', '../escape']) {
    const before = snapshot(dir);
    assert.deepEqual(await cli(['report', '--runs', `${ids[0]},${id}`], env),
      { code: 1, stdout: '', stderr: 'eval report: unknown run\n' });
    assert.deepEqual(snapshot(dir), before);
  }
});

test('missing case inventory refuses without writes; missing draft or support files cannot pass', async (t) => {
  const { dir, env } = fixture(t);
  const data = input();
  writeRuns(dir, data);
  fs.unlinkSync(path.join(dir, 'cases.jsonl'));
  const before = snapshot(dir);
  const refused = await cli(['report', '--runs', ids.join(',')], env);
  assert.equal(refused.code, 1);
  assert.equal(refused.stdout, '');
  assert.deepEqual(snapshot(dir), before);
  for (const file of ['drafts', 'support']) {
    writeRuns(dir, data);
    fs.unlinkSync(path.join(dir, 'evals', ids[0], `${file}.jsonl`));
    const result = await cli(['report', '--runs', ids.join(',')], env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(store.readJson(dir, `evals/reliability/${ids.join('+')}.json`).status, 'incomplete');
  }
});

test('three real eval runs with recording fake hosts produce a passing CLI reliability report', async (t) => {
  const { dir, env } = fixture(t);
  const calls = [];
  const hosts = { get(host) { return { async run(input) {
    calls.push({ host, ...input });
    return { model: 'fake-returned', text: input.outputSchema === support.outputSchema
      ? JSON.stringify({ verdict: 'supported', reason: 'Synthetic support.' })
      : input.outputSchema ? JSON.stringify({ rating: 'send_as_is', reason: 'Synthetic reason.', claims: [],
        wrong_uncited: 0, language_match: true }) : 'Cloudberry Lantern uses Akari. [demo.model.provider]' };
  } }; } };
  const runIds = [];
  for (let index = 0; index < 3; index++) {
    runIds.push((await evalRun.run(dir, { env, drafter: 'fake', judge: 'fake', hosts })).run_id);
  }
  store.writeJson(dir, 'coverage.json', { ...input().coverage, kb_digest_hash: kb.digest(kb.load(kb.resolve({ name: 'demo', env }))).hash,
    cases: { 'sample-13': { coverage: 'C', entries: ['demo.model.provider'] } } });
  const result = await cli(['report', '--runs', runIds.join(',')], env);
  assert.equal(result.code, 0, result.stderr);
  const value = store.readJson(dir, `evals/reliability/${runIds.join('+')}.json`);
  assert.equal(value.status, 'pass');
  assert.deepEqual(value.counts, { stable_pass: 1, stable_fail: 0, unstable: 0, incomplete: 0 });
  assert.ok(value.per_run.every((row) => row.send_as_is_rate === 1 && row.kb_gates_status === 'pass'));
  assert.equal(calls.filter((call) => call.outputSchema === support.outputSchema).length, 3);
});
