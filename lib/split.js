'use strict';

const crypto = require('node:crypto');
const store = require('./store');

function readSplit(personaDir) {
  let state;
  try {
    state = store.readJson(personaDir, 'split.json');
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Missing split.json; run `bunshin init <name>` first.');
    throw error;
  }
  if (!state || state.format_version !== 1 || typeof state.salt !== 'string' || !state.salt
    || !Number.isFinite(state.heldout_ratio) || state.heldout_ratio < 0 || state.heldout_ratio > 1
    || !state.assignments || typeof state.assignments !== 'object' || Array.isArray(state.assignments)
    || Object.entries(state.assignments).some(([id, set]) => !/^[a-z0-9-]+$/.test(id) || !['build', 'heldout'].includes(set))) {
    throw new Error('Invalid split.json.');
  }
  return state;
}

function assign(personaDir, options) {
  const pairs = require('./pairs').listPairs(personaDir, { set: 'all' });
  const state = readSplit(personaDir);
  const result = { build: 0, heldout: 0, new: 0 };
  for (const pair of pairs) {
    if (!Object.hasOwn(state.assignments, pair.id)) {
      const hash = crypto.createHash('sha256').update(`${state.salt}:${pair.id}`).digest();
      const set = hash.readUInt32BE(0) / 2 ** 32 < state.heldout_ratio ? 'heldout' : 'build';
      Object.defineProperty(state.assignments, pair.id, { value: set, enumerable: true, writable: true, configurable: true });
      result.new += 1;
    }
    result[state.assignments[pair.id]] += 1;
  }
  if (result.new) store.writeJson(personaDir, 'split.json', state, options);
  return result;
}

function setOf(personaDir, pairId) {
  const state = readSplit(personaDir);
  return Object.hasOwn(state.assignments, pairId) ? state.assignments[pairId] : undefined;
}

module.exports = { assign, setOf, readSplit };
