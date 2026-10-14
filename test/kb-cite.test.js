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
const kbCheck = require('../lib/kb-check');
const ssot = require('../lib/kb-ssot');
const twinCheck = require('../lib/twin-check');
const kbGates = require('../lib/kb-gates');

const sample = path.resolve(__dirname, '../sample/kb/demo');
const id = 'demo.model.provider';

const ackLines = ['ありがとうございます！', 'ありがとうございます。', '確認ありがとうございます！',
  '確認ありがとうございます。', 'ご確認ありがとうございます！', 'ご確認ありがとうございます。',
  'Thanks!', 'Thanks for checking.'];

test('ack allowlist is exact and ordered; only the first non-empty whole line is exempt', () => {
  assert.deepEqual(cite.ACK_LINES, ackLines);
  const kbData = kb.load(sample);
  const answer = `Sample fact [${id}].\n- Another fact [${id}].`;
  for (const phrase of ackLines) {
    for (const prefix of ['', '\n \r\n']) {
      const text = `${prefix}  ${phrase}  \r\n${answer}`;
      const result = cite.check(kbData, text);
      assert.equal(result.ok, true);
      assert.deepEqual(result.sentences[0], { text: phrase, ids: [], problems: [], exempt: true });
      assert.equal(result.sentences.length, 3);
      assert.deepEqual(result.cited, [id]);
      assert.equal(twinCheck.checkSpecReply(text, { kbData }).facts, 2);
    }
  }
});

for (const [name, text, exemptions] of [
  ['ack plus fact on one line', 'ありがとうございます！東京リージョンです。', 0],
  ['ack on line two', `Sample fact [${id}].\nありがとうございます！`, 0],
  ['two ack lines', 'ありがとうございます！\nThanks for checking.', 1],
  ['near-miss ack', 'ありがとうございます!!', 0],
  ['uncited heading', `**結論**\nSample fact [${id}].`, 0],
  ['prose hedge', `Sample fact [${id}].\n手元の資料では確認できませんでした。`, 0],
  ['ack after a quote', '> Sample quotation.\nThanks!', 0],
  ['ack after a fallback pair', 'Not covered.\nClosest topic: model\nThanks!', 0],
]) {
  test(`${name} still fails citation gate`, () => {
    const result = cite.check(kb.load(sample), text);
    assert.equal(result.ok, false);
    assert.ok(result.sentences.some((sentence) => sentence.problems.includes('no-citation')));
    assert.equal(result.sentences.filter((sentence) => sentence.exempt).length, exemptions);
  });
}

test('every exempt ack still receives scrub checks without echoing matches', () => {
  const kbData = kb.load(sample);
  for (const phrase of ackLines) {
    const result = cite.check(kbData, phrase, { scrub: [phrase] });
    assert.equal(result.ok, false);
    assert.deepEqual(result.sentences, [{ text: '[redacted]', ids: [], problems: ['scrub'], exempt: true }]);
    assert.equal(JSON.stringify(result).includes(phrase), false);
    assert.equal(twinCheck.checkSpecReply(phrase, { kbData, scrub: [phrase] }).facts, 0);
  }
});

test('cited facts followed by hand-back grade partial for P coverage', () => {
  const kbData = kb.load(sample);
  for (const form of ['要確認（人の判断が必要です）。', 'Needs human.']) {
    const text = `Thanks!\nSample fact [${id}].\n${form}\nReason: The retention period is not covered.`;
    const shape = twinCheck.checkSpecReply(text, { kbData });
    assert.equal(shape.ok, true);
    assert.equal(shape.handback, true);
    assert.equal(shape.facts, 1);
    const result = kbGates.grade({
      run: { kb: { digest_hash: 'digest' } }, cases: [{ id: 'sample-13', layer: 'knowledge' }],
      drafts: [{ case_id: 'sample-13', skill: 'spec-answer', kb: { name: 'demo' }, shape,
        gates: { citation: true, resolves: true, current: true, scrub: true } }],
      support: [{ case_id: 'sample-13', sentences: [{ verdict: 'supported' }] }],
      coverage: { kb_digest_hash: 'digest', cases: { 'sample-13': { coverage: 'P', entries: [id] } } },
    });
    assert.equal(result.counts.partial, 1);
    assert.equal(result.cases[0].outcome, 'partial');
    assert.equal(result.cases[0].pass, true);
    assert.equal(result.status, 'pass');
  }
});

