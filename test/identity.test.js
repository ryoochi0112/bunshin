'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { Readable } = require('node:stream');
const test = require('node:test');
const store = require('../lib/store');
const identity = require('../lib/identity');
const { main } = require('../bin/bunshin');

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-identity-')));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); store._resetGuardCache(); });
  store.writeJson(dir, 'persona.json', {
    format_version: 1, name: 'sample', display_name: 'Sample Person', synthetic: true, version: 0,
  }, { synthetic: true });
  store.writeJsonl(dir, 'pairs.jsonl', ['build-one', 'heldout-one', 'unassigned-one'].map((id) => ({
    id, source: 'manual', permalink: `https://fiction.invalid/${id}`, channel: 'sample-channel',
    asked_at: '2026-01-01T00:00:00Z', harvested_at: '2026-01-01T00:00:00Z',
    layer: 'judgment', layer_source: 'manual', question: { author: 'sample-colleague', text: 'Sample question?' },
    context: [], answer: { text: 'Sample answer.' },
  })));
  store.writeJson(dir, 'split.json', {
    format_version: 1, salt: 'sample', heldout_ratio: 0.3,
    assignments: { 'build-one': 'build', 'heldout-one': 'heldout', 'unassigned-one': 'build' },
  });
  store.writeJsonl(dir, 'interview.jsonl', [{ id: 'iv-0001' }, { id: 'iv-0002' }]);
  store.writeJsonl(dir, 'conflicts.jsonl', [
    { id: 'cf-0001', status: 'open', interview_ref: 'iv-0001' },
    { id: 'cf-0002', status: 'resolved', interview_ref: 'iv-0002' },
  ]);
  return dir;
}

function draft() {
  const pair = { type: 'pair', ref: 'build-one', permalink: 'https://fiction.invalid/build-one' };
  return {
    format_version: 1, persona: 'sample', version: 0, built_at: '2026-01-01T00:00:00Z',
    voice: [{ id: 'voice-one', statement: 'Be concise.', evidence: [pair] }],
    priorities: [{ id: 'priority-one', name: 'Clarity', statement: 'Explain decisions.', evidence: [{ type: 'interview', ref: 'iv-0002' }], conflict: 'cf-0002' }],
    objections: [{ id: 'objection-one', statement: 'Ask for the reason.', priority: 'priority-one', evidence: [pair] }],
    context_rules: [{ id: 'context-one', statement: 'Give context.', evidence: [pair] }],
  };
}

function snapshot(dir) {
  return Object.fromEntries(['identity.json', 'identity.md', 'persona.json'].map((file) => {
    try { return [file, fs.readFileSync(path.join(dir, file), 'utf8')]; } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return [file, null];
    }
  }));
}

async function cli(dir, args, stdin = '') {
  let stdout = '';
  let stderr = '';
  const code = await main(['identity', ...args, '--persona', dir], {
    stdin, env: {}, stdout: { write: (text) => { stdout += text; } },
    stderr: { write: (text) => { stderr += text; } },
  });
  return { code, stdout, stderr };
}

test('validation accepts build and resolved interview evidence; reports all evidence errors together', (t) => {
  const dir = fixture(t);
  assert.deepEqual(identity.validate(dir, draft()), { ok: true, errors: [] });
  const invalid = draft();
  invalid.voice = [
    { id: 'empty', statement: 'Secret trait text.', evidence: [] },
    { id: 'unknown-pair', statement: 'Sample.', evidence: [{ type: 'pair', ref: 'missing' }] },
    { id: 'heldout', statement: 'Sample.', evidence: [{ type: 'pair', ref: 'heldout-one' }] },
    { id: 'unknown-interview', statement: 'Sample.', evidence: [{ type: 'interview', ref: 'iv-9999' }] },
    { id: 'open-conflict', statement: 'Sample.', evidence: draft().voice[0].evidence, conflict: 'cf-0001' },
    { id: 'open-interview', statement: 'Sample.', evidence: [{ type: 'interview', ref: 'iv-0001' }] },
    { id: 'missing-conflict', statement: 'Sample.', evidence: draft().voice[0].evidence, conflict: 'cf-9999' },
  ];
  invalid.objections[0].priority = 'missing';
  invalid.context_rules[0].id = 'priority-one';
  const result = identity.validate(dir, invalid);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 9);
  assert.deepEqual(result.errors.map((error) => error.trait), [
    'empty', 'unknown-pair', 'heldout', 'unknown-interview', 'open-conflict',
    'open-interview', 'missing-conflict', 'objection-one', 'priority-one',
  ]);
  assert.match(result.errors[0].message, /Evidence must not be empty/);
  assert.match(result.errors[1].message, /unknown or non-build pair/);
  assert.match(result.errors[2].message, /held-out pair/);
  assert.match(result.errors[3].message, /unknown interview/);
  assert.match(result.errors[4].message, /Conflict is open/);
  assert.match(result.errors[5].message, /open conflict/);
  assert.match(result.errors[6].message, /Unknown conflict/);
  assert.match(result.errors[7].message, /existing priority id/);
  assert.match(result.errors[8].message, /Duplicate trait id/);
  assert.doesNotMatch(JSON.stringify(result), /Secret trait text/);
});

