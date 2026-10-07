'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const leak = require('../lib/leak');
const check = require('../lib/check');
const identity = require('../lib/identity');
const store = require('../lib/store');
const { main } = require('../bin/bunshin');

function pair(id, text = 'A fictional build answer.') {
  return {
    id, source: 'manual', permalink: `https://chat.example.invalid/thread/${id}`, channel: 'fictional-channel',
    asked_at: '2026-01-01T00:00:00Z', harvested_at: '2026-01-01T00:00:00Z',
    layer: 'judgment', layer_source: 'manual', question: { author: 'fictional-colleague', text: 'A fictional question?' },
    context: [], answer: { text },
  };
}

function draft() {
  return {
    format_version: 1, persona: 'sample', version: 0, built_at: '2026-01-01T00:00:00Z',
    voice: [{ id: 'voice-one', statement: 'Keep explanations brief.', evidence: [{
      type: 'pair', ref: 'build-one', permalink: 'https://chat.example.invalid/thread/build-one',
    }] }], priorities: [], objections: [], context_rules: [],
  };
}

function fixture(t, heldout = [pair('heldout-one', 'abcdefghijklmnopqrstuvwxyz0123456789')]) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-check-')));
  const dir = path.join(root, 'persona');
  const previous = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  for (const key of Object.keys(previous)) {
    process.env[key] = path.join(root, key);
    fs.mkdirSync(process.env[key]);
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
    store._resetGuardCache();
  });
  store.writeJson(dir, 'persona.json', {
    format_version: 1, name: 'sample', display_name: 'Sample Person', synthetic: true, version: 0,
  }, { synthetic: true });
  store.writeJsonl(dir, 'pairs.jsonl', [pair('build-one'), ...heldout]);
  store.writeJson(dir, 'split.json', {
    format_version: 1, salt: 'sample', heldout_ratio: 0.3,
    assignments: { 'build-one': 'build', ...Object.fromEntries(heldout.map(({ id }) => [id, 'heldout'])) },
  });
  store.writeJson(dir, 'identity.json', draft());
  store.writeText(dir, 'identity.md', identity.render({ ...draft(), display_name: 'Sample Person' }));
  return dir;
}

async function cli(dir, args = ['check'], stdin = '', env = {}) {
  let stdout = '';
  let stderr = '';
  const code = await main([...args, '--persona', dir], {
    env, stdin, stdout: { write: (text) => { stdout += text; } },
    stderr: { write: (text) => { stderr += text; } },
  });
  return { code, stdout, stderr };
}

function snapshot(dir) {
  return Object.fromEntries(fs.readdirSync(dir).sort().map((name) => [
    name, crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex'),
  ]));
}

test('normalization applies NFKC, lower-case and whitespace collapse', () => {
  assert.ok(leak.normalize('ＡＢＣ\t\nｶﾞｯﾂ　架空の回答') === 'abc ガッツ 架空の回答', 'Normalization must handle width, case and whitespace.');
  assert.ok(leak.normalize('  Fictional\r\n text  ') === ' fictional text ', 'Whitespace runs must become one space.');
});

test('window scan matches interior and final windows, reports ids once per file and omits text', () => {
  const answer = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const findings = leak.findLeaks([
    { name: 'first.md', text: `!${answer.slice(5, 29)}!${answer.slice(-24)}!` },
    { name: 'second.md', text: answer },
    { name: 'first.md', text: answer },
  ], [{ id: 'heldout-one', text: answer }, { id: 'heldout-two', text: answer }]);
  assert.deepEqual(findings.map(({ name, id }) => ({ name, id })), [
    { name: 'first.md', id: 'heldout-one' }, { name: 'first.md', id: 'heldout-two' },
    { name: 'second.md', id: 'heldout-one' }, { name: 'second.md', id: 'heldout-two' },
  ]);
  assert.ok(findings.every((finding) => Object.keys(finding).join(',') === 'name,id'), 'Findings must contain only file names and pair ids.');
});

