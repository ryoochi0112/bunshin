'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const store = require('../lib/store');
const evalRun = require('../lib/eval-run');
const judge = require('../lib/judge');
const evalCommand = require('../lib/commands/eval');
const calibrateCommand = require('../lib/commands/calibrate');

const root = path.join(__dirname, '..');
const verdict = { rating: 'send_as_is', reason: 'Synthetic reason.', claims: [], wrong_uncited: 0, language_match: true };

function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-trust-')));
  const dir = path.join(home, 'fictional');
  fs.cpSync(path.join(root, 'sample', 'persona'), dir, { recursive: true });
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); store._resetGuardCache(); });
  return { home, dir };
}

function recording(rating = 'send_as_is') {
  const calls = [];
  return { calls, get(host) { return { async run(input) {
    calls.push({ host, tools: input.tools });
    return { text: input.tools === 'none' ? JSON.stringify({ ...verdict, rating }) : 'Synthetic draft.', model: `${host}-model` };
  } }; } };
}

function io(home) {
  const out = { stdout: '', stderr: '' };
  return { out, value: { env: { BUNSHIN_HOME: home },
    stdout: { write(text) { out.stdout += text; } }, stderr: { write(text) { out.stderr += text; } } } };
}

function rateAll(dir, runId, rating) {
  const rows = store.readJsonl(dir, `evals/${runId}/drafts.jsonl`)
    .map((row) => ({ case_id: row.case_id, run_id: runId, rating, rated_at: '2026-10-20T00:00:00.000Z' }));
  store.writeJsonl(dir, `calibration/${runId}/ratings.jsonl`, rows);
  return rows.length;
}

// Copies a run's drafts, judgments and ratings until it has at least 30 ratings.
function padRatings(dir, runId) {
  const drafts = store.readJsonl(dir, `evals/${runId}/drafts.jsonl`);
  const judgments = store.readJsonl(dir, `evals/${runId}/judgments.jsonl`);
  const ratings = store.readJsonl(dir, `calibration/${runId}/ratings.jsonl`);
  const copies = Math.ceil(30 / drafts.length);
  const extend = (rows) => Array.from({ length: copies }, (_, n) => rows.map((row) => ({ ...row, case_id: `${row.case_id}-${n}` }))).flat();
  store.writeJsonl(dir, `evals/${runId}/drafts.jsonl`, extend(drafts));
  store.writeJsonl(dir, `evals/${runId}/judgments.jsonl`, extend(judgments));
  store.writeJsonl(dir, `calibration/${runId}/ratings.jsonl`, extend(ratings));
}

test('rubric hash is stable, matches the stripped template and changes with the text', () => {
  const text = judge.rubric();
  assert.ok(!text.startsWith('---'));
  assert.match(judge.rubricHash(), /^[0-9a-f]{16}$/);
  assert.equal(judge.rubricHash(), judge.rubricHash(text));
  assert.notEqual(judge.rubricHash(`${text}\nOne more rule.`), judge.rubricHash());
});

test('judge rubric defines every rating and keeps unverifiable claims neutral', () => {
  const text = judge.rubric();
  for (const rating of ['send_as_is:', 'needs_edits:', 'wrong:']) assert.ok(text.includes(rating), rating);
  assert.match(text, /not the only\s+acceptable answer/);
  assert.match(text, /correct null never lowers the rating/);
});

test('new runs record the rubric hash and refuse to resume under a different rubric', async (t) => {
  const { dir } = fixture(t);
  const result = await evalRun.run(dir, { drafter: 'fake', judge: 'fake', limit: 1, hosts: recording() });
  const file = `evals/${result.run_id}/run.json`;
  assert.equal(store.readJson(dir, file).judge_rubric, judge.rubricHash());
  store.writeJson(dir, file, { ...store.readJson(dir, file), judge_rubric: '0000000000000000' });
  await assert.rejects(evalRun.run(dir, { runId: result.run_id, hosts: recording() }), /judge rubric differs from run/);
});