test('malformed traits, evidence and schema fail closed without leaking text', (t) => {
  const dir = fixture(t);
  for (const value of [null, [], 'secret']) assert.equal(identity.validate(dir, value).ok, false);
  const value = draft();
  value.format_version = 2;
  value.persona = 'wrong';
  value.voice = [null, { id: 'secret\ntext', evidence: [null, { type: 'unknown', ref: 'secret' }] }];
  value.priorities[0].name = '';
  value.context_rules = null;
  const result = identity.validate(dir, value);
  assert.equal(result.ok, false);
  assert.doesNotMatch(JSON.stringify(result.errors), /secret/);
  const mismatched = draft();
  mismatched.voice[0].evidence[0].permalink = 'https://secret:password@fiction.invalid/';
  assert.match(identity.validate(dir, mismatched).errors[0].message, /permalink does not match/);
});

test('render has deterministic Markdown and preserves trait and evidence order', () => {
  const value = draft();
  value.display_name = 'Sample Person';
  value.voice.push({ id: 'voice-two', statement: 'Be direct.', evidence: [{ type: 'interview', ref: 'iv-0002' }] });
  const expected = '# Sample Person — identity v0\n\n## Voice\n\n'
    + '- Be concise.\n  - [build-one](https://fiction.invalid/build-one)\n'
    + '- Be direct.\n  - [iv-0002](interview.jsonl#iv-0002)\n'
    + '\n## Priorities\n\n- Explain decisions.\n  - [iv-0002](interview.jsonl#iv-0002)\n'
    + '\n## Typical objections\n\n- Ask for the reason.\n  - [build-one](https://fiction.invalid/build-one)\n'
    + '\n## Context rules\n\n- Give context.\n  - [build-one](https://fiction.invalid/build-one)\n';
  assert.equal(identity.render(value), expected);
  assert.equal(identity.render(JSON.parse(JSON.stringify(value))), expected);
});

test('CLI accepts files and string/stream stdin; commit increments versions; show renders source of truth', async (t) => {
  const dir = fixture(t);
  const value = draft();
  const input = path.join(dir, 'draft.json');
  store.writeJson(dir, 'draft.json', value);
  assert.equal((await cli(dir, ['validate', input])).code, 0);
  assert.equal((await cli(dir, ['validate', '-'], Readable.from([JSON.stringify(value)]))).code, 0);
  assert.equal((await cli(dir, ['commit', '-'], JSON.stringify(value))).code, 0);
  const committed = store.readJson(dir, 'identity.json');
  assert.equal(committed.version, 1);
  assert.equal(store.readJson(dir, 'persona.json').version, 1);
  assert.ok(Number.isFinite(Date.parse(committed.built_at)));
  const markdown = identity.render({ ...committed, display_name: 'Sample Person' });
  assert.equal(fs.readFileSync(path.join(dir, 'identity.md'), 'utf8'), markdown);
  assert.deepEqual(await cli(dir, ['show']), { code: 0, stdout: markdown, stderr: '' });
  assert.equal((await cli(dir, ['commit', input])).code, 0);
  assert.equal(store.readJson(dir, 'identity.json').version, 2);
  assert.equal(store.readJson(dir, 'persona.json').version, 2);
  assert.equal(value.version, 0);
});

