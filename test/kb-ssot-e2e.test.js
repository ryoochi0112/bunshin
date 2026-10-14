'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Readable } = require('node:stream');
const store = require('../lib/store');
const kb = require('../lib/kb');
const evalRun = require('../lib/eval-run');
const judge = require('../lib/judge');
const support = require('../lib/support');
const kbCommand = require('../lib/commands/kb');
const coverageCommand = require('../lib/commands/coverage');
const evalCommand = require('../lib/commands/eval');

const root = path.join(__dirname, '..');
const statementId = 'demo.model.s1';
const statementText = 'Cloudberry Lantern は架空のモデル「灯り」を利用する。';

async function invoke(command, args, env, stdin) {
  let stdout = '';
  let stderr = '';
  const code = await command.run(args, { env, stdin, probe: () => 'private',
    stdout: { write(text) { stdout += text; } }, stderr: { write(text) { stderr += text; } },
  });
  assert.equal(code, 0, stderr);
  assert.equal(stderr, '');
  return stdout;
}

test('sample SSOT draft, approval and enable flow reaches eval gates and invalidates coverage', async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-kb-ssot-e2e-')));
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); store._resetGuardCache(); });
  const dir = path.join(home, 'sample');
  fs.cpSync(path.join(root, 'sample', 'persona'), dir, { recursive: true });
  store.writeJson(dir, 'persona.json', { ...store.readJson(dir, 'persona.json'), kb: 'demo' });
  const pairs = store.readJsonl(dir, 'pairs.jsonl');
  // The sample has one held-out knowledge case; reuse a copied judgment case for P.
  const partial = pairs.find((row) => row.id === 'sample-12');
  partial.layer = 'knowledge';
  store.writeJsonl(dir, 'pairs.jsonl', pairs);

  const env = { BUNSHIN_HOME: home };
  const kbDir = kb.resolve({ name: 'demo', env });
  fs.cpSync(path.join(root, 'sample', 'kb', 'demo'), kbDir, { recursive: true });
  const originalEntries = fs.readFileSync(path.join(kbDir, 'entries', 'model.md'), 'utf8');
  const originalDigest = kb.digest(kb.load(kbDir));
  assert.equal(Object.hasOwn(store.readJson(kbDir, 'kb.json'), 'digest'), false);

  const labelsFile = path.join(home, 'sample-coverage.json');
  fs.writeFileSync(labelsFile, JSON.stringify({ cases: [
    { id: 'sample-13', coverage: 'C', entries: ['demo.model.provider'] },
    { id: 'sample-12', coverage: 'P' },
  ] }));
  await invoke(coverageCommand, ['import', labelsFile, '--persona', dir], env);
  const importedCoverage = store.readJson(dir, 'coverage.json');
  assert.equal(importedCoverage.kb_digest_hash, originalDigest.hash);

  const blocks = `## model\ntitle: 利用モデル\n\n### ${statementId}\ntext: ${statementText}\nbacks: demo.model.provider\n`;
  await invoke(kbCommand, ['ssot', 'draft', 'demo'], env, Readable.from([blocks]));
  assert.equal(fs.readFileSync(path.join(kbDir, 'ssot.md'), 'utf8'), '# demo SSOT\n\n' + blocks);
  assert.equal(await invoke(kbCommand, ['ssot', 'status', 'demo'], env), 'model  draft  1 statements\nuncovered 0\n');
  assert.equal(kb.digest(kb.load(kbDir)).hash, originalDigest.hash);
  await invoke(kbCommand, ['ssot', 'approve', 'demo', 'model'], env);
  assert.equal(kb.digest(kb.load(kbDir)).hash, originalDigest.hash);
  await invoke(kbCommand, ['ssot', 'enable', 'demo'], env);
  assert.equal(await invoke(kbCommand, ['ssot', 'status', 'demo'], env), 'model  approved  1 statements\nuncovered 0\n');
  assert.equal(store.readJson(kbDir, 'kb.json').digest, 'ssot');
  const digest = kb.digest(kb.load(kbDir));
  assert.notEqual(digest.hash, originalDigest.hash);
  assert.deepEqual(digest.ids, [statementId]);
  assert.equal(fs.readFileSync(path.join(kbDir, 'entries', 'model.md'), 'utf8'), originalEntries);

  const cited = `${statementText} [${statementId}]`;
  const calls = [];
  const adapters = { get(host) { return { async run(input) {
    calls.push({ host, ...input });
    if (input.outputSchema === support.outputSchema) {
      return { text: JSON.stringify({ verdict: 'supported', reason: 'Synthetic support.' }), model: 'fake-judge' };
    }
    if (input.outputSchema === judge.outputSchema) {
      return { text: JSON.stringify({ rating: 'send_as_is', reason: 'Synthetic judgment.',
        claims: [], wrong_uncited: 0, language_match: true }), model: 'fake-judge' };
    }
    return { text: input.prompt.includes(partial.question.text)
      ? `${cited}\nNeeds human.\nReason: The processing region is not covered.` : cited, model: 'fake-drafter' };
  } }; } };
  const run = await evalRun.run(dir, { env, drafter: 'fake:ssot', judge: 'fake:ssot', hosts: adapters });
  assert.equal(run.drafted, 3);
  assert.equal(run.judged, 3);
  assert.equal(run.errors, 0);
  const drafts = store.readJsonl(dir, `evals/${run.run_id}/drafts.jsonl`);
  for (const id of ['sample-13', 'sample-12']) {
    const row = drafts.find((value) => value.case_id === id);
    assert.equal(row.skill, 'spec-answer');
    for (const gate of ['citation', 'resolves', 'current']) assert.equal(row.gates[gate], true, `${id}: ${gate}`);
    assert.deepEqual(row.shape, { abstain: false, handback: id === 'sample-12', facts: 1 });
  }
  const supportCalls = calls.filter((call) => call.outputSchema === support.outputSchema);
  assert.equal(supportCalls.length, 2);
  for (const call of supportCalls) {
    assert.ok(call.prompt.includes(statementId));
    assert.ok(call.prompt.includes(statementText));
    assert.equal(call.tools, 'none');
  }

  const reportArgs = ['report', '--run', run.run_id, '--persona', dir];
  const staleOutput = await invoke(evalCommand, reportArgs, env);
  assert.match(staleOutput, /kb gates: coverage_stale/);
  assert.equal(store.readJson(dir, `evals/${run.run_id}/report.json`).kb_gates.status, 'coverage_stale');
  assert.deepEqual(store.readJson(dir, 'coverage.json'), importedCoverage);
  await invoke(coverageCommand, ['import', labelsFile, '--persona', dir], env);
  assert.equal(store.readJson(dir, 'coverage.json').kb_digest_hash, digest.hash);
  assert.deepEqual(store.readJson(dir, 'coverage.json').cases['sample-13'].entries, ['demo.model.provider']);
  const output = await invoke(evalCommand, reportArgs, env);
  assert.match(output, /kb gates: pass/);
  const report = store.readJson(dir, `evals/${run.run_id}/report.json`);
  assert.equal(report.kb_gates.status, 'pass');
  for (const [id, outcome] of [['sample-13', 'answered'], ['sample-12', 'partial']]) {
    const row = report.kb_gates.cases.find((value) => value.id === id);
    assert.equal(row.outcome, outcome);
    assert.equal(row.pass, true);
    assert.deepEqual(row.hard, []);
    assert.equal(row.incomplete, false);
  }
  const reports = [staleOutput, output, JSON.stringify(report),
    fs.readFileSync(path.join(dir, 'evals', run.run_id, 'report.md'), 'utf8'),
    JSON.stringify(store.readJsonl(dir, `evals/${run.run_id}/support.jsonl`))];
  for (const text of reports) {
    assert.ok(!text.includes(statementText));
    for (const match of originalEntries.matchAll(/^claim: (.+)$/gm)) assert.ok(!text.includes(match[1]));
  }
});
