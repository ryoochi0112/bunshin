'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const report = require('../lib/report');
const store = require('../lib/store');
const command = require('../lib/commands/eval');
const hosts = require('../lib/hosts');
const evalRun = require('../lib/eval-run');
const examples = require('../lib/examples');
const examplesCommand = require('../lib/commands/examples');

const root = path.join(__dirname, '..');
const persona = store.readJson(path.join(root, 'sample', 'persona'), 'persona.json');
const run = { run_id: '2026-10-20-01', persona_version: 7, drafter: { host: 'fake', model: null },
  judge: { host: 'fake', model: null }, started_at: '2026-10-20T00:00:00.000Z', limit: null };

function input(k = 24, j = 18, ks = 14, js = 8) {
  const drafts = ['knowledge', 'judgment'].flatMap((layer, index) => Array.from({ length: index ? j : k }, (_, n) => ({
    case_id: `${layer}-${n}`, layer, skill: index ? 'idea-discussion' : 'spec-answer', draft: 'Synthetic draft.',
    drafter: { host: 'fake', model: 'draft-model' }, at: run.started_at,
  })));
  const judgments = drafts.map((draft, index) => ({ case_id: draft.case_id,
    rating: index < k ? index < ks ? 'send_as_is' : 'needs_edits' : index - k < js ? 'send_as_is' : 'needs_edits',
    reason: 'Synthetic comparison.', claims: [], wrong_uncited: 0, language_match: true,
    judge: { host: 'fake', model: 'judge-model' }, at: run.started_at,
  }));
  return { persona: structuredClone(persona), cases: drafts.map((draft) => ({ id: draft.case_id, layer: draft.layer })),
    drafts, judgments, ratings: [], calibration: { match: 26, rated: 30 }, previous: null, run: structuredClone(run) };
}

function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-report-')));
  const dir = path.join(home, 'fictional');
  fs.cpSync(path.join(root, 'sample', 'persona'), dir, { recursive: true });
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); store._resetGuardCache(); });
  return { home, dir };
}

function save(dir, data) {
  const base = `evals/${data.run.run_id}`;
  store.writeJson(dir, `${base}/run.json`, data.run);
  store.writeJsonl(dir, 'cases.jsonl', data.cases);
  store.writeJsonl(dir, `${base}/drafts.jsonl`, data.drafts);
  store.writeJsonl(dir, `${base}/judgments.jsonl`, data.judgments);
}

async function cli(args, home) {
  let stdout = '';
  let stderr = '';
  const code = await command.run(args, { env: { BUNSHIN_HOME: home },
    stdout: { write(text) { stdout += text; } }, stderr: { write(text) { stderr += text; } } });
  return { code, stdout, stderr };
}

test('golden report reproduces spec §3 with synthetic names and host models', () => {
  const data = input();
  data.previous = { knowledge: { send_as_is_rate: 0.50 }, judgment: { send_as_is_rate: 0.41 } };
  const before = structuredClone(data);
  const value = report.build(data);
  assert.deepEqual(data, before, 'build is pure');
  assert.deepEqual(report.build(data), value);
  assert.equal(report.renderMarkdown(value), [
    'bunshin eval — persona sample @ v7 — 2026-10-20',
    'held-out: 42 pairs (knowledge 24, judgment 18)',
    'knowledge: send as-is 58% (+8) · wrong fact without citation 0',
    'judgment:  send as-is 44% (+3)',
    'overall:   send as-is 52%  → launch bar MET',
    'judge agreement with Sora Aoki: 26/30 (87%) → trusted',
    'drafter: fake draft-model · judge: fake judge-model',
    'judge examples: none · 1-call vote', '',
  ].join('\n'));
});

