'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const check = require('../lib/check');
const guard = require('../lib/guard');
const identity = require('../lib/identity');
const leak = require('../lib/leak');
const store = require('../lib/store');
const twin = require('../lib/twin');
const { exportPersona } = require('../lib/export');
const { main } = require('../bin/bunshin');

const packageFiles = [
  '.claude-plugin/plugin.json', 'skills/spec-answer/SKILL.md',
  'skills/idea-discussion/SKILL.md', 'identity.md', 'README.md',
];
const root = path.resolve(__dirname, '..');

function fixture(t) {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-export-')));
  const dir = path.join(temporary, 'persona');
  fs.cpSync(path.join(root, 'sample', 'persona'), dir, { recursive: true });
  t.after(() => { fs.rmSync(temporary, { recursive: true, force: true }); store._resetGuardCache(); });
  return dir;
}

function read(dir, name) {
  return fs.readFileSync(path.join(dir, name), 'utf8');
}

function files(dir) {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name))).sort();
}

async function cli(args, env, probe) {
  let stdout = '';
  let stderr = '';
  const code = await main(args, {
    env, probe, stdout: { write: (text) => { stdout += text; } },
    stderr: { write: (text) => { stderr += text; } },
  });
  return { code, stdout, stderr };
}

function assertNoStage(dir) {
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith('.export-')), []);
}

