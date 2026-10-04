'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { main } = require('../bin/bunshin');
const guard = require('../lib/guard');
const store = require('../lib/store');

const remote = 'https://code.example.invalid/fictional/persona.git';

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
test.afterEach(() => store._resetGuardCache());

function temporaryDirectory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync(dir);
}

function createRepo(dir) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const options = { cwd: dir, env, stdio: 'pipe' };
  childProcess.execFileSync('git', ['-C', dir, 'init', '--quiet'], options);
  childProcess.execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', remote], options);
  return dir;
}

function createIo(env, probe = () => 'public') {
  let stdout = '';
  let stderr = '';
  let calls = 0;
  return {
    io: {
      env,
      probe: (url) => { calls += 1; return probe(url); },
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
    },
    read: () => ({ stdout, stderr }),
    probeCalls: () => calls,
  };
}

test('resolvePersona prioritizes explicit persona over environment and home', (t) => {
  const home = temporaryDirectory(t);
  const env = { BUNSHIN_HOME: home, BUNSHIN_PERSONA: path.join(home, 'environment') };

  assert.equal(store.resolvePersona({ persona: 'explicit-persona', env }), path.resolve('explicit-persona'));
  assert.equal(store.resolvePersona({ env }), env.BUNSHIN_PERSONA);
});

test('resolvePersona selects the single directory in BUNSHIN_HOME and ignores files', (t) => {
  const home = temporaryDirectory(t);
  fs.mkdirSync(path.join(home, 'sample-person'));
  fs.writeFileSync(path.join(home, 'unrelated.txt'), 'fictional');

  assert.equal(store.resolvePersona({ env: { BUNSHIN_HOME: home } }), path.join(home, 'sample-person'));
  assert.equal(store.personaHome({}), path.join(os.homedir(), 'bunshin-personas'));
});

test('resolvePersona refuses missing, empty and ambiguous homes', (t) => {
  const home = temporaryDirectory(t);
  assert.throws(() => store.resolvePersona({ env: { BUNSHIN_HOME: path.join(home, 'missing') } }), /found 0/);
  assert.throws(() => store.resolvePersona({ env: { BUNSHIN_HOME: home } }), /found 0/);
  fs.mkdirSync(path.join(home, 'sample-one'));
  fs.mkdirSync(path.join(home, 'sample-two'));
  assert.throws(() => store.resolvePersona({ env: { BUNSHIN_HOME: home } }), /found 2.*--persona/);
});

test('JSON and JSONL round trip UTF-8 and create nested directories', (t) => {
  const dir = path.join(temporaryDirectory(t), 'persona');
  const first = { id: 'sample-1', text: '架空の質問' };
  const second = { id: 'sample-2', text: 'Fictional answer' };

  store.writeJson(dir, 'nested/record.json', first);
  assert.deepEqual(store.readJson(dir, 'nested/record.json'), first);
  assert.deepEqual(store.readJsonl(dir, 'pairs.jsonl'), []);
  store.appendJsonl(dir, 'pairs.jsonl', first);
  store.appendJsonl(dir, 'pairs.jsonl', second);
  assert.deepEqual(store.readJsonl(dir, 'pairs.jsonl'), [first, second]);
  store.writeJsonl(dir, 'pairs.jsonl', [second]);
  assert.deepEqual(store.readJsonl(dir, 'pairs.jsonl'), [second]);
  store.writeJsonl(dir, 'pairs.jsonl', []);
  assert.equal(fs.readFileSync(path.join(dir, 'pairs.jsonl'), 'utf8'), '');
});

const writers = [
  ['writeJson', (dir, relPath, options) => store.writeJson(dir, relPath, { id: 'sample' }, options)],
  ['writeJsonl', (dir, relPath, options) => store.writeJsonl(dir, relPath, [{ id: 'sample' }], options)],
  ['appendJsonl', (dir, relPath, options) => store.appendJsonl(dir, relPath, { id: 'sample' }, options)],
];

for (const [name, write] of writers) {
  for (const verdict of ['public', 'unknown']) {
    test(`${name} refuses a ${verdict} remote before creating directories or files`, (t) => {
      const repo = createRepo(temporaryDirectory(t));
      const dir = path.join(repo, 'missing', 'persona');

      assert.throws(() => write(dir, 'nested/record.jsonl', { probe: () => verdict }), guard.GuardError);
      assert.ok(!fs.existsSync(path.join(repo, 'missing')));
    });
  }

  test(`${name} rejects absolute and traversal paths`, (t) => {
    const root = temporaryDirectory(t);
    const dir = path.join(root, 'persona');
    for (const relPath of ['../outside.json', 'nested/../../outside.json', 'a/../b', path.join(root, 'absolute.json'), '..', '']) {
      assert.throws(() => write(dir, relPath), /relative|inside/);
    }
    assert.deepEqual(fs.readdirSync(root), []);
  });

  test(`${name} rejects symlinks that escape the persona directory`, (t) => {
    const root = temporaryDirectory(t);
    const dir = path.join(root, 'persona');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(dir);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(dir, 'escape'), 'dir');

    assert.throws(() => write(dir, 'escape/record.jsonl'), /inside/);
    assert.deepEqual(fs.readdirSync(outside), []);
  });
}

