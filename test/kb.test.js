'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const kb = require('../lib/kb');
const store = require('../lib/store');
const ssot = require('../lib/kb-ssot');
const { main } = require('../bin/bunshin');

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

test('unbound sample persona returns null without resolving a KB', () => {
  assert.equal(kb.loadBound(path.resolve(__dirname, '../sample/persona'), {}), null);
});

test('bound sample KB digest includes only citable facts and tracks claim and flag changes', async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-kb-bound-')));
  t.after(() => { store._resetGuardCache(); fs.rmSync(home, { recursive: true, force: true }); });
  const env = { BUNSHIN_HOME: home };
  const personaDir = path.join(home, 'sample');
  const persona = store.readJson(path.resolve(__dirname, '../sample/persona'), 'persona.json');
  store.writeJson(personaDir, 'persona.json', { ...persona, kb: 'demo' }, { synthetic: true });
  let stderr = '';
  assert.equal(await main(['kb', 'init', 'demo', '--sample'], {
    env, stdout: { write() {} }, stderr: { write(text) { stderr += text; } },
  }), 0, stderr);
  const bound = kb.loadBound(personaDir, env);
  const text = '## model\n- [demo.model.provider] Cloudberry Lantern は架空のモデル「灯り」を利用する。\n'
    + '  select: 利用AI=灯り; 提供元国=架空国\n';
  assert.equal(bound.name, 'demo');
  assert.equal(bound.dir, kb.resolve({ name: 'demo', env }));
  assert.deepEqual(bound.data.errors, []);
  assert.deepEqual(bound.digest, {
    text, hash: crypto.createHash('sha256').update(text).digest('hex'), ids: ['demo.model.provider'],
  });
  assert.deepEqual(kb.loadBound(personaDir, env).digest, bound.digest);
  const file = 'entries/model.md';
  const original = fs.readFileSync(path.join(bound.dir, file), 'utf8');
  store.writeText(bound.dir, file, original.replace('claim: Cloudberry', 'claim: cloudberry'), { synthetic: true });
  assert.notEqual(kb.loadBound(personaDir, env).digest.hash, bound.digest.hash);
  store.writeText(bound.dir, file, original, { synthetic: true });
  store.appendJsonl(bound.dir, 'flags.jsonl', { id: 'demo.model.provider', flagged: true }, { synthetic: true });
  const empty = kb.loadBound(personaDir, env).digest;
  assert.deepEqual(empty, { text: '', hash: crypto.createHash('sha256').update('').digest('hex'), ids: [] });
  store.appendJsonl(bound.dir, 'flags.jsonl', { id: 'demo.model.provider', flagged: false }, { synthetic: true });
  assert.deepEqual(kb.loadBound(personaDir, env).digest, bound.digest);
});

test('digest preserves file and entry order and treats legacy flags as active', (t) => {
  const { dir } = fixture(t, valid + valid.replace('provider', 'second'));
  store.writeText(dir, 'entries/alpha.md', valid.replace('demo.model.provider', 'demo.alpha.first'), { synthetic: true });
  const data = kb.load(dir);
  const digest = kb.digest(data);
  assert.deepEqual(digest.ids, ['demo.alpha.first', 'demo.model.provider', 'demo.model.second']);
  assert.equal(digest.text, '## alpha\n- [demo.alpha.first] 架空のモデルを利用する。\n'
    + '## model\n- [demo.model.provider] 架空のモデルを利用する。\n- [demo.model.second] 架空のモデルを利用する。\n');
  data.flags.set('demo.alpha.first', { id: 'demo.alpha.first', reason: 'Review again.' });
  assert.deepEqual(kb.digest(data).ids, ['demo.model.provider', 'demo.model.second']);
});

test('loadBound rejects missing KBs and reports the first located parse error', (t) => {
  const { home, dir } = fixture(t);
  const personaDir = path.join(home, 'sample');
  const persona = store.readJson(path.resolve(__dirname, '../sample/persona'), 'persona.json');
  store.writeJson(personaDir, 'persona.json', { ...persona, kb: 'missing' }, { synthetic: true });
  assert.throws(() => kb.loadBound(personaDir, { BUNSHIN_HOME: home }), { message: 'KB missing not found' });
  store.writeJson(personaDir, 'persona.json', { ...persona, kb: 'demo' });
  store.writeText(dir, 'entries/model.md', valid + 'extra: value\nnot a field\n', { synthetic: true });
  assert.throws(() => kb.loadBound(personaDir, { BUNSHIN_HOME: home }), {
    message: 'KB demo has parse errors: entries/model.md:6 Unknown key: extra.',
  });
});

