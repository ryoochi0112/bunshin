'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const store = require('../lib/store');
const evalRun = require('../lib/eval-run');
const judge = require('../lib/judge');
const twin = require('../lib/twin');
const hosts = require('../lib/hosts');
const command = require('../lib/commands/eval');

const root = path.join(__dirname, '..');
const drafter = `fake:${path.join(__dirname, 'fixtures', 'hosts', 'eval-drafts.json')}`;
const judgeSpec = `fake:${path.join(__dirname, 'fixtures', 'hosts', 'judge-replies.json')}`;
const valid = { rating: 'needs_edits', reason: 'Synthetic reason.', claims: [
  { text: 'Wrong without citation.', cited: false, correct: false },
  { text: 'Wrong with citation.', cited: true, correct: false },
  { text: 'Unknown.', cited: false, correct: null },
], wrong_uncited: 1, language_match: true };

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-eval-')));
  fs.cpSync(path.join(root, 'sample', 'persona'), dir, { recursive: true });
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); store._resetGuardCache(); });
  return dir;
}

function recording(fn) {
  const calls = [];
  return { calls, get(host) { return { async run(input) {
    calls.push({ host, ...input });
    return fn ? fn(input, calls.length) : { text: input.tools === 'none' ? JSON.stringify(valid) : 'Synthetic draft.', model: `${host}-returned` };
  } }; } };
}

async function cli(args, env = {}) {
  let stdout = '';
  let stderr = '';
  const code = await command.run(args, { env,
    stdout: { write(text) { stdout += text; } }, stderr: { write(text) { stderr += text; } },
  });
  return { code, stdout, stderr };
}

test('judge validates bare and fenced JSON, all fields, and wrong_uncited exactly', () => {
  const text = JSON.stringify(valid);
  assert.deepEqual(judge.parse(text), valid);
  assert.deepEqual(judge.parse(`\n\`\`\`json\n${text}\n\`\`\`\n`), valid);
  for (const [field, value] of [
    ['rating', 'judge_error'], ['reason', '  '], ['claims', {}], ['wrong_uncited', 0],
    ['wrong_uncited', 1.5], ['language_match', 'true'], ['extra', 'secret model text'],
  ]) assert.throws(() => judge.parse(JSON.stringify({ ...valid, [field]: value })), /Invalid judgment field:/);
  for (const [field, value] of [['text', 3], ['cited', null], ['correct', 'false'], ['correct', undefined]]) {
    assert.throws(() => judge.parse(JSON.stringify({ ...valid, claims: [{ ...valid.claims[0], [field]: value }] })), new RegExp(`claims.${field}`));
  }
  for (const field of Object.keys(valid)) {
    const value = { ...valid };
    delete value[field];
    assert.throws(() => judge.parse(JSON.stringify(value)), new RegExp(field));
  }
  for (const text of ['private canary never included in diagnostics', '[]', 'null', '{}',
    `prefix ${JSON.stringify(valid)}`, `\`\`\`\n${JSON.stringify(valid)}\n\`\`\``,
    `\`\`\`json\n${JSON.stringify(valid)}\n\`\`\`\n\`\`\`json\n{}\n\`\`\``]) {
    assert.throws(() => judge.parse(text), (error) => !error.message.includes('private canary') && /Invalid judgment field:/.test(error.message));
  }
});

