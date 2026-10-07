'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const twin = require('./twin');

const outputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['rating', 'reason', 'claims', 'wrong_uncited', 'language_match'],
  properties: {
    rating: { type: 'string', enum: ['send_as_is', 'needs_edits', 'wrong'] },
    reason: { type: 'string', minLength: 1 },
    claims: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['text', 'cited', 'correct'],
      properties: { text: { type: 'string' }, cited: { type: 'boolean' }, correct: { type: ['boolean', 'null'] } },
    } },
    wrong_uncited: { type: 'integer', minimum: 0 },
    language_match: { type: 'boolean' },
  },
};

function questionPrompt(value) {
  return `Question:\n${value.question.text}\n\nContext:\n${value.context.map(({ author, text }) => `${author}: ${text}`).join('\n')}`;
}

function buildPrompt(value, draft) {
  return `${questionPrompt(value)}\n\nReference answer:\n${value.reference_answer}\n\nDraft:\n${draft.draft}`;
}

function rubric() {
  return twin.stripTemplateFrontmatter(fs.readFileSync(path.join(__dirname, '..', 'templates', 'judge.md'), 'utf8'));
}

// A run records this hash so judge trust never crosses a rubric change.
function rubricHash(text = rubric()) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function examplesTemplate() {
  return twin.stripTemplateFrontmatter(fs.readFileSync(path.join(__dirname, '..', 'templates', 'judge-examples.md'), 'utf8'));
}

function renderExample(row) {
  return [`## Example ${row.position}`,
    `Question:\n${row.question.text}`,
    `Context:\n${row.context.map(({ author, text }) => `${author}: ${text}`).join('\n')}`,
    `Reference answer:\n${row.reference_answer}`,
    `Draft:\n${row.draft}`,
    `Owner rating: ${row.rating}${typeof row.reason === 'string' && row.reason !== '' ? `\nOwner reason: ${row.reason}` : ''}`].join('\n\n');
}

function examplesBlock(rows) {
  return `${examplesTemplate()}\n\n${[...rows].sort((a, b) => a.position - b.position).map(renderExample).join('\n\n')}`;
}

function examplesHash(block) {
  return crypto.createHash('sha256').update(block).digest('hex').slice(0, 16);
}

function composeSystem(rows) {
  return rows === null ? rubric() : `${rubric()}\n\n${examplesBlock(rows)}`;
}

const VOTES = 3;
const MAX_BLOCK_CHARS = 60000;

// Majority of three judge calls; a split with no majority is needs_edits.
function vote(calls) {
  if (!Array.isArray(calls) || calls.length !== VOTES) throw new Error('judge: vote needs 3 judgments');
  const labels = ['send_as_is', 'needs_edits', 'wrong'];
  const rating = labels.find((label) => calls.filter((c) => c.rating === label).length >= 2) || 'needs_edits';
  const source = calls.find((c) => c.rating === rating) || calls[0];
  const wrong = calls.map((c) => c.wrong_uncited).sort((a, b) => a - b)[1];
  return {
    rating, reason: source.reason, claims: source.claims, wrong_uncited: wrong,
    language_match: calls.filter((c) => c.language_match).length >= 2,
    votes: calls.map((c) => ({ rating: c.rating, wrong_uncited: c.wrong_uncited, language_match: c.language_match })),
  };
}

function invalid(field) {
  throw new Error(`Invalid judgment field: ${field}.`);
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parse(text) {
  if (typeof text !== 'string') invalid('JSON');
  let source = text.trim();
  const fence = source.match(/^```json\s*\n([\s\S]*?)\n```$/);
  if (fence) source = fence[1];
  let value;
  try { value = JSON.parse(source); } catch { invalid('JSON'); }
  if (!object(value)) invalid('JSON');
  if (Object.keys(value).some((key) => !Object.hasOwn(outputSchema.properties, key))) invalid('fields');
  if (!['send_as_is', 'needs_edits', 'wrong'].includes(value.rating)) invalid('rating');
  if (typeof value.reason !== 'string' || !value.reason.trim()) invalid('reason');
  if (!Array.isArray(value.claims)) invalid('claims');
  for (const claim of value.claims) {
    if (!object(claim) || Object.keys(claim).some((key) => !['text', 'cited', 'correct'].includes(key))) invalid('claims');
    if (typeof claim.text !== 'string') invalid('claims.text');
    if (typeof claim.cited !== 'boolean') invalid('claims.cited');
    if (claim.correct !== null && typeof claim.correct !== 'boolean') invalid('claims.correct');
  }
  const count = value.claims.filter((claim) => claim.cited === false && claim.correct === false).length;
  if (!Number.isInteger(value.wrong_uncited) || value.wrong_uncited !== count) invalid('wrong_uncited');
  if (typeof value.language_match !== 'boolean') invalid('language_match');
  return value;
}

module.exports = {
  buildPrompt, parse, outputSchema, questionPrompt, rubric, rubricHash,
  VOTES, MAX_BLOCK_CHARS, vote, examplesTemplate, examplesBlock, examplesHash, composeSystem,
};
