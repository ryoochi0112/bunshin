'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const store = require('../lib/store');
const calibrate = require('../lib/calibrate');
const command = require('../lib/commands/calibrate');
const report = require('../lib/report');
const root = path.join(__dirname, '..');
const id = '2026-10-20-100';
const canary = 'Secret judge explanation exceeding twenty four characters';
function setup(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-t5-')));
  const dir = path.join(home, 'fictional');
  fs.cpSync(path.join(root, 'sample/persona'), dir, { recursive: true });
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); store._resetGuardCache(); });
  const drafts = Array.from({ length: 36 }, (_, n) => ({ case_id: `case-${n}`, layer: n % 2 ? 'judgment' : 'knowledge', draft: 'A synthetic proposal.', skill: n % 2 ? 'idea-discussion' : 'spec-answer', drafter: { host: 'fake', model: null }, at: '2026-10-20T00:00:00Z' }));
  const judgments = drafts.slice(0, 35).map((row, n) => ({ case_id: row.case_id, rating: n === 34 ? 'judge_error' : 'send_as_is', reason: canary, claims: [], wrong_uncited: 0, judge: { host: 'fake', model: null }, at: row.at }));
  store.writeJson(dir, `evals/${id}/run.json`, { run_id: id, persona_version: 1, drafter: { host: 'fake' }, judge: { host: 'fake' } });
  store.writeJsonl(dir, `evals/${id}/drafts.jsonl`, drafts);
  store.writeJsonl(dir, `evals/${id}/judgments.jsonl`, judgments);
  store.writeJsonl(dir, 'cases.jsonl', drafts.map((row) => ({ id: row.case_id, layer: row.layer, question: { author: 'someone', text: 'What should we try?' }, context: [], reference_answer: 'Try a small pilot.', permalink: 'https://example.invalid' })));
  function cli(args, spawned = false) {
    if (spawned) {
      const env = { ...process.env, BUNSHIN_HOME: home }; delete env.BUNSHIN_PERSONA;
      const result = spawnSync(process.execPath, [path.join(root, 'bin/bunshin.js'), 'calibrate', ...args], { env, encoding: 'utf8' });
      return { code: result.status, stdout: result.stdout, stderr: result.stderr };
    }
    let stdout = ''; let stderr = '';
    const code = command.run(args, { env: { BUNSHIN_HOME: home }, stdout: { write(s) { stdout += s; } }, stderr: { write(s) { stderr += s; } } });
    return { code, stdout, stderr };
  }
  return { home, dir, drafts, cli };
}
function hidden(result) {
  assert.equal(result.code, 0, result.stderr);
  for (const text of [canary, 'send_as_is', 'rating', 'reason', 'claims']) assert.ok(!(result.stdout + result.stderr).includes(text), text);
}
test('selector is deterministic, balanced, exhausts short layers and caps n', () => {
  const rows = Array.from({ length: 40 }, (_, n) => ({ case_id: `case-${n}`, layer: n < 4 ? 'knowledge' : 'judgment' }));
  const selected = calibrate.select(rows, '0123456789abcdef', 30);
  assert.deepEqual(selected, calibrate.select(rows, '0123456789abcdef', 30));
  assert.notDeepEqual(selected, calibrate.select(rows, 'fedcba9876543210', 30));
  assert.deepEqual(selected.slice(0, 8).map((r) => r.layer), Array.from({ length: 8 }, (_, n) => n % 2 ? 'judgment' : 'knowledge'));
  assert.equal(selected.length, 30);
  assert.equal(calibrate.select(rows, '0123456789abcdef', 99).length, 40);
  assert.deepEqual(calibrate.select([], '0123456789abcdef', 30), []);
});
test('sample and next hide judgment values, persist a seed once, and show exact blinded text', (t) => {
  const { cli, dir } = setup(t);
  hidden(cli(['sample']));
  const queue = calibrate.readQueue(dir, id);
  assert.equal(queue.length, 30);
  assert.equal(queue.filter((r) => r.layer === 'knowledge').length, 15);
  assert.equal(new Set(queue.map((r) => r.seed)).size, 1);
  for (const row of queue) assert.deepEqual(calibrate.validateQueueItem(row), []);
  const before = fs.readFileSync(path.join(dir, `calibration/${id}/queue.jsonl`), 'utf8');
  assert.equal(cli(['sample', '--n', '1'], true).stdout, `calibrate: queue exists for ${id} (30 items)\n`);
  assert.equal(fs.readFileSync(path.join(dir, `calibration/${id}/queue.jsonl`), 'utf8'), before);
  const expected = `item 1/30 — ${queue[0].case_id} (knowledge)\n\n## Question\nWhat should we try?\n\n## Twin draft\nA synthetic proposal.\n\n## Reference answer\nTry a small pilot.\n`;
  for (const spawned of [false, true]) { const result = cli(['next'], spawned); hidden(result); assert.equal(result.stdout, expected); }
});
test('every subcommand works spawned and in process; latest ratings win and score matches report', (t) => {
  const { cli, dir } = setup(t);
  hidden(cli(['sample', '--n', '99'], true));
  assert.equal(calibrate.readQueue(dir, id).length, 34);
  assert.deepEqual(calibrate.agreement(dir, id), { match: 0, rated: 0, rate: null, trust: 'untrusted' });
  assert.equal(cli(['score']).stdout, 'judge agreement with Sora Aoki: 0/0 (n/a) → untrusted\n');
  for (const row of calibrate.readQueue(dir, id)) assert.equal(cli(['rate', row.case_id, 'send_as_is'], row.position === 1).code, 0);
  assert.equal(cli(['next']).stdout, 'calibrate: all 34 items rated — run calibrate score\n');
  assert.equal(cli(['next'], true).code, 0);
  assert.equal(cli(['rate', 'case-0', 'wrong', '--wrong-uncited-fact', 'yes']).code, 0);
  assert.equal(calibrate.readRatings(dir, id).length, 34);
  assert.equal(store.readJsonl(dir, `calibration/${id}/ratings.jsonl`).length, 35);
  assert.equal(calibrate.readRatings(dir, id).find((r) => r.case_id === 'case-0').wrong_uncited_fact, true);
  assert.equal(cli(['rate', 'case-0', 'wrong', '--wrong-uncited-fact', 'no']).code, 0);
  assert.equal(cli(['rate', 'case-0', 'send_as_is']).stdout, 'calibrate: rated case-0 (34/34)\n');
  assert.ok(!Object.hasOwn(calibrate.readRatings(dir, id).find((r) => r.case_id === 'case-0'), 'wrong_uncited_fact'));
  const score = cli(['score']); assert.deepEqual(cli(['score'], true), score);
  assert.equal(score.stdout, 'judge agreement with Sora Aoki: 34/34 (100%) → trusted\n');
  const agreement = calibrate.agreement(dir, id);
  const value = report.build({ persona: store.readJson(dir, 'persona.json'), cases: [], drafts: store.readJsonl(dir, `evals/${id}/drafts.jsonl`), judgments: store.readJsonl(dir, `evals/${id}/judgments.jsonl`), ratings: calibrate.readRatings(dir, id), calibration: agreement, previous: null, run: store.readJson(dir, `evals/${id}/run.json`) });
  assert.ok(report.renderMarkdown(value).includes(score.stdout));
  store.appendJsonl(dir, `calibration/${id}/ratings.jsonl`, { case_id: 'case-34', run_id: id, rating: 'wrong', rated_at: new Date().toISOString() });
  store.appendJsonl(dir, `calibration/${id}/ratings.jsonl`, { case_id: 'case-35', run_id: id, rating: 'wrong', rated_at: new Date().toISOString() });
  assert.equal(calibrate.agreement(dir, id).rated, 34);
});
test('guards refuse malformed runs, ids, counts, ratings and all wrong-fact branches', (t) => {
  const { cli, dir } = setup(t);
  assert.equal(cli(['next']).stderr, 'calibrate: no queue — run calibrate sample\n');
  for (const sub of ['sample', 'next', 'rate', 'score']) {
    const prefix = sub === 'rate' ? [sub, 'case-0', 'wrong'] : [sub];
    for (const run of ['x2026-10-20-100', '2026-10-20-100x', '2026-10-20-1', '2026-10-20-99', '../escape']) assert.equal(cli([...prefix, '--run', run]).stderr, 'calibrate: unknown run\n');
    assert.equal(cli([...prefix, '--run']).code, 1);
  }
  for (const n of ['0', '-1', '1.5', 'x2', '2x', '2\n', '9007199254740992']) assert.equal(cli(['sample', '--n', n]).code, 1);
  assert.equal(cli(['sample', '--n', '99', '--persona', dir]).code, 0);
  for (const caseId of ['/case-0', 'case-0/', 'case-0\n', '', 'Case-0']) assert.equal(cli(['rate', caseId, 'wrong']).stderr, 'calibrate: invalid case id\n');
  for (const caseId of ['unknown', 'case-34', 'case-35']) assert.equal(cli(['rate', caseId, 'wrong']).stderr, `calibrate: ${caseId} is not in the queue\n`);
  assert.equal(cli(['rate', 'case-0', 'other']).stderr, 'calibrate: invalid rating\n');
  for (const opts of [[], ['--wrong-uncited-fact', 'maybe']]) assert.equal(cli(['rate', 'case-0', 'wrong', ...opts]).code, 1);
  for (const [caseId, rating] of [['case-0', 'send_as_is'], ['case-0', 'needs_edits'], ['case-1', 'wrong'], ['case-1', 'send_as_is'], ['case-1', 'needs_edits']]) assert.equal(cli(['rate', caseId, rating, '--wrong-uncited-fact', 'yes']).code, 1);
  assert.equal(store.readJsonl(dir, `calibration/${id}/ratings.jsonl`).length, 0);
  for (const args of [[], ['other'], ['sample', '--n'], ['next', '--n', '1'], ['sample', '--n', '1', '--n', '2']]) assert.equal(cli(args).code, 1);
});