test('judge examples line shows counts and vote size, or none', () => {
  const render = (extra) => report.renderMarkdown(report.build({ ...input(), run: { ...run, ...extra } })).split('\n');
  const at = (lines) => lines[lines.indexOf(lines.find((line) => line.startsWith('drafter: '))) + 1];
  const labels = { send_as_is: 7, needs_edits: 4, wrong: 1 };
  assert.equal(at(render({ judge_examples: { n: 12, labels }, judge_votes: 3 })),
    'judge examples: 12 (send_as_is 7 · needs_edits 4 · wrong 1) · 3-call vote');
  assert.equal(at(render({ judge_examples: null, judge_votes: 3 })), 'judge examples: none · 3-call vote');
  assert.equal(at(render({})), 'judge examples: none · 1-call vote');
  const value = report.build({ ...input(), run: { ...run, judge_examples: { n: 2, labels }, judge_votes: 3 } });
  assert.deepEqual([value.judge_examples.n, value.judge_votes], [2, 3]);
});

test('judge examples line counts reasons when run.json records them; legacy runs keep the old line', () => {
  const render = (extra) => report.renderMarkdown(report.build({ ...input(), run: { ...run, ...extra } })).split('\n');
  const at = (lines) => lines[lines.indexOf(lines.find((line) => line.startsWith('drafter: '))) + 1];
  const labels = { send_as_is: 11, needs_edits: 1, wrong: 0 };
  assert.equal(at(render({ judge_examples: { hash: 'aaaaaaaaaaaaaaaa', n: 12, labels, reasons: 3 }, judge_votes: 3 })),
    'judge examples: 12 (send_as_is 11 · needs_edits 1 · wrong 0 · reasons 3) · 3-call vote');
  assert.equal(at(render({ judge_examples: { hash: 'aaaaaaaaaaaaaaaa', n: 12, labels, reasons: 0 }, judge_votes: 3 })),
    'judge examples: 12 (send_as_is 11 · needs_edits 1 · wrong 0 · reasons 0) · 3-call vote');
  assert.equal(at(render({ judge_examples: { hash: 'aaaaaaaaaaaaaaaa', n: 12, labels }, judge_votes: 3 })),
    'judge examples: 12 (send_as_is 11 · needs_edits 1 · wrong 0) · 3-call vote');
  const value = report.build({ ...input(), run: { ...run, judge_examples: { hash: 'aaaaaaaaaaaaaaaa', n: 12, labels, reasons: 3 }, judge_votes: 3 } });
  assert.deepEqual(value.judge_examples, { hash: 'aaaaaaaaaaaaaaaa', n: 12, labels, reasons: 3 });
});

test('AC8: a report after 3 marker reasons counts them and contains no reason text', async (t) => {
  const { home, dir } = fixture(t);
  const at = '2026-10-07T00:00:00.000Z';
  const chosen = examples.selectSet(dir, { seed: '0123456789abcdef', n: 12 });
  store.writeJson(dir, 'judge-examples/set.json', { format_version: 1, seed: '0123456789abcdef', n: 12,
    pair_ids: chosen.map((pair) => pair.id), drafter: { host: 'fake', model: null }, created_at: at });
  store.writeJsonl(dir, 'judge-examples/examples.jsonl', chosen.map((pair, i) => ({ pair_id: pair.id, layer: pair.layer, position: i + 1,
    question: { author: pair.question.author, text: `Example question ${i + 1}.` }, context: [{ author: 'ann', text: `Example context ${i + 1}.` }],
    reference_answer: `Example answer ${i + 1}.`, draft: `Example draft ${i + 1}.`, drafter: { host: 'fake', model: null }, drafted_at: at })));
  const markers = ['REPORT-REASON-A', 'REPORT-REASON-B', 'REPORT-REASON-C'];
  for (const [i, pair] of chosen.entries()) {
    const args = ['rate', pair.id, i === 4 ? 'needs_edits' : 'send_as_is', ...(i < 3 ? ['--reason', markers[i]] : []), '--persona', dir];
    const out = { write() {} };
    assert.equal(await examplesCommand.run(args, { env: { BUNSHIN_HOME: home }, stdout: out, stderr: out }), 0);
  }
  const adapters = { get(host) { return { async run(input) {
    return { text: input.tools === 'none' ? JSON.stringify({ rating: 'send_as_is', reason: 'Synthetic reason.', claims: [], wrong_uncited: 0, language_match: true }) : 'Synthetic draft.', model: `${host}-model` };
  } }; } };
  const result = await evalRun.run(dir, { drafter: 'fake', judge: 'fake', limit: 1, hosts: adapters });
  const shown = await cli(['report', '--run', result.run_id, '--persona', dir], home);
  assert.equal(shown.code, 0, shown.stderr);
  const markdown = fs.readFileSync(path.join(dir, 'evals', result.run_id, 'report.md'), 'utf8');
  const json = fs.readFileSync(path.join(dir, 'evals', result.run_id, 'report.json'), 'utf8');
  assert.ok(markdown.split('\n').some((line) => line === 'judge examples: 12 (send_as_is 11 · needs_edits 1 · wrong 0 · reasons 3) · 3-call vote'), markdown);
  assert.equal(JSON.parse(json).judge_examples.reasons, 3);
  for (const marker of markers) {
    for (const text of [markdown, json, shown.stdout]) assert.ok(!text.includes(marker), marker);
  }
});