test('sample export has only the standalone package and exact composer bodies after frontmatter', (t) => {
  const dir = fixture(t);
  const markdown = read(dir, 'identity.md').replace(/\n/g, '\r\n') + '  \r\n';
  store.writeText(dir, 'identity.md', markdown);
  for (const name of ['evals/run-one/report.md', 'calibration/run-one/ratings.jsonl', 'shadow/one/draft.json']) {
    store.writeText(dir, name, 'Fictional private artifact that must stay in the persona.');
  }
  const out = path.join(path.dirname(dir), 'standalone');
  const result = exportPersona(dir, out);
  assert.deepEqual(result, { files: packageFiles.map((name) => path.join(out, name)) });
  assert.deepEqual(files(out), [...packageFiles].sort());
  const manifest = store.readJson(dir, 'persona.json');
  assert.deepEqual(JSON.parse(read(out, '.claude-plugin/plugin.json')), {
    name: `${manifest.name}-twin`, version: String(manifest.version),
  });
  assert.equal(read(out, 'identity.md'), markdown);
  for (const skill of ['spec-answer', 'idea-discussion']) {
    const exported = fs.readFileSync(path.join(out, 'skills', skill, 'SKILL.md'));
    const frontmatter = exported.toString('utf8').match(/^---\nname: ([a-z-]+)\ndescription: [^\n]+\n---\n/);
    assert.ok(frontmatter, 'Each skill needs name and description frontmatter.');
    assert.equal(frontmatter[1], skill);
    assert.equal((exported.toString().match(/^---\r?$/gm) || []).length, 2, 'Each skill has exactly one frontmatter block.');
    assert.equal((exported.toString().match(/^(?:name|description):/gm) || []).length, 2);
    assert.deepEqual(exported.subarray(Buffer.byteLength(frontmatter[0])), Buffer.from(twin.composePrompt(dir, skill)));
    assert.match(exported.toString(), /main language of the question/i);
    assert.match(exported.toString(), /never post, send or schedule anything/i);
    if (skill === 'spec-answer') {
      assert.match(exported.toString(), /search Notion.*answer time/i);
      assert.match(exported.toString(), /every factual claim/i);
      assert.match(exported.toString(), /Sources: none/);
      assert.match(exported.toString(), /never guess/i);
    } else {
      assert.match(exported.toString(), /position in the first sentence/i);
      assert.match(exported.toString(), /at least one objection or question/i);
      assert.match(exported.toString(), /\(priority: <name>\)/);
    }
  }
  const readme = read(out, 'README.md');
  assert.match(readme, new RegExp(`^# ${manifest.name} twin — persona v${manifest.version}\\n`));
  assert.doesNotMatch(readme, /^---\r?$|^(?:name|description):/m);
  const texts = result.files.map((file) => fs.readFileSync(file, 'utf8'));
  for (const pair of store.readJsonl(dir, 'pairs.jsonl')) {
    for (const text of [pair.question.text, pair.answer.text, ...pair.context.map((entry) => entry.text)]) {
      assert.ok(texts.every((exported) => !exported.includes(text)), 'Package must omit raw pair text.');
    }
  }
  for (const answer of store.readJsonl(dir, 'interview.jsonl')) {
    assert.ok(texts.every((exported) => !exported.includes(answer.answer)), 'Package must omit interview answers.');
  }
  assert.ok(texts.every((text) => !/bin\/bunshin|require\(/.test(text)));
  assertNoStage(dir);
});

test('README template pins loading, invocation, live source fallback and privacy rules', () => {
  const text = read(path.join(root, 'templates', 'export'), 'README.md');
  assert.match(text, /claude --plugin-dir/);
  assert.match(text, /fresh Claude Code session/i);
  assert.match(text, /no bunshin (?:code|installation|plugin).*required/i);
  assert.match(text, /spec-answer/);
  assert.match(text, /idea-discussion/);
  assert.match(text, /Notion.*search.*read/i);
  assert.match(text, /I do not know/);
  assert.match(text, /Sources: none/);
  assert.match(text, /main language of the question/i);
  assert.match(text, /never posts or sends anything/i);
  assert.match(text, /keep.*package private/i);
});

test('short colleague messages and owner answers do not refuse an export', (t) => {
  const dir = fixture(t);
  const records = store.readJsonl(dir, 'pairs.jsonl');
  records[0].context.push(...['ok', '+1', 'yes', '了解です'].map((text) => ({
    author: 'Fictional Colleague', text,
  })));
  records[0].answer.text = 'Yes.';
  const assignments = store.readJson(dir, 'split.json').assignments;
  records.find((pair) => assignments[pair.id] === 'heldout').answer.text = 'Yes.';
  store.writeJsonl(dir, 'pairs.jsonl', records);
  const answers = store.readJsonl(dir, 'interview.jsonl');
  answers[0].answer = 'ok';
  store.writeJsonl(dir, 'interview.jsonl', answers);
  const out = path.join(path.dirname(dir), 'short-message-package');
  assert.deepEqual(exportPersona(dir, out), { files: packageFiles.map((name) => path.join(out, name)) });
  assert.deepEqual(files(out), [...packageFiles].sort());
  assertNoStage(dir);
});

test('check receives all staged files and leak scan covers every non-owner message and held-out answer before destination writes', (t) => {
  const dir = fixture(t);
  const manifest = store.readJson(dir, 'persona.json');
  store.writeJson(dir, 'persona.json', { ...manifest, owner: { slack_user_id: 'fictional-owner' } });
  const records = store.readJsonl(dir, 'pairs.jsonl');
  records[0].question.author = 'fictional-owner';
  records[0].context = [
    { author: 'fictional-owner', text: 'Fictional owner-only context for the pilot.' },
    { author: 'fictional-colleague', text: 'Fictional colleague-only context for the pilot.' },
  ];
  store.writeJsonl(dir, 'pairs.jsonl', records);
  const assignments = store.readJson(dir, 'split.json').assignments;
  const expectedNeedles = records.flatMap((pair) => [
    ...[pair.question, ...pair.context].filter((message) => message.author !== 'fictional-owner')
      .map((message) => ({ id: pair.id, text: message.text })),
    ...(assignments[pair.id] === 'heldout' ? [{ id: pair.id, text: pair.answer.text }] : []),
  ]);
  const out = path.join(path.dirname(dir), 'checked-package');
  const originalCheck = check.runChecks;
  const originalLeaks = leak.findLeaks;
  let checked = false;
  let scanned = false;
  t.mock.method(check, 'runChecks', (personaDir, options) => {
    if (options?.extraFiles) {
      assert.equal(personaDir, dir);
      assert.equal(fs.existsSync(out), false);
      assert.equal(options.extraFiles.length, packageFiles.length);
      for (const name of packageFiles) {
        const staged = options.extraFiles.find((file) => file.endsWith(`/${name}`));
        assert.ok(staged, `Missing ${name} from extraFiles.`);
        assert.ok(read(dir, staged).length > 0);
      }
      checked = true;
    }
    return originalCheck(personaDir, options);
  });
  t.mock.method(leak, 'findLeaks', (haystacks, needles, options) => {
    if (needles.some((needle) => needle.text === records[0].context[1].text)) {
      assert.equal(fs.existsSync(out), false);
      assert.equal(haystacks.length, packageFiles.length);
      for (const name of packageFiles) assert.ok(haystacks.some((file) => file.name.endsWith(name)));
      assert.deepEqual(needles, expectedNeedles);
      scanned = true;
    }
    return originalLeaks(haystacks, needles, options);
  });
  exportPersona(dir, out);
  assert.equal(checked, true);
  assert.equal(scanned, true);
  assertNoStage(dir);
});

test('committed colleague-message window refuses export with exactly the identity filenames and pair id', (t) => {
  const dir = fixture(t);
  const value = store.readJson(dir, 'identity.json');
  const pair = store.readJsonl(dir, 'pairs.jsonl').find(({ id }) => id === 'sample-14');
  value.priorities.push({
    id: 'p-settings', name: 'Settings grouping',
    statement: 'Use a separate settings page when related settings need consideration together.',
    evidence: [{ type: 'pair', ref: pair.id, permalink: pair.permalink }],
  });
  assert.equal(identity.validate(dir, value).ok, true);
  store.writeJson(dir, 'identity.json', value);
  store.writeText(dir, 'identity.md', identity.render({
    ...value, display_name: store.readJson(dir, 'persona.json').display_name,
  }));
  const out = path.join(path.dirname(dir), 'colleague-window-package');
  assert.throws(() => exportPersona(dir, out), (error) => {
    assert.equal(error.message, 'identity.json (sample-14)\nidentity.md (sample-14)');
    return true;
  });
  assert.equal(fs.existsSync(out), false);
  assertNoStage(dir);
});

test('sample exports, then a colleague sentence seeded into identity fails with only filenames and pair id', async (t) => {
  const dir = fixture(t);
  exportPersona(dir, path.join(path.dirname(dir), 'clean-package'));
  const pair = store.readJsonl(dir, 'pairs.jsonl')[0];
  store.writeText(dir, 'identity.md', read(dir, 'identity.md') + `\n${pair.question.text}\n`);
  const out = path.join(path.dirname(dir), 'leaking-package');
  const result = await cli(['export', '--out', out, '--persona', dir], {});
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, new RegExp(`identity\\.md \\(${pair.id}\\)`));
  assert.equal(result.stderr, `identity.md (${pair.id})\n`);
  for (const line of result.stderr.trim().split('\n')) assert.match(line, /^[\w./-]+ \([a-z0-9-]+\)$/);
  assert.ok(!result.stderr.includes(pair.question.text));
  assert.equal(fs.existsSync(out), false);
  assertNoStage(dir);
});

