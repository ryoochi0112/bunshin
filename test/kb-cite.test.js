'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const kb = require('../lib/kb');
const store = require('../lib/store');
const command = require('../lib/commands/kb');
const cite = require('../lib/kb-cite');

const sample = path.resolve(__dirname, '../sample/kb/demo');
const id = 'demo.model.provider';

function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-cite-test-')));
  t.after(() => { store._resetGuardCache(); fs.rmSync(home, { recursive: true, force: true }); });
  let stdout = '';
  let stderr = '';
  const io = { env: { BUNSHIN_HOME: home },
    stdout: { write(text) { stdout += text; } }, stderr: { write(text) { stderr += text; } } };
  assert.equal(command.run(['init', 'demo', '--sample'], io), 0);
  stdout = '';
  const dir = kb.resolve({ name: 'demo', env: io.env });
  const draft = path.join(home, 'draft.txt');
  return { home, dir, draft, io, output: () => ({ stdout, stderr }) };
}

test('verified citations resolve without splitting the dots inside ids', () => {
  const data = kb.load(sample);
  for (const text of [`架空のモデルです。[${id}]`, `A sample model [${id}].`, `A sample model. [${id}]`]) {
    assert.deepEqual(cite.check(data, text), {
      ok: true, abstain: false, sentences: [{ text, ids: [id], problems: [] }],
    });
  }
});

test('golden missing, unknown and non-citable cases report precise problems', () => {
  const data = kb.load(sample);
  for (const [text, ids, problems] of [
    ['A sample fact.', [], ['no-citation']],
    ['A sample fact [demo.model.absent].', ['demo.model.absent'], ['unknown-id']],
    ...['region', 'retention', 'legacy'].map((slug) => [
      `A sample fact [demo.model.${slug}].`, [`demo.model.${slug}`], ['not-citable'],
    ]),
  ]) {
    assert.deepEqual(cite.check(data, text), { ok: false, abstain: false, sentences: [{ text, ids, problems }] });
  }
});

test('every trailing citation must resolve and be citable; problems are unique', () => {
  const text = `A sample fact [${id}][demo.model.absent][demo.model.region][demo.model.legacy].`;
  assert.deepEqual(cite.check(kb.load(sample), text), {
    ok: false, abstain: false, sentences: [{ text,
      ids: [id, 'demo.model.absent', 'demo.model.region', 'demo.model.legacy'],
      problems: ['unknown-id', 'not-citable'] }],
  });
  const misplaced = `According to [${id}], a sample fact.`;
  assert.deepEqual(cite.check(kb.load(sample), misplaced).sentences,
    [{ text: misplaced, ids: [], problems: ['no-citation'] }]);
});

test('Japanese, English, question marks and newlines each split sentences', () => {
  const parts = [`架空の事実。[${id}]`, '引用なし？', `Sample fact [${id}].`, 'Uncited?', '改行だけ', `最後 [${id}]`];
  const result = cite.check(kb.load(sample), `${parts[0]}${parts[1]}${parts[2]} ${parts[3]}\r\n${parts[4]}\n${parts[5]}`);
  assert.equal(result.ok, false);
  assert.deepEqual(result.sentences, parts.map((text, index) => ({ text,
    ids: [0, 2, 5].includes(index) ? [id] : [],
    problems: [0, 2, 5].includes(index) ? [] : ['no-citation'],
  })));
});

test('empty and quoted lines are exempt without marking abstention', () => {
  assert.deepEqual(cite.check(kb.load(sample), '\n  \r\n> Sample quotation. No citation?\n  > 引用。\n'),
    { ok: true, abstain: false, sentences: [] });
});

test('only a complete two-line abstention form is exempt', () => {
  const data = kb.load(sample);
  for (const phrase of ['該当する情報がありません。', 'Not covered.']) {
    assert.deepEqual(cite.check(data, `${phrase}\nClosest topic: model`),
      { ok: true, abstain: true, sentences: [] });
    assert.equal(cite.check(data, phrase).ok, false);
    assert.equal(cite.check(data, `${phrase}\nClosest topic: `).ok, false);
    assert.equal(cite.check(data, `${phrase} Extra claim\nClosest topic: model`).abstain, false);
    const mixed = cite.check(data, `${phrase}\nClosest topic: model\nUncited fact.`);
    assert.deepEqual(mixed, { ok: false, abstain: true,
      sentences: [{ text: 'Uncited fact.', ids: [], problems: ['no-citation'] }] });
  }
});

