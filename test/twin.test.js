'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const kb = require('../lib/kb');
const kbCite = require('../lib/kb-cite');
const store = require('../lib/store');
const twin = require('../lib/twin');
const twinCheck = require('../lib/twin-check');
const { main } = require('../bin/bunshin');

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-twin-')));
  fs.cpSync(path.join(__dirname, '..', 'sample', 'persona'), dir, { recursive: true });
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); store._resetGuardCache(); });
  return dir;
}

function boundFixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-twin-kb-')));
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); store._resetGuardCache(); });
  const dir = path.join(home, 'sample');
  fs.cpSync(path.join(__dirname, '..', 'sample', 'persona'), dir, { recursive: true });
  store.writeJson(dir, 'persona.json', { ...store.readJson(dir, 'persona.json'), kb: 'demo' });
  const env = { BUNSHIN_HOME: home };
  const kbDir = kb.resolve({ name: 'demo', env });
  for (const file of ['kb.json', 'sources.jsonl', 'entries/model.md']) {
    store.writeText(kbDir, file, fs.readFileSync(path.join(__dirname, '..', 'sample', 'kb', 'demo', file), 'utf8'), { synthetic: true });
  }
  return { dir, kbDir, env };
}

const demoDigest = '## model\n- [demo.model.provider] Cloudberry Lantern は架空のモデル「灯り」を利用する。\n'
  + '  select: 利用AI=灯り; 提供元国=架空国\n';
const demoHash = crypto.createHash('sha256').update(demoDigest).digest('hex');

function template(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'templates', 'twin', `${name}.md`), 'utf8');
}