for (const source of ['question', 'context', 'heldout']) {
  for (const target of packageFiles) {
    test(`export scans ${target} for normalized ${source} text and removes staging on refusal`, (t) => {
      const dir = fixture(t);
      const text = 'ＡＢＣ　ｶﾞｯﾂﾎﾟｰｽﾞで架空の品質を守り、次の手順を確認します。';
      const copy = 'abc\t\nガッツポーズで架空の品質を守り、次の手順を確認します。';
      const records = store.readJsonl(dir, 'pairs.jsonl');
      const pair = source === 'heldout' ? records.find((record) => store.readJson(dir, 'split.json').assignments[record.id] === 'heldout') : records[0];
      if (source === 'question') pair.question.text = text;
      if (source === 'context') pair.context.push({ author: 'Fictional Colleague', text });
      if (source === 'heldout') pair.answer.text = text;
      store.writeJsonl(dir, 'pairs.jsonl', records);
      const original = store.writeText;
      t.mock.method(store, 'writeText', (base, name, content, options) => {
        if (name.endsWith(target)) content += `\n${copy}`;
        return original(base, name, content, options);
      });
      const out = path.join(path.dirname(dir), 'leaking-package');
      let message = '';
      try { exportPersona(dir, out); } catch (error) { message = error.message; }
      assert.ok(message.includes(target) && message.includes(`(${pair.id})`));
      assert.ok(!message.includes(text) && !message.includes(copy) && !message.includes('ガッツポーズ'));
      assert.equal(fs.existsSync(out), false);
      assertNoStage(dir);
    });
  }
}