test('KB reply shape counts facts and marks existing exempt sentence rows', () => {
  const kbData = kb.load(sample);
  const template = fs.readFileSync(path.join(__dirname, '../templates/twin/spec-answer-kb.md'), 'utf8');
  const forms = [...template.matchAll(/^```text\n([^`]+)\n```$/gm)]
    .map((match) => match[1].replace('<topic>', 'model').replace('<one line>', 'Review needed.'));
  const answer = `Sample fact [${id}].\nAnother fact [${id}].`;
  const cases = [
    [answer, false, false, 2],
    ...forms.map((form, index) => [form, index < 2, index >= 2, 0]),
    ...forms.slice(2).map((form) => [`${answer}\n${form}`, false, true, 2]),
    [`> Sample quotation. No citation?\n${answer}`, false, false, 2],
    ['Uncited fact.', false, false, 1],
    ['Not covered.\nClosest topic: ', false, false, 2],
    ['Needs human.\nReason: ', false, false, 2],
  ];
  for (const [text, abstain, handback, facts] of cases) {
    const result = cite.check(kbData, text);
    assert.ok(result.sentences.every((sentence) => sentence.exempt === false), text);
    const checked = twinCheck.checkSpecReply(text, { kbData });
    assert.deepEqual({ abstain: checked.abstain, handback: checked.handback, facts: checked.facts },
      { abstain, handback, facts }, text);
    assert.deepEqual(checked.sentences, result.sentences);
  }
  for (const text of ['> Private sample.', ...forms.map((form) => form.replace(/model|Review needed\./, 'Private sample.'))]) {
    const result = cite.check(kbData, text, { scrub: ['Private sample'] });
    assert.deepEqual(result.sentences, [{ text: '[redacted]', ids: [], problems: ['scrub'], exempt: true }]);
    const checked = twinCheck.checkSpecReply(text, { kbData, scrub: ['Private sample'] });
    assert.equal(checked.facts, 0);
    assert.equal(checked.ok, false);
    assert.deepEqual(checked.sentences, result.sentences);
  }
});

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
      ok: true, abstain: false, handback: false, cited: [id], sentences: [{ text, ids: [id], problems: [], exempt: false }],
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
    assert.deepEqual(cite.check(data, text), {
      ok: false, abstain: false, handback: false, cited: ids, sentences: [{ text, ids, problems, exempt: false }],
    });
  }
});

test('every trailing citation must resolve and be citable; problems are unique', () => {
  const text = `A sample fact [${id}][demo.model.absent][demo.model.region][demo.model.legacy].`;
  assert.deepEqual(cite.check(kb.load(sample), text), {
    ok: false, abstain: false, handback: false,
    cited: [id, 'demo.model.absent', 'demo.model.region', 'demo.model.legacy'], sentences: [{ text,
      ids: [id, 'demo.model.absent', 'demo.model.region', 'demo.model.legacy'],
      problems: ['unknown-id', 'not-citable'], exempt: false }],
  });
  const misplaced = `According to [${id}], a sample fact.`;
  assert.deepEqual(cite.check(kb.load(sample), misplaced).sentences,
    [{ text: misplaced, ids: [], problems: ['no-citation'], exempt: false }]);
});

test('Japanese, English, question marks and newlines each split sentences', () => {
  const parts = [`架空の事実。[${id}]`, '引用なし？', `Sample fact [${id}].`, 'Uncited?', '改行だけ', `最後 [${id}]`];
  const result = cite.check(kb.load(sample), `${parts[0]}${parts[1]}${parts[2]} ${parts[3]}\r\n${parts[4]}\n${parts[5]}`);
  assert.equal(result.ok, false);
  assert.deepEqual(result.sentences, parts.map((text, index) => ({ text,
    ids: [0, 2, 5].includes(index) ? [id] : [],
    problems: [0, 2, 5].includes(index) ? [] : ['no-citation'],
    exempt: false,
  })));
});

test('empty and quoted lines are exempt without marking abstention', () => {
  assert.deepEqual(cite.check(kb.load(sample), '\n  \r\n> Sample quotation. No citation?\n  > 引用。\n'),
    { ok: true, abstain: false, handback: false, cited: [], sentences: [] });
});

test('only a complete two-line abstention form is exempt', () => {
  const data = kb.load(sample);
  for (const phrase of ['該当する情報がありません。', 'Not covered.']) {
    assert.deepEqual(cite.check(data, `${phrase}\nClosest topic: model`),
      { ok: true, abstain: true, handback: false, cited: [], sentences: [] });
    assert.equal(cite.check(data, phrase).ok, false);
    assert.equal(cite.check(data, `${phrase}\nClosest topic: `).ok, false);
    assert.equal(cite.check(data, `${phrase} Extra claim\nClosest topic: model`).abstain, false);
    const mixed = cite.check(data, `${phrase}\nClosest topic: model\nUncited fact.`);
    assert.deepEqual(mixed, { ok: false, abstain: true, handback: false, cited: [],
      sentences: [{ text: 'Uncited fact.', ids: [], problems: ['no-citation'], exempt: false }] });
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

test('citation metadata collects unique trailing ids in reply order', () => {
  const other = 'demo.model.region';
  const result = cite.check(kb.load(sample), `Sample [${id}][${other}][${id}].\nAgain [${other}].`);
  assert.deepEqual(result.cited, [id, other]);
  assert.equal(result.handback, false);
  assert.deepEqual(cite.check(kb.load(sample), '').cited, []);
  assert.deepEqual(cite.check(kb.load(sample), `According to [${id}], a sample fact.`).cited, []);
});

test('citation results retain the same plain fields with or without scrub options', () => {
  const data = kb.load(sample);
  for (const text of [`Sample fact [${id}].`, 'Not covered.\nClosest topic: model',
    'Needs human.\nReason: Review needed.']) {
    const result = cite.check(data, text);
    assert.deepEqual(result, cite.check(data, text, { scrub: [] }));
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  }
});

test('shared scrub reader normalizes lists and distinguishes missing defaults from explicit files', (t) => {
  const { home, dir } = fixture(t);
  assert.deepEqual(kbCheck.readScrubList(dir), []);
  assert.throws(() => kbCheck.readScrubList(dir, `${dir}.scrub.txt`), { message: 'Cannot read scrub list.' });
  store.writeText(path.dirname(dir), 'demo.scrub.txt', '\r\n  ＬｕｍａＣｌｉｅｎｔ  \r\n\t\r\nLumaClient\r\n', { synthetic: true });
  assert.deepEqual(kbCheck.readScrubList(dir), ['lumaclient']);
  const scrubFile = path.join(home, 'scrub-list.txt');
  store.writeText(home, 'scrub-list.txt', '  Sample Client  \n', { synthetic: true });
  assert.deepEqual(kbCheck.readScrubList(dir, scrubFile), ['sample client']);
  assert.throws(() => kbCheck.readScrubList(dir, home), { message: 'Cannot read scrub list.' });
});

test('fallback forms in the KB template are exempt and set their respective metadata', () => {
  const template = fs.readFileSync(path.join(__dirname, '../templates/twin/spec-answer-kb.md'), 'utf8');
  const forms = [...template.matchAll(/^```text\n([^`]+)\n```$/gm)].map((match) => match[1]);
  assert.deepEqual(forms, [
    '該当する情報がありません。\nClosest topic: <topic>',
    'Not covered.\nClosest topic: <topic>',
    '要確認（人の判断が必要です）。\nReason: <one line>',
    'Needs human.\nReason: <one line>',
  ]);
  for (const [index, form] of forms.entries()) {
    const result = cite.check(kb.load(sample), form.replace('<topic>', 'model').replace('<one line>', 'A commitment needs review.'));
    assert.equal(result.ok, true);
    assert.equal(result.abstain, index < 2);
    assert.equal(result.handback, index >= 2);
    assert.deepEqual(result.cited, []);
    assert.deepEqual(result.sentences, []);
  }
});