function templateBody(name) {
  const text = template(name);
  return text.slice(text.search(/^# /m));
}

test('composer starts with twin behaviour and omits template frontmatter', (t) => {
  const dir = fixture(t);
  for (const skill of ['spec-answer', 'idea-discussion']) {
    const prompt = twin.composePrompt(dir, skill);
    assert.match(prompt, /^# Twin behaviour\n/);
    assert.doesNotMatch(prompt, /^---\r?$/m);
    assert.doesNotMatch(prompt, /^(?:name|description):/m);
  }
});

test('template stripping removes exactly one leading block and keeps body bytes', () => {
  for (const newline of ['\n', '\r\n']) {
    const header = ['---', 'name: fictional', 'description: Fictional template.', '---', ''].join(newline);
    const body = `# Fictional template${newline}架空の説明。  ${newline}---${newline}name: body metadata${newline}---${newline}`;
    assert.equal(twin.stripTemplateFrontmatter(header + newline + body), body);
    assert.equal(twin.stripTemplateFrontmatter(header + body), body);
    assert.equal(twin.stripTemplateFrontmatter(header + header + body), header + body);
    assert.equal(twin.stripTemplateFrontmatter(body), body);
    assert.equal(twin.stripTemplateFrontmatter(`---${newline}name: unterminated${newline}`), `---${newline}name: unterminated${newline}`);
  }
});

test('composer uses core, exact identity bytes and the selected skill in deterministic order', (t) => {
  const dir = fixture(t);
  // Identity frontmatter, Unicode, CRLF and trailing whitespace are all persona bytes.
  const markdown = '---\r\nname: fictional-identity\r\ndescription: Synthetic identity.\r\n---\r\n\r\n'
    + fs.readFileSync(path.join(dir, 'identity.md'), 'utf8').replace(/\n/g, '\r\n') + '  \r\n';
  store.writeText(dir, 'identity.md', markdown);
  for (const skill of ['spec-answer', 'idea-discussion']) {
    const expected = [templateBody('core'), markdown, templateBody(skill)].join('\n\n');
    assert.equal(twin.composePrompt(dir, skill), expected);
    assert.equal(twin.composePrompt(dir, skill), expected);
    assert.ok(Buffer.from(expected).includes(Buffer.from(markdown)));
  }
  assert.equal(twin.skillForLayer('knowledge'), 'spec-answer');
  assert.equal(twin.skillForLayer('judgment'), 'idea-discussion');
  for (const value of ['unknown', '__proto__', null, undefined]) {
    assert.throws(() => twin.skillForLayer(value), /layer/i);
    assert.throws(() => twin.composePrompt(dir, value), /skill/i);
  }
});

test('compose preserves the unbound prompt bytes and reports no KB for either skill', (t) => {
  const dir = fixture(t);
  const markdown = fs.readFileSync(path.join(dir, 'identity.md'), 'utf8');
  for (const skill of ['spec-answer', 'idea-discussion']) {
    const expected = [templateBody('core'), markdown, templateBody(skill)].join('\n\n');
    assert.deepEqual(twin.compose(dir, skill), { text: expected, kb: null });
    assert.deepEqual(twin.compose(dir, skill, { env: { BUNSHIN_HOME: path.join(dir, 'missing') } }), { text: expected, kb: null });
  }
  for (const skill of ['unknown', '__proto__', null, undefined]) {
    assert.throws(() => twin.compose(dir, skill), /skill/i);
  }
});

test('bound spec-answer composes only the KB template and digest with stripped frontmatter', (t) => {
  const { dir, kbDir, env } = boundFixture(t);
  const note = 'Fictional reviewer-only note must never reach the prompt.';
  const entries = fs.readFileSync(path.join(kbDir, 'entries/model.md'), 'utf8');
  store.writeText(kbDir, 'entries/model.md', entries.replace('note: サンプルの承認済み項目。', `note: ${note}`), { synthetic: true });
  const markdown = fs.readFileSync(path.join(dir, 'identity.md'), 'utf8');
  const text = [templateBody('core'), markdown, templateBody('spec-answer-kb')].join('\n\n') + '\n' + demoDigest;
  assert.deepEqual(twin.compose(dir, 'spec-answer', { env }), {
    text, kb: { name: 'demo', hash: demoHash, count: 1 },
  });
  assert.equal(twin.composePrompt(dir, 'spec-answer', { env }), text);
  assert.match(text, /\[demo\.model\.provider\]/);
  assert.doesNotMatch(text, /Sources:|search Notion|^---\r?$|^(?:name|description):/im);
  assert.ok(!text.includes(note));
  for (const slug of ['region', 'retention', 'legacy']) assert.ok(!text.includes(`[demo.model.${slug}]`));
});

test('composer reuses a supplied bound KB without loading it again', (t) => {
  const { dir, env } = boundFixture(t);
  const bound = kb.loadBound(dir, env);
  const markdown = fs.readFileSync(path.join(dir, 'identity.md'), 'utf8');
  const expected = {
    text: [templateBody('core'), markdown, templateBody('spec-answer-kb')].join('\n\n') + '\n' + demoDigest,
    kb: { name: 'demo', hash: demoHash, count: 1 },
  };
  const load = t.mock.method(kb, 'loadBound');
  assert.deepEqual(twin.compose(dir, 'spec-answer', { env, bound }), expected);
  assert.equal(twin.composePrompt(dir, 'spec-answer', { env, bound }), expected.text);
  assert.deepEqual(twin.compose(dir, 'idea-discussion', { env, bound }), {
    text: [templateBody('core'), markdown, templateBody('idea-discussion')].join('\n\n'), kb: null,
  });
  assert.equal(load.mock.calls.length, 0);
  assert.deepEqual(twin.compose(dir, 'spec-answer', { env }), expected);
  assert.equal(load.mock.calls.length, 1, 'omitting bound still loads the KB');
});

test('composer accepts an explicit null bound without loading a KB', (t) => {
  const { dir, env } = boundFixture(t);
  const markdown = fs.readFileSync(path.join(dir, 'identity.md'), 'utf8');
  const load = t.mock.method(kb, 'loadBound');
  for (const skill of ['spec-answer', 'idea-discussion']) {
    const expected = [templateBody('core'), markdown, templateBody(skill)].join('\n\n');
    assert.deepEqual(twin.compose(dir, skill, { env, bound: null }), { text: expected, kb: null });
    assert.equal(twin.composePrompt(dir, skill, { env, bound: null }), expected);
  }
  assert.equal(load.mock.calls.length, 0);
});

test('bound idea-discussion keeps the original prompt and does not require a readable KB', (t) => {
  const { dir, kbDir, env } = boundFixture(t);
  fs.rmSync(kbDir, { recursive: true, force: true });
  const text = [templateBody('core'), fs.readFileSync(path.join(dir, 'identity.md'), 'utf8'),
    templateBody('idea-discussion')].join('\n\n');
  assert.deepEqual(twin.compose(dir, 'idea-discussion', { env }), { text, kb: null });
  assert.equal(twin.composePrompt(dir, 'idea-discussion', { env }), text);
});

test('bound spec-answer retains an empty digest section when no entry is citable', (t) => {
  const { dir, kbDir, env } = boundFixture(t);
  store.appendJsonl(kbDir, 'flags.jsonl', { id: 'demo.model.provider', flagged: true,
    reason: 'Synthetic review pending', at: '2026-10-13' }, { synthetic: true });
  const result = twin.compose(dir, 'spec-answer', { env });
  assert.ok(result.text.endsWith('# Knowledge base digest\n\n'));
  assert.doesNotMatch(result.text, /\[demo\.model\./);
  assert.deepEqual(result.kb, { name: 'demo', hash: crypto.createHash('sha256').update('').digest('hex'), count: 0 });
});

test('composer refuses absent, uncommitted or mismatched identities', (t) => {
  for (const file of ['identity.json', 'identity.md']) {
    const dir = fixture(t);
    fs.unlinkSync(path.join(dir, file));
    assert.throws(() => twin.composePrompt(dir, 'spec-answer'), /committed identity/i);
  }
  const dir = fixture(t);
  const manifest = store.readJson(dir, 'persona.json');
  for (const version of [0, -1, '1', manifest.version + 1]) {
    store.writeJson(dir, 'persona.json', { ...manifest, version });
    assert.throws(() => twin.composePrompt(dir, 'spec-answer'), /committed identity/i);
  }
});

test('composer reuses identity evidence validation and the held-out firewall', (t) => {
  const dir = fixture(t);
  const value = store.readJson(dir, 'identity.json');
  value.voice[0].evidence = [];
  store.writeJson(dir, 'identity.json', value);
  assert.throws(() => twin.composePrompt(dir, 'idea-discussion'), /Evidence/);
  const clean = fixture(t);
  const heldout = store.readJsonl(clean, 'cases.jsonl')[0];
  store.writeText(clean, 'identity.md', fs.readFileSync(path.join(clean, 'identity.md'), 'utf8') + heldout.reference_answer);
  assert.throws(() => twin.composePrompt(clean, 'spec-answer'), /Held-out/);
});

test('templates state persona, language, privacy, live citations and named objections', () => {
  const core = template('core');
  assert.match(core, /speak as the persona/i);
  assert.match(core, /main language of the question/i);
  assert.match(core, /never post, send or schedule anything/i);
  assert.match(core, /never quote a colleague's message/i);
  const spec = template('spec-answer');
  assert.match(spec, /search Notion.*host's search tool.*answer time/i);
  assert.match(spec, /every factual claim/i);
  assert.match(spec, /- <page title> — <url>/);
  assert.match(spec, /no search tool.*no source/i);
  assert.match(spec, /I do not know/);
  assert.match(spec, /Sources: none/);
  assert.match(spec, /never guess/i);
  const idea = template('idea-discussion');
  assert.match(idea, /position in the first sentence/i);
  assert.match(idea, /at least one objection or question/i);
  assert.match(idea, /\(priority: <name>\)/);
  assert.match(idea, /priority name from the identity/i);
});

test('KB template pins digest-only citations, exact fallback forms and strict reply shape', () => {
  const spec = template('spec-answer-kb');
  assert.match(spec, /^---\nname: spec-answer-kb\n/);
  assert.ok(spec.endsWith('# Knowledge base digest\n'));
  for (const sentence of [
    'Use only facts in the knowledge base digest below.',
    'Every cited sentence ends with one or more `[<id>]` citations taken only from the digest.',
    "Answer in the question's main language.",
    'Do not add a sources block.',
    'Never mention or quote `note` text.',
    'For an N question (no coverage), or when the digest is empty, use only one of these two-line abstain forms:',
    'For a commitment, date, price or contract term, or when two digest statements disagree, use only one of these two-line hand-back forms:',
    'For a P question (partial coverage), answer the covered part with cited sentences, then use the hand-back form whose `Reason:` names the uncovered part.',
    'Each line must be a cited sentence, the optional thanks line, a `>` quote, or part of a fixed two-line form.',
    'No headings, no bold-only lines, no connecting or hedging sentences, and no @mentions.',
    'A `- ` bullet is allowed only as a cited sentence.',
    'You may use one optional thanks line as the first non-empty line only; the whole line must exactly match one of these phrases:',
    'When the user asks you to check their draft or their understanding, confirm supported parts with cited sentences and do not rewrite them. Identify wrong parts with cited sentences; use the hand-back form for unsupported parts.',
  ]) assert.ok(spec.includes(sentence), sentence);
  for (const phrase of kbCite.ACK_LINES) assert.ok(spec.includes(`\`${phrase}\``));
  const forms = [...spec.matchAll(/^```text\n([^`]+)\n```$/gm)].map((match) => match[1]);
  assert.deepEqual(forms, [
    '該当する情報がありません。\nClosest topic: <topic>',
    'Not covered.\nClosest topic: <topic>',
    '要確認（人の判断が必要です）。\nReason: <one line>',
    'Needs human.\nReason: <one line>',
  ]);
  const data = kb.load(path.join(__dirname, '..', 'sample', 'kb', 'demo'));
  for (const form of forms.slice(0, 2)) {
    const result = kbCite.check(data, form.replace('<topic>', 'model'));
    assert.equal(result.ok, true);
    assert.equal(result.abstain, true);
    assert.deepEqual(result.sentences, []);
  }
  assert.doesNotMatch(spec, /Sources:|search Notion/i);
});

test('sources parser reads terminal source blocks, Unicode titles and no-source form', () => {
  const reply = 'Saved previews last seven days [Preview rules](https://example.invalid/preview).\r\n\r\nSources:\r\n'
    + '- Preview rules — https://example.invalid/preview\r\n'
    + '- プレビュー — 保存 — https://example.invalid/ja\r\n';
  assert.deepEqual(twinCheck.parseSources(reply), { sources: [
    { title: 'Preview rules', url: 'https://example.invalid/preview' },
    { title: 'プレビュー — 保存', url: 'https://example.invalid/ja' },
  ], none: false });
  assert.deepEqual(twinCheck.checkSpecReply(reply), { ok: true, problems: [] });
  for (const answer of ['I do not know.', 'わかりません。']) {
    const reply = `${answer}\nSources: none\n`;
    assert.deepEqual(twinCheck.parseSources(reply), { sources: [], none: true });
    assert.deepEqual(twinCheck.checkSpecReply(reply), { ok: true, problems: [] });
  }
});

test('spec check rejects absent or malformed source blocks and empty replies', () => {
  for (const reply of [
    '', null, 'Previews last seven days.', 'Previews last seven days.\nSources:',
    'Answer.\nSources:\n- Preview — not-a-url',
    'Answer.\nSources:\n- Preview — javascript:alert(1)',
    'Answer.\nSources:\n- — https://example.invalid/preview',
    'Answer.\nSources:\n- Preview — https://example.invalid/preview\nMore facts.',
    'Answer.\nSources: none\n- Preview — https://example.invalid/preview',
    'Answer.\nSources: none\nSources: none', 'Sources: none',
  ]) {
    assert.equal(twinCheck.checkSpecReply(reply).ok, false, String(reply));
    assert.ok(twinCheck.checkSpecReply(reply).problems.length > 0);
    assert.deepEqual(twinCheck.parseSources(reply), { sources: [], none: false });
  }
});

test('idea check matches identity priority names exactly and deduplicates in reply order', (t) => {
  const value = store.readJson(fixture(t), 'identity.json');
  const [first, second] = value.priorities.map((priority) => priority.name);
  assert.deepEqual(twinCheck.checkIdeaReply(`Start small. What signal justifies expansion? (priority: ${second})\n`
    + `Can we measure it? (priority: ${first}) (priority: ${second}) (priority: Unknown)`, value), {
    ok: true, named_priorities: [second, first],
  });
  for (const reply of ['', null, 'Start small. Any evidence?', '(priority: Unknown)',
    `(priority: ${value.priorities[0].id})`, `(priority: ${first.toLowerCase()})`]) {
    assert.deepEqual(twinCheck.checkIdeaReply(reply, value), { ok: false, named_priorities: [] });
  }
  assert.deepEqual(twinCheck.checkIdeaReply(`(priority: ${first})`, null), { ok: false, named_priorities: [] });
});

async function cli(args, env = {}) {
  let stdout = '';
  let stderr = '';
  const code = await main(['twin', ...args], {
    env, stdout: { write: (text) => { stdout += text; } }, stderr: { write: (text) => { stderr += text; } },
  });
  return { code, stdout, stderr };
}

function spawnedCli(args, env) {
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'bunshin.js'), 'twin', ...args], {
    env: { ...process.env, ...env, BUNSHIN_PERSONA: '' }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('CLI prints composer output with persona flag or environment selection and rejects bad usage', async (t) => {
  const dir = fixture(t);
  for (const skill of ['spec-answer', 'idea-discussion']) {
    const expected = { code: 0, stdout: twin.composePrompt(dir, skill), stderr: '' };
    assert.deepEqual(await cli(['prompt', '--skill', skill, '--persona', dir]), expected);
    assert.deepEqual(await cli(['prompt', '--skill', skill], { BUNSHIN_PERSONA: dir }), expected);
  }
  for (const args of [[], ['prompt'], ['prompt', '--skill'], ['prompt', '--skill', 'unknown'],
    ['prompt', '--skill', 'spec-answer', 'extra'], ['show', '--skill', 'spec-answer'],
    ['prompt', '--skill', 'spec-answer', '--skill', 'idea-discussion'],
    ['prompt', '--skill', 'spec-answer', '--persona']]) {
    const result = await cli(args, { BUNSHIN_PERSONA: dir });
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Usage: bunshin twin prompt/);
  }
  fs.unlinkSync(path.join(dir, 'identity.md'));
  const result = await cli(['prompt', '--skill', 'spec-answer', '--persona', dir]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /committed identity/i);
});

test('CLI prints bound text and JSON metadata in process and through the executable', async (t) => {
  const { dir, env } = boundFixture(t);
  const composed = twin.compose(dir, 'spec-answer', { env });
  for (const args of [
    ['prompt', '--skill', 'spec-answer'],
    ['prompt', '--skill', 'spec-answer', '--json'],
    ['prompt', '--json', '--skill', 'spec-answer', '--persona', dir],
  ]) {
    const expected = { code: 0, stdout: args.includes('--json') ? `${JSON.stringify(composed)}\n` : composed.text, stderr: '' };
    assert.deepEqual(await cli(args, env), expected);
    assert.deepEqual(spawnedCli(args, env), expected);
    if (args.includes('--json')) assert.deepEqual(JSON.parse(expected.stdout).kb, { name: 'demo', hash: demoHash, count: 1 });
  }
});

test('CLI JSON output reports null for unbound personas and bound idea-discussion', async (t) => {
  const { dir, env } = boundFixture(t);
  const manifest = store.readJson(dir, 'persona.json');
  delete manifest.kb;
  store.writeJson(dir, 'persona.json', manifest);
  for (const skill of ['spec-answer', 'idea-discussion']) {
    const args = ['prompt', '--skill', skill, '--json'];
    const expected = { code: 0, stdout: `${JSON.stringify({ text: twin.composePrompt(dir, skill), kb: null })}\n`, stderr: '' };
    assert.deepEqual(await cli(args, env), expected);
    assert.deepEqual(spawnedCli(args, env), expected);
  }
  store.writeJson(dir, 'persona.json', { ...manifest, kb: 'demo' });
  const args = ['prompt', '--skill', 'idea-discussion', '--json'];
  const expected = { code: 0, stdout: `${JSON.stringify({ text: twin.composePrompt(dir, 'idea-discussion'), kb: null })}\n`, stderr: '' };
  assert.deepEqual(await cli(args, env), expected);
  assert.deepEqual(spawnedCli(args, env), expected);
});

test('composer and CLI refuse missing or malformed bound KBs with the loadBound message', async (t) => {
  for (const malformed of [false, true]) {
    const { dir, kbDir, env } = boundFixture(t);
    let message;
    if (malformed) {
      store.writeText(kbDir, 'entries/model.md', '# model\n### demo.model.provider\nclaim: Synthetic fact.\n'
        + 'status: unknown\nsources: S01#model\nextra: value\n', { synthetic: true });
      message = 'KB demo has parse errors: entries/model.md:4 Invalid status; expected draft, verified, conflict or retired.';
    } else {
      fs.rmSync(kbDir, { recursive: true, force: true });
      message = 'KB demo not found';
    }
    assert.throws(() => twin.compose(dir, 'spec-answer', { env }), { message });
    assert.throws(() => twin.composePrompt(dir, 'spec-answer', { env }), { message });
    for (const json of [false, true]) {
      const args = ['prompt', '--skill', 'spec-answer', ...(json ? ['--json'] : [])];
      const expected = { code: 1, stdout: '', stderr: `${message}\n` };
      assert.deepEqual(await cli(args, env), expected);
      assert.deepEqual(spawnedCli(args, env), expected);
    }
  }
});

test('CLI rejects malformed JSON options and leading or trailing usage junk', async (t) => {
  const { env } = boundFixture(t);
  for (const args of [
    ['prompt', '--skill', 'spec-answer', '--json', '--json'],
    ['prompt', '--skill', 'spec-answer', '--json', 'true'],
    ['prompt', '--skill', 'spec-answer', '--json=true'],
    ['prompt', '--json'], ['prompt', '--skill', '--json'],
    ['junk', 'prompt', '--skill', 'spec-answer', '--json'],
    ['show', '--skill', 'spec-answer', '--json'],
    ['prompt', 'junk', '--skill', 'spec-answer', '--json'],
    ['prompt', '--skill', 'spec-answer', '--json', 'junk'],
    ['prompt', '--skill', 'xspec-answer', '--json'],
    ['prompt', '--skill', 'spec-answerx', '--json'],
    ['prompt', '--skill', 'spec-answer', '--skill', 'idea-discussion', '--json'],
    ['prompt', '--skill', 'spec-answer', '--json', '--persona'],
  ]) {
    for (const result of [await cli(args, env), spawnedCli(args, env)]) {
      assert.equal(result.code, 2, args.join(' '));
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /Usage: bunshin twin prompt/);
    }
  }
});

test('KB reply check returns citation metadata and flattens problems with sentence numbers', () => {
  const kbData = kb.load(path.join(__dirname, '..', 'sample', 'kb', 'demo'));
  const id = 'demo.model.provider';
  assert.deepEqual(twinCheck.checkSpecReply(`Sample fact [${id}].\nAgain [${id}].`, { kbData }), {
    ok: true, problems: [], abstain: false, handback: false, cited: [id],
    facts: 2, sentences: [
      { text: `Sample fact [${id}].`, ids: [id], problems: [], exempt: false },
      { text: `Again [${id}].`, ids: [id], problems: [], exempt: false },
    ],
  });
  assert.deepEqual(twinCheck.checkSpecReply(`Sample fact [${id}].\nLumaClient sample [${id}].\nUnknown [demo.model.absent].\nUncited fact.`,
    { kbData, scrub: ['LumaClient'] }), {
    ok: false, problems: ['2: scrub', '3: unknown-id', '4: no-citation'],
    abstain: false, handback: false, cited: [id, 'demo.model.absent'],
    facts: 4, sentences: [
      { text: `Sample fact [${id}].`, ids: [id], problems: [], exempt: false },
      { text: '[redacted]', ids: [id], problems: ['scrub'], exempt: false },
      { text: 'Unknown [demo.model.absent].', ids: ['demo.model.absent'], problems: ['unknown-id'], exempt: false },
      { text: 'Uncited fact.', ids: [], problems: ['no-citation'], exempt: false },
    ],
  });
  assert.deepEqual(twinCheck.checkSpecReply('Uncitable [demo.model.region][demo.model.absent].', { kbData }), {
    ok: false, problems: ['1: not-citable', '1: unknown-id'], abstain: false,
    handback: false, cited: ['demo.model.region', 'demo.model.absent'],
    facts: 1, sentences: [{ text: 'Uncitable [demo.model.region][demo.model.absent].',
      ids: ['demo.model.region', 'demo.model.absent'], problems: ['not-citable', 'unknown-id'], exempt: false }],
  });
});

test('KB reply check accepts each exact template fallback form with matching metadata', () => {
  const kbData = kb.load(path.join(__dirname, '..', 'sample', 'kb', 'demo'));
  const forms = [...template('spec-answer-kb').matchAll(/^```text\n([^`]+)\n```$/gm)].map((match) => match[1]);
  assert.deepEqual(forms, [
    '該当する情報がありません。\nClosest topic: <topic>',
    'Not covered.\nClosest topic: <topic>',
    '要確認（人の判断が必要です）。\nReason: <one line>',
    'Needs human.\nReason: <one line>',
  ]);
  for (const [index, form] of forms.entries()) {
    assert.deepEqual(twinCheck.checkSpecReply(form.replace('<topic>', 'model').replace('<one line>', 'Review needed.'), { kbData }), {
      ok: true, problems: [], abstain: index < 2, handback: index >= 2, cited: [],
      facts: 0, sentences: [],
    });
  }
});

test('KB reply scrub messages never include scrubbed sentence text or citation ids', () => {
  const kbData = kb.load(path.join(__dirname, '..', 'sample', 'kb', 'demo'));
  const result = twinCheck.checkSpecReply('LumaClient sample [demo.model.lumaclient].', { kbData, scrub: ['LumaClient'] });
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, ['1: unknown-id', '1: scrub']);
  assert.equal(JSON.stringify(result).toLowerCase().includes('lumaclient'), false);
});

test('Sources checks retain their original results when options contain no KB data', () => {
  for (const reply of ['Sample answer.\nSources: none', 'Sample answer.\nSources:\n- Sample page — https://example.invalid/model',
    'Sample answer.', '', null]) {
    for (const options of [{}, { scrub: ['Sample'] }, { kbData: null, scrub: ['Sample'] }]) {
      assert.deepEqual(twinCheck.checkSpecReply(reply, options), twinCheck.checkSpecReply(reply));
    }
  }
});