test('fake hosts rebuild cases, write shapes, retry invalid judgments and continue', async (t) => {
  const dir = fixture(t);
  store.writeJsonl(dir, 'cases.jsonl', []);
  const calls = [];
  const adapters = { get(host) { return { async run(input) {
    calls.push(input);
    return hosts.get(host).run(input);
  } }; } };
  const result = await evalRun.run(dir, { drafter, judge: judgeSpec, hosts: adapters });
  assert.match(result.run_id, /^\d{4}-\d{2}-\d{2}-\d{2}$/);
  assert.deepEqual(result, { run_id: result.run_id, drafted: 3, judged: 3, errors: 2 });
  const config = store.readJson(dir, `evals/${result.run_id}/run.json`);
  assert.equal(config.persona_version, store.readJson(dir, 'persona.json').version);
  assert.deepEqual(config.drafter, hosts.parseSpec(drafter));
  assert.deepEqual(config.judge, hosts.parseSpec(judgeSpec));
  assert.equal(config.limit, null);
  assert.ok(Number.isFinite(Date.parse(config.started_at)));
  const drafts = store.readJsonl(dir, `evals/${result.run_id}/drafts.jsonl`);
  const judgments = store.readJsonl(dir, `evals/${result.run_id}/judgments.jsonl`);
  assert.deepEqual(drafts.map((row) => row.case_id), ['sample-10', 'sample-12', 'sample-13']);
  assert.deepEqual(drafts.map((row) => row.skill), ['idea-discussion', 'idea-discussion', 'spec-answer']);
  assert.equal(judgments[0].rating, 'send_as_is');
  for (const row of judgments.slice(1)) {
    assert.deepEqual(Object.keys(row).sort(), ['at', 'case_id', 'judge', 'rating', 'reason']);
    assert.equal(row.rating, 'judge_error');
    assert.equal(row.reason, 'invalid judge output');
  }
  for (const row of [...drafts, ...judgments]) {
    assert.equal((row.drafter || row.judge).model, 'fake');
    assert.ok(Number.isFinite(Date.parse(row.at)));
  }
  assert.equal(calls.filter((call) => call.tools === 'none').length, 5);
  const resumed = await evalRun.run(dir, { runId: result.run_id, hosts: adapters });
  assert.deepEqual(resumed, { run_id: result.run_id, drafted: 0, judged: 0, errors: 0 });
  assert.equal(calls.length, 8);
});

test('drafter firewall, composed system, tool boundaries, stripped judge template and returned models', async (t) => {
  const dir = fixture(t);
  const adapters = recording();
  const result = await evalRun.run(dir, { drafter: 'fake:requested', judge: 'fake:requested-judge', hosts: adapters });
  const cases = store.readJsonl(dir, 'cases.jsonl');
  assert.ok(cases.every((value) => value.reference_answer.length >= 24));
  for (let index = 0; index < cases.length; index++) {
    const value = cases[index];
    const draftCall = adapters.calls[index * 2];
    const judgeCall = adapters.calls[index * 2 + 1];
    assert.equal(draftCall.system, twin.composePrompt(dir, twin.skillForLayer(value.layer)));
    assert.equal(draftCall.prompt, `Question:\n${value.question.text}\n\nContext:\n${value.context.map(({ author, text }) => `${author}: ${text}`).join('\n')}`);
    for (const heldout of cases) for (const field of ['prompt', 'system']) {
      assert.ok(!draftCall[field].includes(heldout.reference_answer));
    }
    for (const text of [value.id, value.permalink, value.reference_answer]) assert.ok(!draftCall.prompt.includes(text));
    assert.equal(draftCall.tools, 'notion-read');
    assert.deepEqual(draftCall.allowedTools, hosts.allowedTools(store.readJson(dir, 'persona.json')));
    assert.equal(draftCall.model, 'requested');
    assert.equal(judgeCall.tools, 'none');
    assert.equal(judgeCall.model, 'requested-judge');
    assert.deepEqual(judgeCall.outputSchema, judge.outputSchema);
    assert.equal(judgeCall.system, twin.stripTemplateFrontmatter(fs.readFileSync(path.join(root, 'templates', 'judge.md'), 'utf8')));
    assert.doesNotMatch(judgeCall.system, /^(?:---|name:|description:)/m);
    for (const text of [value.question.text, value.reference_answer, 'Synthetic draft.', ...value.context.map((message) => message.text)]) {
      assert.ok(judgeCall.prompt.includes(text));
    }
  }
  for (const file of ['drafts', 'judgments']) for (const row of store.readJsonl(dir, `evals/${result.run_id}/${file}.jsonl`)) {
    assert.equal((row.drafter || row.judge).model, 'fake-returned');
  }
});

