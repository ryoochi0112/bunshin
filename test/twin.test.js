'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
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
