'use strict';

const store = require('./store');
const pairs = require('./pairs');
const split = require('./split');
const calibrate = require('./calibrate');
const judge = require('./judge');

const DIR = 'judge-examples';
const DEFAULT_N = 12;
const MAX_PAIR_CHARS = 4000;
const LAYERS = ['knowledge', 'judgment'];
const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$(?![\s\S])/;

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function iso(value) {
  return typeof value === 'string' && isoPattern.test(value) && Number.isFinite(Date.parse(value));
}

function drafter(value) {
  return object(value) && text(value.host) && (value.model === null || text(value.model));
}

function pairChars(pair) {
  return pair.question.text.length
    + pair.context.reduce((sum, entry) => sum + entry.text.length + entry.author.length, 0)
    + pair.answer.text.length;
}

function eligible(dir) {
  const build = pairs.listPairs(dir, { set: 'build' });
  const kept = build.filter((pair) => pairChars(pair) <= MAX_PAIR_CHARS);
  return { pairs: kept, skipped: build.length - kept.length };
}

// Returns the chosen pairs in position order (position 1 first).
function selectSet(dir, { seed, n }) {
  const { pairs: candidates } = eligible(dir);
  if (candidates.length < n) throw new Error(`examples: only ${candidates.length} eligible build pairs; need ${n}`);
  const byId = new Map(candidates.map((pair) => [pair.id, pair]));
  const rows = candidates.map((pair) => ({ case_id: pair.id, layer: pair.layer }));
  return calibrate.select(rows, seed, n).map((row) => byId.get(row.case_id));
}

function validateSet(set) {
  return object(set) && set.format_version === 1 && typeof set.seed === 'string' && /^[a-f0-9]{16}$(?![\s\S])/.test(set.seed)
    && Number.isSafeInteger(set.n) && set.n > 0 && drafter(set.drafter) && iso(set.created_at)
    && Array.isArray(set.pair_ids) && set.pair_ids.length === set.n
    && set.pair_ids.every((id) => typeof id === 'string' && calibrate.idPattern.test(id)) && new Set(set.pair_ids).size === set.n
    ? [] : ['examples: invalid example set'];
}

function validateExample(row) {
  return object(row) && typeof row.pair_id === 'string' && calibrate.idPattern.test(row.pair_id)
    && Number.isSafeInteger(row.position) && row.position > 0 && LAYERS.includes(row.layer)
    && object(row.question) && text(row.question.author) && text(row.question.text)
    && Array.isArray(row.context) && row.context.every((entry) => object(entry) && text(entry.author) && text(entry.text))
    && text(row.reference_answer) && text(row.draft) && drafter(row.drafter) && iso(row.drafted_at)
    ? [] : ['examples: invalid example'];
}

// One line, not blank, at most 200 Unicode code points; stored verbatim.
function validReason(value) {
  return typeof value === 'string' && !/[\r\n]/.test(value) && value.trim() !== '' && [...value].length <= 200;
}

function validateRating(row) {
  return object(row) && typeof row.pair_id === 'string' && calibrate.idPattern.test(row.pair_id)
    && calibrate.validRatings.includes(row.rating) && iso(row.rated_at)
    && (!Object.hasOwn(row, 'reason') || row.reason === null || validReason(row.reason))
    ? [] : ['examples: invalid example rating'];
}

function readSet(dir) {
  let set;
  try {
    set = store.readJson(dir, `${DIR}/set.json`);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (validateSet(set).length) throw new Error('examples: invalid example set');
  const examples = store.readJsonl(dir, `${DIR}/examples.jsonl`);
  const positions = new Set();
  const ids = new Set();
  for (const row of examples) {
    if (validateExample(row).length || row.position > set.n || positions.has(row.position) || ids.has(row.pair_id)
      || row.pair_id !== set.pair_ids[row.position - 1]) {
      throw new Error('examples: invalid example');
    }
    positions.add(row.position);
    ids.add(row.pair_id);
  }
  const { assignments } = split.readSplit(dir);
  for (const row of examples) {
    if (!Object.hasOwn(assignments, row.pair_id) || assignments[row.pair_id] !== 'build') {
      throw new Error(`examples: pair ${row.pair_id} is not in the build split`);
    }
  }
  examples.sort((a, b) => a.position - b.position);
  const ratings = {};
  for (const row of store.readJsonl(dir, `${DIR}/ratings.jsonl`)) {
    if (validateRating(row).length || !ids.has(row.pair_id)) throw new Error('examples: invalid example rating');
    ratings[row.pair_id] = row;
  }
  const labels = Object.fromEntries(calibrate.validRatings.map((label) => [label, 0]));
  for (const row of Object.values(ratings)) labels[row.rating] += 1;
  const unrated = examples.filter((row) => !Object.hasOwn(ratings, row.pair_id)).map((row) => row.pair_id);
  const needsReason = examples.filter((row) => Object.hasOwn(ratings, row.pair_id) && !Object.hasOwn(ratings[row.pair_id], 'reason'))
    .map((row) => row.pair_id);
  return {
    set, examples, ratings,
    status: { n: set.n, drafted: examples.length, rated: examples.length - unrated.length, unrated, labels, needsReason },
  };
}

function ready(dir) {
  const state = readSet(dir);
  if (!state) return null;
  const { n, drafted, unrated } = state.status;
  if (drafted < n) throw new Error(`eval run: judge examples not ready — ${drafted} of ${n} drafted`);
  if (unrated.length) throw new Error(`eval run: judge examples not ready — ${unrated.length} of ${n} unrated (${unrated[0]})`);
  return state.examples.map((e) => ({ ...e, rating: state.ratings[e.pair_id].rating, reason: state.ratings[e.pair_id].reason ?? null }));
}

// The run.json judge_examples value.
function summary(rows) {
  const labels = Object.fromEntries(calibrate.validRatings.map((label) => [label, 0]));
  for (const row of rows) labels[row.rating] += 1;
  const reasons = rows.filter((row) => typeof row.reason === 'string' && row.reason !== '').length;
  return { hash: judge.examplesHash(judge.examplesBlock(rows)), n: rows.length, labels, reasons };
}

module.exports = {
  DIR, DEFAULT_N, MAX_PAIR_CHARS, pairChars, eligible, selectSet, readSet, ready, summary,
  validateExample, validateRating, validReason,
};
