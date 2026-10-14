'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const kb = require('../lib/kb');
const check = require('../lib/kb-check');
const draft = require('../lib/kb-draft');
const cite = require('../lib/kb-cite');
const store = require('../lib/store');

const sample = path.resolve(__dirname, '../sample/kb/demo');
const options = { synthetic: true };
const source = { kind: 'slack', label: 'Sample KB thread', ref: 'https://example.invalid/demo/thread', answered_at: '2026-10-13' };
const entry = { id: 'demo.model.next', claim: 'Cloudberry Lantern supports a fictional model.', sources: ['S01#E14', 'S02#model'] };

function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-kb-draft-')));
  t.after(() => { store._resetGuardCache(); fs.rmSync(home, { recursive: true, force: true }); });
  const dir = kb.resolve({ name: 'demo', env: { BUNSHIN_HOME: home } });
  for (const file of ['kb.json', 'sources.jsonl', 'entries/model.md']) {
    store.writeText(dir, file, fs.readFileSync(path.join(sample, file), 'utf8'), options);
  }
  return { dir, home };
}

function directoryHash(dir) {
  const hash = crypto.createHash('sha256');
  function walk(relative) {
    for (const item of fs.readdirSync(path.join(dir, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(relative, item.name);
      hash.update(`${file}\0`);
      if (item.isDirectory()) walk(file);
      else hash.update(fs.readFileSync(path.join(dir, file)));
    }
  }
  walk('');
  return hash.digest('hex');
}

test('stale flags only verified entries citing the changed source after their verification date', (t) => {
  const { dir } = fixture(t);
  const before = directoryHash(dir);
  for (const changedAt of ['2026-10-11', '2026-10-12']) {
    assert.deepEqual(draft.stale(dir, { source: 'S01', changedAt }), { flagged: [], skipped: [] });
    assert.equal(directoryHash(dir), before);
  }
  draft.addSources(dir, [source]);
  assert.deepEqual(draft.stale(dir, { source: 'S03', changedAt: '2026-10-13' }), { flagged: [], skipped: [] });
  const entryBytes = fs.readFileSync(path.join(dir, 'entries/model.md'), 'utf8');
  const original = store.appendJsonl;
  const calls = [];
  t.mock.method(store, 'appendJsonl', (...args) => { calls.push(args); return original(...args); });
  assert.deepEqual(draft.stale(dir, { source: 'S01', changedAt: '2026-10-13' }), { flagged: ['demo.model.provider'], skipped: [] });
  const [flag] = store.readJsonl(dir, 'flags.jsonl');
  assert.deepEqual(flag, { id: 'demo.model.provider', flagged: true, reason: 'source S01 changed 2026-10-13', at: flag.at });
  assert.equal(new Date(flag.at).toISOString(), flag.at);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], dir);
  assert.equal(calls[0][1], 'flags.jsonl');
  assert.equal(calls[0][3].synthetic, true);
  assert.equal(fs.readFileSync(path.join(dir, 'entries/model.md'), 'utf8'), entryBytes);
  const reply = cite.check(kb.load(dir), 'Cloudberry Lantern uses a fictional model. [demo.model.provider]');
  assert.equal(reply.ok, false);
  assert.ok(reply.sentences.some((sentence) => sentence.problems.includes('not-citable')));
});

test('stale dry-run preserves all bytes and latest flag reason controls idempotence', (t) => {
  const { dir } = fixture(t);
  const args = { source: 'S01', changedAt: '2026-10-13', reason: 'Sample source revision' };
  const flagged = { flagged: ['demo.model.provider'], skipped: [] };
  const skipped = { flagged: [], skipped: ['demo.model.provider'] };
  const before = directoryHash(dir);
  assert.deepEqual(draft.stale(dir, { ...args, dryRun: true }), flagged);
  assert.equal(directoryHash(dir), before);
  assert.deepEqual(draft.stale(dir, args), flagged);
  const after = directoryHash(dir);
  assert.deepEqual(draft.stale(dir, args), skipped);
  assert.deepEqual(draft.stale(dir, { ...args, dryRun: true }), skipped);
  assert.equal(directoryHash(dir), after);
  assert.deepEqual(draft.stale(dir, { ...args, reason: 'Another sample revision' }), flagged);
  assert.deepEqual(draft.stale(dir, args), flagged);
  store.appendJsonl(dir, 'flags.jsonl', { id: 'demo.model.provider', flagged: false, reason: args.reason, at: new Date().toISOString() }, options);
  assert.deepEqual(draft.stale(dir, args), flagged);
  assert.equal(store.readJsonl(dir, 'flags.jsonl').length, 5);
});

