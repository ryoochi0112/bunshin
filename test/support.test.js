'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const kb = require('../lib/kb');
const kbSsot = require('../lib/kb-ssot');
const support = require('../lib/support');
const twin = require('../lib/twin');

const sampleKb = path.resolve(__dirname, '../sample/kb/demo');
const entry = { id: 'demo.model.provider', claim: 'Cloudberry Lantern uses Akari.',
  select: { model: 'Akari' }, note: 'PRIVATE NOTE', question: 'PRIVATE QUESTION', status: 'verified' };
const sentence = { text: 'Cloudberry Lantern uses Akari. [demo.model.provider]',
  ids: [entry.id], exempt: false };
const valid = { verdict: 'supported', reason: 'The entry states it.' };

function host(replies) {
  const calls = [];
  return { calls, async run(input) {
    calls.push(input);
    const text = replies[calls.length - 1];
    if (text instanceof Error) throw text;
    return { text, model: 'returned' };
  } };
}

function approvedSsotData(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-support-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = kb.resolve({ name: 'demo', env: { BUNSHIN_HOME: home } });
  fs.cpSync(sampleKb, dir, { recursive: true });
  const data = kb.load(dir);
  const backingEntry = data.entries.find(({ id }) => id === entry.id);
  const statement = { id: 'demo.model.s1', text: 'Cloudberry Lantern uses 灯り.',
    backs: [backingEntry.id], select: { 利用AI: '灯り' } };
  const section = { section: 'model', title: 'Model', statements: [statement] };
  data.manifest.digest = 'ssot';
  data.ssot = { sections: [section], approvals: new Map() };
  data.ssot.approvals.set('model', { id: 'model', text_hash: kbSsot.textHash(section),
    backing_hash: kbSsot.backingHash(section, data) });
  return { data, statement, backingEntry };
}

test('support prompt renders only the sentence and entry id, claim and select', () => {
  const prompt = support.buildPrompt(sentence, [entry]);
  assert.equal(prompt, `Sentence:\n${sentence.text}\n\nEntries:\n${JSON.stringify([
    { id: entry.id, claim: entry.claim, select: entry.select },
  ])}`);
  for (const text of ['PRIVATE NOTE', 'PRIVATE QUESTION', 'verified']) assert.ok(!prompt.includes(text));
});

test('support parser accepts only its schema, bare or JSON fenced', () => {
  assert.equal(support.outputSchema.additionalProperties, false);
  assert.deepEqual(support.outputSchema.required, ['verdict', 'reason']);
  assert.deepEqual(support.outputSchema.properties.verdict.enum, ['supported', 'partly', 'not_supported']);
  for (const verdict of support.outputSchema.properties.verdict.enum) {
    const row = { ...valid, verdict };
    assert.deepEqual(support.parse(JSON.stringify(row)), row);
    assert.deepEqual(support.parse(`\`\`\`json\n${JSON.stringify(row)}\n\`\`\``), row);
  }
  for (const value of [null, [], {}, { verdict: 'supported' }, { reason: 'why' },
    { ...valid, verdict: 'support_error' }, { ...valid, reason: ' ' }, { ...valid, reason: 1 },
    { ...valid, extra: 'secret' }]) assert.throws(() => support.parse(JSON.stringify(value)), /Invalid support field:/);
  for (const text of [undefined, 'private invalid output', `prefix ${JSON.stringify(valid)}`]) {
    assert.throws(() => support.parse(text), (error) => /Invalid support field:/.test(error.message)
      && !error.message.includes('private'));
  }
});

test('support system strips frontmatter and pins the template hash', (t) => {
  const file = path.join(__dirname, '..', 'templates', 'support-judge.md');
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(support.system(), twin.stripTemplateFrontmatter(text));
  assert.doesNotMatch(support.system(), /^(---|name:|description:)/m);
  const before = support.rubricHash();
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (target, ...args) => target === file ? `${text}\nChanged rule.\n` : read(target, ...args));
  assert.notEqual(support.rubricHash(), before);
});

