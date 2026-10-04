'use strict';

const store = require('./store');

const MAX_QUESTIONS = 15;
const INTERVIEW_ANSWER_FIELDS = [
  'id', 'session', 'asked_at', 'topic', 'gap', 'question', 'answer',
];
const INTERVIEW_STATE_FIELDS = [
  'format_version', 'session', 'asked', 'pending', 'pending.asked_at',
  'pending.topic', 'pending.gap', 'pending.question',
];

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateAnswer(answer) {
  if (!object(answer)) return ['interview answer must be an object'];
  const errors = [];
  if (typeof answer.id !== 'string' || !/^iv-\d{4,}$/.test(answer.id)) errors.push('invalid id');
  for (const field of ['session', 'topic', 'gap', 'question', 'answer']) {
    if (typeof answer[field] !== 'string' || !answer[field].trim()) errors.push(`invalid ${field}`);
  }
  if (typeof answer.asked_at !== 'string' || !Number.isFinite(Date.parse(answer.asked_at))) errors.push('invalid asked_at');
  return errors;
}

function listAnswers(personaDir) {
  return store.readJsonl(personaDir, 'interview.jsonl');
}

function readState(personaDir) {
  let state;
  try {
    state = store.readJson(personaDir, 'interview-state.json');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!state || state.format_version !== 1 || typeof state.session !== 'string'
    || !state.session || !Number.isInteger(state.asked) || state.asked < 0
    || state.asked > MAX_QUESTIONS || !(state.pending === null || validPending(state.pending))) {
    throw new Error('Invalid interview-state.json.');
  }
  if (state.pending && state.asked === 0) throw new Error('Invalid interview-state.json.');
  return state;
}

function validPending(pending) {
  return pending && typeof pending === 'object' && !Array.isArray(pending)
    && typeof pending.asked_at === 'string' && !Number.isNaN(Date.parse(pending.asked_at))
    && typeof pending.topic === 'string' && pending.topic.trim().length > 0
    && typeof pending.gap === 'string' && pending.gap.trim().length > 0
    && typeof pending.question === 'string' && pending.question.trim().length > 0;
}

function status(state) {
  return {
    session: state.session,
    asked: state.asked,
    remaining: MAX_QUESTIONS - state.asked,
    pending: state.pending,
  };
}

function latestSessionNumber(answers, currentState) {
  let latest = 0;
  const sessions = new Set();
  for (const answer of answers) {
    if (typeof answer.session === 'string') sessions.add(answer.session);
    const match = /^session-(\d+)$/.exec(answer.session || '');
    if (match) latest = Math.max(latest, Number(match[1]));
  }
  if (currentState && typeof currentState.session === 'string') {
    sessions.add(currentState.session);
    const match = /^session-(\d+)$/.exec(currentState.session);
    if (match) latest = Math.max(latest, Number(match[1]));
  }
  let next = latest + 1;
  while (sessions.has(`session-${String(next).padStart(4, '0')}`)) next += 1;
  return `session-${String(next).padStart(4, '0')}`;
}

function begin(personaDir, options = {}) {
  let state = readState(personaDir);
  if (!state || (state.asked === MAX_QUESTIONS && state.pending === null)) {
    const answers = listAnswers(personaDir);
    state = {
      format_version: 1,
      session: latestSessionNumber(answers, state),
      asked: 0,
      pending: null,
    };
    store.writeJson(personaDir, 'interview-state.json', state, options);
  }
  return status(state);
}

function ask(personaDir, { topic, gap, question }, options = {}) {
  if (typeof gap !== 'string' || !gap.trim()) throw new Error('Interview gap must not be empty.');
  if (typeof topic !== 'string' || !topic.trim() || typeof question !== 'string' || !question.trim()) {
    throw new Error('Interview topic and question must not be empty.');
  }
  const state = readState(personaDir);
  if (!state) throw new Error('No interview session found; run "bunshin interview begin" first.');
  if (state.pending) return { status: status(state), alreadyPending: true };
  if (state.asked >= MAX_QUESTIONS) throw new Error(`Interview session ${state.session} has reached the 15-question limit.`);
  state.asked += 1;
  state.pending = {
    asked_at: new Date().toISOString(),
    topic,
    gap,
    question,
  };
  store.writeJson(personaDir, 'interview-state.json', state, options);
  return { status: status(state), alreadyPending: false };
}

function nextAnswerId(answers) {
  let largest = 0;
  const ids = new Set();
  for (const answer of answers) {
    if (typeof answer.id !== 'string' || !/^iv-\d{4,}$/.test(answer.id) || ids.has(answer.id)) {
      throw new Error('Invalid interview.jsonl id.');
    }
    ids.add(answer.id);
    largest = Math.max(largest, Number(answer.id.slice(3)));
  }
  return `iv-${String(largest + 1).padStart(4, '0')}`;
}

function answer(personaDir, answerText, options = {}) {
  if (typeof answerText !== 'string' || !answerText.trim()) throw new Error('Interview answer must not be empty.');
  const state = readState(personaDir);
  if (!state) throw new Error('No interview session found; run "bunshin interview begin" first.');
  if (!state.pending) throw new Error(`Interview session ${state.session} has no pending question.`);

  const answers = listAnswers(personaDir);
  const record = {
    id: nextAnswerId(answers),
    session: state.session,
    asked_at: state.pending.asked_at,
    topic: state.pending.topic,
    gap: state.pending.gap,
    question: state.pending.question,
    answer: answerText,
  };
  store.appendJsonl(personaDir, 'interview.jsonl', record, options);
  state.pending = null;
  store.writeJson(personaDir, 'interview-state.json', state, options);
  return { ...status(state), answer: record.id };
}

module.exports = {
  MAX_QUESTIONS, INTERVIEW_ANSWER_FIELDS, INTERVIEW_STATE_FIELDS, validateAnswer,
  listAnswers, begin, ask, answer, readState, status,
};
