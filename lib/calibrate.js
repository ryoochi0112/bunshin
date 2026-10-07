'use strict';

const crypto = require('node:crypto');
const store = require('./store');
const report = require('./report');

const QUEUE_FIELDS = ['format_version', 'run_id', 'seed', 'position', 'case_id', 'layer'];
const RATING_FIELDS = ['case_id', 'run_id', 'rating', 'wrong_uncited_fact', 'rated_at'];
const validRatings = ['send_as_is', 'needs_edits', 'wrong'];
const runPattern = /^\d{4}-\d{2}-\d{2}-\d{2,}$(?![\s\S])/;
const idPattern = /^[a-z0-9-]+$(?![\s\S])/;

function validateQueueItem(row) {
  return row && row.format_version === 1 && typeof row.run_id === 'string' && runPattern.test(row.run_id)
    && typeof row.seed === 'string' && /^[a-f0-9]{16}$(?![\s\S])/.test(row.seed) && Number.isSafeInteger(row.position) && row.position > 0
    && typeof row.case_id === 'string' && idPattern.test(row.case_id) && ['knowledge', 'judgment'].includes(row.layer)
    ? [] : ['calibrate: invalid queue item'];
}

function validateRating(row) {
  return row && typeof row.case_id === 'string' && idPattern.test(row.case_id) && typeof row.run_id === 'string' && runPattern.test(row.run_id)
    && validRatings.includes(row.rating) && typeof row.rated_at === 'string' && Number.isFinite(Date.parse(row.rated_at))
    && (!Object.hasOwn(row, 'wrong_uncited_fact') || typeof row.wrong_uncited_fact === 'boolean')
    ? [] : ['calibrate: invalid owner rating'];
}

function select(eligible, seed, n) {
  const hash = (id) => crypto.createHash('sha256').update(`${seed}:${id}`).digest('hex');
  const lists = ['knowledge', 'judgment'].map((layer) => eligible.filter((row) => row.layer === layer)
    .sort((a, b) => hash(a.case_id).localeCompare(hash(b.case_id))));
  const result = [];
  const offsets = [0, 0];
  while (result.length < n && lists.some((list, i) => offsets[i] < list.length)) {
    for (let i = 0; i < 2 && result.length < n; i++) {
      if (offsets[i] < lists[i].length) result.push(lists[i][offsets[i]++]);
    }
  }
  return result;
}

function readQueue(dir, runId) {
  const rows = store.readJsonl(dir, `calibration/${runId}/queue.jsonl`);
  for (const row of rows) if (validateQueueItem(row).length || row.run_id !== runId) throw new Error('calibrate: invalid queue item');
  return rows.sort((a, b) => a.position - b.position);
}

function readRatings(dir, runId) {
  const rows = store.readJsonl(dir, `calibration/${runId}/ratings.jsonl`);
  for (const row of rows) if (validateRating(row).length) throw new Error('calibrate: invalid owner rating');
  return [...new Map(rows.filter((row) => row.run_id === runId).map((row) => [row.case_id, row])).values()];
}

function judgments(dir, runId) {
  return new Map(store.readJsonl(dir, `evals/${runId}/judgments.jsonl`).map((row) => [row.case_id, row]));
}

function eligible(dir, runId) {
  const byId = judgments(dir, runId);
  return store.readJsonl(dir, `evals/${runId}/drafts.jsonl`).filter((row) => validRatings.includes(byId.get(row.case_id)?.rating));
}

function agreement(dir, runId) {
  const byId = judgments(dir, runId);
  const rows = readRatings(dir, runId).filter((row) => validRatings.includes(byId.get(row.case_id)?.rating));
  const match = rows.filter((row) => row.rating === byId.get(row.case_id).rating).length;
  const rated = rows.length;
  return { match, rated, rate: rated ? match / rated : null,
    trust: report.judgeTrust({ match, rated }, store.readJson(dir, 'persona.json')) };
}

const rank = { wrong: 0, needs_edits: 1, send_as_is: 2 };

function compare(dir, runId, ratingsRunId) {
  const byId = judgments(dir, runId);
  const rows = readRatings(dir, ratingsRunId).filter((row) => validRatings.includes(byId.get(row.case_id)?.rating));
  const counts = { match: 0, rated: rows.length, lower: 0, higher: 0 };
  for (const row of rows) {
    const diff = rank[byId.get(row.case_id).rating] - rank[row.rating];
    if (diff === 0) counts.match++;
    else if (diff < 0) counts.lower++;
    else counts.higher++;
  }
  return counts;
}

module.exports = { QUEUE_FIELDS, RATING_FIELDS, validRatings, runPattern, idPattern,
  validateQueueItem, validateRating, select, readQueue, readRatings, eligible, agreement, compare };