test('launch-bar table uses all persona thresholds and only the selected basis', () => {
  const rows = [
    ['held-out minimum', input(14, 14, 14, 14), 'sample_too_small', 'judge'],
    ['layer minimum', input(9, 25, 9, 25), 'sample_too_small', 'judge'],
    ['trusted met', input(15, 15, 8, 7), 'met', 'judge'],
    ['trusted rate below bar', input(15, 15, 7, 7), 'not_met', 'judge'],
    ['wrong uncited knowledge', input(15, 15, 15, 15), 'not_met', 'judge', (data) => { data.judgments[0].wrong_uncited = 1; }],
    ['uncalibrated few owner ratings', input(), 'sample_too_small', 'owner_ratings', (data) => { data.calibration = null; data.ratings = [{ case_id: data.drafts[0].case_id, run_id: run.run_id, rating: 'send_as_is' }]; }],
    ['untrusted enough owner ratings', input(15, 15, 15, 15), 'not_met', 'owner_ratings', (data) => {
      data.calibration = { match: 23, rated: 30 };
      data.ratings = data.drafts.map((draft) => ({ case_id: draft.case_id, run_id: run.run_id, rating: 'wrong' }));
      data.ratings.push(...data.drafts.map((draft) => ({ case_id: draft.case_id, run_id: '2026-10-19-01', rating: 'send_as_is' })));
    }],
    ['judge errors excluded', input(15, 15, 15, 15), 'sample_too_small', 'judge', (data) => {
      data.judgments[0] = { case_id: data.drafts[0].case_id, rating: 'judge_error', reason: 'invalid judge output', judge: run.judge, at: run.started_at };
    }],
    ['changed held-out threshold', input(14, 14, 14, 14), 'met', 'judge', (data) => { data.persona.launch_bar.min_heldout = 28; }],
    ['changed per-layer threshold', input(9, 25, 9, 25), 'met', 'judge', (data) => { data.persona.launch_bar.min_per_layer = 9; }],
    ['changed rate threshold', input(15, 15, 8, 7), 'not_met', 'judge', (data) => { data.persona.launch_bar.send_as_is = 0.51; }],
    ['changed agreement threshold', input(), 'sample_too_small', 'owner_ratings', (data) => { data.persona.launch_bar.min_agreement = 0.9; }],
    ['trust requires 30 ratings', input(), 'sample_too_small', 'owner_ratings', (data) => { data.calibration = { match: 29, rated: 29 }; }],
  ];
  for (const [name, data, status, basis, change] of rows) {
    if (change) change(data);
    const value = report.build(data);
    assert.equal(value.launch_bar, status, name);
    assert.equal(value.basis, basis, name);
    if (name === 'judge errors excluded') { assert.equal(value.knowledge.n, 14); assert.equal(value.judge_errors, 1); }
    if (name === 'untrusted enough owner ratings') { assert.equal(value.overall_rate, 1); assert.equal(value.bar_n, 30); }
  }
});

