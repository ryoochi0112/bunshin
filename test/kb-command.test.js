'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { Readable } = require('node:stream');
const store = require('../lib/store');
const kb = require('../lib/kb');
const check = require('../lib/kb-check');
const command = require('../lib/commands/kb');

const sample = path.resolve(__dirname, '../sample/kb/demo');
const cli = path.resolve(__dirname, '../bin/bunshin.js');

function ssotBlock(section, text = 'Cloudberry Lantern uses a fictional model.', backs = 'demo.model.provider') {
  return `## ${section}\ntitle: Sample ${section}\n\n### demo.${section}.s1\ntext: ${text}\nbacks: ${backs}\nselect: model=Lantern\n`;
}

test('SSOT CLI drafts, approves, shows, enables and disables without changing entries', (t) => {
  const { dir, env, run } = initialized(t);
  const original = readEntry(dir);
  const first = ssotBlock('model');
  const second = ssotBlock('details');
  const drafted = ingest(env, ['ssot', 'draft', 'demo'], first + '\n' + second);
  assert.equal(drafted.status, 0, drafted.stderr);
  assert.equal(fs.readFileSync(path.join(dir, 'ssot.md'), 'utf8'), '# demo SSOT\n\n' + first + '\n' + second);
  assert.deepEqual(run(['ssot', 'status', 'demo']), { code: 0,
    stdout: 'model  draft  1 statements\ndetails  draft  1 statements\nuncovered 0\n', stderr: '' });
  assert.equal(run(['ssot', 'approve', 'demo', 'model']).code, 0);
  const ssot = require('../lib/kb-ssot');
  const data = kb.load(dir);
  const row = store.readJsonl(dir, 'ssot-approvals.jsonl')[0];
  assert.deepEqual(Object.keys(row).sort(), ['approved_at', 'backing_hash', 'id', 'text_hash']);
  assert.equal(row.id, 'model');
  assert.equal(new Date(row.approved_at).toISOString(), row.approved_at);
  assert.equal(row.text_hash, ssot.textHash(data.ssot.sections[0]));
  assert.equal(row.backing_hash, ssot.backingHash(data.ssot.sections[0], data));
  assert.deepEqual(run(['ssot', 'show', 'demo', 'model']), { code: 0, stdout: first + '\nstate: approved\n', stderr: '' });
  assert.match(run(['ssot', 'status', 'demo']).stdout, /^model  approved  1 statements/m);
  assert.equal(run(['ssot', 'enable', 'demo']).code, 0);
  assert.equal(store.readJson(dir, 'kb.json').digest, 'ssot');
  assert.equal(run(['ssot', 'disable', 'demo']).code, 0);
  assert.equal(store.readJson(dir, 'kb.json').digest, 'entries');
  assert.equal(readEntry(dir), original);

  const changed = ssotBlock('model', 'Cloudberry Lantern uses the fictional Lantern model.');
  assert.equal(ingest(env, ['ssot', 'draft', 'demo'], changed + '\n' + ssotBlock('extra')).status, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'ssot.md'), 'utf8'), '# demo SSOT\n\n' + changed + '\n' + second + '\n' + ssotBlock('extra'));
  assert.match(run(['ssot', 'status', 'demo']).stdout, /^model  changed  1 statements/m);
  assert.equal(run(['ssot', 'approve', 'demo', 'model']).code, 0);
  assert.equal(store.readJsonl(dir, 'ssot-approvals.jsonl').length, 2);
  writeEntry(dir, readEntry(dir).replace('claim: Cloudberry Lantern', 'claim: Sample Cloudberry Lantern'));
  assert.match(run(['ssot', 'status', 'demo']).stdout, /^model  stale  1 statements/m);
  assert.equal(run(['flag', 'demo', 'demo.model.provider', '--reason', 'Sample review']).code, 0);
  assert.match(run(['ssot', 'status', 'demo']).stdout, /^model  blocked  1 statements/m);
});

test('SSOT uncovered includes only verified unflagged entries backed by no statement', (t) => {
  const { env, run } = initialized(t);
  assert.equal(run(['ssot', 'status', 'demo']).stdout, 'uncovered 1\ndemo.model.provider\n');
  assert.equal(run(['approve', 'demo', 'demo.model.region']).code, 0);
  assert.equal(run(['approve', 'demo', 'demo.model.retention', '--resolve']).code, 0);
  assert.equal(run(['flag', 'demo', 'demo.model.retention', '--reason', 'Sample review']).code, 0);
  assert.equal(ingest(env, ['ssot', 'draft', 'demo'], ssotBlock('model')).status, 0);
  assert.equal(run(['ssot', 'status', 'demo']).stdout, 'model  draft  1 statements\nuncovered 1\ndemo.model.region\n');
});

