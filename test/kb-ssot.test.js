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

const sample = path.resolve(__dirname, '../sample/kb/demo');
const block = '## model\ntitle: Model\n### demo.model.s1\ntext: Sample model.\nbacks: demo.model.provider\n';

function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-ssot-')));
  t.after(() => { store._resetGuardCache(); fs.rmSync(home, { recursive: true, force: true }); });
  const dir = kb.resolve({ name: 'demo', env: { BUNSHIN_HOME: home } });
  fs.cpSync(sample, dir, { recursive: true });
  return dir;
}

test('parses two sections and three statements with optional document title', () => {
  const text = '# Demo SSOT\n\n' + block + 'select: result=a=b; 地域=北\n\n'
    + '### demo.model.s2\ntext: Second sample.\nbacks: demo.model.provider, demo.model.region\n'
    + '\n## security\ntitle: Security\n### demo.security.s12\ntext: Third sample.\nbacks: demo.model.provider\n';
  const parsed = ssot.parse(text.replace(/\n/g, '\r\n'), 'demo');
  assert.deepEqual(parsed, {
    title: 'Demo SSOT', errors: [], sections: [
      { section: 'model', title: 'Model', line: 3, statements: [
        { id: 'demo.model.s1', text: 'Sample model.', backs: ['demo.model.provider'], select: { result: 'a=b', 地域: '北' }, line: 5 },
        { id: 'demo.model.s2', text: 'Second sample.', backs: ['demo.model.provider', 'demo.model.region'], select: {}, line: 10 },
      ] },
      { section: 'security', title: 'Security', line: 14, statements: [
        { id: 'demo.security.s12', text: 'Third sample.', backs: ['demo.model.provider'], select: {}, line: 16 },
      ] },
    ],
  });
  assert.equal(ssot.parse(block, 'demo').title, '');
  assert.deepEqual(ssot.parse(block.replace('demo.model.provider', 'demo.model.unknown'), 'demo').errors, []);
});

for (const [label, text, line, message] of [
  ['bad section', block.replace(/model/g, 'Model'), 1, /section/i],
  ['bad statement id', block.replace('demo.model.s1', 'demo.model.s0'), 3, /id/i],
  ['entry id', block.replace('demo.model.s1', 'demo.model.provider'), 3, /id/i],
  ['other section', block.replace('demo.model.s1', 'demo.other.s1'), 3, /id/i],
  ['other KB', block.replace('demo.model.s1', 'other.model.s1'), 3, /id/i],
  ['duplicate section', block + '## model\n', 6, /duplicate.*section/i],
  ['duplicate statement', block + block.split('\n').slice(2).join('\n'), 6, /duplicate.*id/i],
  ['missing text', block.replace('text: Sample model.\n', ''), 3, /text/i],
  ['empty text', block.replace('text: Sample model.', 'text:'), 4, /text/i],
  ['missing backs', block.replace('backs: demo.model.provider\n', ''), 3, /backs/i],
  ['empty backs', block.replace('backs: demo.model.provider', 'backs:'), 5, /backs/i],
  ['empty backing item', block.replace('backs: demo.model.provider', 'backs: demo.model.provider,'), 5, /backs/i],
  ['unknown key', block + 'extra: value\n', 6, /unknown.*key/i],
  ['duplicate key', block + 'text: Second sample.\n', 6, /duplicate.*key/i],
  ['duplicate title', block.replace('title: Model\n', 'title: Model\ntitle: Second\n'), 3, /duplicate.*key/i],
  ['stray outside', 'stray\n' + block, 1, /outside|expected|stray/i],
  ['stray section', block.replace('title: Model\n', 'title: Model\nstray\n'), 3, /outside|expected|stray/i],
  ['stray statement', block + 'stray\n', 6, /outside|expected|stray/i],
  ['invalid select', block + 'select: no equals\n', 6, /select/i],
  ['duplicate select', block + 'select: model=a; model=b\n', 6, /duplicate.*select/i],
]) {
  test(`parser locates ${label} and continues`, () => {
    const parsed = ssot.parse(text + '## next\n### demo.next.s1\ntext: Next sample.\nbacks: demo.model.provider\n', 'demo');
    assert.equal(parsed.errors.length, 1);
    assert.equal(parsed.errors[0].file, 'ssot.md');
    assert.equal(parsed.errors[0].line, line);
    assert.match(parsed.errors[0].message, message);
    assert.equal(parsed.sections.at(-1).statements[0].id, 'demo.next.s1');
  });
}

