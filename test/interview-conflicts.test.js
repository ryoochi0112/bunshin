'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { main } = require('../bin/bunshin');
const conflicts = require('../lib/conflicts');
const pairs = require('../lib/pairs');
const store = require('../lib/store');

function pair(id, answer = `Fictional answer for ${id}.`) {
  return {
    id, source: 'manual', permalink: `https://chat.example.invalid/thread/${id}`,
    channel: 'fictional-channel', asked_at: '2026-01-01T00:00:00Z',
    layer: 'knowledge', layer_source: 'auto',
    question: { author: 'fictional-colleague', text: `Question about ${id}?` },
    context: [], answer: { text: answer }, harvested_at: '2026-01-02T00:00:00Z',
  };
}

async function command(dir, args) {
  let stdout = '';
  let stderr = '';
  const code = await main([...args, '--persona', dir], {
    env: { BUNSHIN_HOME: dir },
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
  });
  return { code, stdout, stderr };
}

async function persona(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-interview-'));
  t.after(() => { store._resetGuardCache(); fs.rmSync(root, { recursive: true, force: true }); });
  const previous = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  for (const key of Object.keys(previous)) {
    process.env[key] = path.join(root, key);
    fs.mkdirSync(process.env[key]);
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const io = { env: { BUNSHIN_HOME: root }, stdout: { write() {} }, stderr: { write() {} } };
  assert.equal(await main(['init', 'fictional-person'], io), 0);
  return path.join(root, 'fictional-person');
}

async function askedQuestion(dir, number = 1) {
  return command(dir, ['interview', 'ask', '--topic', `topic-${number}`, '--gap', 'Sources do not show the reason.', '--question', `Why is fictional choice ${number} made?`]);
}

test('interview state resumes a pending question after restart and answer records evidence', async (t) => {
  const dir = await persona(t);
  const started = await command(dir, ['interview', 'begin']);
  assert.equal(started.code, 0);
  const initial = JSON.parse(started.stdout);
  assert.deepEqual(initial, { session: 'session-0001', asked: 0, remaining: 15, pending: null });

  assert.equal((await command(dir, ['interview', 'ask', '--topic', 'priority', '--gap', '   ', '--question', 'Why?'])).code, 1);
  assert.deepEqual(store.readJson(dir, 'interview-state.json'), {
    format_version: 1, session: initial.session, asked: 0, pending: null,
  });
  const asked = await command(dir, ['interview', 'ask', '--topic', 'priority', '--gap', 'Sources do not show the reason.', '--question', 'Why is this fictional priority used?']);
  assert.equal(asked.code, 0);
  const pending = JSON.parse(asked.stdout);
  assert.equal(pending.pending.question, 'Why is this fictional priority used?');
  assert.equal(pending.remaining, 14);

  const resumed = JSON.parse((await command(dir, ['interview', 'begin'])).stdout);
  assert.deepEqual(resumed, pending);
  const blocked = await command(dir, ['interview', 'ask', '--topic', 'another', '--gap', 'Sources do not show this.', '--question', 'A different question?']);
  assert.equal(blocked.code, 3);
  assert.match(blocked.stdout, /Why is this fictional priority used\?/);
  assert.equal(blocked.stderr, '');

  const answered = await command(dir, ['interview', 'answer', '--text', 'A fictional answer with a reason.']);
  assert.equal(answered.code, 0);
  assert.deepEqual(store.readJsonl(dir, 'interview.jsonl'), [{
    id: 'iv-0001', session: initial.session,
    asked_at: pending.pending.asked_at, topic: 'priority',
    gap: 'Sources do not show the reason.',
    question: 'Why is this fictional priority used?', answer: 'A fictional answer with a reason.',
  }]);
  assert.equal(JSON.parse(answered.stdout).pending, null);
  assert.equal((await command(dir, ['interview', 'answer', '--text', 'No pending answer.'])).code, 1);
});

test('interview refuses the sixteenth question in the same session', async (t) => {
  const dir = await persona(t);
  assert.equal((await command(dir, ['interview', 'begin'])).code, 0);
  for (let index = 1; index <= 15; index += 1) {
    const ask = await askedQuestion(dir, index);
    assert.equal(ask.code, 0, `question ${index}: ${ask.stderr}`);
    assert.equal((await command(dir, ['interview', 'answer', '--text', `Fictional answer ${index}.`])).code, 0);
  }
  const rejected = await askedQuestion(dir, 16);
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr, /15-question limit/);
  assert.equal(store.readJsonl(dir, 'interview.jsonl').length, 15);
  assert.equal(store.readJson(dir, 'interview-state.json').asked, 15);
});