test('rejudge copies drafts, calls only the judge and survives a persona version change', async (t) => {
  const { dir } = fixture(t);
  const source = await evalRun.run(dir, { drafter: 'fake', judge: 'fake', hosts: recording() });
  const persona = store.readJson(dir, 'persona.json');
  store.writeJson(dir, 'persona.json', { ...persona, version: persona.version + 1 });
  const adapters = recording('wrong');
  const result = await evalRun.run(dir, { rejudgeFrom: source.run_id, judge: 'fake', hosts: adapters });
  assert.equal(result.drafted, 0);
  assert.ok(result.judged > 0);
  assert.ok(adapters.calls.every((call) => call.tools === 'none'));
  const config = store.readJson(dir, `evals/${result.run_id}/run.json`);
  assert.equal(config.rejudged_from, source.run_id);
  assert.equal(config.persona_version, persona.version);
  assert.equal(config.judge_rubric, judge.rubricHash());
  assert.deepEqual(store.readJsonl(dir, `evals/${result.run_id}/drafts.jsonl`), store.readJsonl(dir, `evals/${source.run_id}/drafts.jsonl`));
  assert.ok(store.readJsonl(dir, `evals/${result.run_id}/judgments.jsonl`).every((row) => row.rating === 'wrong'));
  const resumed = await evalRun.run(dir, { runId: result.run_id, hosts: recording() });
  assert.deepEqual([resumed.drafted, resumed.judged], [0, 0]);
});

test('rejudge refuses drafting options and unknown or empty sources', async (t) => {
  const { dir } = fixture(t);
  for (const opts of [{ drafter: 'fake' }, { limit: 1 }, { runId: '2026-10-20-01' }]) {
    await assert.rejects(evalRun.run(dir, { rejudgeFrom: '2026-10-20-01', ...opts, hosts: recording() }), /takes only --judge/);
  }
  await assert.rejects(evalRun.run(dir, { rejudgeFrom: '2026-10-20-01', hosts: recording() }), /unknown source run/);
  await assert.rejects(evalRun.run(dir, { rejudgeFrom: '../x', hosts: recording() }), /unknown source run/);
  store.writeJson(dir, 'evals/2026-10-20-01/run.json', { run_id: '2026-10-20-01', persona_version: 1 });
  store.writeJsonl(dir, 'evals/2026-10-20-01/drafts.jsonl', []);
  await assert.rejects(evalRun.run(dir, { rejudgeFrom: '2026-10-20-01', hosts: recording() }), /no drafts/);
});

test('reports inherit trust only from a calibrated run with the same judge setup', async (t) => {
  const { home, dir } = fixture(t);
  const calibrated = await evalRun.run(dir, { drafter: 'fake', judge: 'fake', hosts: recording() });
  rateAll(dir, calibrated.run_id, 'send_as_is');
  padRatings(dir, calibrated.run_id);
  const later = await evalRun.run(dir, { drafter: 'fake', judge: 'fake', hosts: recording() });
  const { out, value } = io(home);
  assert.equal(await evalCommand.run(['report', '--run', later.run_id], value), 0, out.stderr);
  const inherited = store.readJson(dir, `evals/${later.run_id}/report.json`);
  assert.equal(inherited.trust_from, calibrated.run_id);
  assert.equal(inherited.judge_trust, 'trusted');
  assert.equal(inherited.basis, 'judge');
  assert.match(out.stdout, new RegExp(`→ trusted \\(from run ${calibrated.run_id}\\)`));

  // A different rubric hash, judge model or missing hash never shares trust.
  const cases = [
    (config) => ({ ...config, judge_rubric: '0000000000000000' }),
    (config) => ({ ...config, judge: { host: 'fake', model: 'other' } }),
    ({ judge_rubric: _, ...config }) => config,
  ];
  for (const change of cases) {
    const file = `evals/${later.run_id}/run.json`;
    const original = store.readJson(dir, file);
    store.writeJson(dir, file, change(original));
    assert.equal(await evalCommand.run(['report', '--run', later.run_id], io(home).value), 0);
    const report = store.readJson(dir, `evals/${later.run_id}/report.json`);
    assert.deepEqual([report.judge_trust, report.trust_from, report.basis], ['uncalibrated', null, 'owner_ratings']);
    store.writeJson(dir, file, original);
  }
  const file = `evals/${later.run_id}/judgments.jsonl`;
  store.writeJsonl(dir, file, store.readJsonl(dir, file).map((row) => ({ ...row, judge: { ...row.judge, model: 'swapped' } })));
  assert.equal(await evalCommand.run(['report', '--run', later.run_id], io(home).value), 0);
  assert.equal(store.readJson(dir, `evals/${later.run_id}/report.json`).trust_from, null);
});

