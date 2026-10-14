'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const store = require('../lib/store');
const pairs = require('../lib/pairs');
const split = require('../lib/split');
const kb = require('../lib/kb');
const coverage = require('../lib/coverage');
const evalRun = require('../lib/eval-run');
const judge = require('../lib/judge');
const support = require('../lib/support');
const evalCommand = require('../lib/commands/eval');

const root = path.join(__dirname, '..');
const seedDir = path.join(__dirname, 'fixtures', 'kb-seeded');
const scrubString = 'FictionalClient';
const verifiedId = 'demo.model.provider';
const defaultDraft = 'Cloudberry Lantern uses the synthetic model Amber Kite. [demo.model.provider]';
const validJudgment = {
  rating: 'send_as_is', reason: 'Synthetic judgment.', claims: [], wrong_uncited: 0, language_match: true,
};

function addPair(id) {
  return {
    id, source: 'manual', permalink: `https://example.invalid/seeded/${id}`,
    channel: 'synthetic-kb-evaluation', asked_at: '2026-01-10T09:00:00.000Z',
    layer: 'knowledge', layer_source: 'manual',
    question: { author: 'Synthetic User', text: `What does seeded case ${id} ask about Cloudberry Lantern?` },
    context: [{ author: 'Synthetic User', text: `Synthetic context for seeded case ${id}.` }],
    answer: { text: `Synthetic reference response for seeded case ${id}.` },
    harvested_at: '2026-01-11T09:00:00.000Z',
  };
}

function fixture(t, seedCases) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-kb-seeded-')));
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); store._resetGuardCache(); });
  const dir = path.join(home, 'sample');
  fs.cpSync(path.join(root, 'sample', 'persona'), dir, { recursive: true });
  store.writeJson(dir, 'persona.json', { ...store.readJson(dir, 'persona.json'), kb: 'demo' });

  const env = { BUNSHIN_HOME: home };
  const kbDir = kb.resolve({ name: 'demo', env });
  store.writeJson(kbDir, 'kb.json', {
    format_version: 1, name: 'demo', product: 'Cloudberry Lantern', synthetic: true, languages: ['en'],
  }, { synthetic: true });
  store.writeJsonl(kbDir, 'sources.jsonl', [{
    id: 'S01', kind: 'notion', label: 'Synthetic Cloudberry Lantern facts',
    ref: 'https://example.invalid/seeded/kb', answered_at: '2026-10-12',
  }], { synthetic: true });
  store.writeText(kbDir, 'entries/model.md', fs.readFileSync(path.join(seedDir, 'entries.md'), 'utf8'), { synthetic: true });
  store.writeJsonl(kbDir, 'flags.jsonl', [{
    id: 'demo.model.flagged', flagged: true, reason: 'Synthetic source changed.', at: '2026-10-13T09:00:00.000Z',
  }], { synthetic: true });
  store.writeText(path.dirname(kbDir), 'demo.scrub.txt', `${scrubString}\n`, { synthetic: true });

  let candidateCount = Math.max(180, seedCases.length * 5);
  let seededHeldout;
  while (true) {
    const generated = Array.from({ length: candidateCount }, (_, index) => addPair(`seeded-${String(index + 1).padStart(4, '0')}`));
    pairs.addPairs(dir, generated);
    split.assign(dir);
    seededHeldout = pairs.listPairs(dir, { set: 'heldout' }).filter((pair) => pair.id.startsWith('seeded-'));
    if (seededHeldout.length >= seedCases.length) break;
    candidateCount += 100;
  }
  seededHeldout.sort((a, b) => a.id.localeCompare(b.id));
  const selected = seededHeldout.slice(0, seedCases.length);
  const splitState = split.readSplit(dir);
  for (const pair of seededHeldout.slice(seedCases.length)) splitState.assignments[pair.id] = 'build';
  store.writeJson(dir, 'split.json', splitState);

  const selectedIds = new Set(selected.map((pair) => pair.id));
  const excludedIds = pairs.listPairs(dir, { set: 'heldout' })
    .filter((pair) => !selectedIds.has(pair.id) && pair.layer === 'knowledge').map((pair) => pair.id);
  const labels = selected.map((pair, index) => ({
    id: pair.id, coverage: seedCases[index].coverage,
    entries: ['C', 'P'].includes(seedCases[index].coverage) ? [verifiedId] : [],
  }));
  labels.push(...excludedIds.map((id) => ({ id, coverage: 'X', entries: [] })));
  const importFile = path.join(home, 'seeded-coverage.json');
  fs.writeFileSync(importFile, JSON.stringify({ cases: labels }));
  coverage.importFile(dir, importFile, { env });
  return { home, dir, env, seedCases, mappedPairs: selected, excludedIds };
}