test('only complete hand-back pairs are exempt and remaining sentences still need citations', () => {
  const data = kb.load(sample);
  for (const phrase of ['要確認（人の判断が必要です）。', 'Needs human.']) {
    for (const text of [phrase, `${phrase}\nReason: `, `${phrase} Extra claim\nReason: Review needed.`,
      `${phrase}\nreason: Review needed.`, `${phrase}\n\nReason: Review needed.`]) {
      const result = cite.check(data, text);
      assert.equal(result.ok, false);
      assert.equal(result.handback, false);
    }
    const result = cite.check(data, `${phrase}\nReason: Review needed.\nUncited fact.`);
    assert.equal(result.ok, false);
    assert.equal(result.handback, true);
    assert.deepEqual(result.sentences, [{ text: 'Uncited fact.', ids: [], problems: ['no-citation'], exempt: false }]);
  }
});

test('scrub gate normalizes both inputs and reports only the affected sentence without echoing it', () => {
  const data = kb.load(sample);
  const scrub = ['  ＬｕｍａＣｌｉｅｎｔ  ', 'LumaClient', '\n\t', '  架空 顧客  '];
  for (const word of ['LumaClient', 'ＬＵＭＡＣＬＩＥＮＴ', 'lumaclient', '架空\t顧客']) {
    const result = cite.check(data, `Safe sample [${id}].\n${word} sample [${id}].\nSafe again [${id}].`, { scrub });
    assert.equal(result.ok, false);
    assert.deepEqual(result.sentences.map((sentence) => sentence.problems), [[], ['scrub'], []]);
    assert.equal(result.sentences[1].text, '[redacted]');
    assert.deepEqual(result.cited, [id]);
    assert.equal(JSON.stringify(result).includes(word), false);
  }
  assert.equal(cite.check(data, `LumaClient sample [${id}].`, { scrub: [] }).ok, true);
});

