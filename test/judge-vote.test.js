'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const judge = require('../lib/judge');

function call(rating, wrong = 0, match = true, tag = rating) {
  return { rating, reason: `reason ${tag}`, claims: [{ text: tag, cited: true, correct: null }], wrong_uncited: wrong, language_match: match };
}

test('vote picks the majority rating and falls back to needs_edits', () => {
  const table = [
    [['send_as_is', 'send_as_is', 'wrong'], 'send_as_is'],
    [['send_as_is', 'needs_edits', 'wrong'], 'needs_edits'],
    [['wrong', 'wrong', 'needs_edits'], 'wrong'],
    [['needs_edits', 'needs_edits', 'needs_edits'], 'needs_edits'],
  ];
  assert.equal(judge.VOTES, 3);
  for (const [ratings, expected] of table) assert.equal(judge.vote(ratings.map((r) => call(r))).rating, expected);
});

test('vote takes the median of wrong_uncited and the majority of language_match', () => {
  const wrongs = (a, b, c) => judge.vote([call('wrong', a), call('wrong', b), call('wrong', c)]).wrong_uncited;
  assert.equal(wrongs(0, 2, 1), 1);
  assert.equal(wrongs(0, 0, 3), 0);
  assert.equal(judge.vote([call('wrong', 0, true), call('wrong', 0, true), call('wrong', 0, false)]).language_match, true);
  assert.equal(judge.vote([call('wrong', 0, false), call('wrong', 0, true), call('wrong', 0, false)]).language_match, false);
});

test('vote copies reason and claims from the first matching call and records votes', () => {
  const calls = [call('wrong', 0, true, 'a'), call('send_as_is', 0, true, 'b'), call('send_as_is', 0, true, 'c')];
  const result = judge.vote(calls);
  assert.equal(result.reason, 'reason b');
  assert.deepEqual(result.claims, calls[1].claims);
  assert.equal(result.votes.length, 3);
  for (const v of result.votes) assert.deepEqual(Object.keys(v), ['rating', 'wrong_uncited', 'language_match']);
  const split = judge.vote([call('wrong', 0, true, 'x'), call('send_as_is', 0, true, 'y'), call('needs_edits', 0, true, 'z')]);
  assert.equal(split.reason, 'reason z');
});

test('vote falls back to the first call when no call matches the result', () => {
  const split = judge.vote([call('wrong', 0, true, 'x'), call('send_as_is', 0, true, 'y'), call('wrong', 0, true, 'z')]);
  assert.equal(split.rating, 'wrong');
  const none = judge.vote([call('wrong', 0, true, 'x'), call('send_as_is', 0, true, 'y'), call('send_as_is', 0, true, 'z')]);
  assert.equal(none.reason, 'reason y');
});

test('vote requires exactly three judgments', () => {
  assert.throws(() => judge.vote([call('wrong'), call('wrong')]), /judge: vote needs 3 judgments/);
  assert.throws(() => judge.vote([call('wrong'), call('wrong'), call('wrong'), call('wrong')]), /judge: vote needs 3 judgments/);
});
