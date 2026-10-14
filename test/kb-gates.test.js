'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { grade } = require('../lib/kb-gates');

function input(label = 'C', shape = { facts: 1, abstain: false, handback: false }) {
  return {
    run: { kb: { digest_hash: 'digest' }, limit: null },
    cases: [{ id: 'sample-13', layer: 'knowledge' }],
    drafts: [{ case_id: 'sample-13', skill: 'spec-answer', kb: { digest_hash: 'digest' }, shape,
      gates: { citation: true, resolves: true, current: true, scrub: true } }],
    support: [{ case_id: 'sample-13', sentences: shape.facts ? [{ index: 0, ids: ['demo.model.provider'], verdict: 'supported' }] : [] }],
    coverage: { kb_digest_hash: 'digest', cases: label ? { 'sample-13': { coverage: label, entries: [] } } : {} },
  };
}

test('every coverage table row has its exact outcome and case flags', () => {
  for (const [label, facts, abstain, handback, outcome, hard, miss, incomplete] of [
    ['C', 1, false, false, 'answered', [], false, false],
    ['C', 0, true, false, 'wrong_abstain', [], true, false],
    ['P', 1, false, true, 'partial', [], false, false],
    ['P', 1, false, false, 'over_answer', ['coverage'], false, false],
    ['P', 0, true, false, 'wrong_abstain', [], true, false],
    ['N', 0, true, false, 'abstained', [], false, false],
    ['N', 0, false, true, 'handback_miss', [], true, false],
    ['N', 1, false, false, 'answered_not_covered', ['coverage'], false, false],
    ['X', 1, false, false, 'excluded', [], false, false],
    [null, 1, false, false, 'unlabelled', [], false, true],
  ]) {
    const data = input(label, { facts, abstain, handback });
    const before = structuredClone(data);
    const value = grade(data);
    assert.deepEqual(value.cases, [{ id: 'sample-13', label, outcome,
      pass: !hard.length && !miss && !incomplete && label !== 'X', hard, miss, incomplete }]);
    assert.equal(value.counts[outcome], 1);
    assert.equal(Object.values(value.counts).reduce((a, b) => a + b), 1);
    assert.equal(value.status, incomplete ? 'incomplete' : hard.length ? 'fail' : 'pass');
    assert.deepEqual(data, before);
  }
});

test('hard gates count cases once, independently of coverage outcome', () => {
  for (const gate of ['citation', 'resolves', 'current', 'scrub', 'support']) {
    const data = input();
    if (gate === 'support') data.support[0].sentences = ['partly', 'not_supported'].map((verdict, index) => ({ index, verdict, ids: ['demo.model.provider'] }));
    else data.drafts[0].gates[gate] = false;
    const value = grade(data);
    assert.equal(value.status, 'fail');
    assert.deepEqual(value.cases[0].hard, [gate]);
    assert.equal(value.gate_failures[gate], 1);
    assert.equal(value.counts.answered, 1);
    assert.equal(value.cases[0].pass, false);
  }
  const data = input('X');
  data.drafts[0].gates.scrub = false;
  data.support = [];
  assert.equal(grade(data).status, 'pass');
  assert.equal(grade(data).gate_failures.scrub, 0);
});

test('missing evidence, old runs, and support errors cannot pass', () => {
  for (const change of [
    (data) => { data.drafts = []; },
    (data) => { delete data.drafts[0].shape; },
    (data) => { delete data.drafts[0].kb; },
    (data) => { data.support = []; },
    (data) => { data.support[0].sentences = []; },
    (data) => { delete data.support[0].sentences; },
    (data) => { data.support[0].sentences[0].verdict = 'support_error'; },
    (data) => { delete data.drafts[0].gates; },
    (data) => { data.support[0].sentences[0].verdict = 'unknown'; },
    (data) => { data.drafts[0].shape.facts = -1; },
    (data) => { delete data.drafts[0].shape.handback; },
    (data) => { data.coverage.cases['sample-13'].coverage = 'invalid'; },
  ]) {
    const data = input(); change(data);
    const value = grade(data);
    assert.equal(value.status, 'incomplete');
    assert.equal(value.cases[0].incomplete, true);
    assert.equal(value.cases[0].pass, false);
    assert.equal(value.gate_failures.support, 0);
  }
  const data = input(); delete data.drafts[0].shape;
  assert.equal(grade(data).counts.ungraded, 1);
});

