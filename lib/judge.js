'use strict';

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

module.exports = { buildPrompt, parse, outputSchema, questionPrompt };
