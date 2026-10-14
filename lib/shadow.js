'use strict';

const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');
const twin = require('./twin');
const hosts = require('./hosts');
const judge = require('./judge');
const kb = require('./kb');
const kbCheck = require('./kb-check');
const twinCheck = require('./twin-check');

function validateId(id) {
  // JavaScript's $ also matches before a final newline; reject surrounding whitespace.
  if (typeof id !== 'string' || !/^\d{4}-\d{2}-\d{2}-\d{2,}$/.test(id) || id.trim() !== id) {
    throw new Error('shadow: unknown id');
  }
}

function requireOwner(ownerId) {
  if (typeof ownerId !== 'string' || !ownerId.trim()) {
    throw new Error('shadow: owner.slack_user_id is not set in persona.json');
  }
}

function splitThread(thread, ownerId) {
  requireOwner(ownerId);
  if (!Array.isArray(thread?.messages) || thread.messages.length === 0) {
    throw new Error('shadow: invalid thread messages');
  }
  for (const message of thread.messages) {
    if (!message || typeof message.author !== 'string' || typeof message.text !== 'string'
      || !['number', 'string'].includes(typeof message.ts)
      || (typeof message.ts === 'string' && !message.ts.trim()) || !Number.isFinite(Number(message.ts))) {
      throw new Error('shadow: invalid thread message');
    }
  }
  // Array.sort is stable; equal timestamps retain their source order.
  const messages = [...thread.messages].sort((a, b) => Number(a.ts) - Number(b.ts));
  const firstOwner = messages.findIndex((message) => message.author === ownerId);
  const before = firstOwner === -1 ? messages : messages.slice(0, firstOwner);
  const questionIndex = before.findLastIndex((message) => message.author !== ownerId);
  if (questionIndex === -1) throw new Error('shadow: thread has no question from someone else');
  const pick = ({ author, text }) => ({ author, text });
  return {
    question: pick(messages[questionIndex]),
    context: messages.slice(0, questionIndex).filter((message) => message.author !== ownerId).map(pick),
    answer: firstOwner === -1 ? null : messages.slice(questionIndex + 1)
      .filter((message) => message.author === ownerId).map((message) => message.text).join('\n\n'),
  };
}

function nextId(personaDir) {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  let names;
  try { names = fs.readdirSync(path.join(personaDir, 'shadow')); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    names = [];
  }
  const sequences = names.filter((name) => new RegExp(`^${date}-[0-9]{2,}$`).test(name))
    .map((name) => Number(name.slice(date.length + 1)));
  return `${date}-${String(Math.max(0, ...sequences) + 1).padStart(2, '0')}`;
}

function create(personaDir, opts) {
  // Validate the layer even though creating a question does not yet compose a prompt.
  twin.skillForLayer(opts.layer);
  let question;
  let context;
  let answer;
  let permalink = null;
  if (opts.thread !== undefined) {
    const persona = store.readJson(personaDir, 'persona.json');
    ({ question, context, answer } = splitThread(opts.thread, persona.owner?.slack_user_id));
    permalink = opts.thread.permalink ?? null;
  } else {
    question = { author: null, text: opts.question };
    context = [];
    answer = opts.answer ?? null;
  }
  if (typeof question.text !== 'string' || !question.text.trim()) throw new Error('shadow: question text is empty');
  const id = nextId(personaDir);
  store.writeJson(personaDir, `shadow/${id}/question.json`, {
    format_version: 1, id, layer: opts.layer, permalink, question, context, created_at: new Date().toISOString(),
  });
  // Question first: an interruption leaves a usable entry with no real answer.
  if (answer !== null) store.writeJson(personaDir, `shadow/${id}/answer.json`, { format_version: 1, id, text: answer });
  return id;
}

function readQuestion(personaDir, id) {
  validateId(id);
  try { return store.readJson(personaDir, `shadow/${id}/question.json`); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Error('shadow: unknown id');
  }
}

async function draft(personaDir, id, opts = {}) {
  const value = readQuestion(personaDir, id);
  const persona = store.readJson(personaDir, 'persona.json');
  const env = opts.env ?? process.env;
  const bound = kb.loadBound(personaDir, env);
  const skill = twin.skillForLayer(value.layer);
  const useKb = bound && skill === 'spec-answer';
  const scrub = bound ? kbCheck.readScrubList(bound.dir) : [];
  const allowedTools = useKb ? undefined : hosts.allowedTools(persona);
  const { host, model } = hosts.parseSpec(opts.drafter ?? 'claude');
  const system = twin.composePrompt(personaDir, skill, { env, bound });
  const prompt = judge.questionPrompt({ question: value.question, context: value.context });
  let reply;
  try {
    reply = await (opts.hosts ?? hosts).get(host).run({ system, prompt, tools: useKb ? 'none' : 'notion-read', model,
      ...(useKb ? {} : { allowedTools }) });
  } catch {
    throw new Error(`shadow draft: host error (${host})`);
  }
  const result = { format_version: 1, id, layer: value.layer, skill, draft: reply.text,
    drafter: { host, model: reply.model }, at: new Date().toISOString() };
  if (useKb) {
    const checked = twinCheck.checkSpecReply(reply.text, { kbData: bound.data, scrub });
    result.kb = { name: bound.name, digest_hash: bound.digest.hash };
    result.cited = checked.cited;
    result.gates = {
      citation: !checked.problems.some((problem) => problem.endsWith(': no-citation')),
      resolves: !checked.problems.some((problem) => problem.endsWith(': unknown-id')),
      current: !checked.problems.some((problem) => problem.endsWith(': not-citable')),
      scrub: !checked.problems.some((problem) => problem.endsWith(': scrub')),
    };
  }
  store.writeJson(personaDir, `shadow/${id}/draft.json`, result);
  return result;
}

function optional(personaDir, file) {
  try { return store.readJson(personaDir, file); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

function show(personaDir, id) {
  const value = readQuestion(personaDir, id);
  const drafted = optional(personaDir, `shadow/${id}/draft.json`);
  const answer = optional(personaDir, `shadow/${id}/answer.json`);
  let text = `## Question\n${value.question.text}\n`;
  if (value.permalink) text += `${value.permalink}\n`;
  text += `\n## Twin draft\n${drafted ? drafted.draft : `(no draft yet — run shadow draft ${id})`}\n`;
  if (drafted?.gates) text += `gates: ${Object.entries(drafted.gates).map(([gate, passed]) => `${gate}=${passed}`).join(' ')}\n`;
  if (answer) text += `\n## Real answer\n${answer.text}\n`;
  return text;
}

module.exports = { splitThread, create, draft, show, validateId };