test('scrub findings retain citation failures and redact scrubbed citation ids', () => {
  const data = kb.load(sample);
  const result = cite.check(data, 'LumaClient uncited.\nUnknown [demo.model.lumaclient].', { scrub: ['LumaClient'] });
  assert.equal(result.ok, false);
  assert.deepEqual(result.sentences.map((sentence) => sentence.problems), [
    ['no-citation', 'scrub'], ['unknown-id', 'scrub'],
  ]);
  assert.equal(JSON.stringify(result).toLowerCase().includes('lumaclient'), false);
  assert.equal(result.cited.some((value) => value.toLowerCase().includes('lumaclient')), false);
});

test('citation-exempt quotes and fallback details still receive the scrub gate', () => {
  const data = kb.load(sample);
  for (const text of ['> LumaClient sample.', 'Not covered.\nClosest topic: LumaClient',
    'Needs human.\nReason: LumaClient commitment.', '要確認（人の判断が必要です）。\nReason: LumaClient commitment.']) {
    const result = cite.check(data, text, { scrub: ['LumaClient'] });
    assert.equal(result.ok, false);
    assert.deepEqual(result.sentences.map((sentence) => sentence.problems), [['scrub']]);
    assert.equal(JSON.stringify(result).includes('LumaClient'), false);
  }
});

test('CLI reads the default scrub file and emits only a numbered scrub diagnostic', (t) => {
  const { dir, draft, io, output } = fixture(t);
  store.writeText(path.dirname(dir), 'demo.scrub.txt', '\r\n  ＬｕｍａＣｌｉｅｎｔ  \r\n\t\r\nLumaClient\r\n', { synthetic: true });
  fs.writeFileSync(draft, `Safe sample [${id}].\nLUMACLIENT sample [${id}].\nSafe again [${id}].`);
  assert.equal(command.run(['cite', 'demo', '--draft', draft], io), 1);
  assert.deepEqual(output(), { stdout: 'sentence 2: scrub\n', stderr: '' });
  assert.equal(JSON.stringify(output()).toLowerCase().includes('lumaclient'), false);
});