test('status precedence, limited runs, and cases outside the KB scope', () => {
  const data = input();
  data.coverage = null;
  assert.equal(grade(data).status, 'no_coverage');
  data.coverage = input().coverage;
  delete data.run.kb;
  assert.equal(grade(data).status, 'no_coverage');
  data.run.kb = { digest_hash: 'changed' };
  assert.equal(grade(data).status, 'coverage_stale');
  data.run.kb.digest_hash = 'digest';
  data.cases.push({ id: 'sample-10', layer: 'judgment' });
  data.coverage.cases['not-in-run'] = { coverage: 'N', entries: [] };
  assert.equal(grade(data).cases.length, 1);
  assert.equal(grade(data).status, 'pass');
  data.run.limit = 1;
  data.cases.push({ id: 'sample-14', layer: 'knowledge' });
  data.coverage.cases['sample-14'] = { coverage: 'N', entries: [] };
  assert.equal(grade(data).cases.length, 1);
  assert.equal(grade(data).counts.abstained, 0);
  assert.equal(grade(data).status, 'incomplete');
});

test('all six failure totals are per case and incomplete takes precedence over fail', () => {
  const data = input('P');
  data.drafts[0].gates = { citation: false, resolves: false, current: false, scrub: false };
  data.support[0].sentences = [
    { index: 0, ids: ['demo.model.provider'], verdict: 'partly' },
    { index: 1, ids: ['demo.model.provider'], verdict: 'not_supported' },
  ];
  let value = grade(data);
  assert.deepEqual(value.gate_failures, { citation: 1, resolves: 1, current: 1, support: 1, coverage: 1, scrub: 1 });
  assert.deepEqual(value.cases[0].hard, ['citation', 'resolves', 'current', 'support', 'coverage', 'scrub']);
  assert.equal(value.status, 'fail');
  data.support[0].sentences.push({ index: 2, ids: ['demo.model.provider'], verdict: 'support_error' });
  value = grade(data);
  assert.equal(value.status, 'incomplete');
  assert.equal(value.gate_failures.support, 1);
  data.coverage.kb_digest_hash = 'stale';
  assert.equal(grade(data).status, 'coverage_stale');
});

test('excluded and unlabelled cases make no gate claim; empty N replies are ungraded', () => {
  const excluded = input('X');
  excluded.drafts = [];
  excluded.support = [];
  assert.equal(grade(excluded).cases[0].incomplete, false);
  const unlabelled = input(null);
  unlabelled.drafts[0].gates.scrub = false;
  unlabelled.support[0].sentences[0].verdict = 'not_supported';
  assert.deepEqual(grade(unlabelled).gate_failures, { citation: 0, resolves: 0, current: 0, support: 0, coverage: 0, scrub: 0 });
  const empty = grade(input('N', { facts: 0, abstain: false, handback: false }));
  assert.equal(empty.counts.ungraded, 1);
  assert.equal(empty.status, 'incomplete');
});

test('each unsupported verdict fails gate 4; structurally rejected sentences need no verdict', () => {
  for (const verdict of ['partly', 'not_supported']) {
    const data = input();
    data.support[0].sentences[0].verdict = verdict;
    const value = grade(data);
    assert.equal(value.status, 'fail');
    assert.deepEqual(value.cases[0].hard, ['support']);
  }
  for (const gate of ['citation', 'resolves', 'current', 'scrub']) {
    const data = input();
    data.drafts[0].gates[gate] = false;
    data.support[0].sentences = [];
    const value = grade(data);
    assert.equal(value.status, 'fail');
    assert.equal(value.cases[0].incomplete, false);
    assert.equal(value.gate_failures.support, 0);
  }
});