test('owner excerpts use Slack id or sample display name; raw interviews are never copied verbatim', (t) => {
  for (const owner of [null, 'fictional-owner']) {
    const dir = fixture(t);
    const manifest = store.readJson(dir, 'persona.json');
    store.writeJson(dir, 'persona.json', { ...manifest, owner: { slack_user_id: owner } });
    const records = store.readJsonl(dir, 'pairs.jsonl');
    records[0].question = { author: owner || manifest.display_name, text: 'A fictional owner message about a quiet lighthouse pilot.' };
    records[0].context = [{ author: owner || manifest.display_name, text: 'A fictional owner context about a small paper lantern trial.' }];
    store.writeJsonl(dir, 'pairs.jsonl', records);
    store.writeText(dir, 'identity.md', read(dir, 'identity.md') + `\n${records[0].question.text.slice(0, 30)}\n${records[0].context[0].text.slice(0, 30)}`);
    exportPersona(dir, path.join(path.dirname(dir), 'owner-package'));
    const answer = store.readJsonl(dir, 'interview.jsonl')[0];
    store.writeText(dir, 'identity.md', read(dir, 'identity.md') + `\n${answer.answer}`);
    assert.throws(() => exportPersona(dir, path.join(path.dirname(dir), 'interview-package')), /identity\.md.*iv-0001/);
    assert.equal(fs.existsSync(path.join(path.dirname(dir), 'interview-package')), false);
    assertNoStage(dir);
  }
});

for (const source of ['build-answer', 'interview']) {
  test(`raw ${source} text in the package README refuses export`, (t) => {
    const dir = fixture(t);
    const needle = source === 'build-answer'
      ? { id: 'sample-01', text: store.readJsonl(dir, 'pairs.jsonl')[0].answer.text }
      : { id: 'iv-0001', text: store.readJsonl(dir, 'interview.jsonl')[0].answer };
    const original = store.writeText;
    t.mock.method(store, 'writeText', (base, name, content, options) =>
      original(base, name, name.endsWith('README.md') ? content + needle.text : content, options));
    const out = path.join(path.dirname(dir), 'raw-package');
    assert.throws(() => exportPersona(dir, out), new RegExp(`README\\.md \\(${needle.id}\\)`));
    assert.equal(fs.existsSync(out), false);
    assertNoStage(dir);
  });
}

test('held-out text already in the identity refuses before staging without printing answer fragments', (t) => {
  const dir = fixture(t);
  const assignments = store.readJson(dir, 'split.json').assignments;
  const pair = store.readJsonl(dir, 'pairs.jsonl').find((record) => assignments[record.id] === 'heldout');
  store.writeText(dir, 'identity.md', read(dir, 'identity.md') + pair.answer.text);
  const out = path.join(path.dirname(dir), 'heldout-package');
  assert.throws(() => exportPersona(dir, out), (error) => error.message === `identity.md (${pair.id})`);
  assert.equal(fs.existsSync(out), false);
  assertNoStage(dir);
});

test('check failure and a failed destination write leave no partial package', (t) => {
  const dir = fixture(t);
  const out = path.join(path.dirname(dir), 'failed-package');
  const originalCheck = check.runChecks;
  const checkMock = t.mock.method(check, 'runChecks', (base, options) => options?.extraFiles
    ? { ok: false, findings: [{ name: options.extraFiles[0], id: 'sample-10', message: 'Held-out answer window.' }] }
    : originalCheck(base, options));
  assert.throws(() => exportPersona(dir, out), /plugin\.json.*sample-10/);
  assert.equal(fs.existsSync(out), false);
  assertNoStage(dir);
  checkMock.mock.restore();
  const originalWrite = store.writeText;
  let writes = 0;
  t.mock.method(store, 'writeText', (base, ...args) => {
    if (base === out && ++writes === 2) throw new Error('Fictional disk write failure.');
    return originalWrite(base, ...args);
  });
  assert.throws(() => exportPersona(dir, out), /Fictional disk write failure/);
  assert.equal(writes, 2);
  assert.equal(fs.existsSync(out), false);
  assertNoStage(dir);
});