for (const [label, input, setup] of [
  ['bad block', ssotBlock('details').replace('text:', 'unknown:')],
  ['unknown backing', ssotBlock('details', undefined, 'demo.model.missing')],
  ['draft backing', ssotBlock('details', undefined, 'demo.model.region')],
  ['conflict backing', ssotBlock('details', undefined, 'demo.model.retention')],
  ['retired backing', ssotBlock('details', undefined, 'demo.model.legacy')],
  ['flagged backing', ssotBlock('details'), (f) => f.run(['flag', 'demo', 'demo.model.provider', '--reason', 'Sample review'])],
  ['email', ssotBlock('details', 'sample.person@example.invalid')],
  ['phone', ssotBlock('details', '０９０－１２３４－５６７８')],
  ['scrub text', ssotBlock('details', 'ＬＵＭＡＣＬＩＥＮＴ')],
  ['scrub title', ssotBlock('details').replace('Sample details', 'LumaClient')],
  ['email select', ssotBlock('details').replace('model=Lantern', 'model=sample.person@example.invalid')],
  ['scrub select key', ssotBlock('details').replace('model=Lantern', 'LumaClient=Lantern')],
  ['scrub select value', ssotBlock('details').replace('model=Lantern', 'model=LumaClient')],
]) {
  test(`SSOT draft refuses ${label} before writing the whole batch`, (t) => {
    const f = initialized(t);
    store.writeText(path.dirname(f.dir), 'demo.scrub.txt', 'LumaClient\n', { synthetic: true });
    if (setup) setup(f);
    const before = directoryHash(f.dir);
    const result = ingest(f.env, ['ssot', 'draft', 'demo'], ssotBlock('model') + '\n' + input);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /details/);
    for (const secret of ['sample.person@example.invalid', '０９０－１２３４－５６７８', 'LumaClient', 'ＬＵＭＡＣＬＩＥＮＴ']) {
      assert.ok(!result.stderr.includes(secret));
    }
    assert.equal(directoryHash(f.dir), before);
  });
}

test('SSOT refusals and usage errors leave the KB unchanged', (t) => {
  const { dir, env, run } = initialized(t);
  const before = directoryHash(dir);
  for (const action of ['approve', 'show']) assert.equal(run(['ssot', action, 'demo', 'missing']).code, 1);
  assert.deepEqual(run(['ssot', 'enable', 'demo']), { code: 1, stdout: '', stderr: 'No approved SSOT section.\n' });
  for (const text of ['', '# document title\n', ssotBlock('model') + '\n' + ssotBlock('model')]) {
    assert.equal(ingest(env, ['ssot', 'draft', 'demo'], text).status, 1);
    assert.equal(directoryHash(dir), before);
  }
  for (const args of [['ssot'], ['ssot', 'other', 'demo'], ['ssot', 'approve', 'demo'],
    ['ssot', 'show', 'demo', '../bad'], ['ssot', 'draft', 'demo', 'extra'],
    ['ssot', 'status', 'demo', '--other'], ['ssot', 'enable', '../demo']]) {
    assert.equal(run(args).code, 2);
  }
  assert.equal(directoryHash(dir), before);
});

test('SSOT approve refuses unsafe hand-edited text, bad backs and parse errors without writes', (t) => {
  const { dir, run } = initialized(t);
  store.writeText(path.dirname(dir), 'demo.scrub.txt', 'LumaClient\n', { synthetic: true });
  for (const text of [ssotBlock('model', 'sample.person@example.invalid'), ssotBlock('model', 'LumaClient'),
    ssotBlock('model').replace('Sample model', 'LumaClient'), ssotBlock('model').replace('model=Lantern', 'model=LumaClient'),
    ssotBlock('model', undefined, 'demo.model.region'), ssotBlock('model', undefined, 'demo.model.missing'),
    ssotBlock('model').replace('text:', 'unknown:')]) {
    store.writeText(dir, 'ssot.md', '# demo SSOT\n\n' + text, { synthetic: true });
    const before = directoryHash(dir);
    const result = run(['ssot', 'approve', 'demo', 'model']);
    assert.equal(result.code, 1);
    assert.ok(!result.stderr.includes('LumaClient'));
    assert.ok(!result.stderr.includes('sample.person@example.invalid'));
    assert.equal(directoryHash(dir), before);
  }
});

test('SSOT draft accepts stream stdin and writer returns added and replaced sections', async (t) => {
  const { dir, env } = initialized(t);
  let stdout = '';
  let stderr = '';
  const first = ssotBlock('model');
  const code = await command.run(['ssot', 'draft', 'demo'], { env, probe: () => 'private',
    stdin: Readable.from([first.slice(0, 20), first.slice(20)]),
    stdout: { write(text) { stdout += text; } }, stderr: { write(text) { stderr += text; } } });
  assert.equal(code, 0, stderr);
  assert.ok(stdout.includes('model'));
  const writer = require('../lib/kb-ssot-write');
  assert.deepEqual(writer.draft(dir, ssotBlock('model') + '\n' + ssotBlock('details')), { added: ['details'], replaced: ['model'] });
});

