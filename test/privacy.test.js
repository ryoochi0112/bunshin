'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const store = require('../lib/store');

const root = path.resolve(__dirname, '..');
// Every spec §7 persona file and directory name; data belongs only in /sample/persona/.
const sensitiveDirectories = ['evals', 'calibration', 'shadow', 'export'];
const sensitiveFiles = new Set([
  'persona.json', 'pairs.jsonl', 'split.json', 'cases.jsonl', 'interview.jsonl', 'interview-state.json',
  'conflicts.jsonl', 'identity.json', 'identity.md', '.identity-transaction.json', ...sensitiveDirectories,
]);

function privacyFindings(repo) {
  const findings = [];
  const sample = path.join('sample', 'persona');
  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    if (dir !== repo && entries.some((entry) => entry.name === '.git')) return;
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const target = path.join(dir, entry.name);
      const relative = path.relative(repo, target);
      const codeDirectory = entry.isDirectory() && sensitiveDirectories.includes(entry.name)
        && ['skills', 'templates'].includes(path.relative(repo, dir));
      if (sensitiveFiles.has(entry.name) && !relative.startsWith(`${sample}${path.sep}`) && !codeDirectory) {
        findings.push(relative);
      }
      if (entry.isDirectory()) walk(target);
    }
  }
  walk(repo);
  try {
    if (store.readJson(path.join(repo, sample), 'persona.json').synthetic !== true) {
      findings.push(path.join(sample, 'persona.json') + ': synthetic must be true');
    }
  } catch {
    findings.push(path.join(sample, 'persona.json') + ': cannot read synthetic manifest');
  }
  return findings.sort();
}

function temporaryDirectory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-privacy-'));
  t.after(() => { store._resetGuardCache(); fs.rmSync(dir, { recursive: true, force: true }); });
  return fs.realpathSync(dir);
}