test('all writers use one guard verdict per resolved persona directory, with a test reset', (t) => {
  const repo = createRepo(temporaryDirectory(t));
  const dir = path.join(repo, 'persona');
  const alias = path.join(repo, 'alias');
  let probes = 0;
  const options = { probe: () => { probes += 1; return 'private'; } };
  const originalGuard = guard.assertSafePersonaPath;
  const spy = t.mock.method(guard, 'assertSafePersonaPath', (...args) => originalGuard(...args));

  store.writeJson(dir, 'record.json', { id: 'sample' }, options);
  fs.symlinkSync(dir, alias, 'dir');
  store.writeJsonl(alias, 'pairs.jsonl', [], options);
  store.appendJsonl(dir, 'pairs.jsonl', { id: 'sample' }, options);
  assert.equal(probes, 1);
  assert.equal(spy.mock.callCount(), 1);
  store._resetGuardCache();
  store.writeJson(alias, 'record.json', { id: 'sample-2' }, options);
  assert.equal(probes, 2);
});

test('a refused verdict is cached and cannot be replaced by a later probe', (t) => {
  const repo = createRepo(temporaryDirectory(t));
  let probes = 0;
  let laterProbes = 0;
  const probe = () => { probes += 1; return 'unknown'; };

  assert.throws(() => store.writeJson(repo, 'record.json', {}, { probe }), guard.GuardError);
  assert.throws(() => store.writeJson(repo, 'record.json', {}, {
    probe: () => { laterProbes += 1; return 'private'; },
  }), guard.GuardError);
  assert.equal(probes, 1);
  assert.equal(laterProbes, 0);
  assert.ok(!fs.existsSync(path.join(repo, 'record.json')));
});

for (const synthetic of [true, false, 'true']) {
  test(`store reads synthetic: ${String(synthetic)} from the manifest`, (t) => {
    const dir = createRepo(temporaryDirectory(t));
    fs.writeFileSync(path.join(dir, 'persona.json'), JSON.stringify({ format_version: 1, synthetic }));
    let probes = 0;
    const write = () => store.writeJson(dir, 'record.json', {}, {
      probe: () => { probes += 1; return 'public'; },
      synthetic: true,
    });

    if (synthetic === true) {
      assert.doesNotThrow(write);
      assert.equal(probes, 0);
    } else {
      assert.throws(write, guard.GuardError);
      assert.equal(probes, 1);
    }
  });
}

test('sample initialization can pass synthetic: true before a manifest exists', (t) => {
  const dir = createRepo(temporaryDirectory(t));
  let calls = 0;
  store.writeJson(dir, 'persona.json', { format_version: 1, synthetic: true }, {
    synthetic: true, probe: () => { calls += 1; return 'public'; },
  });
  assert.equal(store.readJson(dir, 'persona.json').synthetic, true);
  assert.equal(calls, 0);
});

for (const [name, write] of writers) {
  test(`${name} replaces files by rename with a complete temporary file`, (t) => {
    const dir = temporaryDirectory(t);
    const target = path.join(dir, 'record.jsonl');
    fs.writeFileSync(target, 'previous\n');
    const originalRename = fs.renameSync;
    let renamed = false;
    t.mock.method(fs, 'renameSync', (from, to) => {
      assert.equal(to, target);
      assert.equal(path.dirname(from), dir);
      assert.equal(fs.readFileSync(target, 'utf8'), 'previous\n');
      assert.deepEqual(JSON.parse(fs.readFileSync(from, 'utf8').trim()), { id: 'sample' });
      renamed = true;
      originalRename(from, to);
    });
    // appendJsonl needs a valid previous record; an empty file also tests first append.
    if (name === 'appendJsonl') {
      fs.writeFileSync(target, '');
      t.mock.restoreAll();
      t.mock.method(fs, 'renameSync', (from, to) => {
        assert.equal(to, target);
        assert.equal(path.dirname(from), dir);
        assert.equal(fs.readFileSync(target, 'utf8'), '');
        assert.deepEqual(JSON.parse(fs.readFileSync(from, 'utf8').trim()), { id: 'sample' });
        renamed = true;
        originalRename(from, to);
      });
    }

    write(dir, 'record.jsonl');
    assert.ok(renamed);
    assert.deepEqual(fs.readdirSync(dir), ['record.jsonl']);
  });
}

test('failed atomic replacement preserves the old file and removes the temporary file', (t) => {
  const dir = temporaryDirectory(t);
  store.writeJson(dir, 'record.json', { id: 'old' });
  t.mock.method(fs, 'renameSync', () => { throw new Error('Simulated rename failure'); });

  assert.throws(() => store.writeJson(dir, 'record.json', { id: 'new' }), /Simulated rename failure/);
  assert.deepEqual(store.readJson(dir, 'record.json'), { id: 'old' });
  assert.deepEqual(fs.readdirSync(dir), ['record.json']);
});