test('SSOT show prints the final section, including a single section without a final newline', (t) => {
  const { dir, run } = initialized(t);
  const first = ssotBlock('model');
  const last = ssotBlock('details').trimEnd();
  store.writeText(dir, 'ssot.md', '# Sample title\n\n' + first + '\n' + last, { synthetic: true });
  assert.deepEqual(run(['ssot', 'show', 'demo', 'details']), { code: 0, stdout: last + '\nstate: draft\n', stderr: '' });
  store.writeText(dir, 'ssot.md', '# Sample title\n\n' + last, { synthetic: true });
  assert.deepEqual(run(['ssot', 'show', 'demo', 'details']), { code: 0, stdout: last + '\nstate: draft\n', stderr: '' });
});

test('SSOT enable and approve refusals preserve an existing draft or blocked section', (t) => {
  const { dir, env, run } = initialized(t);
  assert.equal(ingest(env, ['ssot', 'draft', 'demo'], ssotBlock('model')).status, 0);
  let before = directoryHash(dir);
  assert.deepEqual(run(['ssot', 'enable', 'demo']), { code: 1, stdout: '', stderr: 'No approved SSOT section.\n' });
  assert.equal(directoryHash(dir), before);
  assert.equal(run(['ssot', 'approve', 'demo', 'model']).code, 0);
  assert.equal(run(['flag', 'demo', 'demo.model.provider', '--reason', 'Sample review']).code, 0);
  before = directoryHash(dir);
  assert.equal(run(['ssot', 'approve', 'demo', 'model']).code, 1);
  assert.equal(run(['ssot', 'enable', 'demo']).code, 1);
  assert.equal(ingest(env, ['ssot', 'draft', 'demo'], ssotBlock('model', 'Sample replacement.')).status, 1);
  assert.equal(directoryHash(dir), before);
});

test('SSOT draft refuses reserved entry slugs and redacts private section names', (t) => {
  const { dir, env } = initialized(t);
  store.writeText(path.dirname(dir), 'demo.scrub.txt', 'lumaclient\n', { synthetic: true });
  let before = directoryHash(dir);
  const result = ingest(env, ['ssot', 'draft', 'demo'], ssotBlock('lumaclient'));
  assert.equal(result.status, 1);
  assert.ok(!result.stderr.includes('lumaclient'));
  assert.equal(result.stdout, '');
  assert.equal(directoryHash(dir), before);
  writeEntry(dir, readEntry(dir).replace('demo.model.provider', 'demo.model.s1'));
  before = directoryHash(dir);
  assert.equal(ingest(env, ['ssot', 'draft', 'demo'], ssotBlock('model', undefined, 'demo.model.s1')).status, 1);
  assert.equal(directoryHash(dir), before);
});

function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-kb-command-')));
  t.after(() => { store._resetGuardCache(); fs.rmSync(home, { recursive: true, force: true }); });
  const env = { BUNSHIN_HOME: home };
  const dir = kb.resolve({ name: 'demo', env });
  const run = (args, extra = {}) => {
    let stdout = '';
    let stderr = '';
    const code = command.run(args, { env, stdout: { write: (text) => { stdout += text; } },
      stderr: { write: (text) => { stderr += text; } }, ...extra });
    return { code, stdout, stderr };
  };
  return { home, dir, env, run };
}

function initialized(t) {
  const f = fixture(t);
  assert.equal(f.run(['init', 'demo', '--sample']).code, 0);
  return f;
}

function localDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
function readEntry(dir) { return fs.readFileSync(path.join(dir, 'entries/model.md'), 'utf8'); }
function writeEntry(dir, text) { store.writeText(dir, 'entries/model.md', text, { synthetic: true }); }

test('CLI stale compares dates, supports dry-run, skips repeat flags, and makes citations not-citable', (t) => {
  const { dir, env, run } = initialized(t);
  const invoke = (...args) => spawnSync(process.execPath, [cli, 'kb', ...args], { env: { ...process.env, ...env }, encoding: 'utf8' });
  const args = ['stale', 'demo', '--source', 'S01', '--changed-at', '2026-10-13'];
  const before = directoryHash(dir);
  for (const date of ['2026-10-11', '2026-10-12']) {
    assert.deepEqual(run(['stale', 'demo', '--source', 'S01', '--changed-at', date]), { code: 0, stdout: '', stderr: '' });
  }
  const dry = invoke(...args, '--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(dry.stdout, 'flagged demo.model.provider\n');
  assert.equal(directoryHash(dir), before);
  store.writeText(path.dirname(dir), 'reply.txt', 'Cloudberry Lantern uses a fictional model. [demo.model.provider]\n', { synthetic: true });
  const citeArgs = ['cite', 'demo', '--draft', path.join(path.dirname(dir), 'reply.txt')];
  assert.equal(run(citeArgs).code, 0);
  const first = invoke(...args);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, 'flagged demo.model.provider\n');
  const after = directoryHash(dir);
  assert.deepEqual(run(args), { code: 0, stdout: 'skipped demo.model.provider\n', stderr: '' });
  assert.equal(directoryHash(dir), after);
  const cited = run(citeArgs);
  assert.equal(cited.code, 1);
  assert.match(cited.stdout, /not-citable/);
  assert.deepEqual(run([...args, '--reason', 'Sample source revision']), { code: 0, stdout: 'flagged demo.model.provider\n', stderr: '' });
  assert.equal(store.readJsonl(dir, 'flags.jsonl').at(-1).reason, 'Sample source revision');
});