test('conflicts validates interview refs and build-set pair refs', async (t) => {
  const dir = await persona(t);
  pairs.addPairs(dir, [pair('build-one'), pair('heldout-one')]);
  const split = store.readJson(dir, 'split.json');
  split.assignments = { 'build-one': 'build', 'heldout-one': 'heldout' };
  store.writeJson(dir, 'split.json', split);
  await command(dir, ['interview', 'begin']);
  await askedQuestion(dir);
  await command(dir, ['interview', 'answer', '--text', 'A fictional reason.']);

  const invalidInterview = await command(dir, ['conflicts', 'add', '--claim', 'Fictional claim', '--interview-ref', 'iv-0002', '--behaviour-refs', 'build-one']);
  assert.equal(invalidInterview.code, 1);
  assert.match(invalidInterview.stderr, /Unknown interview ref iv-0002/);
  const invalidPair = await command(dir, ['conflicts', 'add', '--claim', 'Fictional claim', '--interview-ref', 'iv-0001', '--behaviour-refs', 'missing-one']);
  assert.equal(invalidPair.code, 1);
  assert.match(invalidPair.stderr, /Unknown behaviour pair missing-one/);
  const heldout = await command(dir, ['conflicts', 'add', '--claim', 'Fictional claim', '--interview-ref', 'iv-0001', '--behaviour-refs', 'heldout-one']);
  assert.equal(heldout.code, 1);
  assert.match(heldout.stderr, /heldout-one is not in the build set/);
  assert.deepEqual(conflicts.listConflicts(dir), []);

  const added = await command(dir, ['conflicts', 'add', '--claim', 'The fictional claim conflicts with a pattern.', '--interview-ref', 'iv-0001', '--behaviour-refs', 'build-one']);
  assert.equal(added.code, 0, added.stderr);
  assert.equal(JSON.parse(added.stdout).id, 'cf-0001');
  assert.deepEqual(conflicts.openInterviewRefs(dir), new Set(['iv-0001']));
});

test('conflicts list joins interview and behaviour evidence and resolve closes the reference', async (t) => {
  const dir = await persona(t);
  pairs.addPairs(dir, [pair('build-one', 'Observed fictional behaviour.'), pair('build-two', 'Another observed fictional behaviour.')]);
  const split = store.readJson(dir, 'split.json');
  split.assignments = { 'build-one': 'build', 'build-two': 'build' };
  store.writeJson(dir, 'split.json', split);
  await command(dir, ['interview', 'begin']);
  await askedQuestion(dir);
  await command(dir, ['interview', 'answer', '--text', 'Self-report fictional answer.']);
  const add = await command(dir, ['conflicts', 'add', '--claim', 'A fictional claim.', '--interview-ref', 'iv-0001', '--behaviour-refs', 'build-one,build-two']);
  assert.equal(add.code, 0, add.stderr);

  const listing = await command(dir, ['conflicts', 'list']);
  assert.equal(listing.code, 0, listing.stderr);
  for (const expected of [
    'Why is fictional choice 1 made?', 'Self-report fictional answer.',
    'https://chat.example.invalid/thread/build-one', 'Observed fictional behaviour.',
    'https://chat.example.invalid/thread/build-two', 'Another observed fictional behaviour.',
  ]) assert.ok(listing.stdout.includes(expected), expected);
  const json = await command(dir, ['conflicts', 'list', '--open', '--json']);
  const record = JSON.parse(json.stdout.trim());
  assert.equal(record.interview.question, 'Why is fictional choice 1 made?');
  assert.equal(record.behaviour[1].answer, 'Another observed fictional behaviour.');

  const resolved = await command(dir, ['conflicts', 'resolve', 'cf-0001', '--as', 'context', '--note', 'Fictional context explains the difference.']);
  assert.equal(resolved.code, 0, resolved.stderr);
  assert.equal(JSON.parse(resolved.stdout).resolution, 'context');
  assert.deepEqual(conflicts.openInterviewRefs(dir), new Set());
  assert.equal((await command(dir, ['conflicts', 'list', '--open'])).stdout, '');
  assert.equal((await command(dir, ['conflicts', 'resolve', 'cf-0001', '--as', 'behaviour'])).code, 1);
});

test('interview and conflicts reject unsupported argument forms', async (t) => {
  const dir = await persona(t);
  for (const args of [
    ['interview'], ['interview', 'begin', 'extra'], ['interview', 'ask', '--topic', 't', '--gap', 'g'],
    ['interview', 'answer', '--text', 'a', '--text', 'b'], ['conflicts'],
    ['conflicts', 'list', '--open', '--open'], ['conflicts', 'resolve', 'cf-0001', '--as', 'other'],
  ]) {
    const output = await command(dir, args);
    assert.equal(output.code, 2, args.join(' '));
    assert.equal(output.stdout, '');
  }
  assert.deepEqual(fs.readdirSync(dir).sort(), ['persona.json', 'split.json']);
});