test('owner wrong facts count only knowledge; owner bar can pass despite judge scores', () => {
  const data = input(15, 15, 0, 0);
  data.calibration = null;
  data.ratings = data.drafts.map((draft) => ({ case_id: draft.case_id, run_id: run.run_id, rating: 'send_as_is', wrong_uncited_fact: draft.layer === 'judgment' }));
  assert.equal(report.build(data).launch_bar, 'met');
  data.ratings[0].wrong_uncited_fact = true;
  assert.equal(report.build(data).launch_bar, 'not_met');
});

test('errors, unjudged cases, models, null rates and rounded deltas render exactly', () => {
  const data = input(3, 0, 1, 0);
  data.calibration = null;
  data.judgments[1] = { case_id: data.drafts[1].case_id, rating: 'judge_error', reason: 'invalid judge output', judge: { host: 'fake', model: null }, at: run.started_at };
  data.judgments.pop();
  data.drafts[1].drafter.model = null;
  data.previous = { knowledge: { send_as_is_rate: 1 }, judgment: { send_as_is_rate: 0.8 } };
  const value = report.build(data);
  assert.equal(value.knowledge.n, 1);
  assert.equal(value.judgment.send_as_is_rate, null);
  assert.equal(value.unjudged, 1);
  assert.equal(value.judge_errors, 1);
  const text = report.renderMarkdown(value);
  assert.match(text, /knowledge: send as-is 100% \(\+0\)/);
  assert.match(text, /judgment:  send as-is n\/a\n/);
  assert.match(text, /drafter: fake draft-model, default · judge: fake judge-model, default/);
  assert.ok(text.endsWith("judge errors: 1 (excluded from rates)\nnot judged: 1\nincomplete: 2 of 3 held-out cases drafted and judged — no launch-bar claim\nlaunch bar basis: Sora Aoki's ratings (0 rated)\n"));
  data.judgments[0].rating = 'wrong';
  data.previous.knowledge.send_as_is_rate = 0.034;
  assert.match(report.renderMarkdown(report.build(data)), /0% \(-3\)/);
  data.previous.knowledge.send_as_is_rate = null;
  assert.equal(report.build(data).delta.knowledge, null);
  data.previous = null;
  assert.doesNotMatch(report.renderMarkdown(report.build(data)), /\([+-]\d+\)/);
});

test('report CLI selects numeric latest run and latest earlier report, and reruns idempotently', async (t) => {
  const { home, dir } = fixture(t);
  for (const id of ['2026-10-19-999', '2026-10-20-09', '2026-10-20-99', '2026-10-20-100', '2026-10-20-101', '2026-10-21-01']) {
    const data = input(); data.run.run_id = id; save(dir, data);
  }
  store.writeJson(dir, 'evals/2026-10-20-09/report.json', { knowledge: { send_as_is_rate: 0 }, judgment: { send_as_is_rate: 0 } });
  store.writeJson(dir, 'evals/2026-10-20-99/report.json', { knowledge: { send_as_is_rate: 0.50 }, judgment: { send_as_is_rate: 0.41 } });
  store.writeJson(dir, 'evals/2026-10-21-01/report.json', { knowledge: { send_as_is_rate: 1 }, judgment: { send_as_is_rate: 1 } });
  const args = ['report', '--run', '2026-10-20-101'];
  const result = await cli(args, home);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /58% \(\+8\)/);
  assert.match(result.stdout, /44% \(\+3\)/);
  assert.equal(store.readJson(dir, 'evals/2026-10-20-101/report.json').run_id, '2026-10-20-101');
  const target = path.join(dir, 'evals', '2026-10-20-101', 'report.md');
  assert.equal(fs.readFileSync(target, 'utf8'), result.stdout);
  fs.unlinkSync(target); // Crash after report.json: rerun restores the second file.
  assert.deepEqual(await cli(args, home), result);
  assert.equal(fs.readFileSync(target, 'utf8'), result.stdout);
  assert.match((await cli(['report'], home)).stdout, /2026-10-21/);
  fs.rmSync(path.join(dir, 'evals', '2026-10-21-01'), { recursive: true });
  assert.equal((await cli(['report'], home)).code, 0);
  assert.equal(store.readJson(dir, 'evals/2026-10-20-101/report.json').run_id, '2026-10-20-101');
});

