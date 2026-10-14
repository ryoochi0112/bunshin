'use strict';

const outcomes = ['answered', 'partial', 'abstained', 'wrong_abstain', 'handback_miss', 'over_answer',
  'answered_not_covered', 'excluded', 'unlabelled', 'ungraded'];
const gates = ['citation', 'resolves', 'current', 'support', 'coverage', 'scrub'];
const structural = ['citation', 'resolves', 'current', 'scrub'];

function grade({ run, cases, drafts, support = [], coverage = null }) {
  const result = {
    status: 'no_coverage', counts: Object.fromEntries(outcomes.map((key) => [key, 0])),
    gate_failures: Object.fromEntries(gates.map((key) => [key, 0])), cases: [],
  };
  if (!run.kb || coverage === null) return result;
  const draftById = new Map(drafts.map((row) => [row.case_id, row]));
  const supportById = new Map(support.map((row) => [row.case_id, row]));
  const selected = run.limit == null ? cases : cases.slice(0, run.limit);
  for (const value of selected) {
    const draft = draftById.get(value.id);
    if (draft ? draft.skill !== 'spec-answer' : value.layer !== 'knowledge') continue;
    const label = coverage.cases[value.id]?.coverage ?? null;
    let outcome;
    let incomplete = false;
    let miss = false;
    const failures = new Set();
    const shape = draft?.shape;
    if (label === 'X') outcome = 'excluded';
    else if (label === null) { outcome = 'unlabelled'; incomplete = true; }
    else if (!draft?.kb || !shape || !Number.isInteger(shape.facts) || shape.facts < 0
        || typeof shape.abstain !== 'boolean' || typeof shape.handback !== 'boolean') {
      outcome = 'ungraded'; incomplete = true;
    } else {
      if (label === 'C') outcome = shape.facts > 0 ? 'answered' : 'wrong_abstain';
      else if (label === 'P') outcome = shape.facts > 0 ? shape.handback ? 'partial' : 'over_answer' : 'wrong_abstain';
      else if (label === 'N') outcome = shape.facts > 0 ? 'answered_not_covered'
        : shape.abstain ? 'abstained' : shape.handback ? 'handback_miss' : 'ungraded';
      else outcome = 'unlabelled';
      incomplete = ['ungraded', 'unlabelled'].includes(outcome);
      miss = ['wrong_abstain', 'handback_miss'].includes(outcome);
      if (['over_answer', 'answered_not_covered'].includes(outcome)) failures.add('coverage');
      for (const gate of structural) {
        if (draft.gates?.[gate] === false) failures.add(gate);
        else if (draft.gates?.[gate] !== true) incomplete = true;
      }
      const row = supportById.get(value.id);
      if (!Array.isArray(row?.sentences)) incomplete = true;
      else {
        for (const sentence of row.sentences) {
          if (['partly', 'not_supported'].includes(sentence.verdict)) failures.add('support');
          else if (sentence.verdict !== 'supported') incomplete = true;
        }
        // With clean structural gates every fact is eligible for a support verdict.
        if (structural.every((gate) => draft.gates?.[gate] === true) && row.sentences.length < shape.facts) incomplete = true;
      }
    }
    const hard = gates.filter((gate) => failures.has(gate));
    result.counts[outcome]++;
    for (const gate of hard) result.gate_failures[gate]++;
    result.cases.push({ id: value.id, label, outcome,
      pass: outcome !== 'excluded' && !hard.length && !miss && !incomplete, hard, miss, incomplete });
  }
  result.status = coverage.kb_digest_hash !== run.kb.digest_hash ? 'coverage_stale'
    : run.limit != null || result.cases.some((row) => row.incomplete) ? 'incomplete'
      : result.cases.some((row) => row.hard.length) ? 'fail' : 'pass';
  return result;
}

module.exports = { grade };