function git(repo, args, env) {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_')));
  return childProcess.spawnSync('git', ['-C', repo, ...args], {
    cwd: repo, encoding: 'utf8', timeout: 5000,
    env: { ...cleaned, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('repository contains persona data only in the synthetic sample', () => {
  assert.deepEqual(privacyFindings(root), []);
});

test('privacy walk finds every protected filename including ignored and hidden directories', (t) => {
  const repo = temporaryDirectory(t);
  store.writeJson(path.join(repo, 'sample', 'persona'), 'persona.json', { synthetic: true }, { synthetic: true });
  fs.mkdirSync(path.join(repo, '.git'));
  const expected = [];
  for (const file of sensitiveFiles) {
    const relative = path.join('.hidden', 'personas', 'x', file);
    store.writeText(repo, relative, 'Fictional private fixture.', { synthetic: true });
    expected.push(relative);
    // A journal in the sample would be an interrupted commit, not a sample file.
    if (file !== '.identity-transaction.json') {
      store.writeText(repo, path.join('sample', 'persona', file), '{"synthetic":true}\n', { synthetic: true });
    }
  }
  store.writeText(repo, 'sample/persona-copy/pairs.jsonl', '{}\n', { synthetic: true });
  expected.push(path.join('sample', 'persona-copy', 'pairs.jsonl'));
  assert.deepEqual(privacyFindings(repo), expected.sort());
});

test('privacy walk allows protected directory names directly under root skills and templates', (t) => {
  const repo = temporaryDirectory(t);
  store.writeJson(path.join(repo, 'sample', 'persona'), 'persona.json', { synthetic: true }, { synthetic: true });
  for (const parent of ['skills', 'templates']) {
    for (const directory of sensitiveDirectories) {
      const file = parent === 'skills' ? 'SKILL.md' : 'README.md';
      store.writeText(repo, path.join(parent, directory, file), 'Fictional skill or template.', { synthetic: true });
    }
  }
  assert.deepEqual(privacyFindings(repo), []);
});

test('privacy walk rejects protected filenames directly under root skills and templates', (t) => {
  const repo = temporaryDirectory(t);
  store.writeJson(path.join(repo, 'sample', 'persona'), 'persona.json', { synthetic: true }, { synthetic: true });
  const expected = [];
  for (const parent of ['skills', 'templates']) {
    for (const file of sensitiveFiles) {
      const relative = path.join(parent, file);
      store.writeText(repo, relative, 'Fictional private fixture.', { synthetic: true });
      expected.push(relative);
    }
  }
  assert.deepEqual(privacyFindings(repo), expected.sort());
});

test('privacy walk still finds protected files and deeper or fixture directories', (t) => {
  const repo = temporaryDirectory(t);
  store.writeJson(path.join(repo, 'sample', 'persona'), 'persona.json', { synthetic: true }, { synthetic: true });
  const expected = [];
  for (const parent of ['skills/export', 'templates/export', 'skills/x/files', 'templates/x', 'test/fixtures/files']) {
    for (const file of sensitiveFiles) {
      const relative = path.join(parent, file);
      store.writeText(repo, relative, 'Fictional private fixture.', { synthetic: true });
      expected.push(relative);
    }
  }
  for (const parent of [
    'skills/x', 'templates/x/nested', 'skills/export/nested', 'templates/export/nested',
    'test/fixtures', 'nested/skills', 'nested/templates',
  ]) {
    for (const directory of sensitiveDirectories) {
      const relative = path.join(parent, directory);
      fs.mkdirSync(path.join(repo, relative), { recursive: true });
      expected.push(relative);
    }
  }
  assert.deepEqual(privacyFindings(repo), expected.sort());
});

test('privacy walk skips git internals, dependencies and nested checkouts with a git directory or file', (t) => {
  const repo = temporaryDirectory(t);
  store.writeJson(path.join(repo, 'sample', 'persona'), 'persona.json', { synthetic: true }, { synthetic: true });
  for (const dir of ['.git', 'node_modules', 'nested/repo-directory', 'nested/repo-file']) {
    for (const file of sensitiveFiles) {
      store.writeText(repo, path.join(dir, 'deep', file), 'Fictional skipped fixture.', { synthetic: true });
    }
  }
  fs.mkdirSync(path.join(repo, 'nested', 'repo-directory', '.git'));
  fs.writeFileSync(path.join(repo, 'nested', 'repo-file', '.git'), 'gitdir: fictional-metadata\n');
  // Reading these instead of skipping the directories would also fail on invalid JSON.
  assert.deepEqual(privacyFindings(repo), []);
});

test('privacy walk rejects a missing, malformed or non-synthetic sample manifest', (t) => {
  const repo = temporaryDirectory(t);
  const sample = path.join(repo, 'sample', 'persona');
  assert.equal(privacyFindings(repo).length, 1);
  for (const synthetic of [false, 'true', undefined]) {
    store.writeJson(sample, 'persona.json', { synthetic }, { synthetic: true });
    assert.deepEqual(privacyFindings(repo), [path.join('sample', 'persona', 'persona.json') + ': synthetic must be true']);
    fs.unlinkSync(path.join(sample, 'persona.json'));
  }
  store.writeText(sample, 'persona.json', 'Fictional malformed manifest.', { synthetic: true });
  assert.deepEqual(privacyFindings(repo), [path.join('sample', 'persona', 'persona.json') + ': cannot read synthetic manifest']);
});

test('gitignore protects every private persona file and permits sample files despite hostile git environment', (t) => {
  const temporary = temporaryDirectory(t);
  const home = path.join(temporary, 'home');
  const xdg = path.join(temporary, 'xdg');
  fs.mkdirSync(home);
  fs.mkdirSync(xdg);
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg };
  const decoy = path.join(temporary, 'decoy');
  fs.mkdirSync(decoy);
  const initialized = git(decoy, ['init', '--quiet'], env);
  assert.equal(initialized.error, undefined);
  assert.equal(initialized.status, 0, initialized.stderr);
  fs.writeFileSync(path.join(decoy, '.gitignore'), 'sample/\n');
  const globalConfig = path.join(temporary, 'global-config');
  fs.writeFileSync(globalConfig, `[core]\nexcludesFile = ${path.join(decoy, '.gitignore')}\n`);
  const hostile = {
    ...env, GIT_DIR: path.join(decoy, '.git'), GIT_WORK_TREE: decoy,
    GIT_CONFIG: globalConfig, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_SYSTEM: globalConfig,
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.excludesFile', GIT_CONFIG_VALUE_0: path.join(decoy, '.gitignore'),
    GIT_CONFIG_PARAMETERS: "'core.excludesFile=/fictional/missing'",
  };
  const files = (dir) => [...sensitiveFiles].filter((file) => file !== '.identity-transaction.json')
    .map((file) => (sensitiveDirectories.includes(file) ? `${dir}/${file}/run-1/report.json` : `${dir}/${file}`));
  // Outside /personas/, so each filename rule is what ignores the path.
  const privatePaths = [...files('stray/x'), 'stray/x/.identity-transaction.json'];
  const codePaths = [
    'templates/export/README.md', 'skills/export/SKILL.md', 'skills/shadow/SKILL.md', 'skills/calibrate/SKILL.md',
    'test/fixtures/evals/run-1/report.json', 'test/fixtures/shadow/s1/question.json', 'test/fixtures/persona.json',
  ];
  for (const environment of [env, hostile]) {
    // --no-index also checks ignore rules after the sample is tracked.
    const ignored = git(root, ['check-ignore', '--no-index', '--', ...privatePaths], environment);
    assert.equal(ignored.error, undefined);
    assert.equal(ignored.status, 0, ignored.stderr);
    assert.equal(ignored.stdout, privatePaths.map((file) => `${file}\n`).join(''));
    assert.equal(ignored.stderr, '');
    const sample = git(root, ['check-ignore', '--no-index', '--', ...files('sample/persona')], environment);
    assert.equal(sample.error, undefined);
    assert.equal(sample.status, 1, sample.stderr);
    assert.equal(sample.stdout, '');
    assert.equal(sample.stderr, '');
    const code = git(root, ['check-ignore', '--no-index', '--', ...codePaths], environment);
    assert.equal(code.error, undefined);
    assert.equal(code.status, 1, code.stderr);
    assert.equal(code.stdout, '');
    assert.equal(code.stderr, '');
  }
});