test('empty run writes reports; malformed and unknown run ids refuse without persona text', async (t) => {
  const { home, dir } = fixture(t);
  assert.deepEqual(await cli(['report'], home), { code: 1, stdout: '', stderr: 'eval report: unknown run\n' });
  save(dir, input(0, 0));
  const result = await cli(['report'], home);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /overall:   send as-is n\/a  → sample too small/);
  assert.match(result.stdout, /drafter: fake default · judge: fake default/);
  assert.equal(store.readJson(dir, `evals/${run.run_id}/report.json`).launch_bar, 'sample_too_small');
  // Existing directories with junk on either side must still be refused by validation.
  for (const id of ['x2026-10-20-01', '2026-10-20-01x', '2026-10-20-1']) {
    const data = input(0, 0); data.run.run_id = id; save(dir, data);
  }
  for (const id of ['2026-10-20-02', '../escape', 'x2026-10-20-01', '2026-10-20-01x', '2026-10-20-1']) {
    assert.deepEqual(await cli(['report', '--run', id], home), { code: 1, stdout: '', stderr: 'eval report: unknown run\n' });
  }
  for (const args of [['report', '--run'], ['report', '--run', '--persona']]) assert.equal((await cli(args, home)).code, 1);
  for (const args of [[], ['report', '--judge', 'fake'], ['report', '--persona'], ['report', '--run', run.run_id, '--run', run.run_id]]) {
    const value = await cli(args, home);
    assert.equal(value.code, 2); assert.match(value.stderr, /bunshin eval report/);
  }
});

test('eval run appends same report after summary; host errors write no report', async (t) => {
  const { home, dir } = fixture(t);
  const result = await cli(['run', '--drafter', 'fake', '--judge', `fake:${path.join(__dirname, 'fixtures', 'hosts', 'judge-replies.json')}`, '--limit', '1'], home);
  assert.equal(result.code, 0, result.stderr);
  const id = fs.readdirSync(path.join(dir, 'evals'))[0];
  const markdown = fs.readFileSync(path.join(dir, 'evals', id, 'report.md'), 'utf8');
  assert.equal(result.stdout, `run ${id}: drafted 1, judged 1, judge errors 0\n${markdown}`);
  assert.equal((await cli(['report', '--run', id], home)).stdout, markdown);
  const get = hosts.get;
  hosts.get = () => ({ async run() { throw new Error('Synthetic private host failure longer than twenty four characters'); } });
  try {
    const failed = await cli(['run', '--drafter', 'fake', '--judge', 'fake'], home);
    assert.equal(failed.code, 1); assert.equal(failed.stdout, '');
    assert.doesNotMatch(failed.stderr, /Synthetic private host failure longer than twenty four characters/);
    const last = fs.readdirSync(path.join(dir, 'evals')).sort().at(-1);
    for (const file of ['report.json', 'report.md']) assert.equal(fs.existsSync(path.join(dir, 'evals', last, file)), false);
  } finally { hosts.get = get; }
});