test('stale rejects unknown sources and malformed dates without writes', (t) => {
  const { dir } = fixture(t);
  const before = directoryHash(dir);
  assert.throws(() => draft.stale(dir, { source: 'S99', changedAt: '2026-10-13' }), /unknown source/i);
  for (const changedAt of [undefined, null, 20261013, '2026-2-01', '2026-02-30', '2026-13-01', '2026-10-13T00:00:00Z']) {
    assert.throws(() => draft.stale(dir, { source: 'S01', changedAt }), /YYYY-MM-DD/);
  }
  assert.equal(directoryHash(dir), before);
});

test('addSources assigns ids after the highest existing source and uses the store append writer', (t) => {
  const { dir } = fixture(t);
  const rows = [source, { ...source, id: 'S07', kind: 'sheet', label: 'Sample KB additions', ref: 'https://example.invalid/demo/additions', file_sha256: '1'.repeat(64), superseded_by: 'S02' }];
  const original = store.appendJsonl;
  const calls = [];
  t.mock.method(store, 'appendJsonl', (...args) => { calls.push(args); return original(...args); });
  assert.deepEqual(draft.addSources(dir, rows), { added: [{ ...source, id: 'S03' }, rows[1]] });
  assert.deepEqual(store.readJsonl(dir, 'sources.jsonl').slice(2), [{ ...source, id: 'S03' }, rows[1]]);
  assert.ok(calls.every((args) => args[0] === dir && args[1] === 'sources.jsonl'));
  assert.equal(calls.length, 2);
  const next = draft.addSources(dir, [{ ...source, ref: 'https://example.invalid/demo/next' }]);
  assert.equal(next.added[0].id, 'S08');
  assert.deepEqual(rows, [source, rows[1]]);
  assert.equal(check.run(dir).ok, true);
});

test('generated source ids have two digits minimum and do not fill old gaps', (t) => {
  const { dir } = fixture(t);
  draft.addSources(dir, [{ ...source, id: 'S99' }]);
  assert.equal(draft.addSources(dir, [{ ...source, ref: 'https://example.invalid/demo/100' }]).added[0].id, 'S100');
});

for (const [label, bad, reason] of [
  ['existing id', { ...source, id: 'S01' }, /id already exists/],
  ['existing ref', { ...source, ref: 'https://example.invalid/demo/model' }, /ref already exists/],
  ['existing sha', { ...source, file_sha256: '0'.repeat(64) }, /file_sha256 already exists/],
  ['invalid id', { ...source, id: 'other' }, /id/],
  ['invalid kind', { ...source, kind: 'email' }, /kind/],
  ['missing label', { ...source, label: '' }, /label/],
  ['invalid date', { ...source, answered_at: '2026-02-30' }, /answered_at/],
  ['missing date', { ...source, answered_at: undefined }, /answered_at/],
  ['invalid sha', { ...source, file_sha256: 'bad' }, /file_sha256/],
  ['invalid supersession', { ...source, superseded_by: 2 }, /superseded_by/],
  ['scrub label', { ...source, label: 'ＬＵＭＡＣＬＩＥＮＴ' }, /label.*scrub/],
  ['scrub ref', { ...source, ref: 'https://example.invalid/LumaClient' }, /ref.*scrub/],
  ['email label', { ...source, label: 'demo.person@example.invalid' }, /label.*email.*phone/],
  ['email ref', { ...source, ref: 'https://example.invalid/demo.person@example.invalid' }, /ref.*email.*phone/],
  ['phone ref', { ...source, ref: 'https://example.invalid/０９０－１２３４－５６７８' }, /ref.*email.*phone/],
  ['non-object', null, /object/],
]) {
  test(`addSources refuses ${label} in row 2 without changing any files`, (t) => {
    const { dir } = fixture(t);
    store.writeText(path.dirname(dir), 'demo.scrub.txt', 'LumaClient\n', options);
    const before = directoryHash(dir);
    assert.throws(() => draft.addSources(dir, [{ ...source, ref: 'https://example.invalid/demo/first' }, bad]), (error) => {
      assert.match(error.message, /^Row 2:/);
      assert.match(error.message, reason);
      assert.ok(!error.message.includes('LumaClient'));
      return true;
    });
    assert.equal(directoryHash(dir), before);
  });
}