test('23-character copies and needles below the normalized window never match', () => {
  const answer = 'abcdefghijklmnopqrstuvwxyz0123456789';
  assert.equal(leak.findLeaks([{ name: 'short.md', text: `!${answer.slice(0, 23)}!` }], [{ id: 'heldout-one', text: answer }]).length, 0);
  assert.equal(leak.findLeaks([{ name: 'short.md', text: answer }], [{ id: 'heldout-one', text: answer.slice(0, 23) }]).length, 0);
  const whitespace = 'Abc' + ' '.repeat(40) + 'def';
  assert.equal(leak.findLeaks([{ name: 'short.md', text: whitespace }], [{ id: 'heldout-one', text: whitespace }]).length, 0);
  assert.equal(leak.findLeaks([{ name: 'custom.md', text: 'xyzabc!' }], [{ id: 'heldout-one', text: 'ABC' }], { window: 3 }).length, 1);
  assert.equal(leak.findLeaks([], [{ id: 'heldout-one', text: answer }]).length, 0);
  assert.equal(leak.findLeaks([{ name: 'empty.md', text: '' }], []).length, 0);
});

test('window boundaries count Unicode characters after normalization', () => {
  for (const size of [12, 23, 24]) {
    const answer = '🧪'.repeat(size);
    assert.equal(leak.findLeaks([{ name: 'unicode.md', text: answer }], [{ id: 'heldout-one', text: answer }]).length, size === 24 ? 1 : 0);
  }
  const answer = '㍿'.repeat(6);
  assert.equal(leak.findLeaks([{ name: 'unicode.md', text: '株式会社'.repeat(6) }], [{ id: 'heldout-one', text: answer }]).length, 1);
});

test('invalid scanner inputs fail closed without echoing values', () => {
  for (const window of [0, -1, 1.5, NaN, Infinity, '24']) {
    assert.throws(() => leak.findLeaks([], [], { window }), /^Error: Leak scan window must be a positive integer\.$/);
  }
  for (const [haystacks, needles] of [
    [null, []], [[], null], [[{ name: 'sample.md', text: 42 }], []],
    [[], [{ id: 'heldout-one', text: null }]], [[{ text: 'Private sample text.' }], []],
  ]) assert.throws(() => leak.findLeaks(haystacks, needles), /^Error: (Leak scan inputs must be arrays|Invalid leak scan input)\.$/);
  assert.throws(() => leak.normalize(null), /^Error: Leak scan text must be a string\.$/);
});

test('check CLI passes a clean persona with a fixed success line and writes no files', async (t) => {
  const dir = fixture(t);
  const before = snapshot(dir);
  assert.deepEqual(check.runChecks(dir), { ok: true, findings: [] });
  assert.deepEqual(await cli(dir), { code: 0, stdout: 'Held-out checks passed.\n', stderr: '' });
  assert.deepEqual(snapshot(dir), before);
});

