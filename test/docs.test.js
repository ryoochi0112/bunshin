'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const conflicts = require('../lib/conflicts');
const identity = require('../lib/identity');
const interview = require('../lib/interview');
const pairs = require('../lib/pairs');
const store = require('../lib/store');
const judge = require('../lib/judge');
const report = require('../lib/report');
const evalRun = require('../lib/eval-run');
const calibrate = require('../lib/calibrate');

const root = path.join(__dirname, '..');
const sampleDir = path.join(root, 'sample', 'persona');
const formats = fs.readFileSync(path.join(root, 'docs', 'formats.md'), 'utf8');

function section(title) {
  const heading = `## ${title}`;
  const start = formats.indexOf(heading);
  assert.notEqual(start, -1, `Missing section ${heading}`);
  const contentStart = start + heading.length;
  const next = formats.slice(contentStart).search(/^## /m);
  return next === -1 ? formats.slice(contentStart) : formats.slice(contentStart, contentStart + next);
}

function documentedFields(title) {
  const rows = section(title).matchAll(/^\|\s*`([^`]+)`\s*\|/gm);
  return [...rows].map((row) => row[1]);
}

function documentedExample(file) {
  const heading = `### Example: \`${file}\``;
  const start = formats.indexOf(heading);
  assert.notEqual(start, -1, `Missing example for ${file}`);
  const match = formats.slice(start + heading.length).match(/```json\s*\n([\s\S]*?)\n```/);
  assert.ok(match, `Missing JSON example for ${file}`);
  return JSON.parse(match[1]);
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateManifest(value) {
  if (!object(value) || value.format_version !== 1 || typeof value.name !== 'string'
    || !/^[a-z0-9-]+$/.test(value.name) || typeof value.display_name !== 'string'
    || typeof value.synthetic !== 'boolean' || !object(value.owner)
    || !(value.owner.slack_user_id === null || typeof value.owner.slack_user_id === 'string')
    || !Number.isSafeInteger(value.version) || value.version < 0 || !object(value.launch_bar)
    || !Number.isFinite(value.launch_bar.send_as_is) || !Number.isInteger(value.launch_bar.min_heldout)
    || !Number.isInteger(value.launch_bar.min_per_layer) || !Number.isFinite(value.launch_bar.min_agreement)
    || !object(value.hosts) || !object(value.hosts.claude) || !Array.isArray(value.hosts.claude.allowed_tools)
    || value.hosts.claude.allowed_tools.some((tool) => typeof tool !== 'string')) {
    return ['invalid persona.json'];
  }
  return [];
}

function validateCase(value) {
  if (!object(value) || typeof value.id !== 'string' || !/^[a-z0-9-]+$/.test(value.id)
    || !['knowledge', 'judgment'].includes(value.layer) || !object(value.question)
    || typeof value.question.author !== 'string' || !value.question.author.trim()
    || typeof value.question.text !== 'string' || !value.question.text.trim()
    || !Array.isArray(value.context) || value.context.some((entry) => !object(entry)
      || typeof entry.author !== 'string' || !entry.author.trim()
      || typeof entry.text !== 'string' || !entry.text.trim())
    || typeof value.reference_answer !== 'string' || !value.reference_answer.trim()
    || typeof value.permalink !== 'string' || !value.permalink.trim()) {
    return ['invalid case'];
  }
  return [];
}

function validateSplit(value) {
  if (!object(value) || value.format_version !== 1 || typeof value.salt !== 'string' || !value.salt
    || !Number.isFinite(value.heldout_ratio) || value.heldout_ratio < 0 || value.heldout_ratio > 1
    || !object(value.assignments)
    || Object.entries(value.assignments).some(([id, set]) => !/^[a-z0-9-]+$/.test(id)
      || !['build', 'heldout'].includes(set))) {
    return ['invalid split.json'];
  }
  return [];
}

function assertValid(result, label) {
  if (Array.isArray(result)) assert.deepEqual(result, [], label);
  else assert.equal(result.ok, true, `${label}: ${JSON.stringify(result.errors)}`);
}

test('format tables contain every exported field list', () => {
  const fieldTables = [
    ['Calibration queue item: `queue.jsonl`', calibrate.QUEUE_FIELDS],
    ['Owner rating: `ratings.jsonl`', calibrate.RATING_FIELDS],
    ['Pair record: `pairs.jsonl`', pairs.PAIR_FIELDS],
    ['Interview answer: `interview.jsonl`', interview.INTERVIEW_ANSWER_FIELDS],
    ['Interview state: `interview-state.json`', interview.INTERVIEW_STATE_FIELDS],
    ['Conflict record: `conflicts.jsonl`', conflicts.CONFLICT_FIELDS],
    ['Identity: `identity.json` and `identity.md`', identity.IDENTITY_FIELDS],
  ];

  for (const [title, fields] of fieldTables) {
    assert.deepEqual(documentedFields(title), fields, title);
  }
});

test('format docs contain no sample held-out questions or answers', () => {
  const split = store.readJson(sampleDir, 'split.json');
  const samplePairs = store.readJsonl(sampleDir, 'pairs.jsonl');
  const cases = store.readJsonl(sampleDir, 'cases.jsonl');

  for (const pair of samplePairs.filter((row) => split.assignments[row.id] === 'heldout')) {
    const heldoutCase = cases.find((row) => row.id === pair.id);
    assert.ok(heldoutCase, `Missing case for ${pair.id}`);
    for (const [field, text] of [
      ['question.text', pair.question.text],
      ['answer.text', pair.answer.text],
      ['reference_answer', heldoutCase.reference_answer],
    ]) {
      assert.equal(formats.includes(text), false, `${pair.id} ${field} must not appear in docs/formats.md`);
    }
  }
});

test('JSON examples parse, match the sample except for the fictional case, and pass their validators', () => {
  const examples = [
    ['persona.json', store.readJson(sampleDir, 'persona.json'), validateManifest],
    ['pairs.jsonl', store.readJsonl(sampleDir, 'pairs.jsonl')[0], pairs.validatePair],
    ['split.json', store.readJson(sampleDir, 'split.json'), validateSplit],
    ['cases.jsonl', null, validateCase],
    ['interview.jsonl', store.readJsonl(sampleDir, 'interview.jsonl')[0], interview.validateAnswer],
    ['conflicts.jsonl', store.readJsonl(sampleDir, 'conflicts.jsonl')[0], conflicts.validateConflict],
    ['identity.json', store.readJson(sampleDir, 'identity.json'), (value) => identity.validate(sampleDir, value)],
  ];

  assert.equal([...formats.matchAll(/```json\s*\n/g)].length, examples.length + 6);
  for (const [file, sampleValue, validator] of examples) {
    const value = documentedExample(file);
    if (file === 'cases.jsonl') {
      const split = store.readJson(sampleDir, 'split.json');
      assert.equal(Object.hasOwn(split.assignments, value.id), false, 'Case example id must not be in the sample split');
    } else {
      assert.deepEqual(value, sampleValue, `${file} example must come from sample/persona`);
    }
    assertValid(validator(value), file);
  }
});

test('README states the M2 scope and limits and links to the format reference', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /^## 5-minute sample path$/m);
  assert.match(readme, /^M2: Claude Code path covers criteria 1–14: .+\.$/m);
  assert.match(readme, /^Harvest needs the Slack connector and runs on Claude Code only\.$/m);
  assert.match(readme, /^The sample report says "sample too small" because the sample has 3 held-out pairs\.$/m);
  assert.match(readme, /^Codex host support is planned for M3\.$/m);
  assert.match(readme, /\[docs\/formats\.md\]\(docs\/formats\.md\)/);
  assert.match(readme, /MIT/);
});


test('eval format examples match persisted records, judge parser, and report builder', async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-docs-')));
  fs.cpSync(sampleDir, dir, { recursive: true });
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); store._resetGuardCache(); });
  const result = await evalRun.run(dir, {
    drafter: 'fake', judge: `fake:${path.join(__dirname, 'fixtures', 'hosts', 'judge-replies.json')}`,
  });
  const base = `evals/${result.run_id}`;
  const draft = documentedExample('drafts.jsonl');
  const judgment = documentedExample('judgments.jsonl');
  const error = documentedExample('judge_error');
  const actualDraft = store.readJsonl(dir, `${base}/drafts.jsonl`)[0];
  const actualJudgments = store.readJsonl(dir, `${base}/judgments.jsonl`);
  const keys = (value) => Object.keys(value).sort();
  assert.deepEqual(keys(draft), keys(actualDraft));
  assert.deepEqual(keys(draft.drafter), keys(actualDraft.drafter));
  assert.deepEqual(keys(judgment), keys(actualJudgments.find((row) => row.rating !== 'judge_error')));
  assert.deepEqual(keys(error), keys(actualJudgments.find((row) => row.rating === 'judge_error')));
  assert.equal(error.rating, 'judge_error');
  assert.equal(error.reason, 'invalid judge output');
  const { case_id, judge: provenance, at, votes, ...output } = judgment;
  assert.deepEqual(judge.parse(JSON.stringify(output)), output);
  assert.equal(provenance.host, 'fake');
  assert.ok(Number.isFinite(Date.parse(at)));
  assert.equal(case_id, draft.case_id);
  assert.equal(draft.skill, require('../lib/twin').skillForLayer(draft.layer));
  const value = report.build({
    persona: store.readJson(sampleDir, 'persona.json'), cases: store.readJsonl(sampleDir, 'cases.jsonl').filter((row) => row.id === draft.case_id),
    drafts: [draft], judgments: [judgment], ratings: [], calibration: null, previous: null,
    run: { run_id: '2026-10-20-01', persona_version: 1, drafter: { host: 'fake', model: null }, judge: { host: 'fake', model: null } },
  });
  assert.deepEqual(documentedExample('report.json'), value);
  assert.deepEqual(documentedFields('Report: `report.json` and `report.md`'), Object.keys(value));
  for (const [title, row] of [['Draft record: `drafts.jsonl`', draft], ['Judgment record: `judgments.jsonl`', judgment]]) {
    for (const field of Object.keys(row)) assert.ok(documentedFields(title).includes(field), field);
  }
  const markdown = formats.match(/### Example: `report.md`\s*```text\n([\s\S]*?)```/);
  assert.ok(markdown);
  assert.equal(markdown[1], report.renderMarkdown(value));
});


test('calibration examples pass readers and match shapes written by the command', (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-doc-t5-')));
  fs.cpSync(sampleDir, dir, { recursive: true });
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); store._resetGuardCache(); });
  const queue = documentedExample('queue.jsonl');
  const rating = documentedExample('ratings.jsonl');
  assert.deepEqual(calibrate.validateQueueItem(queue), []);
  assert.deepEqual(calibrate.validateRating(rating), []);
  const runId = queue.run_id;
  store.writeJson(dir, `evals/${runId}/run.json`, { run_id: runId });
  store.writeJsonl(dir, `evals/${runId}/drafts.jsonl`, [{ case_id: rating.case_id, layer: 'knowledge' }]);
  store.writeJsonl(dir, `evals/${runId}/judgments.jsonl`, [{ case_id: rating.case_id, rating: 'wrong' }]);
  const command = require('../lib/commands/calibrate');
  const io = { stdout: { write() {} }, stderr: { write() {} } };
  assert.equal(command.run(['sample', '--persona', dir], io), 0);
  assert.deepEqual(Object.keys(calibrate.readQueue(dir, runId)[0]), Object.keys(queue));
  assert.equal(command.run(['rate', rating.case_id, 'wrong', '--wrong-uncited-fact', 'yes', '--persona', dir], io), 0);
  assert.deepEqual(Object.keys(calibrate.readRatings(dir, runId)[0]), Object.keys(rating));
  store.writeJsonl(dir, `calibration/${runId}/queue.jsonl`, [queue]);
  store.writeJsonl(dir, `calibration/${runId}/ratings.jsonl`, [rating]);
  assert.deepEqual(calibrate.readQueue(dir, runId), [queue]);
  assert.deepEqual(calibrate.readRatings(dir, runId), [rating]);
});