test('CLI stale retains strict options and reports invalid source or date as failures', (t) => {
  const { dir, run } = initialized(t);
  const args = ['stale', 'demo', '--source', 'S01', '--changed-at', '2026-10-13'];
  const before = directoryHash(dir);
  for (const invalid of [['stale'], ['stale', 'demo'], ['stale', 'demo', '--source', 'S01'],
    ['stale', 'demo', '--changed-at', '2026-10-13'], [...args, '--other'], [...args, 'extra'],
    [...args, '--reason'], [...args, '--reason', '  '], [...args, '--source', 'S02'],
    [...args, '--dry-run', '--dry-run'], [...args, '--dry-run', 'true']]) {
    assert.equal(run(invalid).code, 2, JSON.stringify(invalid));
  }
  assert.equal(run(['stale', 'missing', '--source', 'S01', '--changed-at', '2026-10-13']).code, 1);
  const unknown = run(['stale', 'demo', '--source', 'S99', '--changed-at', '2026-10-13']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /unknown source/i);
  for (const date of ['bad', '2026-02-30']) {
    const result = run(['stale', 'demo', '--source', 'S01', '--changed-at', date]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /YYYY-MM-DD/);
  }
  assert.equal(directoryHash(dir), before);
  assert.match(run(['--help']).stdout, /stale <name> --source S<nn> --changed-at <date>/);
});

test('init creates an empty KB and sample init renames manifest and entry ids', (t) => {
  const { run, home } = fixture(t);
  assert.equal(run(['init', 'empty']).code, 0);
  const empty = path.join(home, 'kb/empty');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(empty, 'kb.json'), 'utf8')), {
    format_version: 1, name: 'empty', product: 'empty', synthetic: false, languages: ['ja'],
  });
  assert.deepEqual(fs.readdirSync(path.join(empty, 'entries')), []);
  assert.equal(fs.readFileSync(path.join(empty, 'sources.jsonl'), 'utf8'), '');
  assert.equal(run(['init', 'sample-copy', '--sample']).code, 0);
  const copied = kb.load(path.join(home, 'kb/sample-copy'));
  assert.deepEqual(copied.errors, []);
  assert.equal(copied.manifest.name, 'sample-copy');
  assert.equal(copied.manifest.synthetic, true);
  assert.equal(copied.entries.length, 4);
  assert.ok(copied.entries.every((entry) => entry.id.startsWith('sample-copy.')));
  assert.equal(run(['init', 'sample-copy', '--sample']).code, 1);
  assert.equal(run(['check', 'sample-copy']).code, 0);
});

test('approve changes only the draft block through the atomic store writer', (t) => {
  const { run, dir } = initialized(t);
  const before = readEntry(dir);
  const original = store.writeText;
  const calls = [];
  t.mock.method(store, 'writeText', (...args) => { calls.push(args); return original(...args); });
  const today = localDate();
  assert.equal(run(['approve', 'demo', 'demo.model.region']).code, 0);
  const expected = before.replace('status: draft\n', `status: verified\nverified: ${today}\n`);
  assert.equal(readEntry(dir), expected);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], dir);
  assert.equal(calls[0][1], 'entries/model.md');
  assert.equal(run(['check', 'demo']).code, 0);
});

test('approval preserves CRLF, field comments, existing date, and heading boundaries', (t) => {
  const { run, dir } = initialized(t);
  let before = readEntry(dir).replace('status: draft\n', 'status: draft  # pending\nverified: 2026-01-01\n');
  before = before.replace('\n### demo.model.retention', '\n# Sample divider\nText outside any entry.\n\n### demo.model.retention').replace(/\n/g, '\r\n');
  writeEntry(dir, before);
  assert.equal(run(['approve', 'demo', 'demo.model.region']).code, 0);
  assert.equal(readEntry(dir), before.replace('status: draft  # pending', 'status: verified  # pending')
    .replace('verified: 2026-01-01', `verified: ${localDate()}`));
});

test('conflicts require resolve and exactly one claim; retired and verified refuse approval', (t) => {
  const { run, dir } = initialized(t);
  const before = readEntry(dir);
  assert.equal(run(['approve', 'demo', 'demo.model.retention']).code, 1);
  assert.equal(readEntry(dir), before);
  writeEntry(dir, before.replace('status: conflict', 'claim: 別の架空の回答。\nstatus: conflict'));
  const unresolved = readEntry(dir);
  const refused = run(['approve', 'demo', 'demo.model.retention', '--resolve']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /one claim/i);
  assert.equal(readEntry(dir), unresolved);
  writeEntry(dir, before.replace('claim: 保持期間について、資料には７日と１４日の異なる記載がある。\n', ''));
  assert.equal(run(['approve', 'demo', 'demo.model.retention', '--resolve']).code, 1);
  writeEntry(dir, before);
  assert.equal(run(['approve', 'demo', 'demo.model.retention', '--resolve']).code, 0);
  assert.equal(kb.load(dir).entries.find((entry) => entry.id.endsWith('.retention')).status, 'verified');
  for (const id of ['demo.model.provider', 'demo.model.legacy']) {
    assert.equal(run(['approve', 'demo', id]).code, 1);
  }
});

