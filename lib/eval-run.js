'use strict';

const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');
const check = require('./check');
const twin = require('./twin');
const hosts = require('./hosts');
const judge = require('./judge');
const examples = require('./examples');

function spec(value) {
  const parsed = hosts.parseSpec(value);
  return { host: parsed.host, model: parsed.model ?? null };
}

function nextRunId(personaDir) {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  let names;
  try { names = fs.readdirSync(path.join(personaDir, 'evals'), { withFileTypes: true }); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    names = [];
  }
  const sequences = names.filter((entry) => entry.isDirectory() && new RegExp(`^${date}-[0-9]{2,}$`).test(entry.name))
    .map((entry) => Number(entry.name.slice(date.length + 1)));
  return `${date}-${String(Math.max(0, ...sequences) + 1).padStart(2, '0')}`;
}

async function run(personaDir, opts = {}) {
  const result = check.runChecks(personaDir);
  if (!result.ok) throw new Error(check.formatFindings(result.findings));
  // An incomplete owner example set refuses every run mode before anything is written.
  const exampleRows = examples.ready(personaDir);
  let caseErrors = '';
  const code = require('./commands/cases').run(['build', '--persona', personaDir], {
    stdout: { write() {} }, stderr: { write(text) { caseErrors += text; } },
  });
  if (code !== 0) throw new Error(caseErrors.trim());
  const cases = store.readJsonl(personaDir, 'cases.jsonl');
  const persona = store.readJson(personaDir, 'persona.json');
  const allowedTools = hosts.allowedTools(persona);
  if (opts.limit !== undefined && opts.limit !== null && (!Number.isSafeInteger(opts.limit) || opts.limit < 1)) {
    throw new Error('eval run: limit must be a positive integer');
  }
  const judgeSystem = judge.composeSystem(exampleRows);
  const judgeRubric = judge.rubricHash();
  const judgeExamples = exampleRows ? examples.summary(exampleRows) : null;
  let config;
  let sourceDrafts = null;
  if (opts.rejudgeFrom !== undefined) {
    if (['runId', 'drafter', 'limit'].some((key) => opts[key] !== undefined && opts[key] !== null)) {
      throw new Error('eval run: --rejudge-from takes only --judge');
    }
    if (typeof opts.rejudgeFrom !== 'string' || !/^\d{4}-\d{2}-\d{2}-\d{2,}$/.test(opts.rejudgeFrom)) {
      throw new Error('eval run: unknown source run');
    }
    let source;
    try { source = store.readJson(personaDir, `evals/${opts.rejudgeFrom}/run.json`); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      throw new Error('eval run: unknown source run');
    }
    const ids = new Set(cases.map((row) => row.id));
    sourceDrafts = store.readJsonl(personaDir, `evals/${opts.rejudgeFrom}/drafts.jsonl`).filter((row) => ids.has(row.case_id));
    if (!sourceDrafts.length) throw new Error('eval run: source run has no drafts');
    config = {
      run_id: nextRunId(personaDir), persona_version: source.persona_version,
      drafter: source.drafter, judge: spec(opts.judge ?? 'claude'), judge_rubric: judgeRubric,
      judge_examples: judgeExamples, judge_votes: judge.VOTES,
      rejudged_from: opts.rejudgeFrom, started_at: new Date().toISOString(), limit: source.limit ?? null,
    };
  } else if (opts.runId !== undefined) {
    if (typeof opts.runId !== 'string' || !/^\d{4}-\d{2}-\d{2}-\d{2,}$/.test(opts.runId)) {
      throw new Error('eval run: unknown run');
    }
    try { config = store.readJson(personaDir, `evals/${opts.runId}/run.json`); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      throw new Error('eval run: unknown run');
    }
    // A re-judge run drafts nothing, so the identity may have moved on since its drafts.
    if (!config.rejudged_from && config.persona_version !== persona.version) throw new Error('eval run: persona version differs from run');
    for (const role of ['drafter', 'judge']) {
      if (opts[role] !== undefined && JSON.stringify(spec(opts[role])) !== JSON.stringify(config[role])) {
        throw new Error(`eval run: ${role} differs from run`);
      }
    }
    if ((config.judge_rubric ?? null) !== judgeRubric) throw new Error('eval run: judge rubric differs from run');
    if (config.judge_examples === undefined || (config.judge_examples?.hash ?? null) !== (judgeExamples?.hash ?? null)) {
      throw new Error('eval run: judge examples differ from run');
    }
    if (config.judge_votes !== judge.VOTES) throw new Error('eval run: judge votes differ from run');
    if (opts.limit !== undefined && opts.limit !== config.limit) throw new Error('eval run: limit differs from run');
  } else {
    config = {
      run_id: nextRunId(personaDir), persona_version: persona.version,
      drafter: spec(opts.drafter ?? 'claude'), judge: spec(opts.judge ?? 'claude'), judge_rubric: judgeRubric,
      judge_examples: judgeExamples, judge_votes: judge.VOTES,
      started_at: new Date().toISOString(), limit: opts.limit ?? null,
    };
  }
  const adapters = opts.hosts ?? hosts;
  const drafterHost = adapters.get(config.drafter.host);
  const judgeHost = adapters.get(config.judge.host);
  const root = `evals/${config.run_id}`;
  const rejudge = Boolean(config.rejudged_from);
  let selected = config.limit === null ? cases : cases.slice(0, config.limit);
  if (rejudge) {
    // Drafts are copied before run.json, so a listed re-judge run always has them.
    if (sourceDrafts) store.writeJsonl(personaDir, `${root}/drafts.jsonl`, sourceDrafts);
    const drafted = new Set(store.readJsonl(personaDir, `${root}/drafts.jsonl`).map((row) => row.case_id));
    selected = cases.filter((row) => drafted.has(row.id));
  }
  // Compose before recording a new run, so an unusable identity spends no call.
  const systems = new Map();
  for (const value of rejudge ? [] : selected) {
    const skill = twin.skillForLayer(value.layer);
    if (!systems.has(skill)) systems.set(skill, twin.composePrompt(personaDir, skill));
  }
  if (opts.runId === undefined) store.writeJson(personaDir, `${root}/run.json`, config);
  // Missing row files are empty after a crash during run initialization.
  for (const file of ['drafts.jsonl', 'judgments.jsonl']) {
    if (!fs.existsSync(path.join(personaDir, root, file))) store.writeJsonl(personaDir, `${root}/${file}`, []);
  }
  const drafts = new Map(store.readJsonl(personaDir, `${root}/drafts.jsonl`).map((row) => [row.case_id, row]));
  const judgments = new Set(store.readJsonl(personaDir, `${root}/judgments.jsonl`).map((row) => row.case_id));
  const counts = { run_id: config.run_id, drafted: 0, judged: 0, errors: 0 };
  async function call(adapter, role, value, input) {
    try { return await adapter.run({ ...input, model: config[role].model ?? undefined }); } catch {
      throw new Error(`eval run: host error on case ${value.id} (${config[role].host}); rerun with --run ${config.run_id} to resume`);
    }
  }
  for (const value of selected) {
    if (judgments.has(value.id)) continue;
    let draft = drafts.get(value.id);
    if (!draft && rejudge) continue;
    if (!draft) {
      const skill = twin.skillForLayer(value.layer);
      const reply = await call(drafterHost, 'drafter', value, {
        system: systems.get(skill), prompt: judge.questionPrompt(value), tools: 'notion-read', allowedTools,
      });
      draft = { case_id: value.id, layer: value.layer, skill, draft: reply.text,
        drafter: { host: config.drafter.host, model: reply.model }, at: new Date().toISOString() };
      store.appendJsonl(personaDir, `${root}/drafts.jsonl`, draft);
      drafts.set(value.id, draft);
      counts.drafted++;
    }
    // All votes are collected before any row, so a host error leaves the case for a fresh resume.
    const parsed = [];
    const replies = [];
    let malformed = false;
    for (let index = 0; index < judge.VOTES && !malformed; index++) {
      let judgment;
      let reply;
      for (let attempt = 0; attempt < 2; attempt++) {
        reply = await call(judgeHost, 'judge', value, {
          system: judgeSystem, prompt: judge.buildPrompt(value, draft), tools: 'none', outputSchema: judge.outputSchema,
        });
        try { judgment = judge.parse(reply.text); break; } catch { /* Retry malformed output once. */ }
      }
      replies.push(reply);
      if (judgment) parsed.push(judgment); else malformed = true;
    }
    let row;
    if (malformed) {
      row = { rating: 'judge_error', reason: 'invalid judge output' };
      counts.errors++;
    } else {
      const merged = judge.vote(parsed);
      row = { ...merged, votes: merged.votes.map((entry, index) => ({ ...entry, model: replies[index].model })) };
    }
    store.appendJsonl(personaDir, `${root}/judgments.jsonl`, {
      ...row, case_id: value.id, judge: { host: config.judge.host, model: replies[0].model }, at: new Date().toISOString(),
    });
    judgments.add(value.id);
    counts.judged++;
  }
  return counts;
}

module.exports = { run };
