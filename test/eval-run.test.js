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
const examples = require('../lib/examples');

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
  // sample-10: 3 valid calls; sample-12 and sample-13: call 1 malformed twice, then judge_error.
  assert.equal(calls.filter((call) => call.tools === 'none').length, 7);
  assert.equal(config.judge_votes, 3);
  assert.equal(config.judge_examples, null);
  assert.equal(judgments[0].votes.length, 3);
  const resumed = await evalRun.run(dir, { runId: result.run_id, hosts: adapters });
  assert.deepEqual(resumed, { run_id: result.run_id, drafted: 0, judged: 0, errors: 0 });
  assert.equal(calls.length, 10);
});

test('drafter firewall, composed system, tool boundaries, stripped judge template and returned models', async (t) => {
  const dir = fixture(t);
  const adapters = recording();
  const result = await evalRun.run(dir, { drafter: 'fake:requested', judge: 'fake:requested-judge', hosts: adapters });
  const cases = store.readJsonl(dir, 'cases.jsonl');
  assert.ok(cases.every((value) => value.reference_answer.length >= 24));
  for (let index = 0; index < cases.length; index++) {
    const value = cases[index];
    const draftCall = adapters.calls[index * 4];
    const judgeCalls = adapters.calls.slice(index * 4 + 1, index * 4 + 4);
    assert.equal(judgeCalls.length, 3);
    const judgeCall = judgeCalls[0];
    for (const call of judgeCalls) assert.deepEqual(call, judgeCall);
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
  // Call 2 is sample-10's first judge call; call 5 is sample-12's draft.
  for (const failAt of [2, 5]) {
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
  assert.equal(adapters.calls.length, 5);
  assert.equal(result.errors, 0);
  const row = store.readJsonl(dir, `evals/${result.run_id}/judgments.jsonl`)[0];
  assert.equal(row.judge.model, 'model-3');
  assert.deepEqual(row.votes.map((v) => v.model), ['model-3', 'model-4', 'model-5']);
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
  assert.equal(adapters.calls.length, 4);
  const runId = fs.readdirSync(path.join(dir, 'evals'))[0];
  assert.deepEqual(await evalRun.run(dir, { runId, hosts: adapters }), { run_id: runId, drafted: 0, judged: 0, errors: 0 });
  assert.equal(adapters.calls.length, 4);
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
  assert.match(result.stdout, /^run \d{4}-\d{2}-\d{2}-01: drafted 1, judged 1, judge errors 0\nbunshin eval — persona sample @ v\d+ — \d{4}-\d{2}-\d{2}\n/);
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

const ratedAt = '2026-10-07T00:00:00.000Z';
const labels = ['send_as_is', 'needs_edits', 'wrong'];

// Writes a 12-example set through the examples store shapes, with a marker in every field.
function writeExamples(dir, rated = 12) {
  const chosen = examples.selectSet(dir, { seed: '0123456789abcdef', n: 12 });
  store.writeJson(dir, 'judge-examples/set.json', { format_version: 1, seed: '0123456789abcdef', n: 12,
    pair_ids: chosen.map((pair) => pair.id), drafter: { host: 'fake', model: null }, created_at: ratedAt });
  const rows = chosen.map((pair, i) => ({ pair_id: pair.id, layer: pair.layer, position: i + 1,
    question: { author: pair.question.author, text: `QMARK-${i + 1}-Q` },
    context: [{ author: `author-${i + 1}`, text: `CMARK-${i + 1}-C` }],
    reference_answer: `RMARK-${i + 1}-R`, draft: `DMARK-${i + 1}-D`,
    drafter: { host: 'fake', model: null }, drafted_at: ratedAt }));
  store.writeJsonl(dir, 'judge-examples/examples.jsonl', rows);
  store.writeJsonl(dir, 'judge-examples/ratings.jsonl', rows.slice(0, rated)
    .map((row, i) => ({ pair_id: row.pair_id, rating: labels[i % 3], rated_at: ratedAt })));
  return { chosen, rows };
}

test('AC2: an incomplete example set refuses every run mode before any write; a complete one is recorded', async (t) => {
  const dir = fixture(t);
  const { rows } = writeExamples(dir, 11);
  store.writeJsonl(dir, 'cases.jsonl', []);
  const adapters = recording();
  await assert.rejects(evalRun.run(dir, { drafter: 'fake', judge: 'fake', hosts: adapters }),
    { message: `eval run: judge examples not ready — 1 of 12 unrated (${rows[11].pair_id})` });
  assert.equal(adapters.calls.length, 0);
  assert.equal(fs.existsSync(path.join(dir, 'evals')), false);
  assert.deepEqual(store.readJsonl(dir, 'cases.jsonl'), [], 'cases.jsonl is not rebuilt before the readiness gate');
  for (const opts of [{ runId: '2026-10-20-01' }, { rejudgeFrom: '2026-10-20-01' }]) {
    await assert.rejects(evalRun.run(dir, { ...opts, hosts: adapters }), /judge examples not ready — 1 of 12 unrated/);
  }
  assert.equal(fs.existsSync(path.join(dir, 'evals')), false);
  store.appendJsonl(dir, 'judge-examples/ratings.jsonl', { pair_id: rows[11].pair_id, rating: 'send_as_is', rated_at: ratedAt });
  const result = await evalRun.run(dir, { drafter: 'fake', judge: 'fake', limit: 1, hosts: adapters });
  const config = store.readJson(dir, `evals/${result.run_id}/run.json`);
  assert.equal(config.judge_examples.n, 12);
  assert.match(config.judge_examples.hash, /^[0-9a-f]{16}$/);
  assert.equal(Object.values(config.judge_examples.labels).reduce((a, b) => a + b, 0), 12);
  assert.deepEqual(config.judge_examples, examples.summary(examples.ready(dir)));
  assert.equal(config.judge_votes, 3);
  assert.equal(config.judge_rubric, judge.rubricHash());
  const rejudged = await evalRun.run(dir, { rejudgeFrom: result.run_id, judge: 'fake', hosts: recording() });
  const rejudgedConfig = store.readJson(dir, `evals/${rejudged.run_id}/run.json`);
  assert.deepEqual(rejudgedConfig.judge_examples, config.judge_examples);
  assert.equal(rejudgedConfig.judge_votes, 3);
  assert.equal(rejudgedConfig.judge_rubric, judge.rubricHash());
});

test('AC2: without an example set the run records judge_examples null and judge_votes 3', async (t) => {
  const dir = fixture(t);
  const result = await evalRun.run(dir, { drafter: 'fake', judge: 'fake', limit: 1, hosts: recording() });
  const config = store.readJson(dir, `evals/${result.run_id}/run.json`);
  assert.equal(config.judge_examples, null);
  assert.equal(config.judge_votes, 3);
  const rejudged = await evalRun.run(dir, { rejudgeFrom: result.run_id, judge: 'fake', hosts: recording() });
  const rejudgedConfig = store.readJson(dir, `evals/${rejudged.run_id}/run.json`);
  assert.equal(rejudgedConfig.judge_examples, null);
  assert.equal(rejudgedConfig.judge_votes, 3);
});

test('AC3: every judge call carries the full example block in system text and nothing else leaks', async (t) => {
  const dir = fixture(t);
  const { rows } = writeExamples(dir);
  const adapters = recording();
  await evalRun.run(dir, { drafter: 'fake', judge: 'fake', hosts: adapters });
  const cases = store.readJsonl(dir, 'cases.jsonl');
  const pairs = store.readJsonl(dir, 'pairs.jsonl');
  const judgeCalls = adapters.calls.filter((call) => call.tools === 'none');
  const draftCalls = adapters.calls.filter((call) => call.tools === 'notion-read');
  assert.equal(judgeCalls.length, cases.length * 3);
  const markers = rows.flatMap((row) => [row.question.text, row.context[0].text, row.reference_answer, row.draft]);
  for (const [index, call] of judgeCalls.entries()) {
    for (const marker of markers) assert.ok(call.system.includes(marker), marker);
    for (const row of rows) {
      const rating = labels[(row.position - 1) % 3];
      assert.ok(call.system.includes(`## Example ${row.position}\n\nQuestion:\n${row.question.text}\n\n`
        + `Context:\n${row.context[0].author}: ${row.context[0].text}\n\nReference answer:\n${row.reference_answer}\n\n`
        + `Draft:\n${row.draft}\n\nOwner rating: ${rating}`), `example ${row.position}`);
    }
    for (const id of ['sample-10', 'sample-12', 'sample-13']) assert.ok(!call.system.includes(id), id);
    for (const pair of pairs) assert.ok(!call.system.includes(pair.permalink), pair.permalink);
    for (const text of ['permalink', 'rated_at', ratedAt]) assert.ok(!call.system.includes(text), text);
    const value = cases[Math.floor(index / 3)];
    const draft = store.readJsonl(dir, `evals/${fs.readdirSync(path.join(dir, 'evals'))[0]}/drafts.jsonl`).find((row) => row.case_id === value.id);
    assert.equal(call.prompt, judge.buildPrompt(value, draft));
    assert.equal(call.system, judge.composeSystem(examples.ready(dir)));
  }
  assert.equal(draftCalls.length, cases.length);
  for (const call of draftCalls) for (const marker of markers) assert.ok(!call.system.includes(marker), marker);
});

function verdict(rating, wrong) {
  return { rating, reason: `Reason ${rating} ${wrong}.`, wrong_uncited: wrong, language_match: wrong === 0,
    claims: Array.from({ length: wrong }, (_, i) => ({ text: `Wrong ${i}.`, cited: false, correct: false })) };
}

test('AC4: three judge calls are stored as their majority vote with per-call votes', async (t) => {
  const dir = fixture(t);
  const plan = [
    [verdict('send_as_is', 0), verdict('send_as_is', 2), verdict('wrong', 1)],
    [verdict('send_as_is', 0), verdict('needs_edits', 0), verdict('wrong', 3)],
    [verdict('wrong', 0), verdict('wrong', 0), verdict('needs_edits', 0)],
  ];
  let judged = 0;
  const adapters = recording((input) => {
    if (input.tools !== 'none') return { text: 'Synthetic draft.', model: 'drafter' };
    const n = judged++;
    return { text: JSON.stringify(plan[Math.floor(n / 3)][n % 3]), model: `judge-${n}` };
  });
  const result = await evalRun.run(dir, { drafter: 'fake', judge: 'fake', hosts: adapters });
  const rows = store.readJsonl(dir, `evals/${result.run_id}/judgments.jsonl`);
  assert.deepEqual(rows.map((row) => row.rating), ['send_as_is', 'needs_edits', 'wrong']);
  assert.deepEqual(rows.map((row) => row.wrong_uncited), [1, 0, 0]);
  assert.equal(rows[0].reason, 'Reason send_as_is 0.');
  assert.deepEqual(rows[0].claims, []);
  assert.deepEqual(rows.map((row) => row.language_match), [false, true, true]);
  for (const [i, row] of rows.entries()) {
    assert.deepEqual(row.judge, { host: 'fake', model: `judge-${i * 3}` });
    assert.equal(row.case_id, ['sample-10', 'sample-12', 'sample-13'][i]);
    assert.ok(Number.isFinite(Date.parse(row.at)));
    assert.deepEqual(row.votes, plan[i].map((call, k) => ({ rating: call.rating, wrong_uncited: call.wrong_uncited,
      language_match: call.language_match, model: `judge-${i * 3 + k}` })));
  }
});

test('AC5: a host error on judge call 2 writes no row and the resume makes 3 fresh calls', async (t) => {
  const dir = fixture(t);
  let judged = 0;
  const adapters = recording((input) => {
    if (input.tools === 'none' && ++judged === 2) throw new Error('private injected error text');
    return { text: input.tools === 'none' ? JSON.stringify(valid) : 'Synthetic draft.', model: 'returned' };
  });
  await assert.rejects(evalRun.run(dir, { drafter: 'fake', judge: 'fake', limit: 1, hosts: adapters }),
    /eval run: host error on case sample-10 \(fake\); rerun with --run \S+ to resume/);
  const runId = fs.readdirSync(path.join(dir, 'evals'))[0];
  assert.deepEqual(store.readJsonl(dir, `evals/${runId}/judgments.jsonl`), []);
  const resumedHosts = recording();
  assert.deepEqual(await evalRun.run(dir, { runId, hosts: resumedHosts }), { run_id: runId, drafted: 0, judged: 1, errors: 0 });
  assert.equal(resumedHosts.calls.length, 3);
  assert.ok(resumedHosts.calls.every((call) => call.tools === 'none'));
  assert.equal(store.readJsonl(dir, `evals/${runId}/judgments.jsonl`)[0].votes.length, 3);
});

test('--run refuses a changed example set or vote count', async (t) => {
  const dir = fixture(t);
  const result = await evalRun.run(dir, { drafter: 'fake', judge: 'fake', limit: 1, hosts: recording() });
  const file = `evals/${result.run_id}/run.json`;
  const original = store.readJson(dir, file);
  const { judge_examples: _, ...missing } = original;
  for (const [config, message] of [
    [{ ...original, judge_examples: { hash: '0000000000000000', n: 12, labels: {} } }, 'eval run: judge examples differ from run'],
    [missing, 'eval run: judge examples differ from run'],
    [{ ...original, judge_votes: 1 }, 'eval run: judge votes differ from run'],
    [(({ judge_votes: _v, ...rest }) => rest)(original), 'eval run: judge votes differ from run'],
  ]) {
    store.writeJson(dir, file, config);
    const adapters = recording();
    await assert.rejects(evalRun.run(dir, { runId: result.run_id, hosts: adapters }), { message });
    assert.equal(adapters.calls.length, 0);
  }
  // A set completed after the run started changes the hash from null.
  store.writeJson(dir, file, original);
  writeExamples(dir);
  await assert.rejects(evalRun.run(dir, { runId: result.run_id, hosts: recording() }), { message: 'eval run: judge examples differ from run' });
});
