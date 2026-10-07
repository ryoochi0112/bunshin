'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { main } = require('../bin/bunshin');

function createIo() {
  let stdout = '';
  let stderr = '';

  return {
    io: {
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
    },
    read: () => ({ stdout, stderr }),
  };
}

test('help lists version and its summary', async () => {
  const output = createIo();

  assert.equal(await main(['--help'], output.io), 0);
  assert.match(output.read().stdout, /version\s+Print the Bunshin version/);
});

test('help lists examples and its summary', async () => {
  const output = createIo();

  assert.equal(await main(['--help'], output.io), 0);
  assert.match(output.read().stdout, /examples\s+Draft and rate judge examples from build pairs/);
});

test('no arguments prints help', async () => {
  const output = createIo();

  assert.equal(await main([], output.io), 0);
  assert.match(output.read().stdout, /Usage: bunshin <command> \[args\]/);
});

test('unknown command returns 2 and writes an error', async () => {
  const output = createIo();

  assert.equal(await main(['missing'], output.io), 2);
  assert.match(output.read().stderr, /Unknown command: missing/);
});

test('version prints the package version', async () => {
  const output = createIo();

  assert.equal(await main(['version'], output.io), 0);
  assert.equal(output.read().stdout, '0.1.0\n');
});