test('loadBound and twin prompt refuse a parsed KB with a scrubbed verified claim without exposing it', async (t) => {
  const { home, dir } = fixture(t, fs.readFileSync(path.join(sample, 'entries/model.md'), 'utf8'));
  store.writeText(dir, 'sources.jsonl', fs.readFileSync(path.join(sample, 'sources.jsonl'), 'utf8'), { synthetic: true });
  const personaDir = path.join(home, 'sample');
  const samplePersona = path.resolve(__dirname, '../sample/persona');
  for (const file of fs.readdirSync(samplePersona)) {
    store.writeText(personaDir, file, fs.readFileSync(path.join(samplePersona, file), 'utf8'), { synthetic: true });
  }
  store.writeJson(personaDir, 'persona.json', { ...store.readJson(personaDir, 'persona.json'), kb: 'demo' });
  const env = { BUNSHIN_HOME: home };
  const scrubWord = 'LumaClient';
  store.writeText(path.dirname(dir), 'demo.scrub.txt', `${scrubWord}\n`, { synthetic: true });
  const text = fs.readFileSync(path.join(dir, 'entries/model.md'), 'utf8');
  store.writeText(dir, 'entries/model.md', text.replace('claim: Cloudberry', `claim: ${scrubWord} Cloudberry`), { synthetic: true });
  assert.deepEqual(kb.load(dir).errors, []);
  const message = 'KB demo fails kb check: scrub: Entry demo.model.provider field claim contains a scrub-list match.';
  assert.throws(() => kb.loadBound(personaDir, env), (error) => {
    assert.equal(error.message, message);
    assert.ok(!error.message.includes(scrubWord));
    return true;
  });
  let stdout = '';
  let stderr = '';
  assert.equal(await main(['twin', 'prompt', '--skill', 'spec-answer', '--persona', personaDir], {
    env, stdout: { write(value) { stdout += value; } }, stderr: { write(value) { stderr += value; } },
  }), 1);
  assert.equal(stdout, '');
  assert.equal(stderr, `${message}\n`);
  assert.ok(!stderr.includes(scrubWord));
});

test('loadBound reports the first kb check finding for a parsed KB', (t) => {
  const { home, dir } = fixture(t);
  const personaDir = path.join(home, 'sample');
  const persona = store.readJson(path.resolve(__dirname, '../sample/persona'), 'persona.json');
  store.writeJson(personaDir, 'persona.json', { ...persona, kb: 'demo' }, { synthetic: true });
  store.writeText(dir, 'entries/model.md', valid.replace('S01#E11', 'S99#E11'), { synthetic: true });
  store.appendJsonl(dir, 'flags.jsonl', { id: 'demo.model.missing', flagged: true }, { synthetic: true });
  assert.deepEqual(kb.load(dir).errors, []);
  assert.throws(() => kb.loadBound(personaDir, { BUNSHIN_HOME: home }), {
    message: 'KB demo fails kb check: source-ref: Entry demo.model.provider sources references unknown source S99.',
  });
});

test('digest mode defaults to entries and preserves the sample text and pre-change hash', () => {
  const data = kb.load(sample);
  const expected = {
    text: '## model\n- [demo.model.provider] Cloudberry Lantern は架空のモデル「灯り」を利用する。\n'
      + '  select: 利用AI=灯り; 提供元国=架空国\n',
    hash: '6aa2e609f7b5a5bb10967907697ca9097d4f5375a7081a33046bcf8ea691c927',
    ids: ['demo.model.provider'],
  };
  assert.equal(kb.mode(data), 'entries');
  assert.deepEqual(kb.digest(data), expected);
  data.manifest.digest = 'entries';
  assert.equal(kb.mode(data), 'entries');
  assert.deepEqual(kb.digest(data), expected);
  assert.deepEqual(kb.citable(data), new Map([['demo.model.provider', {
    id: 'demo.model.provider', claim: data.entries[0].claim, select: data.entries[0].select,
  }]]));
});

test('invalid digest values are located load errors while both explicit modes load', (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-kb-mode-')));
  t.after(() => { store._resetGuardCache(); fs.rmSync(home, { recursive: true, force: true }); });
  const dir = kb.resolve({ name: 'demo', env: { BUNSHIN_HOME: home } });
  fs.cpSync(sample, dir, { recursive: true });
  for (const digest of ['entries', 'ssot', '', 'SSOT', null, false, 0, [], {}]) {
    store.writeJson(dir, 'kb.json', { ...manifest, digest }, { synthetic: true });
    const data = kb.load(dir);
    if (digest === 'entries' || digest === 'ssot') {
      assert.deepEqual(data.errors, []);
      assert.equal(kb.mode(data), digest);
    } else {
      assert.deepEqual(data.errors, [{ file: 'kb.json', line: 1,
        message: 'Invalid digest; expected entries or ssot.' }]);
    }
  }
});