for (const source of [
  {
    name: 'colleague question window', id: 'sample-14', trait: 'p-settings', section: 'priorities',
    message: 'Colleague message window.',
    statement: () => 'Use a separate settings page when related settings need consideration together.',
  },
  {
    name: 'colleague context window', id: 'sample-14', trait: 'p-context', section: 'priorities',
    message: 'Colleague message window.',
    statement: (dir) => {
      const records = store.readJsonl(dir, 'pairs.jsonl');
      records.find(({ id }) => id === 'sample-14').context.push({
        author: 'Fictional Colleague', text: 'Should a fictional lantern workflow use a distinct confirmation screen?',
      });
      store.writeJsonl(dir, 'pairs.jsonl', records);
      return 'Prefer a distinct confirmation screen when a workflow has several steps.';
    },
  },
  {
    name: 'full owner answer', id: 'sample-14', trait: 'voice-answer', section: 'voice',
    message: 'Verbatim private text.',
    statement: (dir) => store.readJsonl(dir, 'pairs.jsonl').find(({ id }) => id === 'sample-14').answer.text,
  },
  {
    name: 'full interview answer', id: 'iv-0002', trait: 'context-interview', section: 'context_rules',
    message: 'Verbatim private text.',
    statement: (dir) => store.readJsonl(dir, 'interview.jsonl').find(({ id }) => id === 'iv-0002').answer,
  },
]) {
  for (const method of ['checkDraft', 'runChecks']) {
    test(`${method} refuses a ${source.name} and names the matching trait`, (t) => {
      const dir = fixture(t);
      fs.cpSync(path.join(__dirname, '..', 'sample', 'persona'), dir, { recursive: true });
      assert.equal(check.runChecks(dir).ok, true);
      const value = store.readJson(dir, 'identity.json');
      const statement = source.statement(dir);
      value[source.section].push({
        id: source.trait, name: 'Fictional priority', statement,
        evidence: source.id.startsWith('iv-') ? [{ type: 'interview', ref: source.id }] : [{
          type: 'pair', ref: source.id, permalink: `https://example.invalid/tidepool/threads/${source.id}`,
        }],
      });
      assert.equal(identity.validate(dir, value).ok, true);
      let findings;
      if (method === 'checkDraft') {
        const before = snapshot(dir);
        assert.throws(() => check.checkDraft(dir, value), (error) => {
          findings = error.findings;
          assert.equal(error.message, check.formatFindings(findings));
          return true;
        });
        assert.deepEqual(snapshot(dir), before);
      } else {
        store.writeJson(dir, 'identity.json', value);
        store.writeText(dir, 'identity.md', identity.render({
          ...value, display_name: store.readJson(dir, 'persona.json').display_name,
        }));
        const result = check.runChecks(dir);
        assert.equal(result.ok, false);
        findings = result.findings;
      }
      assert.deepEqual(findings.map(({ name, id }) => ({ name, id })), [
        { name: 'identity.json', id: source.id }, { name: 'identity.md', id: source.id },
      ]);
      for (const finding of findings) {
        assert.ok(finding.message.includes(source.message), 'The finding must name the privacy rule.');
        assert.ok(finding.message.includes(`trait ${source.trait}`), 'The finding must name the matching trait.');
      }
      const formatted = check.formatFindings(findings);
      assert.ok(formatted.includes(`trait ${source.trait}`));
      assert.ok(!formatted.includes(statement), 'Refusals must omit private text.');
    });
  }
}

test('full held-out answers are reported once per file', (t) => {
  const dir = fixture(t);
  const value = draft();
  value.voice[0].statement = store.readJsonl(dir, 'pairs.jsonl')[1].answer.text;
  assert.throws(() => check.checkDraft(dir, value), (error) => {
    assert.deepEqual(error.findings.map(({ name, id }) => ({ name, id })), [
      { name: 'identity.json', id: 'heldout-one' }, { name: 'identity.md', id: 'heldout-one' },
    ]);
    assert.ok(error.findings.every(({ message }) => message.startsWith('Held-out answer window.')));
    return true;
  });
  store.writeJson(dir, 'identity.json', value);
  store.writeText(dir, 'identity.md', identity.render(value));
  assert.equal(check.runChecks(dir).findings.length, 2);
});

test('checks preserve text-free interview references while export collection validates answer metadata', (t) => {
  const dir = fixture(t);
  store.writeJsonl(dir, 'interview.jsonl', [{ id: 'iv-0001' }]);
  assert.throws(() => check.privateTexts(dir, store.readJson(dir, 'persona.json')),
    /^Error: Invalid interview answer in interview\.jsonl\.$/);
  assert.deepEqual(check.checkDraft(dir, draft()), { ok: true, findings: [] });
  assert.deepEqual(check.runChecks(dir), { ok: true, findings: [] });
});

test('check CLI refuses held-out evidence in identity traits', async (t) => {
  const dir = fixture(t);
  const value = draft();
  value.voice[0].evidence[0].ref = 'heldout-one';
  store.writeJson(dir, 'identity.json', value);
  const result = await cli(dir);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'identity.json (heldout-one): Held-out evidence in trait voice-one.\n');
});

test('check CLI refuses held-out evidence in conflicts even without an identity link', async (t) => {
  const dir = fixture(t);
  store.writeJsonl(dir, 'conflicts.jsonl', [{
    id: 'cf-0001', claim: 'A fictional conflict.', interview_ref: 'iv-0001',
    behaviour_refs: ['heldout-one'], status: 'resolved', resolution: 'behaviour', note: '',
  }]);
  const result = await cli(dir);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'conflicts.jsonl (heldout-one): Held-out evidence in cf-0001.\n');
});