test('preflight failures make no host calls and create no run directory', async (t) => {
  for (const kind of ['check', 'spec', 'allowlist']) {
    const dir = fixture(t);
    const adapters = recording();
    const opts = { drafter: 'fake', judge: 'fake', hosts: adapters };
    if (kind === 'check') store.writeText(dir, 'identity.md', store.readJsonl(dir, 'cases.jsonl')[0].reference_answer);
    if (kind === 'spec') opts.judge = 'unknown';
    if (kind === 'allowlist') {
      const manifest = store.readJson(dir, 'persona.json');
      manifest.hosts.claude.allowed_tools = ['mcp__Slack__read'];
      store.writeJson(dir, 'persona.json', manifest);
    }
    await assert.rejects(evalRun.run(dir, opts));
    assert.equal(adapters.calls.length, 0);
    assert.equal(fs.existsSync(path.join(dir, 'evals')), false);
    if (kind === 'check') {
      const result = await cli(['run', '--persona', dir, '--drafter', 'fake', '--judge', 'fake']);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /identity.md.*sample-10/);
      assert.ok(!result.stderr.includes(store.readJsonl(dir, 'cases.jsonl')[0].reference_answer));
    }
  }
});

test('host failures preserve rows and resume only missing work, including judge-only resumes', async (t) => {
  for (const failAt of [2, 3]) {
    const dir = fixture(t);
    const adapters = recording((input, count) => {
      if (count === failAt) throw new Error('private injected error text');
      return { text: input.tools === 'none' ? JSON.stringify(valid) : 'Synthetic draft.', model: 'returned' };
    });
    await assert.rejects(evalRun.run(dir, { drafter: 'fake', judge: 'fake', limit: 2, hosts: adapters }), (error) => {
      assert.match(error.message, new RegExp(`host error on case sample-${failAt === 2 ? '10' : '12'} \\(fake\\)`));
      assert.ok(!error.message.includes('private injected'));
      return true;
    });
    assert.equal(adapters.calls.length, failAt);
    const runId = fs.readdirSync(path.join(dir, 'evals'))[0];
    assert.equal(store.readJsonl(dir, `evals/${runId}/drafts.jsonl`).length, 1);
    assert.equal(store.readJsonl(dir, `evals/${runId}/judgments.jsonl`).length, failAt === 2 ? 0 : 1);
    const resumedHosts = recording();
    const resumed = await evalRun.run(dir, { runId, hosts: resumedHosts });
    assert.deepEqual(resumed, { run_id: runId, drafted: 1, judged: failAt === 2 ? 2 : 1, errors: 0 });
    assert.equal(resumedHosts.calls[0].tools, failAt === 2 ? 'none' : 'notion-read');
    for (const file of ['drafts', 'judgments']) {
      assert.deepEqual(store.readJsonl(dir, `evals/${runId}/${file}.jsonl`).map((row) => row.case_id), ['sample-10', 'sample-12']);
    }
  }
});

test('first invalid judgment retries fresh and valid retry is stored', async (t) => {
  const dir = fixture(t);
  const adapters = recording((input, count) => ({
    text: input.tools === 'notion-read' ? 'Synthetic draft.' : count === 2 ? 'invalid' : JSON.stringify(valid), model: `model-${count}`,
  }));
  const result = await evalRun.run(dir, { drafter: 'fake', judge: 'fake', limit: 1, hosts: adapters });
  assert.equal(adapters.calls.length, 3);
  assert.equal(result.errors, 0);
  assert.equal(store.readJsonl(dir, `evals/${result.run_id}/judgments.jsonl`)[0].judge.model, 'model-3');
});

test('interruption after a persisted judgment does not duplicate calls or rows on resume', async (t) => {
  const dir = fixture(t);
  const adapters = recording();
  const append = store.appendJsonl;
  let interrupted = 0;
  store.appendJsonl = (personaDir, file, row) => {
    append(personaDir, file, row);
    if (file.endsWith('/judgments.jsonl')) {
      interrupted++;
      throw new Error('simulated interruption after append');
    }
  };
  try {
    await assert.rejects(evalRun.run(dir, { drafter: 'fake', judge: 'fake', limit: 1, hosts: adapters }), /simulated interruption/);
  } finally { store.appendJsonl = append; }
  assert.equal(interrupted, 1);
  assert.equal(adapters.calls.length, 2);
  const runId = fs.readdirSync(path.join(dir, 'evals'))[0];
  assert.deepEqual(await evalRun.run(dir, { runId, hosts: adapters }), { run_id: runId, drafted: 0, judged: 0, errors: 0 });
  assert.equal(adapters.calls.length, 2);
  for (const file of ['drafts', 'judgments']) assert.equal(store.readJsonl(dir, `evals/${runId}/${file}.jsonl`).length, 1);
});