for (const field of ['id', 'ref', 'file_sha256']) {
  test(`addSources rejects duplicate ${field} within the batch`, (t) => {
    const { dir } = fixture(t);
    const first = { ...source, id: 'S03', file_sha256: '2'.repeat(64) };
    const second = { ...source, id: 'S04', ref: 'https://example.invalid/demo/second', file_sha256: '3'.repeat(64), [field]: first[field] };
    const before = directoryHash(dir);
    assert.throws(() => draft.addSources(dir, [first, second]), { message: new RegExp(`^Row 2:.*${field} already exists`) });
    assert.equal(directoryHash(dir), before);
  });
}

test('addEntries appends exact blocks, creates topics, and records answers through store writers', (t) => {
  const { dir } = fixture(t);
  const before = fs.readFileSync(path.join(dir, 'entries/model.md'), 'utf8');
  store.appendJsonl(dir, 'answers.jsonl', { row_id: 'sample-old', entry: 'demo.model.provider' }, options);
  const answer = { row_id: 14, cell: 'E14', question: 'Which fictional model?', answer: 'Lantern', answer_type: 'text' };
  const rows = [
    { ...entry, id: 'demo.security.encryption', select: { transport: 'fictional TLS', storage: 'fictional encryption' }, note: 'Sample review.', answers: [answer] },
    entry,
    { ...entry, id: 'demo.model.future' },
  ];
  const write = store.writeText;
  const append = store.appendJsonl;
  const writes = [];
  const appends = [];
  t.mock.method(store, 'writeText', (...args) => { writes.push(args); return write(...args); });
  t.mock.method(store, 'appendJsonl', (...args) => { appends.push(args); return append(...args); });
  assert.deepEqual(draft.addEntries(dir, rows), { added: rows.map((row) => row.id) });
  assert.equal(fs.readFileSync(path.join(dir, 'entries/model.md'), 'utf8'), before
    + '\n### demo.model.next\nclaim: Cloudberry Lantern supports a fictional model.\nstatus: draft\nsources: S01#E14, S02#model\n'
    + '\n### demo.model.future\nclaim: Cloudberry Lantern supports a fictional model.\nstatus: draft\nsources: S01#E14, S02#model\n');
  assert.equal(fs.readFileSync(path.join(dir, 'entries/security.md'), 'utf8'), '# security\n'
    + '\n### demo.security.encryption\nclaim: Cloudberry Lantern supports a fictional model.\nstatus: draft\nsources: S01#E14, S02#model\n'
    + 'select: transport=fictional TLS; storage=fictional encryption\nnote: Sample review.\n');
  assert.deepEqual(store.readJsonl(dir, 'answers.jsonl'), [
    { row_id: 'sample-old', entry: 'demo.model.provider' },
    { ...answer, source: 'S01', entry: rows[0].id, excluded: null, why: '' },
  ]);
  assert.equal(writes.length, 2);
  assert.equal(appends.length, 1);
  assert.ok(writes.every((args) => args[0] === dir && args[3].synthetic === true));
  assert.equal(appends[0][1], 'answers.jsonl');
  assert.deepEqual(kb.load(dir).errors, []);
  assert.equal(check.run(dir).ok, true);
});

test('entry appends preserve CRLF and a missing final newline in all prior bytes', (t) => {
  const { dir } = fixture(t);
  const before = fs.readFileSync(path.join(dir, 'entries/model.md'), 'utf8').trimEnd().replace(/\n/g, '\r\n');
  store.writeText(dir, 'entries/model.md', before, options);
  draft.addEntries(dir, [entry]);
  assert.equal(fs.readFileSync(path.join(dir, 'entries/model.md'), 'utf8'), before
    + '\n### demo.model.next\nclaim: Cloudberry Lantern supports a fictional model.\nstatus: draft\nsources: S01#E14, S02#model\n');
});