test('CLI scrub diagnostics omit sentence text even when citation checks also fail', (t) => {
  const { dir, draft, io, output } = fixture(t);
  store.writeText(path.dirname(dir), 'demo.scrub.txt', 'LumaClient\n', { synthetic: true });
  fs.writeFileSync(draft, 'LumaClient uncited.\nUnknown [demo.model.lumaclient].');
  assert.equal(command.run(['cite', 'demo', '--draft', draft], io), 1);
  assert.deepEqual(output(), { stdout: 'sentence 1: no-citation\nsentence 1: scrub\nsentence 2: unknown-id\nsentence 2: scrub\n', stderr: '' });
});

test('CLI accepts empty scrub lists and hand-backs, and fails closed on unreadable scrub files', (t) => {
  const { dir, draft, io, output } = fixture(t);
  fs.writeFileSync(draft, 'Needs human.\nReason: A commitment needs review.');
  assert.equal(command.run(['cite', 'demo', '--draft', draft], io), 0);
  store.writeText(path.dirname(dir), 'demo.scrub.txt', '\n　\n', { synthetic: true });
  assert.equal(command.run(['cite', 'demo', '--draft', draft], io), 0);
  assert.deepEqual(output(), { stdout: '', stderr: '' });
  fs.unlinkSync(`${dir}.scrub.txt`);
  fs.mkdirSync(`${dir}.scrub.txt`);
  assert.equal(command.run(['cite', 'demo', '--draft', draft], io), 1);
  assert.deepEqual(output(), { stdout: '', stderr: 'Cannot read scrub list.\n' });
});

test('ssot citations resolve approved statements and distinguish existing from unknown ids', (t) => {
  const { dir } = fixture(t);
  store.writeJson(dir, 'kb.json', { ...kb.load(dir).manifest, digest: 'ssot' }, { synthetic: true });
  store.writeText(dir, 'ssot.md', '# Demo SSOT\n'
    + '## model\ntitle: Model\n### demo.model.s1\ntext: Sample model.\nbacks: demo.model.provider\n'
    + '## stale\ntitle: Stale\n### demo.stale.s1\ntext: Old sample.\nbacks: demo.model.provider\n'
    + '## draft\ntitle: Draft\n### demo.draft.s1\ntext: Draft sample.\nbacks: demo.model.provider\n',
  { synthetic: true });
  let data = kb.load(dir);
  store.writeJsonl(dir, 'ssot-approvals.jsonl', data.ssot.sections.slice(0, 2).map((section) => ({
    id: section.section, approved_at: '2026-10-14', text_hash: ssot.textHash(section),
    backing_hash: section.section === 'stale' ? '0'.repeat(64) : ssot.backingHash(section, data),
  })), { synthetic: true });
  data = kb.load(dir);
  assert.deepEqual(data.errors, []);
  assert.equal(ssot.states(data).get('stale'), 'stale');
  for (const [citedId, problems] of [
    ['demo.model.s1', []], [id, ['not-citable']], ['demo.model.region', ['not-citable']],
    ['demo.stale.s1', ['not-citable']], ['demo.draft.s1', ['not-citable']],
    ['demo.missing.s1', ['unknown-id']],
  ]) {
    const text = `Sample fact [${citedId}].`;
    assert.deepEqual(cite.check(data, text), {
      ok: problems.length === 0, abstain: false, handback: false, cited: [citedId],
      sentences: [{ text, ids: [citedId], problems, exempt: false }],
    });
  }
  data.ssot.sections[0].statements[0].text += ' Edited.';
  assert.deepEqual(cite.check(data, 'Sample fact [demo.model.s1].').sentences[0].problems, ['not-citable']);
  data.ssot.sections[0].statements[0].text = 'Sample model.';
  data.flags.set(id, { id, flagged: true });
  assert.deepEqual(cite.check(data, 'Sample fact [demo.model.s1].').sentences[0].problems, ['not-citable']);
  data.flags.clear();
  data.manifest.digest = 'entries';
  assert.equal(cite.check(data, `Sample fact [${id}].`).ok, true);
  assert.deepEqual(cite.check(data, 'Sample fact [demo.model.s1].').sentences[0].problems, ['not-citable']);
});