function adaptersFor(seedCases, mappedPairs) {
  const drafts = new Map(mappedPairs.map((pair, index) => [pair.question.text, seedCases[index].draft]));
  const verdicts = new Map(seedCases.filter((row) => row.support_verdict)
    .map((row) => [row.draft.split('\n')[0], row.support_verdict]));
  const calls = [];
  return {
    calls,
    get(host) {
      return { async run(input) {
        calls.push({ host, input });
        if (input.outputSchema === support.outputSchema) {
          const sentence = /^Sentence:\n([^\n]*)/.exec(input.prompt)?.[1];
          const verdict = verdicts.get(sentence) ?? 'supported';
          return { text: JSON.stringify({ verdict, reason: 'Synthetic support result.' }), model: 'synthetic-judge' };
        }
        if (input.outputSchema === judge.outputSchema) {
          return { text: JSON.stringify(validJudgment), model: 'synthetic-judge' };
        }
        const prompt = /^Question:\n([^\n]*)/.exec(input.prompt)?.[1];
        return { text: drafts.get(prompt) ?? defaultDraft, model: 'synthetic-drafter' };
      } };
    },
  };
}

test('seeded KB defects fail their individual gates through eval run and report', async (t) => {
  const fixtureData = JSON.parse(fs.readFileSync(path.join(seedDir, 'cases.json'), 'utf8'));
  const { dir, env, seedCases, mappedPairs, excludedIds } = fixture(t, fixtureData.cases);
  assert.equal(excludedIds.length, 1);
  const adapters = adaptersFor(seedCases, mappedPairs);

  const run = await evalRun.run(dir, { env, drafter: 'fake:seeded', judge: 'fake:seeded', hosts: adapters });
  assert.equal(run.drafted, mappedPairs.length + excludedIds.length + 2);
  assert.equal(run.judged, run.drafted);
  assert.equal(run.errors, 0);

  let stdout = '';
  let stderr = '';
  const code = await evalCommand.run(['report', '--run', run.run_id, '--persona', dir], {
    env, stdout: { write(text) { stdout += text; } }, stderr: { write(text) { stderr += text; } },
  });
  assert.equal(code, 0, stderr);
  const report = store.readJson(dir, `evals/${run.run_id}/report.json`);
  const gates = report.kb_gates;
  assert.equal(gates.status, 'fail');
  assert.deepEqual(gates.counts, {
    answered: 29, partial: 2, abstained: 1, wrong_abstain: 0, handback_miss: 0,
    over_answer: 5, answered_not_covered: 5, excluded: excludedIds.length,
    unlabelled: 0, ungraded: 0,
  });
  assert.deepEqual(gates.gate_failures, {
    citation: 0, resolves: 5, current: 10, support: 10, coverage: 10, scrub: 2,
  });

  const byId = new Map(gates.cases.map((row) => [row.id, row]));
  for (const [index, seed] of seedCases.entries()) {
    const row = byId.get(mappedPairs[index].id);
    assert.ok(row, seed.key);
    if (seed.defect_gate) {
      assert.deepEqual(row.hard, [seed.defect_gate], seed.key);
      assert.equal(row.pass, false, seed.key);
      assert.equal(row.incomplete, false, seed.key);
    } else {
      assert.deepEqual(row.hard, [], seed.key);
      assert.equal(row.pass, true, seed.key);
      assert.equal(row.outcome, seed.expected_outcome, seed.key);
    }
  }
  for (const id of excludedIds) {
    const row = byId.get(id);
    assert.deepEqual(row.hard, []);
    assert.equal(row.outcome, 'excluded');
  }

  const supportRows = store.readJsonl(dir, `evals/${run.run_id}/support.jsonl`);
  const supportById = new Map(supportRows.map((row) => [row.case_id, row]));
  for (const row of supportRows) {
    assert.deepEqual(Object.keys(row).sort(), ['at', 'case_id', 'judge', 'sentences']);
    for (const sentence of row.sentences) {
      assert.deepEqual(Object.keys(sentence).sort(), ['ids', 'index', 'verdict']);
    }
  }
  for (const [index, seed] of seedCases.entries()) {
    if (!seed.support_verdict) continue;
    assert.deepEqual(supportById.get(mappedPairs[index].id).sentences.map((row) => row.verdict), [seed.support_verdict], seed.key);
  }
  const supportText = JSON.stringify(supportRows);
  const reportText = JSON.stringify(report);
  const reportOutput = `${stdout}\n${reportText}`;
  for (const seed of seedCases) {
    assert.ok(!supportText.includes(seed.draft), seed.key);
    assert.ok(!reportText.includes(seed.draft), seed.key);
    const sentence = seed.draft.split('\n')[0];
    assert.ok(!supportText.includes(sentence), seed.key);
    assert.ok(!reportText.includes(sentence), seed.key);
  }
  const entryValues = [...fs.readFileSync(path.join(seedDir, 'entries.md'), 'utf8').matchAll(/^(?:claim|select|note): (.+)$/gm)]
    .map((match) => match[1]);
  for (const value of entryValues) {
    assert.ok(!supportText.includes(value));
    assert.ok(!reportOutput.includes(value));
  }
  assert.ok(!supportText.includes(scrubString));
  assert.ok(!reportText.includes(scrubString));
  assert.ok(!stdout.includes(scrubString));
  assert.match(stdout, /kb gates: fail/);
});