test('CLI invalid drafts write nothing and report trait ids; malformed input and usage return errors', async (t) => {
  const dir = fixture(t);
  const before = snapshot(dir);
  const value = draft();
  value.voice[0].evidence = [];
  value.objections[0].priority = 'missing';
  for (const action of ['validate', 'commit']) {
    const result = await cli(dir, [action, '-'], JSON.stringify(value));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /voice-one: Evidence/);
    assert.match(result.stderr, /objection-one: Objection/);
    assert.equal(result.stdout, '');
    assert.deepEqual(snapshot(dir), before);
  }
  const malformed = await cli(dir, ['commit', '-'], '{secret draft text');
  assert.equal(malformed.code, 1);
  assert.equal(malformed.stderr, 'Invalid identity draft JSON.\n');
  assert.equal((await cli(dir, ['validate', path.join(dir, 'missing.json')])).code, 1);
  for (const args of [[], ['show', '-'], ['commit'], ['validate', '-', 'extra'], ['unknown'], ['show', '--persona', dir]]) {
    assert.equal((await cli(dir, args)).code, 2);
  }
  assert.equal((await cli(dir, ['show'])).code, 1);
  assert.deepEqual(snapshot(dir), before);
});

for (const existing of [false, true]) {
  for (const failingFile of ['identity.md', 'persona.json']) {
    test(`failure writing ${failingFile} restores ${existing ? 'existing' : 'absent'} identity files byte for byte`, (t) => {
      const dir = fixture(t);
      if (existing) identity.commit(dir, draft());
      const before = snapshot(dir);
      const method = failingFile === 'identity.md' ? 'writeText' : 'writeJson';
      const original = store[method];
      let failures = 0;
      store[method] = (...args) => {
        if (args[1] === failingFile) { failures += 1; throw new Error('Injected write failure.'); }
        return original(...args);
      };
      try { assert.throws(() => identity.commit(dir, draft()), /Injected write failure/); } finally { store[method] = original; }
      assert.equal(failures, 1);
      assert.deepEqual(snapshot(dir), before);
      assert.equal(fs.existsSync(path.join(dir, '.identity-transaction.json')), false);
      assert.equal(identity.commit(dir, draft()).version, existing ? 2 : 1);
    });
  }
}

test('interrupted commit recovers on the next store read and retry increments only once', (t) => {
  const dir = fixture(t);
  identity.commit(dir, draft());
  const before = snapshot(dir);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  env.HOME = dir;
  env.XDG_CONFIG_HOME = dir;
  const child = spawnSync(process.execPath, ['-e', `
    const store = require('./lib/store');
    const identity = require('./lib/identity');
    const original = store.writeJson;
    store.writeJson = (...args) => {
      original(...args);
      if (args[1] === 'persona.json') process.exit(73);
    };
    identity.commit(process.argv[1], JSON.parse(process.argv[2]));
  `, dir, JSON.stringify(draft())], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' });
  assert.equal(child.status, 73, child.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'persona.json'), 'utf8')).version, 2);
  // The dead process's lock is stale, so the next read recovers instead of waiting.
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.identity.lock'), 'utf8')).pid, child.pid);
  // Recover in a fresh process: its guard cache is empty, as for every CLI call.
  const reader = spawnSync(process.execPath, ['-e', `
    process.stdout.write(String(require('./lib/store').readJson(process.argv[1], 'persona.json').version));
  `, dir], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' });
  assert.equal(reader.status, 0, reader.stderr);
  assert.equal(reader.stdout, '1');
  assert.equal(fs.existsSync(path.join(dir, '.identity-transaction.json')), false);
  assert.equal(fs.existsSync(path.join(dir, '.identity.lock')), false);
  assert.equal(store.readJson(dir, 'persona.json').version, 1);
  assert.deepEqual(snapshot(dir), before);
  assert.equal(identity.commit(dir, draft()).version, 2);
});

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