test('support judges only eligible sentences and persists no text or reason', async () => {
  const adapter = host([JSON.stringify(valid)]);
  const sentences = [sentence, { ...sentence, exempt: true }, { ...sentence, ids: [] },
    { ...sentence, ids: ['demo.model.missing'] }, { ...sentence, ids: [entry.id, 'demo.model.missing'] },
    { ...sentence, text: '[redacted]' }, { ...sentence, ids: ['[redacted]'] }];
  const result = await support.judgeDraft({ host: adapter, model: 'requested', draft: { question: 'PRIVATE QUESTION' },
    sentences, kbData: { entries: [entry] } });
  assert.deepEqual(result, { sentences: [{ index: 0, ids: [entry.id], verdict: 'supported' }], model: 'returned' });
  assert.equal(adapter.calls.length, 1);
  assert.deepEqual(adapter.calls[0], { system: support.system(), prompt: support.buildPrompt(sentence, [entry]),
    tools: 'none', model: 'requested', outputSchema: support.outputSchema });
  assert.ok(!JSON.stringify(result).includes(sentence.text));
  assert.ok(!JSON.stringify(result).includes(valid.reason));
  const duplicate = host([]);
  assert.deepEqual(await support.judgeDraft({ host: duplicate, model: null, sentences: [sentence],
    kbData: { entries: [entry, entry] } }), { sentences: [], model: null });
  assert.equal(duplicate.calls.length, 0);
});

test('ssot mode judges statement text through kb.citable and skips entry ids', async (t) => {
  const { data, statement, backingEntry } = approvedSsotData(t);
  const ssotSentence = { text: `${statement.text} [${statement.id}]`,
    ids: [statement.id], exempt: false };
  const adapter = host([JSON.stringify(valid)]);
  const result = await support.judgeDraft({ host: adapter, sentences: [ssotSentence], kbData: data });

  assert.equal(kb.mode(data), 'ssot');
  assert.deepEqual(result.sentences, [{ index: 0, ids: [statement.id], verdict: 'supported' }]);
  assert.equal(adapter.calls.length, 1);
  assert.ok(adapter.calls[0].prompt.includes(statement.id));
  assert.ok(adapter.calls[0].prompt.includes(statement.text));
  assert.ok(!adapter.calls[0].prompt.includes(backingEntry.claim));

  const entrySentence = { text: `${backingEntry.claim} [${backingEntry.id}]`, ids: [backingEntry.id], exempt: false };
  const entryAdapter = host([]);
  assert.deepEqual(await support.judgeDraft({ host: entryAdapter, sentences: [entrySentence], kbData: data }),
    { sentences: [], model: null });
  assert.equal(entryAdapter.calls.length, 0);
});

test('entries mode keeps judging a unique id when its entry is draft and flagged', async () => {
  const flaggedEntry = { ...entry, status: 'draft' };
  const adapter = host([JSON.stringify(valid)]);
  const result = await support.judgeDraft({ host: adapter, sentences: [sentence], kbData: {
    manifest: { digest: 'entries' }, entries: [flaggedEntry], flags: new Map([[entry.id, { flagged: true }]]),
  } });

  assert.deepEqual(result.sentences, [{ index: 0, ids: [entry.id], verdict: 'supported' }]);
  assert.equal(adapter.calls.length, 1);
  assert.deepEqual(JSON.parse(adapter.calls[0].prompt.split('\n\nEntries:\n')[1]), [
    { id: entry.id, claim: entry.claim, select: entry.select },
  ]);
});

test('support retries malformed output once and fails closed, but propagates host errors', async () => {
  for (const [replies, verdict] of [[['invalid', JSON.stringify(valid)], 'supported'], [['invalid', 'invalid'], 'support_error']]) {
    const adapter = host(replies);
    const result = await support.judgeDraft({ host: adapter, sentences: [sentence], kbData: { entries: [entry] } });
    assert.deepEqual(result.sentences, [{ index: 0, ids: [entry.id], verdict }]);
    assert.equal(adapter.calls.length, 2);
    assert.deepEqual(adapter.calls[0], adapter.calls[1]);
  }
  const adapter = host([new Error('host failure')]);
  await assert.rejects(support.judgeDraft({ host: adapter, sentences: [sentence], kbData: { entries: [entry] } }), /host failure/);
  assert.equal(adapter.calls.length, 1);
});
