'use strict';

const layers = ['knowledge', 'judgment'];
// Spec §7 rule 4: judge trust requires at least 30 owner ratings.
const MIN_TRUST_RATINGS = 30;
const validRatings = new Set(['send_as_is', 'needs_edits', 'wrong']);

function stats(rows, draftById, owner = false) {
  const result = Object.fromEntries(layers.map((layer) => [layer, { n: 0, send_as_is: 0, send_as_is_rate: null, wrong_uncited: 0 }]));
  for (const row of rows) {
    const layer = draftById.get(row.case_id)?.layer;
    if (!result[layer] || !validRatings.has(row.rating)) continue;
    const value = result[layer];
    value.n++;
    if (row.rating === 'send_as_is') value.send_as_is++;
    value.wrong_uncited += owner ? Number(layer === 'knowledge' && row.wrong_uncited_fact === true) : row.wrong_uncited;
  }
  for (const value of Object.values(result)) value.send_as_is_rate = value.n ? value.send_as_is / value.n : null;
  const n = result.knowledge.n + result.judgment.n;
  return { ...result, n, send_as_is_rate: n ? (result.knowledge.send_as_is + result.judgment.send_as_is) / n : null };
}

function provenance(rows, role, fallback) {
  return { host: fallback.host, models: [...new Set(rows.map((row) => row[role].model ?? null))] };
}

function judgeTrust({ match, rated }, persona) {
  return rated >= MIN_TRUST_RATINGS && match / rated >= persona.launch_bar.min_agreement ? 'trusted' : 'untrusted';
}

function build({ persona, cases, drafts, judgments, ratings, calibration, previous, run }) {
  const draftById = new Map(drafts.map((row) => [row.case_id, row]));
  const judgedIds = new Set(judgments.map((row) => row.case_id));
  const judgeStats = stats(judgments, draftById);
  const agreement = calibration === null ? null : { match: calibration.match, rated: calibration.rated };
  const judge_trust = agreement === null ? 'uncalibrated' : judgeTrust(agreement, persona);
  const basis = judge_trust === 'trusted' ? 'judge' : 'owner_ratings';
  const bar = basis === 'judge' ? judgeStats : stats(ratings.filter((row) => row.run_id === run.run_id), draftById, true);
  const thresholds = persona.launch_bar;
  const undrafted = cases.filter((row) => !draftById.has(row.id)).length;
  const unjudged = [...draftById.keys()].filter((id) => !judgedIds.has(id)).length;
  // Criteria 9/11: no launch-bar claim unless every held-out case is drafted and judged in an unlimited run.
  const complete = undrafted === 0 && unjudged === 0 && (run.limit ?? null) === null;
  const launch_bar = !complete || bar.n < thresholds.min_heldout || layers.some((layer) => bar[layer].n < thresholds.min_per_layer)
    ? 'sample_too_small' : bar.send_as_is_rate >= thresholds.send_as_is && bar.knowledge.wrong_uncited === 0 ? 'met' : 'not_met';
  const delta = Object.fromEntries(layers.map((layer) => {
    const rate = judgeStats[layer].send_as_is_rate;
    const before = previous?.[layer]?.send_as_is_rate;
    return [layer, rate == null || before == null ? null : Math.round(100 * rate) - Math.round(100 * before)];
  }));
  return {
    format_version: 1, persona: persona.name, display_name: persona.display_name,
    run_id: run.run_id, persona_version: run.persona_version,
    heldout: { n: cases.length, ...Object.fromEntries(layers.map((layer) => [layer, cases.filter((row) => row.layer === layer).length])) },
    knowledge: judgeStats.knowledge, judgment: judgeStats.judgment, overall_rate: judgeStats.send_as_is_rate, delta,
    drafter: provenance(drafts, 'drafter', run.drafter), judge: provenance(judgments, 'judge', run.judge),
    judge_trust, agreement, basis, bar_n: bar.n, launch_bar,
    judge_errors: judgments.filter((row) => row.rating === 'judge_error').length,
    unjudged, undrafted, complete,
  };
}

function renderMarkdown(report) {
  const percent = (rate) => rate === null ? 'n/a' : `${Math.round(100 * rate)}%`;
  const delta = (layer) => report.delta[layer] === null ? '' : ` (${report.delta[layer] >= 0 ? '+' : ''}${report.delta[layer]})`;
  const role = (value) => `${value.host} ${(value.models.length ? value.models : [null]).map((model) => model ?? 'default').join(', ')}`;
  const labels = { met: 'launch bar MET', not_met: 'launch bar NOT MET', sample_too_small: 'sample too small' };
  const lines = [
    `bunshin eval — persona ${report.persona} @ v${report.persona_version} — ${report.run_id.slice(0, 10)}`,
    `held-out: ${report.heldout.n} pairs (knowledge ${report.heldout.knowledge}, judgment ${report.heldout.judgment})`,
    `knowledge: send as-is ${percent(report.knowledge.send_as_is_rate)}${delta('knowledge')} · wrong fact without citation ${report.knowledge.wrong_uncited}`,
    `judgment:  send as-is ${percent(report.judgment.send_as_is_rate)}${delta('judgment')}`,
    `overall:   send as-is ${percent(report.overall_rate)}  → ${labels[report.launch_bar]}`,
    report.agreement === null ? `judge agreement with ${report.display_name}: not calibrated → uncalibrated`
      : `judge agreement with ${report.display_name}: ${report.agreement.match}/${report.agreement.rated} (${percent(report.agreement.rated ? report.agreement.match / report.agreement.rated : null)}) → ${report.judge_trust}`,
    `drafter: ${role(report.drafter)} · judge: ${role(report.judge)}`,
  ];
  if (report.judge_errors) lines.push(`judge errors: ${report.judge_errors} (excluded from rates)`);
  if (report.unjudged) lines.push(`not judged: ${report.unjudged}`);
  if (report.undrafted) lines.push(`not drafted: ${report.undrafted}`);
  if (!report.complete) {
    lines.push(`incomplete: ${report.heldout.n - report.undrafted - report.unjudged} of ${report.heldout.n} held-out cases drafted and judged — no launch-bar claim`);
  }
  if (report.basis === 'owner_ratings') lines.push(`launch bar basis: ${report.display_name}'s ratings (${report.bar_n} rated)`);
  return `${lines.join('\n')}\n`;
}

module.exports = { build, renderMarkdown, judgeTrust };