test('a read in another process during an identity commit waits and never rolls the commit back', async (t) => {
  const dir = fixture(t);
  identity.commit(dir, draft());
  const changed = draft();
  changed.voice[0].statement = 'Be very concise.';
  const marker = path.join(dir, '.reader-saw-journal');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  env.HOME = dir;
  env.XDG_CONFIG_HOME = dir;
  let reader;
  let stdout = '';
  const original = store.writeText;
  // Between identity.json and identity.md, start a reader that sees the live journal.
  t.mock.method(store, 'writeText', (...args) => {
    if (args[1] === 'identity.md' && !reader) {
      reader = spawn(process.execPath, ['-e', `
        const fs = require('node:fs');
        const path = require('node:path');
        const store = require('./lib/store');
        const [dir, marker] = process.argv.slice(1);
        while (!fs.existsSync(path.join(dir, '.identity-transaction.json'))) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
        fs.writeFileSync(marker, '');
        process.stdout.write(store.readJson(dir, 'identity.json').voice[0].statement);
      `, dir, marker], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'inherit'] });
      reader.stdout.on('data', (chunk) => { stdout += chunk; });
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(marker) && Date.now() < deadline) sleep(10);
      assert.equal(fs.existsSync(marker), true);
      sleep(300);
    }
    return original(...args);
  });
  assert.equal(identity.commit(dir, changed).version, 2);
  const [code] = await once(reader, 'close');
  assert.equal(code, 0);
  assert.equal(stdout, 'Be very concise.');
  assert.equal(store.readJson(dir, 'identity.json').voice[0].statement, 'Be very concise.');
  assert.match(fs.readFileSync(path.join(dir, 'identity.md'), 'utf8'), /Be very concise\./);
  assert.equal(store.readJson(dir, 'persona.json').version, 2);
  assert.equal(fs.existsSync(path.join(dir, '.identity-transaction.json')), false);
  assert.equal(fs.existsSync(path.join(dir, '.identity.lock')), false);
});

test('pre-commit hooks run before writes and a refusal leaves all files unchanged', (t) => {
  const dir = fixture(t);
  const before = snapshot(dir);
  const previous = identity.preCommitChecks;
  let calls = 0;
  let received;
  identity.preCommitChecks = [(personaDir, value) => {
    calls += 1;
    received = { personaDir, version: value.version };
    return { ok: false };
  }];
  try { assert.throws(() => identity.commit(dir, draft()), /pre-commit check failed/); } finally { identity.preCommitChecks = previous; }
  assert.equal(calls, 1);
  assert.deepEqual(received, { personaDir: dir, version: 1 });
  assert.deepEqual(snapshot(dir), before);
});

test('malformed recovery journals refuse reads and writes without exposing journal contents', (t) => {
  const dir = fixture(t);
  const before = snapshot(dir);
  for (const journal of ['secret journal text', JSON.stringify([
    { path: '../outside', text: 'secret journal text' },
    { path: 'identity.md', text: null }, { path: 'persona.json', text: null },
  ])]) {
    fs.writeFileSync(path.join(dir, '.identity-transaction.json'), journal);
    assert.throws(() => store.readJson(dir, 'persona.json'), /^Error: Invalid identity transaction journal\.$/);
    assert.throws(() => identity.commit(dir, draft()), /^Error: Invalid identity transaction journal\.$/);
    assert.deepEqual(snapshot(dir), before);
    fs.unlinkSync(path.join(dir, '.identity-transaction.json'));
  }
});

test('a failed rollback keeps the journal and refuses state until recovery succeeds', (t) => {
  const dir = fixture(t);
  identity.commit(dir, draft());
  const before = snapshot(dir);
  const original = fs.renameSync;
  let failures = 0;
  fs.renameSync = (from, to) => {
    if (to === path.join(dir, 'identity.md')) {
      failures += 1;
      throw new Error('Injected persistent rename failure.');
    }
    return original(from, to);
  };
  try {
    assert.throws(() => identity.commit(dir, draft()), /persistent rename failure/);
    assert.equal(fs.existsSync(path.join(dir, '.identity-transaction.json')), true);
    assert.throws(() => store.readJson(dir, 'persona.json'), /persistent rename failure/);
  } finally { fs.renameSync = original; }
  assert.equal(failures, 3);
  assert.equal(store.readJson(dir, 'persona.json').version, 1);
  assert.deepEqual(snapshot(dir), before);
  assert.equal(identity.commit(dir, draft()).version, 2);
});
