'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const kb = require('../lib/kb');
const store = require('../lib/store');

const sample = path.resolve(__dirname, '../sample/kb/demo');
const manifest = { format_version: 1, name: 'demo', product: 'Cloudberry Lantern', synthetic: true, languages: ['ja'] };
const source = { id: 'S01', kind: 'sheet', label: 'Sample KB checklist', ref: 'https://example.invalid/demo/checklist' };
const valid = '### demo.model.provider\nclaim: 架空のモデルを利用する。\nstatus: verified\nverified: 2026-10-12\nsources: S01#E11\n';

function fixture(t, text = valid) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-kb-test-')));
  t.after(() => { store._resetGuardCache(); fs.rmSync(home, { recursive: true, force: true }); });
  const dir = kb.resolve({ name: 'demo', env: { BUNSHIN_HOME: home } });
  store.writeJson(dir, 'kb.json', manifest, { synthetic: true });
  store.writeJsonl(dir, 'sources.jsonl', [source], { synthetic: true });
  store.writeText(dir, 'entries/model.md', text, { synthetic: true });
  return { dir, home };
}

test('resolve uses the configured KB home and rejects unsafe or absent names', (t) => {
  const { home, dir } = fixture(t);
  assert.equal(dir, path.join(store.kbHome({ BUNSHIN_HOME: home }), 'demo'));
  assert.ok(path.isAbsolute(dir));
  for (const name of ['0-demo', 'demo-2', 'a']) {
    assert.equal(kb.resolve({ name, env: { BUNSHIN_HOME: home } }), path.join(home, 'kb', name));
  }
  for (const name of [undefined, null, 2, '', '../demo', '/demo', 'Demo', 'demo_name', 'a/b', 'a\\b', 'a\n']) {
    assert.throws(() => kb.resolve({ name, env: { BUNSHIN_HOME: home } }), /name/i);
  }
});

test('sample KB has four entries with complete fields and original heading lines', () => {
  const result = kb.load(sample);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.manifest, manifest);
  assert.deepEqual(result.entries, [
    { id: 'demo.model.provider', topic: 'model', file: 'entries/model.md', line: 3,
      claim: 'Cloudberry Lantern は架空のモデル「灯り」を利用する。', status: 'verified', verified: '2026-10-12',
      sources: [{ source: 'S01', anchor: 'E11' }, { source: 'S02', anchor: 'model' }],
      select: { 利用AI: '灯り', 提供元国: '架空国' }, note: 'サンプルの承認済み項目。' },
    { id: 'demo.model.region', topic: 'model', file: 'entries/model.md', line: 11,
      claim: 'Cloudberry Lantern の処理地域は架空の北地域を予定している。', status: 'draft', verified: null,
      sources: [{ source: 'S01', anchor: 'E12' }], select: {}, note: null },
    { id: 'demo.model.retention', topic: 'model', file: 'entries/model.md', line: 16,
      claim: '保持期間について、資料には７日と１４日の異なる記載がある。', status: 'conflict', verified: null,
      sources: [{ source: 'S01', anchor: 'E13' }, { source: 'S02', anchor: 'retention' }],
      select: {}, note: 'サンプルの不一致を確認する。' },
    { id: 'demo.model.legacy', topic: 'model', file: 'entries/model.md', line: 22,
      claim: '旧モデル「小灯り」の利用は終了した。', status: 'retired', verified: null,
      sources: [{ source: 'S02', anchor: 'legacy' }], select: {}, note: null },
  ]);
  assert.ok(result.sources instanceof Map);
  assert.ok(result.flags instanceof Map);
  assert.equal(result.flags.size, 0);
  assert.equal(result.sources.size, 2);
  for (const row of result.sources.values()) assert.equal(new URL(row.ref).origin, 'https://example.invalid');
  for (const entry of result.entries) {
    for (const ref of entry.sources) assert.ok(result.sources.has(ref.source));
  }
});

const malformed = [
  ['missing claim', valid.replace('claim: 架空のモデルを利用する。\n', ''), 1, /claim/],
  ['bad id', valid.replace('demo.model.provider', 'demo.Model.provider'), 1, /id/],
  ['duplicate id', valid + valid, 6, /duplicate.*id/i],
  ['unknown key', valid + 'extra: value\n', 6, /unknown.*key/i],
  ['verified without date', valid.replace('verified: 2026-10-12\n', ''), 1, /verified/],
  ['empty sources', valid.replace('sources: S01#E11', 'sources:'), 5, /sources/],
];
for (const [label, text, line, message] of malformed) {
  test(`${label} yields exactly one located parse error`, (t) => {
    const result = kb.load(fixture(t, text).dir);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].file, 'entries/model.md');
    assert.equal(result.errors[0].line, line);
    assert.match(result.errors[0].message, message);
  });
}