for (const [label, bad, reason] of [
  ['bad prefix', { ...entry, id: 'other.model.next' }, /prefix/],
  ['invalid id', { ...entry, id: 'demo.Model.next' }, /id/],
  ...['provider', 'region', 'retention', 'legacy'].map((slug) => [`existing ${slug}`, { ...entry, id: `demo.model.${slug}` }, /id already exists/]),
  ['unknown source', { ...entry, sources: ['S99#E1'] }, /unknown source/],
  ['invalid ref', { ...entry, sources: ['S01'] }, /source reference/],
  ['no sources', { ...entry, sources: [] }, /sources/],
  ['empty claim', { ...entry, claim: '' }, /claim/],
  ['multiline claim', { ...entry, claim: 'Sample\nstatus: verified' }, /claim/],
  ['inline comment', { ...entry, claim: 'Sample  # hidden claim' }, /claim/],
  ['scrub claim', { ...entry, claim: 'ＬＵＭＡＣＬＩＥＮＴ' }, /claim.*scrub/],
  ['scrub select key', { ...entry, select: { LumaClient: 'sample' } }, /select.*scrub/],
  ['scrub select value', { ...entry, select: { model: 'LumaClient' } }, /select.*scrub/],
  ['scrub note', { ...entry, note: 'LumaClient' }, /note.*scrub/],
  ['email claim', { ...entry, claim: 'demo.person@example.invalid' }, /claim.*email.*phone/],
  ['phone select', { ...entry, select: { tel: '03-1234-5678' } }, /select.*email.*phone/],
  ['phone note', { ...entry, note: '０９０－１２３４－５６７８' }, /note.*email.*phone/],
  ['invalid select', { ...entry, select: [] }, /select/],
  ['select delimiter', { ...entry, select: { model: 'one; two' } }, /select/],
  ['invalid answers', { ...entry, answers: [{}] }, /answers/],
  ['non-object', [], /object/],
]) {
  test(`addEntries refuses ${label} in row 2 without changing any files`, (t) => {
    const { dir } = fixture(t);
    store.writeText(path.dirname(dir), 'demo.scrub.txt', 'LumaClient\n', options);
    const before = directoryHash(dir);
    assert.throws(() => draft.addEntries(dir, [{ ...entry, id: 'demo.new.first' }, bad]), (error) => {
      assert.match(error.message, /^Row 2:/);
      assert.match(error.message, reason);
      assert.ok(!error.message.includes('LumaClient'));
      return true;
    });
    assert.equal(directoryHash(dir), before);
  });
}

test('addEntries refuses a repeated batch id and reports the first invalid row', (t) => {
  const { dir } = fixture(t);
  const before = directoryHash(dir);
  assert.throws(() => draft.addEntries(dir, [entry, entry, { ...entry, claim: '' }]), /^Error: Row 2:.*id already exists/);
  assert.equal(directoryHash(dir), before);
});

test('both writers honor an explicit scrub file, fail closed, and leave empty batches untouched', (t) => {
  const { dir, home } = fixture(t);
  const scrubFile = path.join(home, 'custom.scrub.txt');
  store.writeText(home, 'custom.scrub.txt', 'Lantern\n', options);
  const before = directoryHash(dir);
  assert.throws(() => draft.addEntries(dir, [entry], { scrubFile }), /Row 1:.*scrub/);
  assert.throws(() => draft.addSources(dir, [{ ...source, label: 'Lantern' }], { scrubFile }), /Row 1:.*scrub/);
  for (const fn of [draft.addSources, draft.addEntries]) {
    assert.throws(() => fn(dir, [], { scrubFile: home }), /Cannot read scrub list/);
    assert.deepEqual(fn(dir, []), { added: [] });
  }
  assert.equal(directoryHash(dir), before);
});

test('draft privacy scan shares kb-check source/date masks and phone patterns', (t) => {
  const { dir } = fixture(t);
  const pii = require('./kb-pii-table');
  for (const [index, text] of pii.clean.entries()) {
    draft.addEntries(dir, [{ ...entry, id: `demo.model.clean-${index}`, note: text }]);
  }
  const before = directoryHash(dir);
  for (const text of pii.phones) {
    assert.throws(() => draft.addEntries(dir, [{ ...entry, note: text }]), /email.*phone/);
  }
  assert.equal(directoryHash(dir), before);
});