for (const size of [23, 24]) {
  test(`check CLI ${size === 24 ? 'refuses' : 'permits'} a ${size}-character copy in on-disk Markdown`, async (t) => {
    const dir = fixture(t);
    const copied = 'abcdefghijklmnopqrstuvwxyz'.slice(0, size);
    store.writeText(dir, 'identity.md', `# Fictional identity\n\n!${copied}!\n`);
    const before = snapshot(dir);
    const result = await cli(dir);
    assert.equal(result.code, size === 24 ? 1 : 0);
    if (size === 24) {
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'identity.md (heldout-one): Held-out answer window.\n');
    } else assert.equal(result.stderr, '');
    assert.ok(!result.stdout.includes(copied), 'Stdout must omit copied text.');
    assert.ok(!result.stderr.includes(copied), 'Stderr must omit copied text.');
    assert.deepEqual(snapshot(dir), before);
  });
}

test('check CLI scans extra files and names only the leaking file and pair id', async (t) => {
  const dir = fixture(t);
  const clean = 'export/sample/clean.md';
  const name = 'export/sample/skill.md';
  const copied = 'abcdefghijklmnopqrstuvwxyz'.slice(0, 24);
  store.writeText(dir, clean, 'Fictional clean export.');
  store.writeText(dir, name, `# Fictional export\n!${copied}!`);
  assert.equal(check.runChecks(dir).ok, true);
  assert.equal(check.runChecks(dir, { extraFiles: [name] }).ok, false);
  const result = await cli(dir, ['check', '--extra-file', clean, '--extra-file', name]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `${name} (heldout-one): Held-out answer window.\n`);
  assert.ok(!result.stdout.includes(copied), 'Stdout must omit copied text.');
  assert.ok(!result.stderr.includes(copied), 'Stderr must omit copied text.');
});

for (const name of ['identity.json', 'persona.json', 'split.json', 'pairs.jsonl']) {
  for (const mode of ['missing', 'corrupt', 'invalid schema']) {
    test(`check CLI refuses ${mode} ${name} without revealing file contents`, async (t) => {
      const dir = fixture(t);
      const privateText = 'Private malformed source.';
      if (mode === 'missing') fs.unlinkSync(path.join(dir, name));
      else store.writeText(dir, name, mode === 'corrupt' ? privateText : JSON.stringify({ notes: privateText }));
      const before = snapshot(dir);
      const checked = check.runChecks(dir);
      assert.equal(checked.ok, false);
      assert.ok(checked.findings.some((finding) => finding.name === name), 'Findings must name the refused source.');
      const result = await cli(dir);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, '');
      assert.ok(result.stderr.includes(name), 'The CLI must name the refused source.');
      assert.ok(!result.stderr.includes(privateText), 'Malformed source contents must be omitted.');
      assert.deepEqual(snapshot(dir), before);
    });
  }
}

test('check CLI refuses missing Markdown or extra files and invalid arguments', async (t) => {
  const dir = fixture(t);
  const missing = await cli(dir, ['check', '--extra-file', 'export/missing.md']);
  assert.equal(missing.code, 1);
  assert.equal(missing.stdout, '');
  assert.equal(missing.stderr, 'export/missing.md: Cannot read check file.\n');
  fs.unlinkSync(path.join(dir, 'identity.md'));
  const result = await cli(dir);
  assert.equal(result.code, 1);
  assert.equal(result.stderr, 'identity.md: Cannot read check file.\n');
  for (const args of [
    ['check', 'extra'], ['check', '--extra-file'], ['check', '--unknown'],
    ['check', '--persona', dir], ['check', '--extra-file', '--unknown'],
  ]) {
    const invalid = await cli(dir, args);
    assert.equal(invalid.code, 2);
    assert.equal(invalid.stdout, '');
    assert.match(invalid.stderr, /^Usage: bunshin check/);
  }
});

test('check refuses invalid extra file lists and paths outside the persona', async (t) => {
  const dir = fixture(t);
  for (const extraFiles of [null, 'identity.md', [null], ['']]) {
    assert.deepEqual(check.runChecks(dir, { extraFiles }), {
      ok: false, findings: [{ name: 'extraFiles', message: 'Invalid extra file list.' }],
    });
  }
  const outside = path.join(path.dirname(dir), 'outside.md');
  fs.writeFileSync(outside, 'Fictional outside text.');
  fs.symlinkSync(outside, path.join(dir, 'escape.md'));
  for (const name of ['../outside.md', outside, 'escape.md', '.']) {
    const result = await cli(dir, ['check', '--extra-file', name]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `${name}: Cannot read check file.\n`);
  }
});