test('runs without a rubric hash or a reported judge model never share trust', async (t) => {
  const { home, dir } = fixture(t);
  const calibrated = await evalRun.run(dir, { drafter: 'fake', judge: 'fake', hosts: recording() });
  rateAll(dir, calibrated.run_id, 'send_as_is');
  padRatings(dir, calibrated.run_id);
  const later = await evalRun.run(dir, { drafter: 'fake', judge: 'fake', hosts: recording() });
  const runs = [calibrated.run_id, later.run_id];
  const check = async () => {
    assert.equal(await evalCommand.run(['report', '--run', later.run_id], io(home).value), 0);
    const report = store.readJson(dir, `evals/${later.run_id}/report.json`);
    assert.deepEqual([report.judge_trust, report.trust_from], ['uncalibrated', null]);
  };
  for (const id of runs) {
    const { judge_rubric: _, ...config } = store.readJson(dir, `evals/${id}/run.json`);
    store.writeJson(dir, `evals/${id}/run.json`, config);
  }
  await check();
  for (const id of runs) {
    store.writeJson(dir, `evals/${id}/run.json`, { ...store.readJson(dir, `evals/${id}/run.json`), judge_rubric: judge.rubricHash() });
    const file = `evals/${id}/judgments.jsonl`;
    store.writeJsonl(dir, file, store.readJsonl(dir, file).map((row) => ({ ...row, judge: { ...row.judge, model: null } })));
  }
  await check();
});

test('own ratings take precedence over inherited trust', async (t) => {
  const { home, dir } = fixture(t);
  const calibrated = await evalRun.run(dir, { drafter: 'fake', judge: 'fake', hosts: recording() });
  rateAll(dir, calibrated.run_id, 'send_as_is');
  padRatings(dir, calibrated.run_id);
  const later = await evalRun.run(dir, { drafter: 'fake', judge: 'fake', hosts: recording() });
  rateAll(dir, later.run_id, 'wrong');
  assert.equal(await evalCommand.run(['report', '--run', later.run_id], io(home).value), 0);
  const report = store.readJson(dir, `evals/${later.run_id}/report.json`);
  assert.equal(report.trust_from, null);
  assert.equal(report.agreement.match, 0);
});

test('calibrate compare reports tuning-set agreement and re-judged runs refuse sampling', async (t) => {
  const { home, dir } = fixture(t);
  const source = await evalRun.run(dir, { drafter: 'fake', judge: 'fake', hosts: recording() });
  const rated = rateAll(dir, source.run_id, 'send_as_is');
  const rejudged = await evalRun.run(dir, { rejudgeFrom: source.run_id, judge: 'fake', hosts: recording('needs_edits') });
  const compare = io(home);
  assert.equal(calibrateCommand.run(['compare', '--run', rejudged.run_id], compare.value), 0, compare.out.stderr);
  assert.equal(compare.out.stdout, `tuning-set agreement with Sora Aoki: 0/${rated} (0%) · judge lower ${rated} · judge higher 0 — ratings from run ${source.run_id}, not used for trust\n`);
  for (const sub of ['sample', 'next']) {
    const result = io(home);
    assert.equal(calibrateCommand.run([sub, '--run', rejudged.run_id], result.value), 1);
    assert.match(result.out.stderr, /calibrate a fresh eval run instead/);
  }
  const plain = io(home);
  assert.equal(calibrateCommand.run(['compare', '--run', source.run_id], plain.value), 1);
  assert.match(plain.out.stderr, /compare needs a run made with eval run --rejudge-from/);
  const report = io(home);
  assert.equal(await evalCommand.run(['report', '--run', rejudged.run_id], report.value), 0);
  assert.match(report.out.stdout, new RegExp(`re-judged drafts from run ${source.run_id}`));
  // Same rubric as the source, so the source's ratings legitimately calibrate this judge.
  assert.equal(store.readJson(dir, `evals/${rejudged.run_id}/report.json`).trust_from, source.run_id);
});

test('eval CLI accepts --rejudge-from and lists it in usage', async (t) => {
  const { home } = fixture(t);
  const usage = io(home);
  assert.equal(await evalCommand.run(['run', '--bogus', 'x'], usage.value), 2);
  assert.match(usage.out.stderr, /eval run --rejudge-from <run_id> \[--judge <spec>\]/);
  const missing = io(home);
  assert.equal(await evalCommand.run(['run', '--rejudge-from', '2026-10-20-01'], missing.value), 1);
  assert.match(missing.out.stderr, /unknown source run/);
});
