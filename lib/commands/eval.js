'use strict';

const fs = require('node:fs');
const path = require('node:path');
const store = require('../store');
const report = require('../report');
const evalRun = require('../eval-run');
const calibrate = require('../calibrate');

const usage = 'Usage: bunshin eval run [--drafter <spec>] [--judge <spec>] [--limit <n>] [--run <run_id>] [--persona <dir>]\n       bunshin eval run --rejudge-from <run_id> [--judge <spec>] [--persona <dir>]\n       bunshin eval report [--run <run_id>] [--persona <dir>]\n';

const runPattern = /^\d{4}-\d{2}-\d{2}-\d{2,}$/;

function compareRuns(a, b) {
  const dates = a.slice(0, 10).localeCompare(b.slice(0, 10));
  if (dates) return dates;
  const left = BigInt(a.slice(11));
  const right = BigInt(b.slice(11));
  return left < right ? -1 : left > right ? 1 : 0;
}

function runIds(dir) {
  try {
    return fs.readdirSync(path.join(dir, 'evals'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && runPattern.test(entry.name)
        && fs.existsSync(path.join(dir, 'evals', entry.name, 'run.json')))
      .map((entry) => entry.name).sort(compareRuns);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return [];
  }
}

function judgeKey(run, judgments) {
  if (typeof run.judge_rubric !== 'string' || !Number.isInteger(run.judge_votes)) return null;
  if (run.judge_examples !== null && typeof run.judge_examples?.hash !== 'string') return null;
  const models = [...new Set(judgments.map((row) => row.judge?.model ?? null))].sort();
  // An unreported model could hide a host-side default change.
  if (!models.length || models.includes(null)) return null;
  return JSON.stringify([run.judge, run.judge_rubric, run.judge_examples?.hash ?? null, run.judge_votes, models]);
}

// A run without its own ratings inherits trust from the latest calibrated run
// with the same judge host, model, rubric hash, examples hash, vote count and returned judge models.
function inheritedCalibration(dir, runId, run, judgments) {
  const key = judgeKey(run, judgments);
  if (key === null) return null;
  for (const id of runIds(dir).reverse()) {
    if (id === runId || !calibrate.readRatings(dir, id).length) continue;
    const other = store.readJson(dir, `evals/${id}/run.json`);
    if (judgeKey(other, store.readJsonl(dir, `evals/${id}/judgments.jsonl`)) !== key) continue;
    const value = calibrate.agreement(dir, id);
    return { match: value.match, rated: value.rated, from: id };
  }
  return null;
}

function writeReport(dir, runId) {
  if (!runPattern.test(runId || '')) throw new Error('eval report: unknown run');
  const base = `evals/${runId}`;
  let run;
  try { run = store.readJson(dir, `${base}/run.json`); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Error('eval report: unknown run');
  }
  let previous = null;
  for (const id of runIds(dir).reverse()) {
    if (compareRuns(id, runId) >= 0) continue;
    try { previous = store.readJson(dir, `evals/${id}/report.json`); break; } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const ratings = calibrate.readRatings(dir, runId);
  const judgments = store.readJsonl(dir, `${base}/judgments.jsonl`);
  const value = report.build({
    persona: store.readJson(dir, 'persona.json'), cases: store.readJsonl(dir, 'cases.jsonl'),
    drafts: store.readJsonl(dir, `${base}/drafts.jsonl`), judgments,
    ratings, calibration: ratings.length ? calibrate.agreement(dir, runId) : inheritedCalibration(dir, runId, run, judgments),
    previous, run,
  });
  const markdown = report.renderMarkdown(value);
  store.writeJson(dir, `${base}/report.json`, value);
  store.writeText(dir, `${base}/report.md`, markdown);
  return markdown;
}

async function execute(subcommand, argv, io) {
  const opts = {};
  const keys = subcommand === 'report' ? { '--run': 'runId', '--persona': 'persona' }
    : { '--drafter': 'drafter', '--judge': 'judge', '--limit': 'limit', '--run': 'runId', '--rejudge-from': 'rejudgeFrom', '--persona': 'persona' };
  for (let index = 0; index < argv.length; index += 2) {
    const key = keys[argv[index]];
    const value = argv[index + 1];
    if (!key || Object.hasOwn(opts, key) || !value || value.startsWith('--')
      || (key === 'limit' && (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))))) {
      if (subcommand === 'report' && key === 'runId' && !Object.hasOwn(opts, key)) {
        io.stderr.write('eval report: unknown run\n');
        return 1;
      }
      io.stderr.write(usage);
      return 2;
    }
    opts[key] = key === 'limit' ? Number(value) : value;
  }
  try {
    const dir = store.resolvePersona({ persona: opts.persona, env: io.env || process.env });
    let runId = opts.runId;
    if (subcommand === 'run') {
      const result = await evalRun.run(dir, opts);
      runId = result.run_id;
      io.stdout.write(`run ${result.run_id}: drafted ${result.drafted}, judged ${result.judged}, judge errors ${result.errors}\n`);
    } else if (runId === undefined) runId = runIds(dir).at(-1);
    io.stdout.write(writeReport(dir, runId));
    return 0;
  } catch (error) {
    io.stderr.write(`${error.message}\n`);
    return 1;
  }
}

module.exports = {
  runIds, compareRuns,
  name: 'eval', summary: 'Run held-out drafts and judgments, or render a report',
  async run(argv, io) {
    if (['run', 'report'].includes(argv[0])) return execute(argv[0], argv.slice(1), io);
    io.stderr.write(usage);
    return 2;
  },
};