test('comments preserve source anchors and single-space hashes; headings end entries', (t) => {
  const text = '# Sample KB\r\n\r\n' + valid.replace(/\n/g, '\r\n')
    .replace('status: verified', 'status: verified  # reviewed')
    .replace('sources: S01#E11', 'sources: S01#E11, S01#1780000000.000001  # evidence')
    + 'select: result=a=b; 地域=北  # canonical\r\nnote: keep # hash  # remove\r\n'
    + '## Other topic\r\nUnstructured introductory text.\r\n';
  const result = kb.load(fixture(t, text).dir);
  assert.deepEqual(result.errors, []);
  assert.equal(result.entries[0].line, 3);
  assert.deepEqual(result.entries[0].select, { result: 'a=b', 地域: '北' });
  assert.equal(result.entries[0].note, 'keep # hash');
  assert.deepEqual(result.entries[0].sources, [{ source: 'S01', anchor: 'E11' }, { source: 'S01', anchor: '1780000000.000001' }]);
});

test('entries load in filename order and duplicate ids are detected across files', (t) => {
  const { dir } = fixture(t);
  store.writeText(dir, 'entries/alpha.md', valid.replace('demo.model.provider', 'demo.alpha.first'), { synthetic: true });
  let result = kb.load(dir);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.entries.map((entry) => entry.topic), ['alpha', 'model']);
  store.writeText(dir, 'entries/alpha.md', valid, { synthetic: true });
  result = kb.load(dir);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].file, 'entries/model.md');
  assert.equal(result.errors[0].line, 1);
  assert.match(result.errors[0].message, /duplicate.*id/i);
});

test('JSONL errors are collected and latest flag row wins in append order', (t) => {
  const { dir } = fixture(t);
  const latest = { id: 'demo.model.provider', reason: 'review again', at: '2026-10-11' };
  store.writeText(dir, 'flags.jsonl', `${JSON.stringify({ ...latest, reason: 'old', at: '2026-10-12' })}\nnot json\n${JSON.stringify(latest)}\n`, { synthetic: true });
  store.writeText(dir, 'sources.jsonl', `${JSON.stringify(source)}\n{broken\n\n`, { synthetic: true });
  const result = kb.load(dir);
  assert.equal(result.sources.get('S01').ref, source.ref);
  assert.deepEqual(result.flags.get(latest.id), latest);
  assert.deepEqual(result.errors.map(({ file, line }) => ({ file, line })), [
    { file: 'sources.jsonl', line: 2 }, { file: 'flags.jsonl', line: 2 },
  ]);
});

test('invalid fields and malformed lines are located without cascading missing-field errors', (t) => {
  for (const [from, to, line, message] of [
    ['status: verified', 'status: unknown', 3, /status/],
    ['verified: 2026-10-12', 'verified: 2026-02-30', 4, /verified/],
    ['sources: S01#E11', 'sources: S01', 5, /sources/],
    ['claim: 架空のモデルを利用する。', 'claim:', 2, /claim/],
  ]) {
    const result = kb.load(fixture(t, valid.replace(from, to)).dir);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].line, line);
    assert.match(result.errors[0].message, message);
  }
  for (const text of [valid + 'not a field\n', valid + 'claim: second\n', valid + 'select: no equals\n']) {
    const result = kb.load(fixture(t, text).dir);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].line, 6);
  }
});

test('invalid manifest JSON is collected rather than thrown', (t) => {
  const { dir } = fixture(t);
  store.writeText(dir, 'kb.json', '{broken\n', { synthetic: true });
  const result = kb.load(dir);
  assert.equal(result.manifest, null);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].file, 'kb.json');
  assert.equal(result.errors[0].line, 1);
  assert.equal(result.entries.length, 1);
});

test('loader reads only sample data or isolated fixtures, never the real home', (t) => {
  const { dir, home } = fixture(t);
  const read = fs.readFileSync;
  const paths = [];
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    const absolute = path.resolve(file);
    assert.ok(absolute.startsWith(`${sample}${path.sep}`) || absolute.startsWith(`${home}${path.sep}`), absolute);
    paths.push(absolute);
    return read(file, ...args);
  });
  assert.deepEqual(kb.load(sample).errors, []);
  assert.deepEqual(kb.load(dir).errors, []);
  assert.ok(paths.length >= 6);
});