test('spawned eval report uses temp BUNSHIN_HOME and a copy of the sample', (t) => {
  const { home, dir } = fixture(t);
  save(dir, input());
  const env = { ...process.env, BUNSHIN_HOME: home }; delete env.BUNSHIN_PERSONA;
  const result = spawnSync(process.execPath, [path.join(root, 'bin', 'bunshin.js'), 'eval', 'report'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
  assert.equal(result.stdout, fs.readFileSync(path.join(dir, 'evals', run.run_id, 'report.md'), 'utf8'));
});


test('a failed Markdown write leaves JSON persisted and rerun repairs both in order', async (t) => {
  const { home, dir } = fixture(t);
  save(dir, input());
  const writeJson = store.writeJson;
  const writeText = store.writeText;
  const calls = [];
  store.writeJson = (...args) => { calls.push('json'); return writeJson(...args); };
  store.writeText = () => { calls.push('markdown'); throw new Error('simulated Markdown interruption'); };
  try {
    const result = await cli(['report'], home);
    assert.equal(result.code, 1);
    assert.equal(result.stderr, 'simulated Markdown interruption\n');
    assert.equal(result.stdout, '');
    assert.deepEqual(calls, ['json', 'markdown']);
    assert.equal(store.readJson(dir, `evals/${run.run_id}/report.json`).run_id, run.run_id);
    assert.equal(fs.existsSync(path.join(dir, 'evals', run.run_id, 'report.md')), false);
  } finally { store.writeJson = writeJson; store.writeText = writeText; }
  const result = await cli(['report'], home);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(dir, 'evals', run.run_id, 'report.md'), 'utf8'), result.stdout);
});

test('report CLI wires calibration, latest owner ratings and persona agreement threshold', async (t) => {
  const { home, dir } = fixture(t);
  const data = input(15, 15, 15, 15);
  data.persona.launch_bar.min_agreement = 0.9;
  data.persona.launch_bar.min_heldout = 2;
  data.persona.launch_bar.min_per_layer = 1;
  store.writeJson(dir, 'persona.json', data.persona);
  save(dir, data);
  const spawned = () => {
    const env = { ...process.env, BUNSHIN_HOME: home }; delete env.BUNSHIN_PERSONA;
    return spawnSync(process.execPath, [path.join(root, 'bin/bunshin.js'), 'eval', 'report'], { env, encoding: 'utf8' });
  };
  const uncalibrated = await cli(['report'], home);
  assert.equal(uncalibrated.code, 0);
  assert.match(uncalibrated.stdout, /not calibrated → uncalibrated/);
  assert.equal(spawned().stdout, uncalibrated.stdout);
  const rows = data.drafts.map((draft) => ({ case_id: draft.case_id, run_id: run.run_id, rating: 'send_as_is', rated_at: run.started_at }));
  const file = `calibration/${run.run_id}/ratings.jsonl`;
  store.writeJsonl(dir, file, rows);
  const trusted = await cli(['report'], home);
  assert.equal(trusted.code, 0);
  assert.match(trusted.stdout, /30\/30 \(100%\) → trusted/);
  assert.equal(store.readJson(dir, `evals/${run.run_id}/report.json`).basis, 'judge');
  assert.equal(spawned().stdout, trusted.stdout);
  // 26/30 would meet the default threshold; this persona requires 90%.
  store.writeJsonl(dir, file, [...rows, ...rows.slice(0, 4).map((row) => ({ ...row, rating: 'needs_edits' }))]);
  const untrusted = await cli(['report'], home);
  assert.equal(untrusted.code, 0);
  assert.match(untrusted.stdout, /26\/30 \(87%\) → untrusted/);
  assert.match(untrusted.stdout, /launch bar basis: Sora Aoki's ratings \(30 rated\)/);
  const value = store.readJson(dir, `evals/${run.run_id}/report.json`);
  assert.equal(value.basis, 'owner_ratings');
  assert.equal(value.bar_n, 30);
  assert.equal(value.launch_bar, 'met');
  const result = spawned(); assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, untrusted.stdout);
});

function limited(n, drafted, mutate = () => {}) {
  const data = input(Math.ceil(n / 2), Math.floor(n / 2), 0, 0);
  data.cases = data.drafts.map((draft) => ({ id: draft.case_id, layer: draft.layer }));
  data.drafts = data.drafts.slice(0, drafted);
  data.judgments = data.judgments.slice(0, drafted).map((row) => ({ ...row, rating: 'send_as_is' }));
  mutate(data);
  return data;
}