for (const [label, ending] of [['CR', '\r'], ['LF', '\n'], ['NUL', '\0'], ['U+2028', '\u2028'], ['U+2029', '\u2029']]) {
  test(`addSources refuses ${label} in every field before writing the batch`, (t) => {
    const { dir } = fixture(t);
    const before = directoryHash(dir);
    for (const [field, value] of [
      ['id', `S04${ending}`], ['kind', `slack${ending}`],
      ['label', `Sample${ending}source`], ['ref', `https://example.invalid/demo/${ending}source`],
      ['answered_at', `2026-10-13${ending}`], ['file_sha256', `${'1'.repeat(64)}${ending}`],
      ['superseded_by', `S02${ending}`],
    ]) {
      assert.throws(() => draft.addSources(dir, [
        { ...source, ref: 'https://example.invalid/demo/first' }, { ...source, [field]: value },
      ]), { message: /^Row 2:/ }, field);
      assert.equal(directoryHash(dir), before, field);
    }
  });

  test(`addEntries refuses ${label} in every field before writing entries or answers`, (t) => {
    const { dir } = fixture(t);
    const answer = { row_id: 'sample-14', cell: 'E14', question: 'Which fictional model?', answer: 'Lantern', answer_type: 'text' };
    const before = directoryHash(dir);
    for (const bad of [
      { ...entry, id: `${entry.id}${ending}` },
      { ...entry, claim: `Sample${ending}claim` },
      { ...entry, sources: [`S01#E14${ending}`] },
      { ...entry, select: { [`model${ending}`]: 'Lantern' } },
      { ...entry, select: { model: `Lantern${ending}model` } },
      { ...entry, note: `a${ending}b` },
      ...Object.keys(answer).map((field) => ({ ...entry, answers: [{ ...answer, [field]: `sample${ending}value` }] })),
    ]) {
      assert.throws(() => draft.addEntries(dir, [
        { ...entry, id: 'demo.new.first', answers: [answer] }, bad,
      ]), { message: /^Row 2:/ });
      assert.equal(directoryHash(dir), before);
    }
  });
}

for (const id of ['demo.model.next', 'demo.new.second']) {
  test(`addEntries reparses the prepared file for ${id} before writing any files`, (t) => {
    const { dir } = fixture(t);
    const before = directoryHash(dir);
    const answer = { row_id: 14, cell: 'E14', question: 'Which fictional model?', answer: 'Lantern', answer_type: 'text' };
    // The writer's prefix turns this single-line value into an inline comment.
    const bad = { ...entry, id, claim: ' # hidden claim' };
    assert.throws(() => draft.addEntries(dir, [
      { ...entry, id: 'demo.new.first', answers: [answer] }, bad,
    ]), { message: /^Row 2: entries\/\w+\.md:\d+ Missing claim\.$/ });
    assert.equal(directoryHash(dir), before);
    assert.deepEqual(kb.load(dir).errors, []);
  });
}

for (const [field, value, id] of [
  ['ref', 'https://example.invalid/demo/model', 'S02'],
  ['file_sha256', '0'.repeat(64), 'S01'],
]) {
  test(`addSources names existing ${id} for duplicate ${field}`, (t) => {
    const { dir } = fixture(t);
    const before = directoryHash(dir);
    assert.throws(() => draft.addSources(dir, [
      { ...source, ref: 'https://example.invalid/demo/first' }, { ...source, [field]: value },
    ]), { message: `Row 2: Source ${field} already exists as ${id}.` });
    assert.equal(directoryHash(dir), before);
  });
}

test('addSources names the assigned batch id and compares SHA-256 without case', (t) => {
  const { dir } = fixture(t);
  const first = { ...source, file_sha256: 'ab'.repeat(32) };
  const before = directoryHash(dir);
  for (const [field, value] of [['ref', first.ref], ['file_sha256', first.file_sha256.toUpperCase()]]) {
    assert.throws(() => draft.addSources(dir, [first, {
      ...source, ref: 'https://example.invalid/demo/second', [field]: value,
    }]), { message: `Row 2: Source ${field} already exists as S03.` });
    assert.equal(directoryHash(dir), before);
  }
  draft.addSources(dir, [{ ...first, id: 'S07' }]);
  const after = directoryHash(dir);
  assert.throws(() => draft.addSources(dir, [{
    ...source, ref: 'https://example.invalid/demo/second', file_sha256: first.file_sha256.toUpperCase(),
  }]), { message: 'Row 1: Source file_sha256 already exists as S07.' });
  assert.equal(directoryHash(dir), after);
});