test('list filters topic and effective status, truncates claims, show prints only selected block', (t) => {
  const { run, dir } = initialized(t);
  const result = kb.load(dir);
  assert.equal(run(['list', 'demo']).stdout, result.entries.map((entry) => `${entry.id}  ${entry.status}  ${entry.claim.slice(0, 60)}\n`).join(''));
  assert.match(run(['list', 'demo', '--status', 'draft', '--topic', 'model']).stdout, /^demo.model.region  draft  /);
  assert.equal(run(['list', 'demo', '--topic', 'absent']).stdout, '');
  const before = readEntry(dir);
  const block = before.slice(before.indexOf('### demo.model.region'), before.indexOf('### demo.model.retention'));
  assert.equal(run(['show', 'demo', 'demo.model.region']).stdout, block);
  writeEntry(dir, before.replace('claim: Cloudberry Lantern の処理地域は架空の北地域を予定している。', `claim: ${'架'.repeat(80)}`));
  assert.equal(run(['list', 'demo', '--status', 'draft']).stdout, `demo.model.region  draft  ${'架'.repeat(60)}\n`);
});

test('flag and unflag append history and latest row controls list status', (t) => {
  const { run, dir } = initialized(t);
  const before = readEntry(dir);
  const append = store.appendJsonl;
  const calls = [];
  t.mock.method(store, 'appendJsonl', (...args) => { calls.push(args); return append(...args); });
  assert.equal(run(['flag', 'demo', 'demo.model.region', '--reason', 'Sample review needed']).code, 0);
  const first = fs.readFileSync(path.join(dir, 'flags.jsonl'), 'utf8');
  assert.equal(JSON.parse(first).reason, 'Sample review needed');
  assert.match(run(['list', 'demo', '--status', 'flagged']).stdout, /^demo.model.region  flagged  /);
  assert.equal(run(['list', 'demo', '--status', 'draft']).stdout, '');
  assert.equal(run(['unflag', 'demo', 'demo.model.region']).code, 0);
  const history = fs.readFileSync(path.join(dir, 'flags.jsonl'), 'utf8');
  assert.ok(history.startsWith(first));
  assert.equal(history.trim().split('\n').length, 2);
  assert.equal(kb.load(dir).flags.get('demo.model.region').flagged, false);
  assert.equal(run(['list', 'demo', '--status', 'flagged']).stdout, '');
  assert.match(run(['list', 'demo', '--status', 'draft']).stdout, /^demo.model.region  draft  /);
  assert.equal(readEntry(dir), before);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((args) => args[0] === dir && args[1] === 'flags.jsonl'));
});

test('check delegates options and prints every finding without leaking scrub matches', (t) => {
  const { run, dir } = initialized(t);
  const probe = () => 'private';
  const original = check.run;
  const calls = [];
  t.mock.method(check, 'run', (...args) => { calls.push(args); return original(...args); });
  store.writeText(path.dirname(dir), 'demo.scrub.txt', 'hidden-demo\n', { synthetic: true });
  store.writeText(dir, 'entries/hidden-demo.md', '### demo.model.hidden-demo\nclaim: hidden-demo\nstatus: draft\nsources: S99#E1\n', { synthetic: true });
  const checked = run(['check', 'demo'], { probe });
  assert.equal(checked.code, 1);
  assert.equal(calls[0][0], dir);
  assert.equal(calls[0][1].probe, probe);
  const findings = original(dir, { probe }).findings;
  assert.ok(findings.length >= 3);
  assert.deepEqual(checked.stdout.trim().split('\n').map((line) => JSON.parse(line)), findings);
  assert.ok(!(checked.stdout + checked.stderr).includes('hidden-demo'));
});