test('entries citable uses the digest filter for statuses, flags, duplicate and invalid ids', () => {
  const data = kb.load(sample);
  const provider = data.entries[0];
  data.entries.push({ ...provider, id: 'invalid' });
  assert.deepEqual([...kb.citable(data).keys()], [provider.id]);
  data.entries.push({ ...provider });
  assert.equal(kb.citable(data).size, 0);
  data.entries.pop();
  for (const row of [{ id: provider.id, flagged: true }, { id: provider.id }]) {
    data.flags.set(provider.id, row);
    assert.equal(kb.citable(data).size, 0);
  }
  data.flags.set(provider.id, { id: provider.id, flagged: false });
  assert.deepEqual([...kb.citable(data).keys()], [provider.id]);
});

test('ssot digest includes approved sections in file order and changes with approval and backing edits', (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-kb-digest-')));
  t.after(() => { store._resetGuardCache(); fs.rmSync(home, { recursive: true, force: true }); });
  const dir = kb.resolve({ name: 'demo', env: { BUNSHIN_HOME: home } });
  fs.cpSync(sample, dir, { recursive: true });
  const entryDigest = kb.digest(kb.load(dir));
  store.writeText(dir, 'ssot.md', '# Demo SSOT\n\n'
    + '## z-model\ntitle: Model\n### demo.z-model.s2\ntext: Sample model.\nbacks: demo.model.provider\n'
    + 'select: result=a=b; 地域=北\n### demo.z-model.s1\ntext: Second sample.\nbacks: demo.model.provider\n'
    + '## stale\ntitle: Stale\n### demo.stale.s1\ntext: Old sample.\nbacks: demo.model.provider\n'
    + '## a-summary\ntitle: Summary\n### demo.a-summary.s1\ntext: Sample summary.\nbacks: demo.model.provider\n',
  { synthetic: true });
  // Drafting alone must not affect an entries-mode digest.
  assert.deepEqual(kb.digest(kb.load(dir)), entryDigest);
  store.writeJson(dir, 'kb.json', { ...manifest, digest: 'ssot' }, { synthetic: true });
  let data = kb.load(dir);
  const empty = { text: '', hash: crypto.createHash('sha256').update('').digest('hex'), ids: [] };
  assert.deepEqual(kb.digest(data), empty);
  const approve = (section) => store.appendJsonl(dir, 'ssot-approvals.jsonl', {
    id: section.section, approved_at: '2026-10-14', text_hash: ssot.textHash(section),
    backing_hash: ssot.backingHash(section, data),
  }, { synthetic: true });
  // Approvals are deliberately appended in reverse section order.
  approve(data.ssot.sections[2]);
  const firstApproval = kb.digest(kb.load(dir));
  assert.notEqual(firstApproval.hash, empty.hash);
  approve(data.ssot.sections[0]);
  store.appendJsonl(dir, 'ssot-approvals.jsonl', {
    id: 'stale', approved_at: '2026-10-14', text_hash: ssot.textHash(data.ssot.sections[1]),
    backing_hash: '0'.repeat(64),
  }, { synthetic: true });
  data = kb.load(dir);
  assert.deepEqual(data.errors, []);
  assert.equal(ssot.states(data).get('stale'), 'stale');
  const text = '## z-model — Model\n- [demo.z-model.s2] Sample model.\n'
    + '  select: result=a=b; 地域=北\n- [demo.z-model.s1] Second sample.\n'
    + '## a-summary — Summary\n- [demo.a-summary.s1] Sample summary.\n';
  assert.deepEqual(kb.digest(data), {
    text, hash: crypto.createHash('sha256').update(text).digest('hex'),
    ids: ['demo.z-model.s2', 'demo.z-model.s1', 'demo.a-summary.s1'],
  });
  assert.notEqual(kb.digest(data).hash, firstApproval.hash);
  assert.deepEqual(kb.citable(data), new Map(data.ssot.sections
    .filter((section) => section.section !== 'stale')
    .flatMap((section) => section.statements.map(({ id, text, select }) => [id, { id, claim: text, select }]))));
  data.entries[0].claim += ' Edited.';
  assert.deepEqual(kb.digest(data), empty);
  assert.equal(kb.citable(data).size, 0);
  assert.deepEqual(kb.digest({ ...data, ssot: { sections: [], approvals: new Map() } }), empty);
});