test('limited run never claims the launch bar and counts held-out from cases', () => {
  const data = input(50, 50, 50, 50);
  data.drafts = [...data.drafts.slice(0, 20), ...data.drafts.slice(50, 70)];
  data.judgments = data.drafts.map((draft) => data.judgments.find((row) => row.case_id === draft.case_id));
  data.run.limit = 40;
  const value = report.build(data);
  assert.equal(value.heldout.n, 100);
  assert.deepEqual([value.heldout.knowledge, value.heldout.judgment], [50, 50]);
  assert.equal(value.undrafted, 60);
  assert.equal(value.launch_bar, 'sample_too_small');
  assert.equal(value.complete, false);
  const text = report.renderMarkdown(value);
  assert.match(text, /held-out: 100 pairs \(knowledge 50, judgment 50\)/);
  assert.match(text, /not drafted: 60\n/);
  assert.match(text, /incomplete: 40 of 100 held-out cases drafted and judged — no launch-bar claim\n/);
});

test('each completeness clause independently blocks the launch bar', () => {
  const full = limited(60, 60);
  assert.equal(report.build(full).launch_bar, 'met');
  assert.equal(report.build(full).complete, true);
  // undrafted only
  const undrafted = limited(60, 59, (data) => { data.judgments = data.judgments.slice(0, 59); });
  undrafted.calibration = { match: 30, rated: 30 };
  assert.equal(report.build(undrafted).launch_bar, 'sample_too_small');
  assert.equal(report.build(undrafted).unjudged, 0);
  // unjudged only (drafted, not judged)
  const unjudged = limited(60, 60, (data) => { data.judgments.pop(); });
  assert.equal(report.build(unjudged).undrafted, 0);
  assert.equal(report.build(unjudged).unjudged, 1);
  assert.equal(report.build(unjudged).launch_bar, 'sample_too_small');
  // judge_error row counts as judged for coverage
  const errored = limited(60, 60, (data) => { data.judgments[0] = { case_id: data.drafts[0].case_id, rating: 'judge_error', reason: 'x', judge: run.judge, at: run.started_at }; });
  assert.equal(report.build(errored).complete, true);
  // limit set while numerically covering every case
  const withLimit = limited(60, 60, (data) => { data.run.limit = 60; });
  assert.equal(report.build(withLimit).launch_bar, 'sample_too_small');
  assert.match(report.renderMarkdown(report.build(withLimit)), /incomplete: 60 of 60 held-out/);
});

test('interrupted run with null limit reports not drafted and incomplete', () => {
  const value = report.build(limited(100, 40));
  assert.equal(value.run_id, run.run_id);
  assert.equal(value.heldout.n, 100);
  assert.equal(value.undrafted, 60);
  assert.equal(value.launch_bar, 'sample_too_small');
  const text = report.renderMarkdown(value);
  assert.match(text, /not drafted: 60\n/);
  assert.match(text, /incomplete: 40 of 100 held-out cases drafted and judged — no launch-bar claim\n/);
  assert.doesNotMatch(text, /not judged/);
});

test('spawned eval report on a saved partial run prints incomplete and sample too small', (t) => {
  const { home, dir } = fixture(t);
  save(dir, limited(100, 40));
  const env = { ...process.env, BUNSHIN_HOME: home }; delete env.BUNSHIN_PERSONA;
  const result = spawnSync(process.execPath, [path.join(root, 'bin', 'bunshin.js'), 'eval', 'report'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /held-out: 100 pairs/);
  assert.match(result.stdout, /→ sample too small/);
  assert.match(result.stdout, /incomplete: 40 of 100 held-out cases drafted and judged — no launch-bar claim/);
  assert.equal(store.readJson(dir, `evals/${run.run_id}/report.json`).launch_bar, 'sample_too_small');
});
