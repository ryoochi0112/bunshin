'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { main } = require('../bin/bunshin');
const pairs = require('../lib/pairs');
const store = require('../lib/store');

const source = path.resolve(__dirname, '..', 'sample', 'persona');
const files = [
  'cases.jsonl', 'conflicts.jsonl', 'identity.json', 'identity.md',
  'interview.jsonl', 'pairs.jsonl', 'persona.json', 'split.json',
];
const remote = 'https://example.invalid/fictional/sample.git';

function temporaryDirectory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-sample-'));
  t.after(() => { store._resetGuardCache(); fs.rmSync(dir, { recursive: true, force: true }); });
  return fs.realpathSync(dir);
}

test.beforeEach((t) => {
  store._resetGuardCache();
  const root = temporaryDirectory(t);
  const values = { HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'xdg') };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  fs.mkdirSync(values.HOME);
  fs.mkdirSync(values.XDG_CONFIG_HOME);
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
});

async function command(home, args, stdin = '') {
  let stdout = '';
  let stderr = '';
  let probes = 0;
  const code = await main(args, {
    env: { BUNSHIN_HOME: home }, stdin,
    probe: () => { probes += 1; return 'public'; },
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
  });
  return { code, stdout, stderr, probes };
}

function bytes(dir, file) {
  return fs.readFileSync(path.join(dir, file));
}