test('usage errors return 2; absent KB/entry, ambiguous or invalid entries return 1', (t) => {
  const { run, dir } = initialized(t);
  for (const args of [[], ['unknown', 'demo'], ['init'], ['init', '../demo'], ['init', 'demo', '--other'],
    ['list', 'demo', '--status', 'unknown'], ['list', 'demo', '--topic'], ['list', 'demo', '--topic', 'model', '--topic', 'model'],
    ['show', 'demo'], ['show', 'demo', 'bad-id'], ['approve', 'demo', 'demo.model.region', '--other'],
    ['flag', 'demo', 'demo.model.region'], ['flag', 'demo', 'demo.model.region', '--reason', '  '],
    ['unflag', 'demo', 'demo.model.region', '--reason', 'sample'], ['check', 'demo', 'extra']]) {
    assert.equal(run(args).code, 2, JSON.stringify(args));
  }
  assert.equal(run(['check', 'missing']).code, 1);
  assert.equal(run(['list', 'missing']).code, 1);
  for (const action of ['show', 'approve', 'flag', 'unflag']) {
    const tail = action === 'flag' ? ['--reason', 'Sample review'] : [];
    assert.equal(run([action, 'demo', 'demo.model.absent', ...tail]).code, 1);
  }
  const before = readEntry(dir);
  writeEntry(dir, before + '\n### demo.model.region\nclaim: 架空の回答。\nstatus: draft\nsources: S01#E1\n');
  const duplicate = readEntry(dir);
  for (const action of ['show', 'approve', 'flag', 'unflag']) {
    assert.equal(run([action, 'demo', 'demo.model.region', ...(action === 'flag' ? ['--reason', 'Sample review'] : [])]).code, 1);
  }
  assert.equal(readEntry(dir), duplicate);
  writeEntry(dir, before.replace('demo.model.region', 'demo.Model.region'));
  assert.equal(run(['list', 'demo']).code, 1);
});

test('command reads only sample and temp fixtures (record outside wrapped run)', (t) => {
  const { run, home } = fixture(t);
  const original = fs.readFileSync;
  const reads = [];
  t.mock.method(fs, 'readFileSync', (file, ...args) => { reads.push(path.resolve(file)); return original(file, ...args); });
  assert.equal(run(['init', 'demo', '--sample']).code, 0);
  for (const args of [['check', 'demo'], ['list', 'demo'], ['show', 'demo', 'demo.model.region'],
    ['approve', 'demo', 'demo.model.region'], ['flag', 'demo', 'demo.model.region', '--reason', 'Sample review'],
    ['unflag', 'demo', 'demo.model.region']]) assert.equal(run(args).code, 0);
  assert.ok(reads.length > 0);
  assert.ok(reads.every((file) => file.startsWith(`${home}${path.sep}`) || file.startsWith(`${sample}${path.sep}`)), JSON.stringify(reads));
});