test('latest flag rows are used, and only explicit flagged:false clears a flag', (t) => {
  const { dir } = fixture(t);
  const rows = [];
  for (const [flag, expected] of [[{ flagged: true }, false], [{ flagged: false }, true], [{}, false]]) {
    rows.push({ id, reason: 'Sample review', at: '2026-10-12', ...flag });
    store.writeJsonl(dir, 'flags.jsonl', rows, { synthetic: true });
    const result = cite.check(kb.load(dir), `Sample fact [${id}].`);
    assert.equal(result.ok, expected);
    assert.deepEqual(result.sentences[0].problems, expected ? [] : ['not-citable']);
  }
});

test('invalid and duplicate loaded ids cannot become citable', (t) => {
  const { dir } = fixture(t);
  const original = fs.readFileSync(path.join(dir, 'entries/model.md'), 'utf8');
  store.writeText(dir, 'entries/duplicate.md', original, { synthetic: true });
  assert.deepEqual(cite.check(kb.load(dir), `Sample fact [${id}].`).sentences[0].problems, ['not-citable']);
  store.writeText(dir, 'entries/duplicate.md', '', { synthetic: true });
  const invalid = 'demo.Model.provider';
  store.writeText(dir, 'entries/model.md', original.replace(id, invalid), { synthetic: true });
  assert.deepEqual(cite.check(kb.load(dir), `Sample fact [${invalid}].`).sentences[0].problems, ['not-citable']);
});

test('CLI emits exactly one JSON line for each failing sentence and exits 1', (t) => {
  const { draft, io, output } = fixture(t);
  fs.writeFileSync(draft, `Sample fact [${id}].\nUncited fact.\nUnknown [demo.model.absent].\nDraft [demo.model.region].`);
  assert.equal(command.run(['cite', 'demo', '--draft', draft], io), 1);
  assert.equal(output().stderr, '');
  assert.deepEqual(output().stdout.trim().split('\n').map((line) => JSON.parse(line)), [
    { text: 'Uncited fact.', ids: [], problems: ['no-citation'] },
    { text: 'Unknown [demo.model.absent].', ids: ['demo.model.absent'], problems: ['unknown-id'] },
    { text: 'Draft [demo.model.region].', ids: ['demo.model.region'], problems: ['not-citable'] },
  ]);
});

test('CLI succeeds for citations and abstention, rejects missing draft and read errors', (t) => {
  const { draft, io, output } = fixture(t);
  for (const text of [`Sample fact [${id}].`, 'Not covered.\nClosest topic: model']) {
    fs.writeFileSync(draft, text);
    assert.equal(command.run(['cite', 'demo', '--draft', draft], io), 0);
    assert.deepEqual(output(), { stdout: '', stderr: '' });
  }
  assert.equal(command.run(['cite', 'demo'], io), 2);
  assert.equal(command.run(['cite', 'demo', '--draft', path.join(path.dirname(draft), 'missing.txt')], io), 1);
});

test('CLI citations use latest flags and refuse KB parse errors', (t) => {
  const { dir, draft, io } = fixture(t);
  fs.writeFileSync(draft, `Sample fact [${id}].`);
  store.writeJsonl(dir, 'flags.jsonl', [{ id, flagged: true }], { synthetic: true });
  assert.equal(command.run(['cite', 'demo', '--draft', draft], io), 1);
  store.appendJsonl(dir, 'flags.jsonl', { id, flagged: false }, { synthetic: true });
  assert.equal(command.run(['cite', 'demo', '--draft', draft], io), 0);
  store.writeText(dir, 'entries/invalid.md', '### invalid\nclaim: Sample\nstatus: verified\nsources: S01#A1\n', { synthetic: true });
  assert.equal(command.run(['cite', 'demo', '--draft', draft], io), 1);
});

test('citation checks read only sample KB and temp fixtures', (t) => {
  const { home, draft, io } = fixture(t);
  fs.writeFileSync(draft, `Sample fact [${id}].`);
  const read = fs.readFileSync;
  const reads = [];
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    reads.push(path.resolve(file));
    return read(file, ...args);
  });
  assert.equal(cite.check(kb.load(sample), `Sample fact [${id}].`).ok, true);
  assert.equal(command.run(['cite', 'demo', '--draft', draft], io), 0);
  assert.ok(reads.includes(draft));
  assert.ok(reads.length >= 6);
  for (const file of reads) assert.ok(file.startsWith(`${sample}${path.sep}`) || file.startsWith(`${home}${path.sep}`), file);
});