const escapedAnswer = 'まず結論から言うと、\n来週の"リリース"は延期で\n品質を優先しましょう。\nテストが通るまで待つ';

for (const [label, insert] of [
  ['priority name', (value, text) => {
    value.priorities = [{ id: 'priority-one', name: text, statement: 'Prefer clarity.', evidence: value.voice[0].evidence }];
  }],
  ['top-level notes', (value, text) => { value.notes = text; }],
  ['nested extra values', (value, text) => { value.notes = { entries: [{ text }] }; }],
  ['extra field key', (value, text) => { value[text] = 'Fictional extra value.'; }],
]) {
  test(`decoded ${label} with newlines and quotes is refused by commit and check`, async (t) => {
    const dir = fixture(t, [pair('heldout-one', escapedAnswer)]);
    const value = draft();
    insert(value, escapedAnswer);
    assert.equal(identity.validate(dir, value).ok, true);
    const before = snapshot(dir);
    const original = store.writeIdentity;
    let writes = 0;
    t.mock.method(store, 'writeIdentity', (...args) => { writes += 1; return original(...args); });
    const committed = await cli(dir, ['identity', 'commit', '-'], JSON.stringify(value));
    assert.equal(committed.code, 1);
    assert.equal(committed.stdout, '');
    assert.equal(committed.stderr, 'identity.json (heldout-one): Held-out answer window.\n');
    assert.equal(writes, 0);
    assert.deepEqual(snapshot(dir), before);

    // Markdown remains clean; only the decoded JSON key or value contains the window.
    store.writeJson(dir, 'identity.json', value);
    const checked = await cli(dir);
    assert.equal(checked.code, 1);
    assert.equal(checked.stdout, '');
    assert.equal(checked.stderr, 'identity.json (heldout-one): Held-out answer window.\n');
    for (const result of [committed, checked]) {
      assert.ok(!result.stdout.includes(escapedAnswer), 'Stdout must omit the held-out answer.');
      assert.ok(!result.stderr.includes(escapedAnswer), 'Stderr must omit the held-out answer.');
      assert.ok(!result.stderr.includes('来週の'), 'Stderr must omit answer fragments.');
    }
  });
}

test('check scans decoded objection priority and conflict strings', async (t) => {
  const dir = fixture(t, [pair('heldout-one', escapedAnswer)]);
  for (const field of ['priority', 'conflict']) {
    const value = draft();
    if (field === 'priority') value.objections = [{ ...value.voice[0], id: 'objection-one', priority: escapedAnswer }];
    else value.voice[0].conflict = escapedAnswer;
    store.writeJson(dir, 'identity.json', value);
    const result = await cli(dir);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'identity.json (heldout-one): Held-out answer window.\n');
  }
});

test('check scans JSON Unicode escapes as decoded strings', async (t) => {
  const dir = fixture(t);
  const copied = 'abcdefghijklmnopqrstuvwxyz'.slice(0, 24);
  const value = { ...draft(), notes: copied };
  const raw = JSON.stringify(value).replace(copied, Array.from(copied, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''));
  store.writeText(dir, 'identity.json', raw);
  const result = await cli(dir);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'identity.json (heldout-one): Held-out answer window.\n');
  assert.ok(!result.stderr.includes(copied), 'Stderr must omit copied text.');
});

test('check retains the on-disk raw JSON scan', async (t) => {
  const dir = fixture(t);
  const raw = `${JSON.stringify(draft(), null, 2)}\n`;
  const answer = raw.slice(raw.indexOf('"voice"'), raw.indexOf('"voice"') + 70);
  store.writeJsonl(dir, 'pairs.jsonl', [pair('build-one'), pair('heldout-one', answer)]);
  const result = await cli(dir);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'identity.json (heldout-one): Held-out answer window.\n');
  assert.ok(!result.stderr.includes(answer), 'Stderr must omit the held-out answer.');
});