test('queue and rating validators reject every invalid field without echoing values', (t) => {
  const { dir } = setup(t);
  const queue = { format_version: 1, run_id: id, seed: '0123456789abcdef', position: 1, case_id: 'case-0', layer: 'knowledge' };
  const rating = { case_id: 'case-0', run_id: id, rating: 'wrong', wrong_uncited_fact: false, rated_at: '2026-10-20T00:00:00Z' };
  const checks = [
    [calibrate.validateQueueItem, queue, {
      format_version: [0], run_id: [undefined, 123, `x${id}`, `${id}x`, `${id}\n`, '2026-10-20-1'],
      seed: [undefined, 123, 'x0123456789abcdef', '0123456789abcdefx', '0123456789abcde', '0123456789abcdeG', '0123456789abcdef\n'],
      position: [0, -1, 1.5, 9007199254740992], case_id: [undefined, 123, '/case-0', 'case-0/', 'case-0\n'], layer: ['other'],
    }],
    [calibrate.validateRating, rating, {
      case_id: [undefined, 123, '/case-0', 'case-0/', 'case-0\n'],
      run_id: [undefined, 123, `x${id}`, `${id}x`, `${id}\n`, '2026-10-20-1'],
      rating: ['other'], wrong_uncited_fact: ['yes'], rated_at: [123, 'invalid'],
    }],
  ];
  for (const [validate, value, invalid] of checks) {
    assert.deepEqual(validate(value), []);
    for (const missing of [null, undefined]) assert.equal(validate(missing).length, 1);
    for (const [key, values] of Object.entries(invalid)) for (const bad of values) {
      const errors = validate({ ...value, [key]: bad });
      assert.equal(errors.length, 1, `${key}: ${String(bad)}`);
      assert.ok(!errors.join().includes(canary));
    }
  }
  const { wrong_uncited_fact, ...ordinary } = rating;
  assert.deepEqual(calibrate.validateRating(ordinary), []);
  store.writeJsonl(dir, `calibration/${id}/queue.jsonl`, [{ ...queue, run_id: '2026-10-20-99' }]);
  assert.throws(() => calibrate.readQueue(dir, id), /invalid queue item/);
  store.writeJsonl(dir, `calibration/${id}/queue.jsonl`, [{ ...queue, position: 0 }]);
  assert.throws(() => calibrate.readQueue(dir, id), /invalid queue item/);
  store.writeJsonl(dir, `calibration/${id}/ratings.jsonl`, [{ ...rating, rating: canary }]);
  assert.throws(() => calibrate.readRatings(dir, id), /invalid owner rating/);
  store.writeJsonl(dir, `calibration/${id}/ratings.jsonl`, [{ ...rating, run_id: '2026-10-20-99' }]);
  assert.deepEqual(calibrate.readRatings(dir, id), []);
});