test('--out is guarded against public and unverifiable repositories, including symlink aliases', async (t) => {
  const dir = fixture(t);
  const manifest = store.readJson(dir, 'persona.json');
  store.writeJson(dir, 'persona.json', { ...manifest, synthetic: false });
  store._resetGuardCache();
  const repo = path.join(path.dirname(dir), 'public-repo');
  fs.mkdirSync(repo);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const args of [['init', '--quiet'], ['remote', 'add', 'origin', 'https://example.invalid/fictional/public.git']]) {
    const git = childProcess.spawnSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' });
    assert.equal(git.status, 0, git.stderr);
  }
  const alias = path.join(path.dirname(dir), 'repo-alias');
  fs.symlinkSync(repo, alias);
  for (const verdict of ['public', 'unknown']) {
    const out = path.join(alias, verdict);
    let probes = 0;
    const result = await cli(['export', '--persona', dir, '--out', out], {}, () => { probes += 1; return verdict; });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /public|unverifiable/);
    assert.ok(probes > 0);
    assert.equal(fs.existsSync(out), false);
    assertNoStage(dir);
  }
  store.writeJson(dir, 'persona.json', { ...manifest, synthetic: true });
  const out = path.join(alias, 'synthetic');
  assert.equal((await cli(['export', '--persona', dir, '--out', out], {}, () => { throw new Error('Synthetic must not probe.'); })).code, 0);
  assert.deepEqual(files(out), [...packageFiles].sort());
});

test('existing output is preserved and missing or uncommitted identity refuses without writes', (t) => {
  const dir = fixture(t);
  const out = path.join(path.dirname(dir), 'existing');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'keep.txt'), 'Fictional existing file.');
  assert.throws(() => exportPersona(dir, out), /already exists/i);
  assert.equal(read(out, 'keep.txt'), 'Fictional existing file.');
  for (const name of ['identity.json', 'identity.md']) {
    const missing = fixture(t);
    fs.unlinkSync(path.join(missing, name));
    assert.throws(() => exportPersona(missing, path.join(path.dirname(missing), 'absent')), /committed identity/i);
    assert.equal(fs.existsSync(path.join(path.dirname(missing), 'absent')), false);
  }
  store.writeJson(dir, 'persona.json', { ...store.readJson(dir, 'persona.json'), version: 0 });
  assert.throws(() => exportPersona(dir, path.join(path.dirname(dir), 'uncommitted')), /committed identity/i);
  assertNoStage(dir);
});

test('CLI exports to default and explicit destinations using persona flags, environment and one-persona home', async (t) => {
  const dir = fixture(t);
  for (const [args, env, out] of [
    [['export', '--out', path.join(path.dirname(dir), 'home-chosen')], { BUNSHIN_HOME: path.dirname(dir) }, path.join(path.dirname(dir), 'home-chosen')],
    [['export', '--persona', dir], {}, path.join(dir, 'export', 'sample-v1')],
    [['export', '--out', path.join(path.dirname(dir), 'chosen')], { BUNSHIN_PERSONA: dir }, path.join(path.dirname(dir), 'chosen')],
  ]) {
    const result = await cli(args, env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { files: packageFiles.map((name) => path.join(out, name)) });
  }
  for (const args of [['export', '--out'], ['export', '--out', '--persona', dir],
    ['export', '--out', 'one', '--out', 'two'], ['export', 'extra'], ['export', '--unknown'],
    ['export', '--persona'], ['export', '--persona', dir, '--persona', dir]]) {
    const result = await cli(args, { BUNSHIN_PERSONA: dir });
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Usage: bunshin export/);
  }
});

test('CLI end to end initializes and exports the synthetic sample with a temporary BUNSHIN_HOME', (t) => {
  const dir = fixture(t);
  const home = path.join(path.dirname(dir), 'home');
  const env = { ...process.env, BUNSHIN_HOME: home };
  delete env.BUNSHIN_PERSONA;
  for (const args of [['init', '--sample'], ['export']]) {
    const result = childProcess.spawnSync(process.execPath, [path.join(root, 'bin', 'bunshin.js'), ...args], {
      cwd: root, env, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
  }
  assert.deepEqual(files(path.join(home, 'sample', 'export', 'sample-v1')), [...packageFiles].sort());
});