test('Japanese held-out width, case and whitespace variants fail both check and commit', async (t) => {
  const answer = 'ＡＢＣ　ｶﾞｯﾂﾎﾟｰｽﾞで架空の品質を守り、次の手順を確認します。';
  const copied = 'abc\t\nガッツポーズで架空の品質を守り、次の手順を確認します。';
  const dir = fixture(t, [pair('heldout-one', answer)]);
  store.writeText(dir, 'identity.md', copied);
  const checked = await cli(dir);
  assert.equal(checked.code, 1);
  assert.equal(checked.stdout, '');
  assert.equal(checked.stderr, 'identity.md (heldout-one): Held-out answer window.\n');
  const before = snapshot(dir);
  const value = draft();
  value.voice[0].statement = copied;
  const committed = await cli(dir, ['identity', 'commit', '-'], JSON.stringify(value));
  assert.equal(committed.code, 1);
  assert.equal(committed.stdout, '');
  assert.ok(committed.stderr.includes('identity.json') && committed.stderr.includes('identity.md')
    && committed.stderr.includes('heldout-one'), 'The refusal must identify both candidate files and the pair.');
  for (const result of [checked, committed]) {
    assert.ok(!result.stdout.includes(copied) && !result.stdout.includes(answer), 'Stdout must omit answer text.');
    assert.ok(!result.stderr.includes(copied) && !result.stderr.includes(answer)
      && !result.stderr.includes('ガッツポーズ'), 'Stderr must omit answer text and fragments.');
  }
  assert.deepEqual(snapshot(dir), before);
});

for (const existing of [false, true]) {
  test(`identity commit refuses a leaking draft before writes with ${existing ? 'existing' : 'absent'} identity files`, async (t) => {
    const dir = fixture(t);
    if (!existing) {
      fs.unlinkSync(path.join(dir, 'identity.json'));
      fs.unlinkSync(path.join(dir, 'identity.md'));
    }
    const before = snapshot(dir);
    const value = draft();
    const copied = 'abcdefghijklmnopqrstuvwxyz'.slice(0, 24);
    value.voice[0].statement = copied;
    const original = store.writeIdentity;
    let writes = 0;
    t.mock.method(store, 'writeIdentity', (...args) => { writes += 1; return original(...args); });
    const result = await cli(dir, ['identity', 'commit', '-'], JSON.stringify(value));
    assert.equal(result.code, 1);
    assert.ok(result.stdout === '', 'A refused commit must have no stdout.');
    assert.ok(result.stderr.includes('identity.json') && result.stderr.includes('identity.md'), 'The refusal must name both candidate files.');
    assert.ok(result.stderr.includes('heldout-one'), 'The refusal must name the held-out pair id.');
    assert.ok(!result.stderr.includes(copied), 'The refusal must omit matched text.');
    assert.equal(writes, 0);
    assert.deepEqual(snapshot(dir), before);
  });
}

test('identity commit scans rendered Markdown including the manifest display name', async (t) => {
  const dir = fixture(t);
  const copied = 'abcdefghijklmnopqrstuvwxyz'.slice(0, 24);
  store.writeJson(dir, 'persona.json', { ...store.readJson(dir, 'persona.json'), display_name: copied });
  const before = snapshot(dir);
  const result = await cli(dir, ['identity', 'commit', '-'], JSON.stringify(draft()));
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes('identity.md') && result.stderr.includes('heldout-one'), 'The refusal must identify a rendered Markdown leak.');
  assert.ok(!result.stderr.includes('identity.json'), 'The candidate JSON does not contain this window.');
  assert.ok(!result.stderr.includes(copied), 'The refusal must omit matched text.');
  assert.deepEqual(snapshot(dir), before);
});

test('identity commit permits a 23-character copy and can replace leaking files with a clean draft', async (t) => {
  const dir = fixture(t);
  const value = draft();
  value.voice[0].statement = 'abcdefghijklmnopqrstuvwxyz'.slice(0, 23);
  store.writeText(dir, 'identity.md', 'abcdefghijklmnopqrstuvwxyz');
  const result = await cli(dir, ['identity', 'commit', '-'], JSON.stringify(value));
  assert.equal(result.code, 0);
  assert.equal(store.readJson(dir, 'persona.json').version, 1);
  assert.ok(store.readJson(dir, 'identity.json').voice[0].statement === value.voice[0].statement, 'The checked candidate must be committed.');
});

