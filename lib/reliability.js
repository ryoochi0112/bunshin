'use strict';

const { isDeepStrictEqual } = require('node:util');
const kbGates = require('./kb-gates');
const coverageFile = require('./coverage');

function selected({ run, cases }) {
  return run.limit == null ? cases : cases.slice(0, run.limit);
}

function frozen(run, coverage) {
  return {
    kb_digest_hash: run.kb?.digest_hash ?? null, persona_version: run.persona_version ?? null,
    drafter: run.drafter ?? null, judge: run.judge ?? null,
    judge_rubric: run.judge_rubric ?? null, support_rubric: run.support_rubric ?? null,
    judge_examples_hash: run.judge_examples?.hash ?? null, coverage_hash: coverageFile.hash(coverage),
  };
}

function sendAsIsRate(judgments) {
  const valid = judgments.filter((row) => ['send_as_is', 'needs_edits', 'wrong'].includes(row.rating));
  return valid.length ? valid.filter((row) => row.rating === 'send_as_is').length / valid.length : null;
}

function build({ runs, coverage = null }) {
  const inputs = frozen(runs[0].run, coverage);
  const caseIds = (row) => selected(row).map(({ id }) => id).sort();
  const ids = caseIds(runs[0]);
  const refuse = (field) => { throw new Error(`eval report: runs differ in ${field}`); };
  // Validate all inputs before the caller writes either report file.
  for (const row of runs) {
    const other = frozen(row.run, coverage);
    for (const field of Object.keys(inputs)) {
      if (!isDeepStrictEqual(inputs[field], other[field])) refuse(field);
    }
    // Older manifests have no coverage pin; the report freezes the shared file.
    if (row.run.coverage_hash !== undefined && row.run.coverage_hash !== inputs.coverage_hash) refuse('coverage_hash');
    if (!isDeepStrictEqual(ids, caseIds(row))) refuse('cases');
  }
  const grades = runs.map((row) => kbGates.grade({ ...row, coverage }));
  const graded = grades.map((value) => new Map(value.cases.map((row) => [row.id, row])));
  const cases = [];
  for (const value of selected(runs[0])) {
    if (value.layer !== 'knowledge' && !graded.some((rows) => rows.has(value.id))) continue;
    const label = coverage?.cases[value.id]?.coverage ?? null;
    if (label === 'X') continue;
    const results = graded.map((rows, index) => {
      const row = rows.get(value.id);
      if (['no_coverage', 'coverage_stale'].includes(grades[index].status) || !row || row.incomplete) return 'incomplete';
      return row.pass ? 'pass' : 'fail';
    });
    const verdict = results.includes('incomplete') ? 'incomplete'
      : results.every((result) => result === 'pass') ? 'stable_pass'
        : results.every((result) => result === 'fail') ? 'stable_fail' : 'unstable';
    cases.push({ id: value.id, label, results, verdict });
  }
  const counts = Object.fromEntries(['stable_pass', 'stable_fail', 'unstable', 'incomplete']
    .map((verdict) => [verdict, cases.filter((row) => row.verdict === verdict).length]));
  return {
    runs: runs.map(({ run }) => run.run_id), frozen: inputs,
    per_run: runs.map((row, index) => ({ run_id: row.run.run_id, kb_gates_status: grades[index].status,
      send_as_is_rate: sendAsIsRate(row.judgments) })),
    cases, counts,
    status: counts.incomplete || grades.some((row) => ['incomplete', 'no_coverage', 'coverage_stale'].includes(row.status))
      ? 'incomplete' : counts.stable_fail || counts.unstable ? 'fail' : 'pass',
  };
}

function renderMarkdown(report) {
  const percent = (rate) => rate === null ? 'n/a' : `${Math.round(100 * rate)}%`;
  const lines = [
    `bunshin eval reliability — ${report.status}`,
    `frozen: ${JSON.stringify(report.frozen)}`,
    ...report.per_run.map((row) => `${row.run_id} · ${row.kb_gates_status} · send as-is ${percent(row.send_as_is_rate)}`),
    `counts: stable pass ${report.counts.stable_pass} · stable fail ${report.counts.stable_fail} · unstable ${report.counts.unstable} · incomplete ${report.counts.incomplete}`,
  ];
  for (const verdict of ['unstable', 'incomplete']) {
    lines.push(`${verdict}: ${report.cases.filter((row) => row.verdict === verdict).map((row) => row.id).join(', ') || 'none'}`);
  }
  return `${lines.join('\n')}\n`;
}

module.exports = { build, renderMarkdown };
