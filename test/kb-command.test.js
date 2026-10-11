'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const store = require('../lib/store');
const kb = require('../lib/kb');
const check = require('../lib/kb-check');
const command = require('../lib/commands/kb');

const sample = path.resolve(__dirname, '../sample/kb/demo');
const cli = path.resolve(__dirname, '../bin/bunshin.js');

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

function readEntry(dir) { return fs.readFileSync(path.join(dir, 'entries/model.md'), 'utf8'); }
function writeEntry(dir, text) { store.writeText(dir, 'entries/model.md', text, { synthetic: true }); }

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
  const today = new Date().toISOString().slice(0, 10);
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
    .replace('verified: 2026-01-01', `verified: ${new Date().toISOString().slice(0, 10)}`));
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