test('identity commit refuses held-out conflict evidence before writes', async (t) => {
  const dir = fixture(t);
  store.writeJsonl(dir, 'conflicts.jsonl', [{
    id: 'cf-0001', claim: 'A fictional conflict.', interview_ref: 'iv-0001',
    behaviour_refs: ['heldout-one'], status: 'resolved', resolution: 'behaviour', note: '',
  }]);
  const before = snapshot(dir);
  const result = await cli(dir, ['identity', 'commit', '-'], JSON.stringify(draft()));
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes('conflicts.jsonl') && result.stderr.includes('heldout-one') && result.stderr.includes('cf-0001'), 'The refusal must identify the held-out conflict evidence.');
  assert.deepEqual(snapshot(dir), before);
});

test('draft checks find held-out evidence in every identity section using split as the authority', (t) => {
  const dir = fixture(t);
  const state = store.readJson(dir, 'split.json');
  state.assignments['heldout-missing'] = 'heldout';
  store.writeJson(dir, 'split.json', state);
  for (const field of ['voice', 'priorities', 'objections', 'context_rules']) {
    const value = draft();
    value[field] = [{ id: 'trait-one', statement: 'A fictional trait.', evidence: [{ type: 'pair', ref: 'heldout-missing' }] }];
    let message = '';
    try { check.checkDraft(dir, value); } catch (error) { message = error.message; }
    assert.ok(message.includes('identity.json') && message.includes('heldout-missing') && message.includes('trait-one'), 'Every section must reject split-authorized held-out evidence.');
    assert.ok(!message.includes(value[field][0].statement), 'The refusal must omit persona text.');
  }
});

test('draft checks refuse unreadable or malformed sources with content-free messages', (t) => {
  for (const [name, content, expected] of [
    ['persona.json', null, 'Cannot read persona manifest.'],
    ['split.json', 'Private malformed source.', 'Cannot read valid split assignments.'],
    ['pairs.jsonl', 'Private malformed source.', 'Cannot read held-out pairs.'],
    ['conflicts.jsonl', 'Private malformed source.', 'Cannot read conflict evidence.'],
  ]) {
    const dir = fixture(t);
    if (content === null) fs.unlinkSync(path.join(dir, name));
    else store.writeText(dir, name, content);
    let message = '';
    try { check.checkDraft(dir, draft()); } catch (error) { message = error.message; }
    assert.ok(message.includes(name) && message.includes(expected), 'Unreadable sources must refuse with their file name.');
    assert.ok(!message.includes('Private malformed source.'), 'Malformed source contents must be omitted.');
  }
});

test('checks refuse manifest names that do not start with a letter or digit', (t) => {
  for (const name of ['--help', '-h', '-sample']) {
    const dir = fixture(t);
    store.writeJson(dir, 'persona.json', { ...store.readJson(dir, 'persona.json'), name }, { synthetic: true });
    assert.deepEqual(check.runChecks(dir), {
      ok: false, findings: [{ name: 'persona.json', message: 'Cannot read persona manifest.' }],
    });
    assert.throws(() => check.checkDraft(dir, draft()), /persona\.json.*Cannot read persona manifest\./);
  }
});

test('draft checks refuse unparseable evidence and candidate serialization', (t) => {
  const dir = fixture(t);
  for (const evidence of [null, { type: 'unknown', ref: 'Private sample text.' }, { type: 'pair', ref: 'Private sample text.' }]) {
    const value = draft();
    value.voice[0].evidence = [evidence];
    let message = '';
    try { check.checkDraft(dir, value); } catch (error) { message = error.message; }
    assert.ok(message.includes('identity.json') && message.includes('Cannot prepare identity files') || message.includes('Invalid evidence'), 'Unparseable evidence must refuse.');
    assert.ok(!message.includes('Private sample text.'), 'Invalid evidence text must be omitted.');
  }
  store.writeJsonl(dir, 'conflicts.jsonl', [{ id: 'cf-0001', behaviour_refs: 'Private sample text.' }]);
  let message = '';
  try { check.checkDraft(dir, draft()); } catch (error) { message = error.message; }
  assert.ok(message.includes('conflicts.jsonl') && message.includes('Invalid evidence'), 'Unparseable conflict evidence must refuse.');
  assert.ok(!message.includes('Private sample text.'), 'Invalid conflict text must be omitted.');
  const circular = draft();
  circular.extra = circular;
  message = '';
  try { check.checkDraft(dir, circular); } catch (error) { message = error.message; }
  assert.ok(message === 'identity.json: Cannot prepare identity files for checking.', 'Unserializable drafts must refuse with a fixed message.');
});

