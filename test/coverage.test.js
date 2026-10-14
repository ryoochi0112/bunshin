'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const store = require('../lib/store');
const kb = require('../lib/kb');
const coverage = require('../lib/coverage');
const { main } = require('../bin/bunshin');

const root = path.join(__dirname, '..');
const rows = [
  { id: 'sample-10', coverage: 'C', entries: ['demo.model.provider'] },
  { id: 'sample-12', coverage: 'N' },
];

function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-coverage-')));
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); store._resetGuardCache(); });
  const dir = path.join(home, 'sample');
  fs.cpSync(path.join(root, 'sample', 'persona'), dir, { recursive: true });
  store.writeJson(dir, 'persona.json', { ...store.readJson(dir, 'persona.json'), kb: 'demo' });
  const env = { BUNSHIN_HOME: home };
  const kbDir = kb.resolve({ name: 'demo', env });
  for (const file of ['kb.json', 'sources.jsonl', 'entries/model.md']) {
    store.writeText(kbDir, file, fs.readFileSync(path.join(root, 'sample', 'kb', 'demo', file), 'utf8'), { synthetic: true });
  }
  const file = path.join(home, 'labels.json');
  return { home, dir, kbDir, env, file };
}

function input(file, cases = rows) {
  fs.writeFileSync(file, JSON.stringify({ cases, method: 'Ignored synthetic metadata' }));
}

function snapshot(dir) {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath ?? entry.path, entry.name))).sort()
    .map((file) => [file, fs.readFileSync(path.join(dir, file)).toString('hex')]);
}

async function cli(argv, env) {
  let stdout = '';
  let stderr = '';
  const code = await main(['coverage', ...argv], { env,
    stdout: { write(text) { stdout += text; } }, stderr: { write(text) { stderr += text; } },
  });
  return { code, stdout, stderr };
}

test('coverage import pins the bound digest, ignores extra keys and show reports counts', async (t) => {
  const { dir, env, file } = fixture(t);
  assert.deepEqual(coverage.LABELS, ['C', 'P', 'N', 'X']);
  assert.equal(coverage.read(dir), null);
  assert.deepEqual(await cli(['show'], env), { code: 0, stdout: 'No coverage labels\n', stderr: '' });
  input(file, rows.map((row) => ({ ...row, note: 'Ignored row metadata' })));
  const before = snapshot(dir);
  const imported = await cli(['import', file, '--persona', dir], env);
  assert.deepEqual(imported, { code: 0,
    stdout: 'Imported 2 labels (C 1 · P 0 · N 1 · X 0) for kb demo\n', stderr: '' });
  const value = coverage.read(dir);
  assert.ok(Number.isFinite(Date.parse(value.imported_at)));
  assert.deepEqual(value, { format_version: 1, kb: 'demo', kb_digest_hash: kb.loadBound(dir, env).digest.hash,
    imported_at: value.imported_at, cases: {
      'sample-10': { coverage: 'C', entries: ['demo.model.provider'] },
      'sample-12': { coverage: 'N', entries: [] },
    } });
  assert.deepEqual(snapshot(dir).filter(([file]) => file !== 'coverage.json'), before);
  const shown = await cli(['show', '--persona', dir], env);
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /2 labels \(C 1 · P 0 · N 1 · X 0\) for kb demo/);
  assert.ok(shown.stdout.includes(`kb digest ${value.kb_digest_hash}`));
  assert.ok(!shown.stdout.includes('stale'));
  input(file, [{ id: 'sample-10', coverage: 'P' }, { id: 'sample-13', coverage: 'X' }]);
  assert.deepEqual(coverage.importFile(dir, file, { env }), { count: 2, labels: { C: 0, P: 1, N: 0, X: 1 } });
});

test('every invalid import row refuses with its index and leaves existing persona bytes intact', async (t) => {
  const { dir, env, file, kbDir } = fixture(t);
  input(file);
  coverage.importFile(dir, file, { env });
  for (const row of [
    { id: 'sample-12', coverage: 'bad' },
    { id: 'sample-01', coverage: 'C' },
    { id: 'unknown-case', coverage: 'C' },
    rows[0],
    ...['unknown.entry.id', 'demo.model.region', 'demo.model.retention', 'demo.model.legacy']
      .map((id) => ({ id: 'sample-12', coverage: 'P', entries: [id] })),
    { id: 'sample-12', coverage: 'C', entries: 'demo.model.provider' },
    { id: 'sample-12', coverage: 'C', entries: [null] },
    null,
  ]) {
    input(file, [rows[0], row]);
    const before = snapshot(dir);
    const result = await cli(['import', file], env);
    assert.equal(result.code, 1, JSON.stringify(row));
    assert.match(result.stderr, /row 2/i);
    assert.deepEqual(snapshot(dir), before);
  }
  store.writeJsonl(kbDir, 'flags.jsonl', [{ id: 'demo.model.provider', flagged: true }], { synthetic: true });
  input(file, [rows[1], { id: 'sample-13', coverage: 'C', entries: ['demo.model.provider'] }]);
  const before = snapshot(dir);
  const result = await cli(['import', file], env);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /row 2/i);
  assert.deepEqual(snapshot(dir), before);
  store.writeJsonl(kbDir, 'flags.jsonl', [{ id: 'demo.model.provider', flagged: false }], { synthetic: true });
  assert.equal((await cli(['import', file], env)).code, 0);
});