test('select has the same values, errors and safe own properties as entry select', () => {
  for (const value of ['', 'a=b=c; 地域=北', '__proto__=safe; constructor=value', 'a=b; a=c', 'a=', '=b', 'a=b;']) {
    const entries = [];
    const errors = [];
    kb.parseEntries(`### demo.model.provider\nclaim: Sample.\nstatus: draft\nsources: S01#E11\nselect: ${value}\n`, 'entries/model.md', entries, new Set(), (file, line, message) => errors.push(message));
    const parsed = ssot.parse(block + `select: ${value}\n`, 'demo');
    assert.deepEqual(parsed.sections[0].statements[0].select, entries[0].select);
    assert.deepEqual(parsed.errors.map((error) => error.message), errors);
  }
});

test('hashes use sorted JSON keys and specified array order, excluding metadata', () => {
  const section = ssot.parse(block + 'select: z=last; a=first\n', 'demo').sections[0];
  const data = kb.load(sample);
  const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
  assert.equal(ssot.textHash(section), hash('{"section":"model","statements":[{"backs":["demo.model.provider"],"id":"demo.model.s1","select":{"a":"first","z":"last"},"text":"Sample model."}],"title":"Model"}'));
  const entry = data.entries[0];
  const expected = JSON.stringify([{ claim: entry.claim, flagged: false, id: entry.id, select: { 利用AI: '灯り', 提供元国: '架空国' }, status: 'verified' }]);
  assert.equal(ssot.backingHash(section, data), hash(expected));
  const before = ssot.backingHash(section, data);
  entry.note = 'Other sample note';
  entry.verified = '2026-10-13';
  assert.equal(ssot.backingHash(section, data), before);
  section.line = 100;
  section.statements[0].line = 102;
  section.statements[0].select = { a: 'first', z: 'last' };
  assert.equal(ssot.textHash(section), hash('{"section":"model","statements":[{"backs":["demo.model.provider"],"id":"demo.model.s1","select":{"a":"first","z":"last"},"text":"Sample model."}],"title":"Model"}'));
  section.statements[0].backs.push('demo.model.region');
  const multiple = ssot.backingHash(section, data);
  section.statements[0].backs.reverse();
  data.entries.reverse();
  assert.equal(ssot.backingHash(section, data), multiple);
  section.statements.push({ ...section.statements[0] });
  assert.equal(ssot.backingHash(section, data), multiple);
  data.flags.set(entry.id, { id: entry.id, flagged: false });
  assert.equal(ssot.backingHash(section, data), multiple);
  data.flags.set(entry.id, { id: entry.id });
  assert.notEqual(ssot.backingHash(section, data), multiple);
});

test('section states reflect approvals, edits and blocked backing entries', () => {
  const data = kb.load(sample);
  data.ssot = { ...ssot.parse(block, 'demo'), approvals: new Map() };
  const section = data.ssot.sections[0];
  const state = () => ssot.states(data).get('model');
  assert.equal(state(), 'draft');
  data.ssot.approvals.set('model', { id: 'model', text_hash: ssot.textHash(section), backing_hash: ssot.backingHash(section, data) });
  assert.equal(state(), 'approved');
  section.statements[0].text += ' Edited.';
  assert.equal(state(), 'changed');
  section.statements[0].text = 'Sample model.';
  const entry = data.entries[0];
  const claim = entry.claim;
  entry.claim += ' Edited.';
  assert.equal(state(), 'stale');
  entry.claim = claim;
  data.flags.set(entry.id, { id: entry.id, flagged: true });
  assert.equal(state(), 'blocked');
  data.flags.set(entry.id, { id: entry.id, flagged: false });
  assert.equal(state(), 'approved');
  entry.status = 'draft';
  assert.equal(state(), 'blocked');
  entry.status = 'retired';
  assert.equal(state(), 'blocked');
  entry.status = 'verified';
  section.statements[0].backs.push('demo.model.unknown');
  assert.equal(state(), 'blocked');
});

test('load handles optional SSOT and last approval row, collecting located errors', (t) => {
  const dir = fixture(t);
  assert.deepEqual(kb.load(dir).ssot, { present: false, sections: [], approvals: new Map() });
  store.writeText(dir, 'ssot.md', '# Demo\n' + block + 'extra: value\n', { synthetic: true });
  const old = { id: 'model', text_hash: 'old', backing_hash: 'old' };
  const latest = { id: 'model', approved_at: '2026-10-14', text_hash: 'new', backing_hash: 'new' };
  store.writeText(dir, 'ssot-approvals.jsonl', `${JSON.stringify(old)}\ninvalid\n{}\n${JSON.stringify(latest)}\n`, { synthetic: true });
  const data = kb.load(dir);
  assert.equal(data.ssot.present, true);
  assert.equal(data.ssot.title, 'Demo');
  assert.equal(data.ssot.sections.length, 1);
  assert.deepEqual(data.ssot.approvals.get('model'), latest);
  assert.deepEqual(data.errors.map(({ file, line }) => ({ file, line })).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line), [
    { file: 'ssot-approvals.jsonl', line: 2 }, { file: 'ssot-approvals.jsonl', line: 3 }, { file: 'ssot.md', line: 7 },
  ]);
});