test('run sequence, saved limit, config/version refusals and initialization recovery', async (t) => {
  const dir = fixture(t);
  const first = await evalRun.run(dir, { drafter, judge: judgeSpec, limit: 1 });
  const second = await evalRun.run(dir, { drafter, judge: judgeSpec, limit: 1 });
  assert.equal(second.run_id, `${first.run_id.slice(0, -2)}02`);
  assert.equal(store.readJson(dir, `evals/${first.run_id}/run.json`).limit, 1);
  for (const opts of [{ drafter: 'fake' }, { judge: 'fake' }, { limit: 2 }, { runId: '2099-01-01-01' }, { runId: '../escape' }]) {
    const adapters = recording();
    await assert.rejects(evalRun.run(dir, { runId: first.run_id, ...opts, hosts: adapters }));
    assert.equal(adapters.calls.length, 0);
  }
  // Simulate interruption after run.json but before either row file exists.
  const config = store.readJson(dir, `evals/${first.run_id}/run.json`);
  const runId = `${first.run_id.slice(0, -2)}03`;
  store.writeJson(dir, `evals/${runId}/run.json`, { ...config, run_id: runId });
  assert.equal((await evalRun.run(dir, { runId })).drafted, 1);
  const manifest = store.readJson(dir, 'persona.json');
  store.writeJson(dir, 'persona.json', { ...manifest, version: manifest.version + 1 });
  const result = await cli(['run', '--run', first.run_id, '--persona', dir]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /persona version differs/);
});

test('in-process command output, usage, defaults and host error exit status', async (t) => {
  const dir = fixture(t);
  const result = await cli(['run', '--persona', dir, '--drafter', drafter, '--judge', judgeSpec, '--limit', '1']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^run \d{4}-\d{2}-\d{2}-01: drafted 1, judged 1, judge errors 0\n$/);
  assert.equal(result.stderr, '');
  for (const args of [[], ['missing'], ['run', '--limit'], ['run', '--limit', '0'], ['run', '--limit', '1.5'],
    ['run', '--limit', '1', '--limit', '2'], ['run', 'extra'], ['run', '--unknown', 'value']]) {
    const result = await cli(args);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^Usage: bunshin eval run/);
  }
  const previous = hosts.get;
  const calls = [];
  hosts.get = (host) => ({ async run(input) { calls.push({ host, ...input }); throw new Error('injected'); } });
  try {
    const failed = await cli(['run', '--persona', dir]);
    assert.equal(failed.code, 1);
    assert.equal(failed.stdout, '');
    assert.match(failed.stderr, /host error on case sample-10 \(claude\); rerun with --run/);
    assert.equal(calls.length, 1);
    const config = store.readJson(dir, `evals/${fs.readdirSync(path.join(dir, 'evals')).sort().at(-1)}/run.json`);
    assert.deepEqual(config.drafter, { host: 'claude', model: null });
    assert.deepEqual(config.judge, { host: 'claude', model: null });
  } finally { hosts.get = previous; }
});

test('spawned CLI uses temp BUNSHIN_HOME and persists a resumable fake run', (t) => {
  const home = fixture(t);
  const dir = path.join(home, 'fictional');
  fs.cpSync(path.join(root, 'sample', 'persona'), dir, { recursive: true });
  const env = { ...process.env, BUNSHIN_HOME: home };
  delete env.BUNSHIN_PERSONA;
  const args = [path.join(root, 'bin', 'bunshin.js'), 'eval', 'run', '--drafter', drafter, '--judge', judgeSpec];
  const result = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /drafted 3, judged 3, judge errors 2/);
  const runId = fs.readdirSync(path.join(dir, 'evals'))[0];
  assert.equal(store.readJson(dir, `evals/${runId}/run.json`).run_id, runId);
  for (const file of ['drafts', 'judgments']) assert.equal(store.readJsonl(dir, `evals/${runId}/${file}.jsonl`).length, 3);
  const resumed = spawnSync(process.execPath, [path.join(root, 'bin', 'bunshin.js'), 'eval', 'run', '--run', runId], { cwd: root, env, encoding: 'utf8' });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stdout, /drafted 0, judged 0, judge errors 0/);
});