test('init --sample copies all eight fictional persona files with the default name', async (t) => {
  const home = path.join(temporaryDirectory(t), 'personas');
  const dir = path.join(home, 'sample');
  const output = await command(home, ['init', '--sample']);
  assert.deepEqual(output, { code: 0, stdout: `Created persona sample at ${dir}\n`, stderr: '', probes: 0 });
  assert.deepEqual(fs.readdirSync(source).sort(), files);
  assert.deepEqual(fs.readdirSync(dir).sort(), files);
  for (const file of files) assert.deepEqual(bytes(dir, file), bytes(source, file), file);
  const manifest = store.readJson(dir, 'persona.json');
  assert.equal(manifest.synthetic, true);
  assert.equal(manifest.display_name, 'Sora Aoki');
  assert.equal(manifest.owner.slack_user_id, null);
  assert.equal(manifest.version, 1);
  assert.equal(store.readJson(dir, 'split.json').salt, '74696465706f6f6c');
  const records = pairs.listPairs(dir, { set: 'all' });
  assert.ok(records.length >= 12);
  assert.ok(pairs.listPairs(dir, { set: 'heldout' }).length >= 3);
  assert.deepEqual(new Set(pairs.listPairs(dir, { set: 'heldout' }).map((pair) => pair.layer)), new Set(['knowledge', 'judgment']));
  const japanese = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
  for (const layer of ['knowledge', 'judgment']) {
    const questions = records.filter((pair) => pair.layer === layer).map((pair) => pair.question.text);
    assert.ok(questions.some((question) => japanese.test(question)), `${layer} Japanese question`);
    assert.ok(questions.some((question) => !japanese.test(question) && /[a-z]/i.test(question)), `${layer} English question`);
  }
  for (const pair of records) {
    assert.deepEqual(pairs.validatePair(pair), []);
    assert.equal(pair.source, 'manual');
    assert.equal(pair.channel, 'tidepool-fictional-design');
    assert.ok(['Mira Pebble', 'Neri Moss'].includes(pair.question.author));
    assert.match(pair.permalink, /^https:\/\/example\.invalid\//);
  }
  const interviews = store.readJsonl(dir, 'interview.jsonl');
  assert.ok(interviews.length >= 4);
  for (const answer of interviews) {
    assert.ok(answer.gap.trim());
    assert.ok(answer.question.trim());
    assert.ok(answer.answer.trim());
  }
  const conflicts = store.readJsonl(dir, 'conflicts.jsonl');
  assert.ok(conflicts.length >= 2);
  assert.ok(conflicts.some((conflict) => conflict.status === 'open' && conflict.resolution === null));
  assert.ok(conflicts.some((conflict) => conflict.status === 'resolved' && conflict.resolution !== null));
  const build = new Set(pairs.listPairs(dir, { set: 'build' }).map((pair) => pair.id));
  for (const conflict of conflicts) {
    assert.ok(conflict.behaviour_refs.every((ref) => build.has(ref)));
    assert.ok(interviews.some((answer) => answer.id === conflict.interview_ref));
  }
  const identity = store.readJson(dir, 'identity.json');
  assert.ok(identity.voice.length >= 2);
  assert.ok(identity.priorities.length >= 3);
  assert.ok(identity.objections.length >= 2);
  // The executable example contains only reserved-domain URLs, including evidence links.
  for (const file of files) {
    const text = bytes(dir, file).toString('utf8');
    for (const url of text.match(/https?:\/\/[^\s"<>\)]+/g) || []) {
      assert.equal(new URL(url).origin, 'https://example.invalid', file);
    }
  }
  assert.match(bytes(dir, 'pairs.jsonl').toString('utf8'), /Tidepool/);
});

test('sample split, cases and identity regenerate through the engine with byte-equal derived files', async (t) => {
  const home = temporaryDirectory(t);
  const dir = path.join(home, 'sample');
  assert.equal((await command(home, ['init', '--sample'])).code, 0);
  const committedSplit = store.readJson(dir, 'split.json');
  store.writeJson(dir, 'split.json', { ...committedSplit, assignments: {} });
  const assigned = await command(home, ['split', '--persona', dir]);
  assert.equal(assigned.code, 0, assigned.stderr);
  assert.equal(JSON.parse(assigned.stdout).new, pairs.listPairs(dir, { set: 'all' }).length);
  assert.deepEqual(bytes(dir, 'split.json'), bytes(source, 'split.json'));

  const cases = await command(home, ['cases', 'build', '--persona', dir]);
  assert.deepEqual(cases, { code: 0, stdout: `Built ${pairs.listPairs(dir, { set: 'heldout' }).length} cases\n`, stderr: '', probes: 0 });
  assert.deepEqual(bytes(dir, 'cases.jsonl'), bytes(source, 'cases.jsonl'));
  const draft = store.readJson(dir, 'identity.json');
  const validated = await command(home, ['identity', 'validate', '-', '--persona', dir], JSON.stringify(draft));
  assert.deepEqual(validated, { code: 0, stdout: 'Identity is valid.\n', stderr: '', probes: 0 });
  const checked = await command(home, ['check', '--persona', dir]);
  assert.deepEqual(checked, { code: 0, stdout: 'Held-out checks passed.\n', stderr: '', probes: 0 });

  // Recreate the initial commit from version zero; built_at is intentionally engine-owned.
  const manifest = store.readJson(dir, 'persona.json');
  store.writeJson(dir, 'persona.json', { ...manifest, version: manifest.version - 1 });
  const committed = await command(home, ['identity', 'commit', '-', '--persona', dir], JSON.stringify(draft));
  assert.deepEqual(committed, { code: 0, stdout: `Committed identity v${manifest.version}.\n`, stderr: '', probes: 0 });
  assert.deepEqual(bytes(dir, 'identity.md'), bytes(source, 'identity.md'));
  assert.equal(store.readJson(dir, 'identity.json').version, manifest.version);
  assert.equal(store.readJson(dir, 'persona.json').version, manifest.version);
});

test('init --sample --name accepts an empty directory and renames both persona references', async (t) => {
  const home = temporaryDirectory(t);
  const dir = path.join(home, 'sample-copy');
  fs.mkdirSync(dir);
  const output = await command(home, ['init', '--sample', '--name', 'sample-copy']);
  assert.deepEqual(output, { code: 0, stdout: `Created persona sample-copy at ${dir}\n`, stderr: '', probes: 0 });
  const manifest = store.readJson(dir, 'persona.json');
  const identity = store.readJson(dir, 'identity.json');
  assert.equal(manifest.name, 'sample-copy');
  assert.equal(identity.persona, 'sample-copy');
  assert.equal(manifest.display_name, 'Sora Aoki');
  assert.equal(manifest.synthetic, true);
  assert.deepEqual(bytes(dir, 'identity.md'), bytes(source, 'identity.md'));
  assert.equal((await command(home, ['identity', 'validate', '-', '--persona', dir], JSON.stringify(identity))).code, 0);
  assert.equal((await command(home, ['check', '--persona', dir])).code, 0);
});

test('sample uses the synthetic guard exemption while real init still refuses a public remote', async (t) => {
  const repo = temporaryDirectory(t);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const options = { cwd: repo, env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, stdio: 'pipe', timeout: 5000 };
  childProcess.execFileSync('git', ['-C', repo, 'init', '--quiet'], options);
  childProcess.execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', remote], options);
  const home = path.join(repo, 'personas');
  const sample = await command(home, ['init', '--sample']);
  assert.equal(sample.code, 0, sample.stderr);
  assert.equal(sample.probes, 0);
  assert.equal(store.readJson(path.join(home, 'sample'), 'persona.json').synthetic, true);
  const real = await command(home, ['init', 'real-persona']);
  assert.equal(real.code, 1);
  assert.equal(real.probes, 1);
  assert.equal(real.stdout, '');
  assert.ok(real.stderr.includes(remote));
  assert.match(real.stderr, /public.*refusing to write persona data/);
  assert.ok(!fs.existsSync(path.join(home, 'real-persona')));
});

test('init --sample refuses non-empty targets without changing existing persona data', async (t) => {
  const home = temporaryDirectory(t);
  const dir = path.join(home, 'sample');
  assert.equal((await command(home, ['init', 'sample'])).code, 0);
  const before = Object.fromEntries(fs.readdirSync(dir).map((file) => [file, bytes(dir, file)]));
  const output = await command(home, ['init', '--sample']);
  assert.equal(output.code, 1);
  assert.match(output.stderr, /not empty/);
  assert.equal(output.stdout, '');
  assert.equal(output.probes, 0);
  assert.deepEqual(fs.readdirSync(home), ['sample']);
  assert.deepEqual(Object.fromEntries(fs.readdirSync(dir).map((file) => [file, bytes(dir, file)])), before);
});

test('init --sample rejects bad names and unsupported arguments before writing', async (t) => {
  const home = temporaryDirectory(t);
  for (const args of [
    ['--sample', '--name'], ['--sample', '--name', ''], ['--sample', '--name', '../escape'],
    ['--sample', '--name', '/absolute'], ['--sample', '--name', 'Sample'],
    ['--sample', '--name', 'sample_person'], ['--sample', '--name', 'two words'],
    ['--sample', '--name', 'sample', 'extra'], ['--sample', 'extra'],
    ['--sample', '--sample'], ['--sample', '--synthetic'], ['--name', 'sample'],
  ]) {
    const output = await command(home, ['init', ...args]);
    assert.equal(output.code, 2, args.join(' '));
    assert.match(output.stderr, /Usage: bunshin init/);
    assert.equal(output.stdout, '');
    assert.equal(output.probes, 0);
  }
  assert.deepEqual(fs.readdirSync(home), []);
});

test('a failed sample copy publishes no partial persona and a retry succeeds', async (t) => {
  const root = temporaryDirectory(t);
  const home = path.join(root, 'personas');
  const dir = path.join(home, 'sample');
  const original = store.writeJsonl;
  let failures = 0;
  let visibleDuringCopy = 0;
  t.mock.method(store, 'writeJsonl', (...args) => {
    if (fs.existsSync(dir)) visibleDuringCopy += 1;
    if (args[1] === 'conflicts.jsonl') {
      failures += 1;
      throw new Error('Simulated sample copy failure.');
    }
    return original(...args);
  });
  const output = await command(home, ['init', '--sample']);
  assert.deepEqual(output, { code: 1, stdout: '', stderr: 'Simulated sample copy failure.\n', probes: 0 });
  assert.equal(failures, 1);
  assert.equal(visibleDuringCopy, 0);
  assert.deepEqual(fs.readdirSync(root), []);
  t.mock.restoreAll();
  const retry = await command(home, ['init', '--sample']);
  assert.equal(retry.code, 0, retry.stderr);
  assert.deepEqual(fs.readdirSync(home), ['sample']);
  assert.deepEqual(fs.readdirSync(dir).sort(), files);
});

test('an interrupted sample copy cannot be selected as a persona and retry publishes one complete persona', async (t) => {
  const root = temporaryDirectory(t);
  const home = path.join(root, 'personas');
  fs.mkdirSync(home);
  const script = `
    const store = require(${JSON.stringify(require.resolve('../lib/store'))});
    store.writeJsonl = () => process.exit(77);
    const { main } = require(${JSON.stringify(require.resolve('../bin/bunshin'))});
    main(['init', '--sample'], { stdout: process.stdout, stderr: process.stderr });
  `;
  const interrupted = childProcess.spawnSync(process.execPath, ['-e', script], {
    cwd: root, env: { ...process.env, BUNSHIN_HOME: home },
    encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(interrupted.error, undefined);
  assert.equal(interrupted.status, 77, interrupted.stderr);
  assert.equal(interrupted.stdout, '');
  assert.equal(interrupted.stderr, '');
  const stages = fs.readdirSync(root).filter((entry) => entry.startsWith('.personas-sample.'));
  assert.equal(stages.length, 1);
  assert.deepEqual(fs.readdirSync(home), []);
  assert.throws(() => store.resolvePersona({ env: { BUNSHIN_HOME: home } }), /found 0/);
  const retry = await command(home, ['init', '--sample']);
  assert.equal(retry.code, 0, retry.stderr);
  const dir = path.join(home, 'sample');
  assert.equal(store.resolvePersona({ env: { BUNSHIN_HOME: home } }), dir);
  assert.deepEqual(fs.readdirSync(home), ['sample']);
  for (const file of files) assert.deepEqual(bytes(dir, file), bytes(source, file), file);
});

test('init --sample refuses a source manifest without literal synthetic true before any write', async (t) => {
  const root = temporaryDirectory(t);
  const home = path.join(root, 'personas');
  const original = store.readJson;
  let reads = 0;
  for (const synthetic of [false, 'true', undefined]) {
    t.mock.method(store, 'readJson', (dir, file) => {
      if (dir === source && file === 'persona.json') {
        reads += 1;
        return { ...original(dir, file), synthetic };
      }
      return original(dir, file);
    });
    const output = await command(home, ['init', '--sample']);
    assert.deepEqual(output, { code: 1, stdout: '', stderr: 'Sample persona must be synthetic.\n', probes: 0 });
    t.mock.restoreAll();
  }
  assert.equal(reads, 3);
  assert.deepEqual(fs.readdirSync(root), []);
});
