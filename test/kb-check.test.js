'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const kb = require('../lib/kb');
const kbCheck = require('../lib/kb-check');
const guard = require('../lib/guard');
const { normalize } = require('../lib/leak');
const store = require('../lib/store');

const sample = path.resolve(__dirname, '../sample/kb/demo');
const manifest = { format_version: 1, name: 'demo', product: 'Cloudberry Lantern', synthetic: true, languages: ['ja'] };
const source = { id: 'S01', kind: 'sheet', label: 'Sample KB checklist', ref: 'https://example.invalid/demo/checklist' };
const valid = '### demo.model.provider\nclaim: 架空のモデルを利用する。\nstatus: verified\nverified: 2026-10-12\nsources: S01#E11\n';
const remote = 'https://code.example.invalid/fictional/kb.git';
const writeOptions = { synthetic: true };

function temporaryDirectory(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-kb-check-')));
  t.after(() => { store._resetGuardCache(); fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

function fixture(t, text = valid) {
  const home = temporaryDirectory(t);
  const dir = kb.resolve({ name: 'demo', env: { BUNSHIN_HOME: home } });
  store.writeJson(dir, 'kb.json', manifest, writeOptions);
  store.writeJsonl(dir, 'sources.jsonl', [source], writeOptions);
  store.writeText(dir, 'entries/model.md', text, writeOptions);
  return { home, dir };
}

function scrub(dir, text = 'LumaClient\n') {
  store.writeText(path.dirname(dir), `${path.basename(dir)}.scrub.txt`, text, writeOptions);
}

function finding(result, name, privateText = 'LumaClient') {
  assert.equal(result.ok, false);
  const matches = result.findings.filter((item) => item.name === name);
  assert.ok(matches.length, JSON.stringify(result));
  const serialized = JSON.stringify(result.findings);
  assert.ok(!normalize(serialized).includes(normalize(privateText)), serialized);
  for (const item of result.findings) {
    assert.equal(typeof item.name, 'string');
    assert.equal(typeof item.message, 'string');
  }
  return matches;
}

// Use the guard tests' local Git and fake-probe approach, with isolated config.
function git(dir, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return childProcess.execFileSync('git', ['-C', dir, ...args], {
    cwd: dir, env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, stdio: 'pipe',
  });
}

function createRepo(dir, url) {
  git(dir, 'init', '--quiet');
  git(dir, 'remote', 'add', 'origin', url);
  return dir;
}

function withEnvironment(values, run) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, values);
    return run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function isolatedGit(home, run) {
  const configHome = path.join(home, 'git-home');
  const xdg = path.join(home, 'xdg');
  fs.mkdirSync(configHome);
  fs.mkdirSync(xdg);
  return withEnvironment({ HOME: configHome, XDG_CONFIG_HOME: xdg }, run);
}

test('sample KB passes with no findings or remote probes', () => {
  assert.deepEqual(kbCheck.run(sample, { probe: () => assert.fail('Synthetic sample must not probe.') }), { ok: true, findings: [] });
});

for (const [label, text, line] of [
  ['missing claim', valid.replace('claim: 架空のモデルを利用する。\n', ''), 1],
  ['invalid id', valid.replace('demo.model.provider', 'demo.Model.provider'), 1],
  ['duplicate id', valid + valid, 6],
  ['verified without date', valid.replace('verified: 2026-10-12\n', ''), 1],
]) {
  test(`${label} reports a located parse finding`, (t) => {
    const { dir } = fixture(t, text);
    const [item] = finding(kbCheck.run(dir), 'parse');
    assert.equal(item.file, 'entries/model.md');
    assert.equal(item.line, line);
  });
}

for (const [file, text] of [['kb.json', '{broken\n'], ['sources.jsonl', '{broken\n'], ['flags.jsonl', '{broken\n']]) {
  test(`malformed ${file} reports a parse finding without throwing`, (t) => {
    const { dir } = fixture(t);
    store.writeText(dir, file, text, writeOptions);
    const items = finding(kbCheck.run(dir), 'parse');
    assert.ok(items.some((item) => item.file === file && item.line === 1));
  });
}

test('unknown source reference identifies its entry and source registry id', (t) => {
  const { dir } = fixture(t, valid.replace('S01#E11', 'S99#E11'));
  const [item] = finding(kbCheck.run(dir), 'source-ref');
  assert.match(item.message, /demo\.model\.provider/);
  assert.match(item.message, /S99/);
  assert.equal(item.file, 'entries/model.md');
  assert.equal(item.line, 1);
});

for (const [label, row] of [
  ['missing id', { ...source, id: undefined }],
  ['non-string id', { ...source, id: 1 }],
  ['invalid source id', { ...source, id: 'other' }],
  ['missing kind', { ...source, kind: undefined }],
  ['unsupported kind', { ...source, kind: 'other' }],
  ['missing label', { ...source, label: undefined }],
  ['empty label', { ...source, label: '  ' }],
  ['non-string label', { ...source, label: 1 }],
  ['missing ref', { ...source, ref: undefined }],
  ['empty ref', { ...source, ref: '' }],
  ['non-string ref', { ...source, ref: {} }],
  ['non-object row', []],
]) {
  test(`source row with ${label} fails its schema check`, (t) => {
    const { dir } = fixture(t);
    store.writeJsonl(dir, 'sources.jsonl', [row], writeOptions);
    const [item] = finding(kbCheck.run(dir), 'source-row');
    assert.equal(item.file, 'sources.jsonl');
    assert.equal(item.line, 1);
  });
}

test('every source row is validated even when a later duplicate replaces it in kb.load', (t) => {
  const { dir } = fixture(t);
  store.writeJsonl(dir, 'sources.jsonl', [{ ...source, kind: undefined }, source], writeOptions);
  const [item] = finding(kbCheck.run(dir), 'source-row');
  assert.equal(item.line, 1);
});

test('sheet, slack and notion sources all resolve, and existing flags may repeat', (t) => {
  const { dir } = fixture(t, valid.replace('S01#E11', 'S01#E11, S02#1780000000.000001, S03#model'));
  store.writeJsonl(dir, 'sources.jsonl', ['sheet', 'slack', 'notion'].map((kind, index) => ({ ...source, id: `S0${index + 1}`, kind })), writeOptions);
  store.writeJsonl(dir, 'flags.jsonl', [{ id: 'demo.model.provider', reason: 'Earlier review.' }, { id: 'demo.model.provider', reason: 'Latest review.' }], writeOptions);
  assert.deepEqual(kbCheck.run(dir), { ok: true, findings: [] });
});

for (const [field, text] of [
  ['id', valid.replace('demo.model.provider', 'demo.model.lumaclient')],
  ['claim', valid.replace('架空のモデルを利用する。', 'ＬＵＭＡＣＬＩＥＮＴ')],
  ['status', valid.replace('status: verified', 'status: LumaClient')],
  ['verified', valid.replace('2026-10-12', 'LumaClient')],
  ['sources', valid.replace('S01#E11', 'S01#LumaClient')],
  ['select', valid + 'select: ＬＵＭＡＣＬＩＥＮＴ=demo\n'],
  ['select', valid + 'select: model=lUmAcLiEnT\n'],
  ['note', valid + 'note: LumaClient\n'],
]) {
  test(`scrub scan covers entry ${field} with normalized, case-insensitive matching`, (t) => {
    const { dir } = fixture(t, text);
    scrub(dir, '\n　\n  LumaClient \r\n\n');
    const [item] = finding(kbCheck.run(dir), 'scrub');
    assert.equal(item.file, 'entries/model.md');
    assert.match(item.message, new RegExp(`\\b${field}\\b`));
    if (field !== 'id') assert.match(item.message, /demo\.model\.provider/);
  });
}

for (const field of ['label', 'ref']) {
  test(`scrub scan covers every source ${field}, including overwritten rows`, (t) => {
    const { dir } = fixture(t);
    scrub(dir);
    const value = field === 'label' ? 'ＬｕｍａＣｌｉｅｎｔ' : 'https://example.invalid/demo/LumaClient';
    store.writeJsonl(dir, 'sources.jsonl', [{ ...source, [field]: value }, source], writeOptions);
    const [item] = finding(kbCheck.run(dir), 'scrub');
    assert.equal(item.file, 'sources.jsonl');
    assert.equal(item.line, 1);
    assert.match(item.message, /S01/);
    assert.match(item.message, new RegExp(`\\b${field}\\b`));
  });
}

for (const text of [valid + 'claim: LumaClient\n', valid + 'lumaclient: demo\n', valid.replace('S01#E11', 'LumaClient')]) {
  test('malformed or discarded entry fields still receive a private scrub diagnostic', (t) => {
    const { dir } = fixture(t, text);
    scrub(dir);
    const result = kbCheck.run(dir);
    finding(result, 'parse');
    finding(result, 'scrub');
  });
}

test('scrubbed topic filenames and entry ids are redacted in every finding field', (t) => {
  const { dir } = fixture(t);
  const file = 'entries/lumaclient.md';
  store.writeText(dir, file, valid.replace('demo.model.provider', 'demo.lumaclient.x'), writeOptions);
  scrub(dir);
  const [item] = finding(kbCheck.run(dir), 'scrub');
  assert.equal(item.file, '[redacted]');
  assert.match(item.message, /Entry \[redacted\] field id/);
  assert.equal(item.line, 1);
});

test('scrubbed duplicate ids are redacted across the whole parser message', (t) => {
  const text = valid.replace('demo.model.provider', 'demo.lumaclient.x');
  const { dir } = fixture(t, text + text);
  scrub(dir, 'LumaClient\nDuplicate entry id\n');
  const result = kbCheck.run(dir);
  const [item] = finding(result, 'parse');
  finding(result, 'parse', 'Duplicate entry id');
  assert.equal(item.message, '[redacted]');
  assert.equal(item.line, 6);
});

for (const [label, text, line, field, entry] of [
  ['trailing comment', valid.replace('claim: 架空のモデルを利用する。', 'claim: 架空のモデルを利用する。  # LumaClient'), 2, 'claim', true],
  ['indented full-line comment', valid + '  # LumaClient\n', 6, 'content', true],
  ['preamble', 'LumaClient\n' + valid, 1, 'content', false],
  ['top-level heading', '# LumaClient\n' + valid, 1, 'heading', false],
  ['appendix heading', valid + '## appendix LumaClient\n', 6, 'heading', false],
  ['bare heading after an entry', valid + '# LumaClient\n', 6, 'heading', false],
  ['text after a heading', valid + '## appendix\nLumaClient\n', 7, 'content', false],
]) {
  test(`scrub scan covers raw ${label} with the correct location and owner`, (t) => {
    const { dir } = fixture(t, text);
    scrub(dir);
    const [item] = finding(kbCheck.run(dir), 'scrub');
    assert.equal(item.file, 'entries/model.md');
    assert.equal(item.line, line);
    assert.match(item.message, new RegExp(`\\b${field}\\b`));
    if (entry) assert.match(item.message, /Entry demo\.model\.provider/);
    else {
      assert.match(item.message, /File/);
      assert.doesNotMatch(item.message, /demo\.model\.provider/);
    }
  });
}

test('raw scans include topic files without any entry blocks', (t) => {
  const { dir } = fixture(t);
  store.writeText(dir, 'entries/appendix.md', '# appendix\n  # LumaClient\n', writeOptions);
  scrub(dir);
  const [item] = finding(kbCheck.run(dir), 'scrub');
  assert.equal(item.file, 'entries/appendix.md');
  assert.equal(item.line, 2);
  assert.match(item.message, /File/);
});

test('scrub list can be explicitly supplied, with no per-needle duplicate findings', (t) => {
  const { home, dir } = fixture(t, valid + 'note: LumaClient\n');
  const scrubFile = path.join(home, 'scrub-list.txt');
  store.writeText(home, 'scrub-list.txt', 'LumaClient\nLuma\nLumaClient\n', writeOptions);
  assert.equal(finding(kbCheck.run(dir, { scrubFile }), 'scrub').length, 1);
});

test('absent default and empty scrub files are allowed; an unreadable supplied file fails closed', (t) => {
  const { dir, home } = fixture(t);
  assert.equal(kbCheck.run(dir).ok, true);
  scrub(dir, '\n　\n');
  assert.equal(kbCheck.run(dir).ok, true);
  finding(kbCheck.run(dir, { scrubFile: home }), 'scrub-file');
  finding(kbCheck.run(dir, { scrubFile: path.join(home, 'missing.txt') }), 'scrub-file');
});

for (const [field, text, privateText] of [
  ['claim', valid.replace('架空のモデルを利用する。', 'demo.person@example.invalid'), 'demo.person@example.invalid'],
  ['claim', valid.replace('架空のモデルを利用する。', 'ｄｅｍｏ＠ｅｘａｍｐｌｅ．ｉｎｖａｌｉｄ'), 'demo@example.invalid'],
  ['claim', valid.replace('架空のモデルを利用する。', '03-1234-5678'), '03-1234-5678'],
  ['claim', valid.replace('架空のモデルを利用する。', '０９０－１２３４－５６７８'), '090-1234-5678'],
  ['note', valid + 'note: +81 (90) 1234-5678\n', '+81 (90) 1234-5678'],
  ['note', valid + 'note: +1 (202) 555-0100\n', '+1 (202) 555-0100'],
  ['note', valid + 'note: 09012345678\n', '09012345678'],
  ['select', valid + 'select: contact=demo.person@example.invalid\n', 'demo.person@example.invalid'],
  ['select', valid + 'select: demo.person@example.invalid=demo\n', 'demo.person@example.invalid'],
  ['sources', valid.replace('S01#E11', 'S01#demo.person@example.invalid'), 'demo.person@example.invalid'],
  ['claim', valid + 'claim: demo.person@example.invalid\n', 'demo.person@example.invalid'],
]) {
  test(`PII scan covers entry ${field} without echoing the match`, (t) => {
    const { dir } = fixture(t, text);
    const [item] = finding(kbCheck.run(dir), 'pii', privateText);
    assert.equal(item.file, 'entries/model.md');
    assert.match(item.message, new RegExp(`\\b${field}\\b`));
  });
}

const refDates = ['s01(2026-10-09)', 's12#c14 2026-10-09', '2026-10-09 - 2026-10-12', 'S01#E11（2026-10-09）, S02（2026-10-10）'];

for (const text of refDates) {
  test(`PII scan ignores source refs and ISO dates: ${text}`, (t) => {
    const { dir } = fixture(t, valid + `note: ${text}\n`);
    assert.deepEqual(kbCheck.run(dir).findings.filter((item) => item.name === 'pii'), []);
  });
}

for (const phoneText of ['電話03-1234-5678', 'TEL03-1234-5678', 'S01 TEL 03-1234-5678']) {
  test(`PII scan still detects phone next to labels: ${phoneText}`, (t) => {
    const { dir } = fixture(t, valid + `note: ${phoneText}\n`);
    finding(kbCheck.run(dir), 'pii', '1234-5678');
  });
}

test('scrub scan covers entry file names without echoing the match', (t) => {
  const { dir } = fixture(t);
  store.writeText(dir, 'entries/lumaclient.md', valid.replace('demo.model.provider', 'demo.other.x'), writeOptions);
  scrub(dir);
  const result = kbCheck.run(dir);
  const [item] = finding(result, 'scrub');
  assert.equal(item.file, '[redacted]');
  assert.match(item.message, /file name/i);
});

for (const label of ['demo.person@example.invalid', '03-1234-5678']) {
  test('PII scan covers overwritten source labels without echoing the match', (t) => {
    const { dir } = fixture(t);
    store.writeJsonl(dir, 'sources.jsonl', [{ ...source, label }, source], writeOptions);
    const [item] = finding(kbCheck.run(dir), 'pii', label);
    assert.equal(item.file, 'sources.jsonl');
    assert.equal(item.line, 1);
    assert.match(item.message, /label/);
  });
}

for (const [label, text, line, entry] of [
  ['non-entry text', 'Contact demo.person@example.invalid\n' + valid, 1, false],
  ['trailing comment', valid + 'note: sample  # demo.person@example.invalid\n', 6, true],
  ['indented full-line comment', valid + '  # demo.person@example.invalid\n', 6, true],
  ['appendix heading', valid + '## appendix demo.person@example.invalid\n', 6, false],
]) {
  test(`PII scan covers raw ${label} without echoing the match`, (t) => {
    const { dir } = fixture(t, text);
    const [item] = finding(kbCheck.run(dir), 'pii', 'demo.person@example.invalid');
    assert.equal(item.file, 'entries/model.md');
    assert.equal(item.line, line);
    assert.match(item.message, entry ? /Entry demo\.model\.provider/ : /File/);
  });
}

test('unknown flags identify the registry line and entry id', (t) => {
  const { dir } = fixture(t);
  store.writeJsonl(dir, 'flags.jsonl', [{ id: 'demo.model.missing', reason: 'Sample review.' }, { id: 'demo.model.provider' }], writeOptions);
  const [item] = finding(kbCheck.run(dir), 'flag-ref');
  assert.equal(item.file, 'flags.jsonl');
  assert.equal(item.line, 1);
  assert.match(item.message, /demo\.model\.missing/);
});

test('scrubbed identifiers in reference findings never appear in their messages', (t) => {
  const { dir } = fixture(t, valid.replace('demo.model.provider', 'demo.model.lumaclient').replace('S01#E11', 'S99#E11'));
  scrub(dir);
  store.writeJsonl(dir, 'flags.jsonl', [{ id: 'demo.model.lumaclient-missing' }], writeOptions);
  const result = kbCheck.run(dir);
  finding(result, 'source-ref');
  finding(result, 'flag-ref');
});

for (const verdict of ['public', 'unknown', 'private']) {
  test(`path guard uses the fake ${verdict} probe for a non-synthetic KB`, (t) => {
    const { dir, home } = fixture(t);
    store.writeJson(dir, 'kb.json', { ...manifest, synthetic: false }, writeOptions);
    createRepo(home, remote);
    const urls = [];
    const result = isolatedGit(home, () => kbCheck.run(dir, { probe: (url) => { urls.push(url); return verdict; } }));
    assert.deepEqual(urls, [remote]);
    if (verdict === 'private') assert.deepEqual(result, { ok: true, findings: [] });
    else finding(result, 'guard');
  });
}

test('path guard resolves directory symlinks and keeps thrown probe details private', (t) => {
  const { dir, home } = fixture(t);
  store.writeJson(dir, 'kb.json', { ...manifest, synthetic: false }, writeOptions);
  createRepo(dir, remote);
  const alias = path.join(home, 'alias');
  fs.symlinkSync(dir, alias, 'dir');
  const result = isolatedGit(home, () => kbCheck.run(alias, { probe: () => { throw new Error('LumaClient'); } }));
  finding(result, 'guard');
});

test('synthetic KBs reuse the guard exemption in a public repository', (t) => {
  const { dir, home } = fixture(t);
  createRepo(home, remote);
  const result = isolatedGit(home, () => kbCheck.run(dir, { probe: () => assert.fail('Synthetic KB must not probe.') }));
  assert.deepEqual(result, { ok: true, findings: [] });
});

for (const synthetic of [undefined, null, 'true', 1, {}, []]) {
  test(`manifest synthetic must be boolean, refusing ${JSON.stringify(synthetic)}`, (t) => {
    const { dir } = fixture(t);
    store.writeJson(dir, 'kb.json', { ...manifest, synthetic }, writeOptions);
    const [item] = finding(kbCheck.run(dir), 'synthetic');
    assert.equal(item.file, 'kb.json');
  });
}

test('only literal true is passed to the guard as a synthetic exemption', (t) => {
  const { dir } = fixture(t);
  store.writeJson(dir, 'kb.json', { ...manifest, synthetic: 'true' }, writeOptions);
  const calls = [];
  const spy = t.mock.method(guard, 'assertSafePersonaPath', (_dir, options) => {
    calls.push({ dir: _dir, options });
  });
  finding(kbCheck.run(dir), 'synthetic');
  assert.equal(spy.mock.callCount(), 1);
  assert.deepEqual(calls, [{ dir, options: { probe: undefined, synthetic: false } }]);
});

for (const alias of [false, true]) {
  test(`non-synthetic KB is refused under the repository sample directory${alias ? ' through a symlink' : ''}`, (t) => {
    const home = temporaryDirectory(t);
    const dir = alias ? path.join(home, 'sample-alias') : sample;
    if (alias) fs.symlinkSync(sample, dir, 'dir');
    const read = fs.readFileSync;
    t.mock.method(fs, 'readFileSync', (file, ...args) => {
      if (path.resolve(file) === path.join(dir, 'kb.json')) return JSON.stringify({ ...manifest, synthetic: false });
      return read(file, ...args);
    });
    t.mock.method(guard, 'assertSafePersonaPath', () => {});
    const [item] = finding(kbCheck.run(dir), 'synthetic');
    assert.match(item.message, /sample/);
    assert.equal(item.file, 'kb.json');
  });
}

test('checker reads only sample data and isolated fixtures, never the real home', (t) => {
  const { home, dir } = fixture(t);
  scrub(dir);
  const read = fs.readFileSync;
  const paths = [];
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    const absolute = path.resolve(file);
    assert.ok(absolute.startsWith(`${sample}${path.sep}`) || absolute === `${sample}.scrub.txt`
      || absolute.startsWith(`${home}${path.sep}`), absolute);
    paths.push(absolute);
    return read(file, ...args);
  });
  assert.deepEqual(kbCheck.run(sample), { ok: true, findings: [] });
  assert.deepEqual(kbCheck.run(dir), { ok: true, findings: [] });
  assert.ok(paths.length >= 8);
});

const piiTable = require('./kb-pii-table');

for (const text of piiTable.clean) {
  test(`PII table: not flagged: ${text}`, (t) => {
    const { dir } = fixture(t, valid + `note: ${text}\n`);
    assert.deepEqual(kbCheck.run(dir).findings.filter((item) => item.name === 'pii'), []);
  });
}

for (const text of piiTable.phones) {
  test(`PII table: flagged: ${text}`, (t) => {
    const { dir } = fixture(t, valid + `note: ${text}\n`);
    assert.ok(kbCheck.run(dir).findings.some((item) => item.name === 'pii'));
  });
}