test('malformed JSON and JSONL errors name the file without exposing its contents', (t) => {
  const dir = temporaryDirectory(t);
  fs.writeFileSync(path.join(dir, 'record.json'), 'PRIVATE_FILE_CONTENT');
  fs.writeFileSync(path.join(dir, 'pairs.jsonl'), '{}\nPRIVATE_FILE_CONTENT\n');

  for (const read of [() => store.readJson(dir, 'record.json'), () => store.readJsonl(dir, 'pairs.jsonl')]) {
    assert.throws(read, (error) => {
      assert.ok(error.message.includes(dir));
      assert.ok(!error.message.includes('PRIVATE_FILE_CONTENT'));
      return true;
    });
  }
});

test('init creates exactly the required manifest defaults and split', async (t) => {
  const home = path.join(temporaryDirectory(t), 'home');
  const output = createIo({ BUNSHIN_HOME: home });

  assert.equal(await main(['init', 'sample-person'], output.io), 0);
  const dir = path.join(home, 'sample-person');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['persona.json', 'split.json']);
  assert.deepEqual(store.readJson(dir, 'persona.json'), {
    format_version: 1, name: 'sample-person', display_name: 'sample-person', synthetic: false,
    owner: { slack_user_id: null }, version: 0,
    launch_bar: { send_as_is: 0.5, min_heldout: 30, min_per_layer: 10, min_agreement: 0.8 },
    hosts: { claude: { allowed_tools: [] } },
  });
  const split = store.readJson(dir, 'split.json');
  assert.match(split.salt, /^[a-f0-9]{16}$/);
  assert.deepEqual(split, { format_version: 1, salt: split.salt, heldout_ratio: 0.3, assignments: {} });
  assert.match(output.read().stdout, /Created persona sample-person/);
  assert.equal(output.read().stderr, '');
  assert.equal(output.probeCalls(), 0);
});

test('init accepts an empty directory and generates an independent salt for each persona', async (t) => {
  const home = temporaryDirectory(t);
  fs.mkdirSync(path.join(home, 'sample-one'));
  const output = createIo({ BUNSHIN_HOME: home });

  assert.equal(await main(['init', 'sample-one'], output.io), 0);
  assert.equal(await main(['init', 'sample-two'], output.io), 0);
  assert.notEqual(store.readJson(path.join(home, 'sample-one'), 'split.json').salt,
    store.readJson(path.join(home, 'sample-two'), 'split.json').salt);
  assert.equal(output.probeCalls(), 0);
});

test('init refuses non-empty directories without changing existing files', async (t) => {
  const home = temporaryDirectory(t);
  const dir = path.join(home, 'sample-person');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'existing.txt'), 'PRIVATE_FILE_CONTENT');
  const output = createIo({ BUNSHIN_HOME: home });

  assert.equal(await main(['init', 'sample-person'], output.io), 1);
  assert.deepEqual(fs.readdirSync(dir), ['existing.txt']);
  assert.equal(fs.readFileSync(path.join(dir, 'existing.txt'), 'utf8'), 'PRIVATE_FILE_CONTENT');
  assert.match(output.read().stderr, /not empty/);
  assert.ok(!output.read().stderr.includes('PRIVATE_FILE_CONTENT'));
  assert.equal(output.read().stdout, '');
  assert.equal(output.probeCalls(), 0);
});

test('init refuses invalid names and argument counts before writing', async (t) => {
  const home = temporaryDirectory(t);
  for (const args of [[], ['Sample'], ['sample_person'], ['../escape'], ['/absolute'], ['two words'], [''], ['valid', 'extra']]) {
    const output = createIo({ BUNSHIN_HOME: home });
    assert.equal(await main(['init', ...args], output.io), 2);
    assert.match(output.read().stderr, /Usage: bunshin init/);
    assert.equal(output.read().stdout, '');
    assert.equal(output.probeCalls(), 0);
  }
  assert.deepEqual(fs.readdirSync(home), []);
});

for (const verdict of ['public', 'unknown']) {
  test(`init refuses ${verdict} remotes before any write`, async (t) => {
    const repo = createRepo(temporaryDirectory(t));
    const home = path.join(repo, 'new-home');
    const output = createIo({ BUNSHIN_HOME: home }, () => verdict);

    assert.equal(await main(['init', 'sample-person'], output.io), 1);
    assert.ok(!fs.existsSync(home));
    assert.ok(output.read().stderr.includes(repo));
    assert.ok(output.read().stderr.includes(remote));
    assert.equal(output.read().stdout, '');
  });
}

test('init allows private remotes and probes once for both files', async (t) => {
  const repo = createRepo(temporaryDirectory(t));
  let probes = 0;
  const output = createIo({ BUNSHIN_HOME: repo }, () => { probes += 1; return 'private'; });

  assert.equal(await main(['init', 'sample-person'], output.io), 0);
  assert.equal(probes, 1);
  assert.equal(store.readJson(path.join(repo, 'sample-person'), 'persona.json').synthetic, false);
});