function generatedText(seed, length) {
  let state = seed;
  let text = '';
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    text += alphabet[(state >>> 0) % alphabet.length];
  }
  return text;
}

test('500 held-out answers against a 200 kB file scan in under two seconds', () => {
  const needles = Array.from({ length: 500 }, (_, index) => ({ id: `heldout-${index}`, text: generatedText(index + 1, 256) }));
  const text = generatedText(9001, 200 * 1024 - 24) + needles[499].text.slice(-24);
  const started = performance.now();
  const findings = leak.findLeaks([{ name: 'large.md', text }], needles);
  const elapsed = performance.now() - started;
  assert.deepEqual(findings.map(({ name, id }) => ({ name, id })), [{ name: 'large.md', id: 'heldout-499' }]);
  assert.ok(elapsed < 2000, `Scan took ${Math.round(elapsed)} ms; expected under 2000 ms.`);
});

test('cited source permalinks do not match private text that quotes the same link', (t) => {
  const link = 'https://chat.example.invalid/thread/build-one';
  const quoting = pair('heldout-one', `Context is in ${link} for this decision.`);
  const dir = fixture(t, [quoting]);
  const pairs = store.readJsonl(dir, 'pairs.jsonl');
  pairs[0].question.text = `Earlier thread: ${link}`;
  store.writeJsonl(dir, 'pairs.jsonl', pairs);
  assert.doesNotThrow(() => check.checkDraft(dir, draft()));
  assert.deepEqual(check.runChecks(dir).findings, []);
});

test('masking a cited permalink keeps statement copies of the quoting text refused', (t) => {
  const dir = fixture(t, [pair('heldout-one', 'Context is in https://chat.example.invalid/thread/build-one for this decision.')]);
  const value = draft();
  value.voice[0].statement = 'thread/build-one for this decision.';
  assert.throws(() => check.checkDraft(dir, value), (error) => {
    assert.ok(error.findings.some(({ id, message }) => id === 'heldout-one'
      && message === 'Held-out answer window. In trait voice-one.'));
    return true;
  });
});

test('a permalink that differs from its source pair is still scanned', (t) => {
  const dir = fixture(t);
  const value = draft();
  value.voice[0].evidence[0].permalink = 'https://chat.example.invalid/abcdefghijklmnopqrstuvwxyz0123456789';
  store.writeJson(dir, 'identity.json', value);
  store.writeText(dir, 'identity.md', identity.render({ ...value, display_name: 'Sample Person' }));
  assert.ok(check.runChecks(dir).findings.some(({ id, message }) => id === 'heldout-one'
    && message === 'Held-out answer window.'));
});

test('a short or non-URL build permalink is never masked, so copied private text is still refused', (t) => {
  for (const link of ['e', 'not a url but long enough to pass a length check', 'ftp://chat.example.invalid/thread/build-one']) {
    const answer = 'This fictional held-out answer is long enough to leak if copied.';
    const dir = fixture(t, [pair('heldout-one', answer)]);
    const stored = store.readJsonl(dir, 'pairs.jsonl');
    stored[0].permalink = link;
    store.writeJsonl(dir, 'pairs.jsonl', stored);
    const value = draft();
    value.voice[0].statement = answer;
    value.voice[0].evidence[0].permalink = link;
    assert.throws(() => check.checkDraft(dir, value), (error) => {
      assert.ok(error.findings.some(({ id }) => id === 'heldout-one'), `not refused for permalink ${link}`);
      return true;
    });
    store.writeJson(dir, 'identity.json', value);
    store.writeText(dir, 'identity.md', identity.render({ ...value, display_name: 'Sample Person' }));
    assert.ok(check.runChecks(dir).findings.some(({ id }) => id === 'heldout-one'), `check passed for permalink ${link}`);
  }
});
