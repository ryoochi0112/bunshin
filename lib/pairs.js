'use strict';

const store = require('./store');
const split = require('./split');

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validatePair(pair) {
  if (!object(pair)) return ['pair must be an object'];
  const errors = [];
  if (typeof pair.id !== 'string' || !/^[a-z0-9-]+$/.test(pair.id)) errors.push('invalid id');
  if (!['slack', 'manual'].includes(pair.source)) errors.push('invalid source');
  if (!['knowledge', 'judgment'].includes(pair.layer)) errors.push('invalid layer');
  if (!['auto', 'manual'].includes(pair.layer_source)) errors.push('invalid layer_source');
  if (pair.format_version !== undefined && pair.format_version !== 1) errors.push('invalid format_version');
  for (const field of ['permalink', 'channel', 'asked_at', 'harvested_at']) {
    if (typeof pair[field] !== 'string' || !pair[field].trim()) errors.push(`${field} must be a non-empty string`);
  }
  for (const field of ['asked_at', 'harvested_at']) {
    if (typeof pair[field] === 'string' && !Number.isFinite(Date.parse(pair[field]))) errors.push(`invalid ${field}`);
  }
  function message(value, field, author) {
    if (!object(value)) {
      errors.push(`${field} must be an object`);
      return;
    }
    if (author && (typeof value.author !== 'string' || !value.author.trim())) errors.push(`${field}.author must be a non-empty string`);
    if (typeof value.text !== 'string' || !value.text.trim()) errors.push(`${field}.text must be a non-empty string`);
  }
  message(pair.question, 'question', true);
  message(pair.answer, 'answer', false);
  if (!Array.isArray(pair.context)) errors.push('context must be an array');
  else pair.context.forEach((entry, index) => message(entry, `context[${index}]`, true));
  return errors;
}

function readPairs(personaDir) {
  const pairs = store.readJsonl(personaDir, 'pairs.jsonl');
  const ids = new Set();
  for (const pair of pairs) {
    if (validatePair(pair).length) throw new Error('Invalid pair in pairs.jsonl.');
    if (ids.has(pair.id)) throw new Error(`Duplicate pair id ${pair.id} in pairs.jsonl.`);
    ids.add(pair.id);
  }
  return pairs;
}

function addPairs(personaDir, incoming, options) {
  if (!Array.isArray(incoming)) throw new Error('Pairs must be an array.');
  incoming.forEach((pair, index) => {
    const errors = validatePair(pair);
    if (errors.length) throw new Error(`Invalid pair at item ${index + 1}: ${errors.join('; ')}.`);
  });
  const byId = new Map(readPairs(personaDir).map((pair) => [pair.id, pair]));
  const result = { added: 0, updated: 0, kept_manual: 0 };
  for (const pair of incoming) {
    const previous = byId.get(pair.id);
    const next = { ...pair };
    if (previous) {
      result.updated += 1;
      if (previous.layer_source === 'manual') {
        next.layer = previous.layer;
        next.layer_source = 'manual';
        result.kept_manual += 1;
      }
    } else result.added += 1;
    byId.set(pair.id, next);
  }
  if (incoming.length) store.writeJsonl(personaDir, 'pairs.jsonl', [...byId.values()], options);
  return result;
}

function listPairs(personaDir, { set } = {}) {
  if (!['build', 'heldout', 'all'].includes(set)) throw new Error('Invalid pair set.');
  const pairs = readPairs(personaDir);
  if (set === 'all') return pairs;
  const state = split.readSplit(personaDir);
  for (const pair of pairs) {
    if (!Object.hasOwn(state.assignments, pair.id)) throw new Error(`Pair ${pair.id} has no assignment; run \`bunshin split\` first.`);
  }
  return pairs.filter((pair) => state.assignments[pair.id] === set);
}

function labelPair(personaDir, id, layer, options) {
  if (!['knowledge', 'judgment'].includes(layer)) throw new Error('Invalid layer.');
  const pairs = readPairs(personaDir);
  const pair = pairs.find((entry) => entry.id === id);
  if (!pair) throw new Error('Pair id not found in pairs.jsonl.');
  pair.layer = layer;
  pair.layer_source = 'manual';
  store.writeJsonl(personaDir, 'pairs.jsonl', pairs, options);
}

module.exports = { validatePair, addPairs, listPairs, labelPair };
