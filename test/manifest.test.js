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

test('Claude and Codex root plugins share the package name and version', () => {
  const manifests = ['package.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json']
    .map(readJson);
  assert.deepEqual(manifests.map(({ name }) => name), ['bunshin', 'bunshin', 'bunshin']);
  assert.deepEqual(manifests.map(({ version }) => version), Array(3).fill(manifests[0].version));
  assert.equal(manifests[2].skills, './skills/');
  assert.deepEqual(Object.keys(manifests[2]).sort(),
    ['author', 'description', 'homepage', 'license', 'name', 'skills', 'version']);
});

test('Codex session instructions identify the engine and privacy boundary', () => {
  const text = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  for (const required of ['Build, test and export a persona of one person.',
    'node bin/bunshin.js', 'node bin/bunshin.js --help',
    '~/bunshin-personas/<name>', 'BUNSHIN_HOME',
    'Never put persona data in this repository.',
    'bunshin never posts or sends anything.',
    'Skills name only search/read connector tools.']) {
    assert.ok(text.includes(required), required);
  }
});