test('CLI help lists kb and subprocess commands use only a temporary home', (t) => {
  const { env } = fixture(t);
  const invoke = (...args) => spawnSync(process.execPath, [cli, ...args], { env: { ...process.env, ...env }, encoding: 'utf8' });
  const help = invoke('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^  kb\s/m);
  assert.equal(invoke('kb', 'init', 'demo', '--sample').status, 0);
  assert.equal(invoke('kb', 'approve', 'demo', 'demo.model.region').status, 0);
  assert.equal(invoke('kb', 'check', 'demo').status, 0);
  assert.equal(invoke('kb', 'approve', 'demo', 'demo.model.retention').status, 1);
  assert.equal(invoke('kb', 'flag', 'demo', 'demo.model.retention', '--reason', 'Sample review').status, 0);
  assert.match(invoke('kb', 'list', 'demo').stdout, /demo.model.retention  flagged  /);
  assert.equal(invoke('kb', 'flag', 'demo').status, 2);
});

for (const text of ['s01(2026-10-09)', 's12#c14 2026-10-09', '2026-10-09 - 2026-10-12', 'S01#E11（2026-10-09）, S02（2026-10-10）']) {
  test(`CLI kb check accepts source refs and dates: ${text}`, (t) => {
    const { run, dir } = initialized(t);
    writeEntry(dir, `${readEntry(dir)}note: ${text}\n`);
    assert.equal(run(['check', 'demo']).code, 0);
  });
}

for (const text of ['電話03-1234-5678', 'TEL03-1234-5678', 'S01 TEL 03-1234-5678']) {
  test(`CLI kb check rejects phone: ${text}`, (t) => {
    const { run, dir } = initialized(t);
    writeEntry(dir, `${readEntry(dir)}note: ${text}\n`);
    assert.equal(run(['check', 'demo']).code, 1);
  });
}

const piiTable = require('./kb-pii-table');

for (const text of piiTable.clean) {
  test(`CLI kb check table: not flagged: ${text}`, (t) => {
    const { run, dir } = initialized(t);
    writeEntry(dir, `${readEntry(dir)}note: ${text}\n`);
    assert.equal(run(['check', 'demo']).code, 0);
  });
}

for (const text of piiTable.phones) {
  test(`CLI kb check table: flagged: ${text}`, (t) => {
    const { run, dir } = initialized(t);
    writeEntry(dir, `${readEntry(dir)}note: ${text}\n`);
    assert.equal(run(['check', 'demo']).code, 1);
  });
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

function ingest(env, args, input) {
  return spawnSync(process.execPath, [cli, 'kb', ...args], {
    env: { ...process.env, ...env }, input, encoding: 'utf8',
  });
}

const sourceRow = { kind: 'slack', label: 'Sample KB thread', ref: 'https://example.invalid/demo/thread', answered_at: '2026-10-13' };
const draftRow = { id: 'demo.model.next', claim: 'Cloudberry Lantern supports a fictional model.', sources: ['S01#E14'] };

test('CLI sources add and draft consume JSONL, preserve existing entry bytes, and list new drafts', (t) => {
  const { dir, env, run } = initialized(t);
  const sources = [sourceRow, { ...sourceRow, id: 'S04', kind: 'notion', label: 'Sample KB extra notes', ref: 'https://example.invalid/demo/extra' }];
  const registered = ingest(env, ['sources', 'add', 'demo'], `\n${sources.map((row) => JSON.stringify(row)).join('\r\n\n')}\n`);
  assert.equal(registered.status, 0, registered.stderr);
  assert.equal(registered.stdout, 'S03  Sample KB thread\nS04  Sample KB extra notes\n');
  const before = readEntry(dir);
  const answer = { row_id: 'sample-14', cell: 'E14', question: 'Which fictional model?', answer: 'Lantern', answer_type: 'text' };
  const entries = [{ ...draftRow, id: 'demo.security.transport', sources: ['S03#p3'], answers: [answer] }, draftRow];
  const drafted = ingest(env, ['draft', 'demo'], `\n${entries.map((row) => JSON.stringify(row)).join('\n\n')}\n`);
  assert.equal(drafted.status, 0, drafted.stderr);
  assert.equal(drafted.stdout, 'demo.security.transport\ndemo.model.next\n');
  assert.equal(readEntry(dir), before + '\n### demo.model.next\nclaim: Cloudberry Lantern supports a fictional model.\nstatus: draft\nsources: S01#E14\n');
  assert.equal(fs.readFileSync(path.join(dir, 'entries/security.md'), 'utf8'), '# security\n\n### demo.security.transport\nclaim: Cloudberry Lantern supports a fictional model.\nstatus: draft\nsources: S03#p3\n');
  assert.deepEqual(store.readJsonl(dir, 'answers.jsonl'), [{ ...answer, source: 'S03', entry: 'demo.security.transport', excluded: null, why: '' }]);
  const listed = run(['list', 'demo', '--status', 'draft']);
  assert.equal(listed.code, 0);
  assert.match(listed.stdout, /^demo.model.next  draft  /m);
  assert.match(listed.stdout, /^demo.security.transport  draft  /m);
});

for (const [label, args, first, bad] of [
  ['duplicate ref', ['sources', 'add', 'demo'], { ...sourceRow, ref: 'https://example.invalid/demo/first' }, { ...sourceRow, ref: 'https://example.invalid/demo/model' }],
  ['duplicate sha', ['sources', 'add', 'demo'], { ...sourceRow, ref: 'https://example.invalid/demo/first' }, { ...sourceRow, file_sha256: '0'.repeat(64) }],
  ['scrub label', ['sources', 'add', 'demo'], { ...sourceRow, ref: 'https://example.invalid/demo/first' }, { ...sourceRow, label: 'LumaClient' }],
  ['email ref', ['sources', 'add', 'demo'], { ...sourceRow, ref: 'https://example.invalid/demo/first' }, { ...sourceRow, ref: 'demo.person@example.invalid' }],
  ['bad prefix', ['draft', 'demo'], { ...draftRow, id: 'demo.new.first' }, { ...draftRow, id: 'other.model.next' }],
  ['retired id reuse', ['draft', 'demo'], { ...draftRow, id: 'demo.new.first' }, { ...draftRow, id: 'demo.model.legacy' }],
  ['unknown source', ['draft', 'demo'], { ...draftRow, id: 'demo.new.first' }, { ...draftRow, sources: ['S99#p3'] }],
  ['scrub claim', ['draft', 'demo'], { ...draftRow, id: 'demo.new.first' }, { ...draftRow, claim: 'ＬＵＭＡＣＬＩＥＮＴ' }],
]) {
  test(`CLI ${label} exits 1 with no file changes for the whole batch`, (t) => {
    const { dir, env } = initialized(t);
    store.writeText(path.dirname(dir), 'demo.scrub.txt', 'LumaClient\n', { synthetic: true });
    const before = directoryHash(dir);
    const result = ingest(env, args, [first, bad].map((row) => JSON.stringify(row)).join('\n'));
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^Row 2:/);
    assert.ok(!result.stderr.includes('LumaClient'));
    assert.equal(directoryHash(dir), before);
  });
}

test('new CLI actions reject malformed JSONL before writes and retain strict usage parsing', (t) => {
  const { dir, env, run } = initialized(t);
  for (const [args, row] of [[['sources', 'add', 'demo'], sourceRow], [['draft', 'demo'], draftRow]]) {
    const before = directoryHash(dir);
    const result = ingest(env, args, `\n${JSON.stringify(row)}\n\n{broken\n`);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^Line 4: invalid JSON/);
    assert.equal(directoryHash(dir), before);
    assert.equal(ingest(env, args, '\n \r\n').status, 0);
    assert.equal(directoryHash(dir), before);
  }
  for (const args of [['sources', 'demo'], ['sources', 'list', 'demo'], ['sources', 'add'],
    ['sources', 'add', '../demo'], ['sources', 'add', 'demo', '--other'], ['sources', 'add', 'demo', 'extra'],
    ['draft'], ['draft', 'demo', '--status', 'verified'], ['draft', 'demo', 'extra']]) {
    assert.equal(run(args).code, 2, JSON.stringify(args));
  }
  assert.equal(ingest(env, ['draft', 'missing'], JSON.stringify(draftRow)).status, 1);
});

