'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

test('plugin manifest is valid and matches the package version', () => {
  const packageJson = readJson('package.json');
  const plugin = readJson('.claude-plugin/plugin.json');

  assert.equal(plugin.name, 'bunshin');
  assert.equal(plugin.version, packageJson.version);
  assert.equal(plugin.description, 'Build, test and export a persona of one person.');
  assert.deepEqual(plugin.author, { name: 'Ryo Ochi' });
  assert.equal(plugin.homepage, 'https://github.com/ryoochi0112/bunshin');
  assert.equal(plugin.license, 'MIT');
});

test('marketplace manifest is valid and lists the root plugin', () => {
  const marketplace = readJson('.claude-plugin/marketplace.json');

  assert.equal(marketplace.name, 'bunshin');
  assert.deepEqual(marketplace.owner, { name: 'Ryo Ochi' });
  assert.ok(marketplace.plugins.some((plugin) => (
    plugin.name === 'bunshin' && plugin.source === './'
  )));
});
