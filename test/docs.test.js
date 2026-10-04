'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const conflicts = require('../lib/conflicts');
const identity = require('../lib/identity');
const interview = require('../lib/interview');
const pairs = require('../lib/pairs');
const store = require('../lib/store');

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

test('JSON examples parse, match the fictional sample, and pass their validators', () => {
  const examples = [
    ['persona.json', store.readJson(sampleDir, 'persona.json'), validateManifest],
    ['pairs.jsonl', store.readJsonl(sampleDir, 'pairs.jsonl')[0], pairs.validatePair],
    ['split.json', store.readJson(sampleDir, 'split.json'), validateSplit],
    ['cases.jsonl', store.readJsonl(sampleDir, 'cases.jsonl')[0], validateCase],
    ['interview.jsonl', store.readJsonl(sampleDir, 'interview.jsonl')[0], interview.validateAnswer],
    ['conflicts.jsonl', store.readJsonl(sampleDir, 'conflicts.jsonl')[0], conflicts.validateConflict],
    ['identity.json', store.readJson(sampleDir, 'identity.json'), (value) => identity.validate(sampleDir, value)],
  ];

  assert.equal([...formats.matchAll(/```json\s*\n/g)].length, examples.length);
  for (const [file, sampleValue, validator] of examples) {
    const value = documentedExample(file);
    assert.deepEqual(value, sampleValue, `${file} example must come from sample/persona`);
    assertValid(validator(value), file);
  }
});

test('README states the M1 scope and links to the format reference', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /M1 status: engine only/);
  assert.match(readme, /Skills are not available yet/);
  assert.match(readme, /install-to-report walkthrough is planned for M2/);
  assert.match(readme, /\[docs\/formats\.md\]\(docs\/formats\.md\)/);
  assert.match(readme, /MIT/);
});
