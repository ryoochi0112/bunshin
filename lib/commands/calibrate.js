'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const store = require('../store');
const calibrate = require('../calibrate');
const { runIds } = require('./eval');

function run(argv, io) {
  try {
    const [sub, ...args] = argv;
    if (!['sample', 'next', 'rate', 'score', 'compare'].includes(sub)) throw new Error('calibrate: expected sample, next, rate, score, or compare');
    const caseId = sub === 'rate' ? args.shift() : undefined;
    const rating = sub === 'rate' ? args.shift() : undefined;
    const opts = {};
    const allowed = ['--run', '--persona', ...(sub === 'sample' ? ['--n'] : []), ...(sub === 'rate' ? ['--wrong-uncited-fact'] : [])];
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i]; const value = args[i + 1];
      if (!allowed.includes(key) || Object.hasOwn(opts, key) || !value || value.startsWith('--')) {
        throw new Error(key === '--run' ? 'calibrate: unknown run' : 'calibrate: invalid options');
      }
      opts[key] = value;
    }
    const dir = store.resolvePersona({ persona: opts['--persona'], env: io.env || process.env });
    const ids = runIds(dir);
    const runId = opts['--run'] ?? ids.at(-1);
    if (!calibrate.runPattern.test(runId || '') || !ids.includes(runId)) throw new Error('calibrate: unknown run');
    const base = `calibration/${runId}`;
    const config = store.readJson(dir, `evals/${runId}/run.json`);
    if (sub === 'compare') {
      // Dev check only: the owner already saw these drafts, so this never sets trust.
      if (!config.rejudged_from) throw new Error('calibrate: compare needs a run made with eval run --rejudge-from');
      const value = calibrate.compare(dir, runId, config.rejudged_from);
      const persona = store.readJson(dir, 'persona.json');
      io.stdout.write(`tuning-set agreement with ${persona.display_name}: ${value.match}/${value.rated} (${value.rated ? `${Math.round(100 * value.match / value.rated)}%` : 'n/a'}) · judge lower ${value.lower} · judge higher ${value.higher} — ratings from run ${config.rejudged_from}, not used for trust\n`);
      return 0;
    }
    if (config.rejudged_from && sub !== 'score') {
      throw new Error(`calibrate: ${runId} re-judges drafts from ${config.rejudged_from}; calibrate a fresh eval run instead`);
    }
    if (sub === 'sample') {
      const raw = opts['--n'] ?? '30';
      if (!/^[1-9][0-9]*$(?![\s\S])/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error('calibrate: n must be a positive integer');
      if (fs.existsSync(path.join(dir, base, 'queue.jsonl'))) {
        io.stdout.write(`calibrate: queue exists for ${runId} (${calibrate.readQueue(dir, runId).length} items)\n`);
        return 0;
      }
      const seed = crypto.randomBytes(8).toString('hex');
      const queue = calibrate.select(calibrate.eligible(dir, runId), seed, Number(raw)).map((row, index) => ({
        format_version: 1, run_id: runId, seed, position: index + 1, case_id: row.case_id, layer: row.layer,
      }));
      store.writeJsonl(dir, `${base}/queue.jsonl`, queue);
      const k = queue.filter((row) => row.layer === 'knowledge').length;
      io.stdout.write(`calibrate: queued ${queue.length} items for ${runId} (knowledge ${k}, judgment ${queue.length - k})\n`);
      return 0;
    }
    if (sub === 'score') {
      const value = calibrate.agreement(dir, runId);
      const persona = store.readJson(dir, 'persona.json');
      io.stdout.write(`judge agreement with ${persona.display_name}: ${value.match}/${value.rated} (${value.rate === null ? 'n/a' : `${Math.round(100 * value.rate)}%`}) → ${value.trust}\n`);
      return 0;
    }
    if (!fs.existsSync(path.join(dir, base, 'queue.jsonl'))) throw new Error('calibrate: no queue — run calibrate sample');
    const queue = calibrate.readQueue(dir, runId);
    const ratings = calibrate.readRatings(dir, runId);
    if (sub === 'next') {
      const item = queue.find((row) => !ratings.some((rated) => rated.case_id === row.case_id));
      if (!item) io.stdout.write(`calibrate: all ${queue.length} items rated — run calibrate score\n`);
      else {
        const value = store.readJsonl(dir, 'cases.jsonl').find((row) => row.id === item.case_id);
        const draft = store.readJsonl(dir, `evals/${runId}/drafts.jsonl`).find((row) => row.case_id === item.case_id);
        if (!value || !draft) throw new Error('calibrate: missing case or draft');
        io.stdout.write(`item ${item.position}/${queue.length} — ${item.case_id} (${item.layer})\n\n## Question\n${value.question.text}\n\n## Twin draft\n${draft.draft}\n\n## Reference answer\n${value.reference_answer}\n`);
      }
      return 0;
    }
    if (!calibrate.idPattern.test(caseId || '')) throw new Error('calibrate: invalid case id');
    const item = queue.find((row) => row.case_id === caseId);
    if (!item) throw new Error(`calibrate: ${caseId} is not in the queue`);
    if (!calibrate.validRatings.includes(rating)) throw new Error('calibrate: invalid rating');
    const wrong = opts['--wrong-uncited-fact'];
    const required = item.layer === 'knowledge' && rating === 'wrong';
    if (required && !['yes', 'no'].includes(wrong)) throw new Error('calibrate: wrong-uncited-fact must be yes or no for knowledge wrong');
    if (!required && wrong !== undefined) throw new Error('calibrate: wrong-uncited-fact is only allowed for knowledge wrong');
    store.appendJsonl(dir, `${base}/ratings.jsonl`, { case_id: caseId, run_id: runId, rating,
      ...(required ? { wrong_uncited_fact: wrong === 'yes' } : {}), rated_at: new Date().toISOString() });
    const count = queue.filter((row) => row.case_id === caseId || ratings.some((rated) => rated.case_id === row.case_id)).length;
    io.stdout.write(`calibrate: rated ${caseId} (${count}/${queue.length})\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`${error.message}\n`);
    return 1;
  }
}

module.exports = { name: 'calibrate', summary: 'Rate blinded drafts and measure judge agreement', run };