test('new CLI actions accept stream stdin and draft runs the checker after writing', async (t) => {
  const { dir, env } = initialized(t);
  const probe = () => 'private';
  const invoke = async (args, stdin) => {
    let stdout = '';
    let stderr = '';
    const code = await command.run(args, { env, probe, stdin,
      stdout: { write(text) { stdout += text; } }, stderr: { write(text) { stderr += text; } } });
    return { code, stdout, stderr };
  };
  const sourceText = JSON.stringify(sourceRow);
  assert.equal((await invoke(['sources', 'add', 'demo'], Readable.from([sourceText.slice(0, 15), sourceText.slice(15)]))).code, 0);
  const original = check.run;
  const calls = [];
  t.mock.method(check, 'run', (...args) => {
    calls.push(args);
    assert.ok(kb.load(dir).entries.some((entry) => entry.id === draftRow.id));
    return original(...args);
  });
  const result = await invoke(['draft', 'demo'], JSON.stringify(draftRow));
  assert.deepEqual(result, { code: 0, stdout: 'demo.model.next\n', stderr: '' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], dir);
  assert.equal(calls[0][1].probe, probe);
});

test('draft prints post-write checker findings and exits 1 when the KB needs review', (t) => {
  const { dir, env } = initialized(t);
  store.writeText(dir, 'entries/model.md', readEntry(dir) + '\n# demo.person@example.invalid\n', { synthetic: true });
  const result = ingest(env, ['draft', 'demo'], JSON.stringify(draftRow));
  assert.equal(result.status, 1);
  const [added, ...findings] = result.stdout.trim().split('\n');
  assert.equal(added, draftRow.id);
  assert.deepEqual(findings.map((line) => JSON.parse(line)), check.run(dir).findings);
  assert.ok(!result.stdout.includes('demo.person@example.invalid'));
  assert.equal(kb.load(dir).entries.find((entry) => entry.id === draftRow.id).status, 'draft');
});

for (const [label, ending] of [['CR', '\r'], ['LF', '\n'], ['NUL', '\0'], ['U+2028', '\u2028'], ['U+2029', '\u2029']]) {
  for (const [field, args, first, bad] of [
    ['note', ['draft', 'demo'], { ...draftRow, id: 'demo.new.first' }, { ...draftRow, note: `a${ending}b` }],
    ['claim', ['draft', 'demo'], { ...draftRow, id: 'demo.new.first' }, { ...draftRow, claim: `a${ending}b` }],
    ['select value', ['draft', 'demo'], { ...draftRow, id: 'demo.new.first' }, { ...draftRow, select: { model: `a${ending}b` } }],
    ['source label', ['sources', 'add', 'demo'], { ...sourceRow, ref: 'https://example.invalid/demo/first' }, { ...sourceRow, label: `a${ending}b` }],
  ]) {
    test(`CLI refuses ${label} in ${field} with no file changes for the whole batch`, (t) => {
      const { dir, env } = initialized(t);
      const before = directoryHash(dir);
      const result = ingest(env, args, [first, bad].map((row) => JSON.stringify(row)).join('\n'));
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /^Row 2:/);
      assert.equal(directoryHash(dir), before);
      assert.deepEqual(kb.load(dir).errors, []);
    });
  }
}

test('CLI refuses a prepared parse error before writing entries or answers', (t) => {
  const { dir, env } = initialized(t);
  const before = directoryHash(dir);
  const answer = { row_id: 14, cell: 'E14', question: 'Which fictional model?', answer: 'Lantern', answer_type: 'text' };
  const rows = [
    { ...draftRow, id: 'demo.new.first', answers: [answer] },
    { ...draftRow, claim: ' # hidden claim' },
  ];
  const result = ingest(env, ['draft', 'demo'], rows.map((row) => JSON.stringify(row)).join('\n'));
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^Row 2: entries\/model\.md:\d+ Missing claim\.\n$/);
  assert.equal(directoryHash(dir), before);
  assert.deepEqual(kb.load(dir).errors, []);
});

for (const [field, value, id] of [
  ['ref', 'https://example.invalid/demo/model', 'S02'],
  ['file_sha256', '0'.repeat(64), 'S01'],
]) {
  test(`CLI duplicate ${field} names ${id} and writes nothing`, (t) => {
    const { dir, env } = initialized(t);
    const before = directoryHash(dir);
    const rows = [{ ...sourceRow, ref: 'https://example.invalid/demo/first' }, { ...sourceRow, [field]: value }];
    const result = ingest(env, ['sources', 'add', 'demo'], rows.map((row) => JSON.stringify(row)).join('\n'));
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `Row 2: Source ${field} already exists as ${id}.\n`);
    assert.equal(directoryHash(dir), before);
  });
}
