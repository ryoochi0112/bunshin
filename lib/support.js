'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const kb = require('./kb');
const twin = require('./twin');

const outputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'reason'],
  properties: {
    verdict: { type: 'string', enum: ['supported', 'partly', 'not_supported'] },
    reason: { type: 'string', minLength: 1 },
  },
};

function system() {
  return twin.stripTemplateFrontmatter(fs.readFileSync(path.join(__dirname, '..', 'templates', 'support-judge.md'), 'utf8'));
}

function rubricHash(text = system()) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function buildPrompt(sentence, entries) {
  return `Sentence:\n${sentence.text}\n\nEntries:\n${JSON.stringify(entries.map(({ id, claim, select }) => ({ id, claim, select })))}`;
}

function invalid(field) {
  throw new Error(`Invalid support field: ${field}.`);
}

function parse(text) {
  if (typeof text !== 'string') invalid('JSON');
  let source = text.trim();
  const fence = source.match(/^```json\s*\n([\s\S]*?)\n```$/);
  if (fence) source = fence[1];
  let value;
  try { value = JSON.parse(source); } catch { invalid('JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('JSON');
  if (Object.keys(value).some((key) => !Object.hasOwn(outputSchema.properties, key))) invalid('fields');
  if (!outputSchema.properties.verdict.enum.includes(value.verdict)) invalid('verdict');
  if (typeof value.reason !== 'string' || !value.reason.trim()) invalid('reason');
  return value;
}

async function judgeDraft({ host, model, sentences, kbData }) {
  const entries = new Map();
  if (kb.mode(kbData) === 'ssot') {
    for (const [id, fact] of kb.citable(kbData)) entries.set(id, [fact]);
  } else {
    for (const entry of kbData.entries) {
      const matches = entries.get(entry.id) || [];
      matches.push(entry);
      entries.set(entry.id, matches);
    }
  }
  const rows = [];
  let returnedModel = model ?? null;
  for (const [index, sentence] of sentences.entries()) {
    if (sentence.exempt !== false || !sentence.ids.length || sentence.text.includes('[redacted]')
        || sentence.ids.some((id) => id === '[redacted]' || entries.get(id)?.length !== 1)) continue;
    const cited = sentence.ids.map((id) => entries.get(id)[0]);
    let verdict = 'support_error';
    for (let attempt = 0; attempt < 2; attempt++) {
      const reply = await host.run({ system: system(), prompt: buildPrompt(sentence, cited),
        tools: 'none', model: model ?? undefined, outputSchema });
      returnedModel = reply.model ?? returnedModel;
      try { verdict = parse(reply.text).verdict; break; } catch { /* Retry malformed output once. */ }
    }
    rows.push({ index, ids: sentence.ids, verdict });
  }
  return { sentences: rows, model: returnedModel };
}

module.exports = { outputSchema, system, rubricHash, buildPrompt, parse, judgeDraft };