test('unbound, broken KB, missing files and malformed input fail closed without writes', async (t) => {
  const { dir, env, file, kbDir } = fixture(t);
  input(file);
  const manifest = store.readJson(dir, 'persona.json');
  const { kb: _kb, ...unbound } = manifest;
  store.writeJson(dir, 'persona.json', unbound);
  let before = snapshot(dir);
  let result = await cli(['import', file], env);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /row 1.*bound KB/i);
  assert.deepEqual(snapshot(dir), before);
  store.writeJson(dir, 'persona.json', manifest);
  for (const text of ['null', '{}', '{"cases":{}}', 'invalid JSON']) {
    fs.writeFileSync(file, text);
    before = snapshot(dir);
    result = await cli(['import', file], env);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /row 1/i);
    assert.deepEqual(snapshot(dir), before);
  }
  fs.unlinkSync(file);
  before = snapshot(dir);
  assert.equal((await cli(['import', file], env)).code, 1);
  assert.deepEqual(snapshot(dir), before);
  input(file);
  fs.unlinkSync(path.join(kbDir, 'sources.jsonl'));
  before = snapshot(dir);
  assert.equal((await cli(['import', file], env)).code, 1);
  assert.deepEqual(snapshot(dir), before);
});

test('show marks a changed bound digest stale and fails if the binding cannot be checked', async (t) => {
  const { dir, env, file, kbDir } = fixture(t);
  input(file);
  coverage.importFile(dir, file, { env });
  const text = fs.readFileSync(path.join(kbDir, 'entries/model.md'), 'utf8');
  store.writeText(kbDir, 'entries/model.md', text.replace('利用AI=灯り', '利用AI=架空の新灯り'), { synthetic: true });
  const shown = await cli(['show'], env);
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /stale/);
  const { kb: _kb, ...manifest } = store.readJson(dir, 'persona.json');
  store.writeJson(dir, 'persona.json', manifest);
  assert.equal((await cli(['show'], env)).code, 1);
});

test('read rejects malformed persisted coverage instead of treating it as absent', (t) => {
  const { dir, env, file } = fixture(t);
  input(file);
  coverage.importFile(dir, file, { env });
  const valid = coverage.read(dir);
  for (const value of [null, [], {},
    ...['format_version', 'kb', 'kb_digest_hash', 'imported_at', 'cases'].map((key) => {
      const copy = { ...valid }; delete copy[key]; return copy;
    }),
    { ...valid, format_version: 2 }, { ...valid, kb: '../demo' },
    { ...valid, kb_digest_hash: 'bad' }, { ...valid, imported_at: 'bad' },
    { ...valid, cases: [] }, { ...valid, cases: { 'sample-10': { coverage: 'bad', entries: [] } } },
    { ...valid, cases: { 'sample-10': { coverage: 'C' } } },
    { ...valid, cases: { 'sample-10': { coverage: 'C', entries: [null] } } },
  ]) {
    store.writeJson(dir, 'coverage.json', value);
    assert.throws(() => coverage.read(dir), /Invalid coverage/);
  }
  store.writeText(dir, 'coverage.json', '{bad');
  assert.throws(() => coverage.read(dir), /Invalid JSON/);
});

test('hash is SHA256 truncated to 16 hex over recursively sorted JSON keys', () => {
  const canonical = '{"a":[{"a":1,"z":2}],"z":3}';
  const expected = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  assert.equal(coverage.hash({ z: 3, a: [{ z: 2, a: 1 }] }), expected);
  assert.equal(coverage.hash({ a: [{ a: 1, z: 2 }], z: 3 }), expected);
  assert.notEqual(coverage.hash(['C', 'P']), coverage.hash(['P', 'C']));
});

test('strict command usage rejects unknown, repeated and missing options', async () => {
  for (const argv of [[], ['other'], ['import'], ['show', 'extra'], ['show', '--persona'],
    ['show', '--unknown'], ['show', '--persona', 'x', '--persona', 'y'],
    ['import', '--persona', 'x'], ['import', 'x', 'extra']]) {
    const result = await cli(argv, {});
    assert.equal(result.code, 2, JSON.stringify(argv));
    assert.match(result.stderr, /Usage: bunshin coverage/);
  }
  assert.equal((await cli(['--help'], {})).code, 0);
});

test('import refuses an escaping coverage path without changing persona bytes or the target', async (t) => {
  const { dir, env, file, home } = fixture(t);
  input(file);
  const target = path.join(home, 'outside.json');
  fs.writeFileSync(target, 'untouched');
  fs.symlinkSync(target, path.join(dir, 'coverage.json'));
  const before = snapshot(dir);
  assert.equal((await cli(['import', file], env)).code, 1);
  assert.deepEqual(snapshot(dir), before);
  assert.equal(fs.readFileSync(target, 'utf8'), 'untouched');
});