test('numeric latest selection, explicit runs, empty queues and interrupted writes', (t) => {
  const { cli, dir } = setup(t);
  const older = '2026-10-20-99';
  store.writeJson(dir, `evals/${older}/run.json`, { run_id: older });
  assert.equal(cli(['sample', '--run', older]).stdout, `calibrate: queued 0 items for ${older} (knowledge 0, judgment 0)\n`);
  assert.equal(cli(['sample', '--run', older]).stdout, `calibrate: queue exists for ${older} (0 items)\n`);
  assert.equal(cli(['next', '--run', older]).stdout, 'calibrate: all 0 items rated — run calibrate score\n');
  assert.match(cli(['score', '--run', older]).stdout, /0\/0 \(n\/a\) → untrusted/);
  const write = store.writeJsonl;
  let calls = 0;
  store.writeJsonl = (...args) => { calls++; return write(...args); };
  try { assert.equal(cli(['sample', '--n', '1']).stdout, `calibrate: queued 1 items for ${id} (knowledge 1, judgment 0)\n`); }
  finally { store.writeJsonl = write; }
  assert.equal(calls, 1);
  const item = calibrate.readQueue(dir, id)[0];
  assert.equal(cli(['rate', item.case_id, 'send_as_is']).code, 0);
  const append = store.appendJsonl;
  store.appendJsonl = () => { throw new Error('simulated rating interruption'); };
  try { assert.equal(cli(['rate', item.case_id, 'wrong', '--wrong-uncited-fact', 'yes']).code, 1); }
  finally { store.appendJsonl = append; }
  assert.equal(calibrate.readRatings(dir, id)[0].rating, 'send_as_is');
  assert.equal(calibrate.readRatings(dir, id).length, 1);
  const value = report.build({ persona: store.readJson(dir, 'persona.json'), cases: [], drafts: [], judgments: [], ratings: [], calibration: calibrate.agreement(dir, older), previous: null, run: store.readJson(dir, `evals/${id}/run.json`) });
  assert.ok(report.renderMarkdown(value).includes(cli(['score', '--run', older]).stdout));
});
