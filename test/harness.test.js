'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const script = path.join(root, 'scripts', 'harness.js');

function reply(verdict) {
  return JSON.stringify({ verdict, reason: 'Synthetic fixture response.' });
}

function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-harness-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const replies = {};
  for (let index = 1; index <= 10; index += 1) {
    replies[`demo.harness.p${index}a`] = reply('supported');
    replies[`demo.harness.p${index}b`] = reply(index <= 5 ? 'not_supported' : 'supported');
  }
  Object.assign(replies, overrides);
  const filename = path.join(directory, 'host.json');
  fs.writeFileSync(filename, JSON.stringify({
    default: reply('supported'),
    replies,
  }));
  return filename;
}

function run(filename) {
  return spawnSync(process.execPath, [script, '--host', `fake:${filename}`], {
    cwd: root, encoding: 'utf8',
  });
}

const expectedLines = [
  'PASS 1 flip pair 1',
  'PASS 2 flip pair 2',
  'PASS 3 flip pair 3',
  'PASS 4 flip pair 4',
  'PASS 5 flip pair 5',
  'PASS 6 length pair 1',
  'PASS 7 length pair 2',
  'PASS 8 length pair 3',
  'PASS 9 length pair 4',
  'PASS 10 length pair 5',
  'harness: 10/10 passed',
];

function failedLines(index) {
  const lines = expectedLines.slice(0, 10);
  lines[index - 1] = lines[index - 1].replace('PASS', 'FAIL');
  lines.push('harness: 9/10 passed');
  return lines;
}

test('harness passes all five flip and five length checks with a fake host', (t) => {
  const result = run(fixture(t));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(result.stdout.trimEnd().split('\n'), expectedLines);
});

test('harness exits 1 and reports the failing pair with a fake host', (t) => {
  const result = run(fixture(t, { 'demo.harness.p3a': reply('not_supported') }));
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(result.stdout.trimEnd().split('\n'), [
    ...expectedLines.slice(0, 2),
    'FAIL 3 flip pair 3',
    ...expectedLines.slice(3, 9),
    'PASS 10 length pair 5',
    'harness: 9/10 passed',
  ]);
});

test('harness catches a non-supporting entry judged supported on flip side 1', (t) => {
  const result = run(fixture(t, { 'demo.harness.p4b': reply('supported') }));
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(result.stdout.trimEnd().split('\n'), failedLines(4));
});

test('harness catches a long supporting entry judged not supported', (t) => {
  const result = run(fixture(t, { 'demo.harness.p8b': reply('not_supported') }));
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(result.stdout.trimEnd().split('\n'), failedLines(8));
});

test('harness catches a twice-malformed support judge reply', (t) => {
  const result = run(fixture(t, { 'demo.harness.p6a': 'not JSON' }));
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(result.stdout.trimEnd().split('\n'), failedLines(6));
});

test('harness reports a missing fake host file as failed checks', (t) => {
  const filename = fixture(t);
  fs.rmSync(filename);
  const result = run(filename);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'harness: host call failed; affected checks are marked FAIL\n');
  assert.deepEqual(result.stdout.trimEnd().split('\n'), [
    ...expectedLines.slice(0, 10).map((line) => line.replace('PASS', 'FAIL')),
    'harness: 0/10 passed',
  ]);
});

test('harness prints usage and exits 2 for bad arguments', () => {
  const result = spawnSync(process.execPath, [script, '--host'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'Usage: node scripts/harness.js --host <claude|codex|fake:<file>>\n');
});
