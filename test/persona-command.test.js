'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawn, spawnSync } = require('node:child_process');
const kb = require('../lib/kb');
const store = require('../lib/store');
const identity = require('../lib/identity');
const command = require('../lib/commands/persona');
const { main } = require('../bin/bunshin');

const cli = path.resolve(__dirname, '../bin/bunshin.js');
const usage = 'Usage: bunshin persona kb [<name> | --unset] [--persona <dir>]\n';

function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-persona-')));
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); store._resetGuardCache(); });
  const dir = path.join(home, 'sample');
  fs.cpSync(path.join(__dirname, '..', 'sample', 'persona'), dir, { recursive: true });
  const env = { BUNSHIN_HOME: home };
  const kbDir = kb.resolve({ name: 'demo', env });
  for (const file of ['kb.json', 'sources.jsonl', 'entries/model.md']) {
    store.writeText(kbDir, file, fs.readFileSync(path.join(__dirname, '..', 'sample', 'kb', 'demo', file), 'utf8'), { synthetic: true });
  }
  const run = (args) => {
    let stdout = '';
    let stderr = '';
    const code = command.run(args, { env, stdout: { write: (text) => { stdout += text; } },
      stderr: { write: (text) => { stderr += text; } } });
    return { code, stdout, stderr };
  };
  const manifestText = () => fs.readFileSync(path.join(dir, 'persona.json'), 'utf8');
  return { home, dir, env, kbDir, run, manifestText };
}

test('persona kb binds a valid KB, shows it, and keeps every other manifest field', (t) => {
  const { dir, env, run } = fixture(t);
  const before = store.readJson(dir, 'persona.json');
  assert.deepEqual(run(['kb']), { code: 0, stdout: 'unbound\n', stderr: '' });
  assert.deepEqual(run(['kb', 'demo']), { code: 0, stdout: 'Bound persona sample to KB demo\n', stderr: '' });
  assert.deepEqual(store.readJson(dir, 'persona.json'), { ...before, kb: 'demo' });
  assert.equal(kb.loadBound(dir, env).name, 'demo');
  assert.deepEqual(run(['kb']), { code: 0, stdout: 'demo\n', stderr: '' });
  assert.deepEqual(run(['kb', 'demo']), { code: 0, stdout: 'Bound persona sample to KB demo\n', stderr: '' });
});

test('persona kb --unset removes the binding and is idempotent', (t) => {
  const { dir, run } = fixture(t);
  const before = store.readJson(dir, 'persona.json');
  assert.equal(run(['kb', 'demo']).code, 0);
  assert.deepEqual(run(['kb', '--unset']), { code: 0, stdout: 'Unbound persona sample\n', stderr: '' });
  assert.deepEqual(store.readJson(dir, 'persona.json'), before);
  assert.equal(Object.hasOwn(store.readJson(dir, 'persona.json'), 'kb'), false);
  assert.deepEqual(run(['kb', '--unset']), { code: 0, stdout: 'Unbound persona sample\n', stderr: '' });
  assert.deepEqual(run(['kb']), { code: 0, stdout: 'unbound\n', stderr: '' });
});

test('persona kb refuses a missing KB without changing persona.json', (t) => {
  const { run, manifestText } = fixture(t);
  const before = manifestText();
  assert.deepEqual(run(['kb', 'nope']), { code: 1, stdout: '', stderr: 'KB nope not found\n' });
  assert.equal(manifestText(), before);
});

test('persona kb refuses a KB that fails kb check or has parse errors without changing persona.json', (t) => {
  const { kbDir, run, manifestText } = fixture(t);
  const before = manifestText();
  const valid = fs.readFileSync(path.join(kbDir, 'entries/model.md'), 'utf8');
  store.writeText(kbDir, 'entries/model.md', valid.replace('S01#E11', 'S99#E11'), { synthetic: true });
  assert.deepEqual(run(['kb', 'demo']), { code: 1, stdout: '',
    stderr: 'KB demo fails kb check: source-ref: Entry demo.model.provider sources references unknown source S99.\n' });
  assert.equal(manifestText(), before);
  store.writeText(kbDir, 'entries/model.md', `${valid}\nnot an entry line\n`, { synthetic: true });
  const parsed = run(['kb', 'demo']);
  assert.equal(parsed.code, 1);
  assert.match(parsed.stderr, /^KB demo has parse errors: /);
  assert.equal(manifestText(), before);
});

test('persona kb unset still works when the bound KB is now invalid', (t) => {
  const { dir, kbDir, run } = fixture(t);
  assert.equal(run(['kb', 'demo']).code, 0);
  fs.rmSync(kbDir, { recursive: true, force: true });
  assert.deepEqual(run(['kb']), { code: 0, stdout: 'demo\n', stderr: '' });
  assert.deepEqual(run(['kb', '--unset']), { code: 0, stdout: 'Unbound persona sample\n', stderr: '' });
  assert.equal(Object.hasOwn(store.readJson(dir, 'persona.json'), 'kb'), false);
});

test('persona kb rejects bad arguments with usage and exit 2', (t) => {
  const { run, manifestText } = fixture(t);
  const before = manifestText();
  for (const args of [[], ['other'], ['kb', 'Demo'], ['kb', '--help'], ['kb', 'demo', 'extra'],
    ['kb', 'demo', '--unset'], ['kb', '--unset', '--unset'], ['kb', '--persona'], ['kb', '../demo']]) {
    assert.deepEqual(run(args), { code: 2, stdout: '', stderr: usage }, args.join(' '));
  }
  assert.equal(manifestText(), before);
});

test('persona kb honours --persona and the binding survives an identity commit', (t) => {
  const { home, dir, env } = fixture(t);
  fs.cpSync(path.join(__dirname, '..', 'sample', 'persona'), path.join(home, 'other'), { recursive: true });
  const result = spawnSync(process.execPath, [cli, 'persona', 'kb', 'demo', '--persona', dir],
    { env: { ...process.env, ...env }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'Bound persona sample to KB demo\n');
  assert.equal(store.readJson(path.join(home, 'other'), 'persona.json').kb, undefined);
  identity.commit(dir, store.readJson(dir, 'identity.json'));
  assert.equal(store.readJson(dir, 'persona.json').kb, 'demo');
});

test('store.updateManifest writes the changed manifest under the identity lock', (t) => {
  const { dir } = fixture(t);
  const before = store.readJson(dir, 'persona.json');
  const result = store.updateManifest(dir, (manifest) => ({ ...manifest, kb: 'demo' }));
  assert.deepEqual(result, { ...before, kb: 'demo' });
  assert.deepEqual(store.readJson(dir, 'persona.json'), result);
  assert.equal(fs.existsSync(path.join(dir, '.identity.lock')), false);
  assert.throws(() => store.updateManifest(dir, () => { throw new Error('stop'); }), /stop/);
  assert.deepEqual(store.readJson(dir, 'persona.json'), result);
  assert.equal(fs.existsSync(path.join(dir, '.identity.lock')), false);
});

test('store.updateManifest waits for a live identity lock before writing', (t) => {
  const { dir } = fixture(t);
  const lock = path.join(dir, '.identity.lock');
  const child = spawn(process.execPath, ['-e',
    `setTimeout(() => require('node:fs').unlinkSync(${JSON.stringify(lock)}), 400); setTimeout(() => {}, 600);`]);
  t.after(() => child.kill());
  fs.writeFileSync(lock, JSON.stringify({ pid: child.pid, started_at: new Date().toISOString() }));
  const started = Date.now();
  store.updateManifest(dir, (manifest) => ({ ...manifest, kb: 'demo' }));
  assert.ok(Date.now() - started >= 300, 'updateManifest did not wait for the lock');
  assert.equal(store.readJson(dir, 'persona.json').kb, 'demo');
});

test('store.updateManifest rolls back an interrupted identity commit before applying the change', (t) => {
  const { dir } = fixture(t);
  const journal = ['identity.json', 'identity.md', 'persona.json'].map((file) => ({
    path: file, text: fs.readFileSync(path.join(dir, file), 'utf8'),
  }));
  const original = JSON.parse(journal[2].text);
  journal[2].text = `${JSON.stringify({ ...original, display_name: 'Journal Name' }, null, 2)}\n`;
  fs.writeFileSync(path.join(dir, '.identity-transaction.json'), JSON.stringify(journal));
  const result = store.updateManifest(dir, (manifest) => ({ ...manifest, kb: 'demo' }));
  assert.equal(fs.existsSync(path.join(dir, '.identity-transaction.json')), false);
  assert.deepEqual(result, { ...original, display_name: 'Journal Name', kb: 'demo' });
  assert.deepEqual(store.readJson(dir, 'persona.json'), result);
});

test('identity commit keeps a binding written while the commit was in progress', (t) => {
  const { dir } = fixture(t);
  const hook = () => { store.updateManifest(dir, (manifest) => ({ ...manifest, kb: 'demo' })); return { ok: true }; };
  identity.preCommitChecks.push(hook);
  t.after(() => { identity.preCommitChecks.splice(identity.preCommitChecks.indexOf(hook), 1); });
  const before = store.readJson(dir, 'persona.json');
  identity.commit(dir, store.readJson(dir, 'identity.json'));
  assert.deepEqual(store.readJson(dir, 'persona.json'), { ...before, kb: 'demo', version: before.version + 1 });
});

test('identity commit refuses when another commit changed the version in the meantime', (t) => {
  const { dir } = fixture(t);
  const hook = () => { store.updateManifest(dir, (manifest) => ({ ...manifest, version: manifest.version + 1 })); return { ok: true }; };
  identity.preCommitChecks.push(hook);
  t.after(() => { identity.preCommitChecks.splice(identity.preCommitChecks.indexOf(hook), 1); });
  const identityText = fs.readFileSync(path.join(dir, 'identity.json'), 'utf8');
  assert.throws(() => identity.commit(dir, store.readJson(dir, 'identity.json')),
    { message: 'persona.json version changed during identity commit; run it again.' });
  assert.equal(fs.readFileSync(path.join(dir, 'identity.json'), 'utf8'), identityText);
  assert.equal(fs.existsSync(path.join(dir, '.identity-transaction.json')), false);
});

test('help lists the persona command', async () => {
  let stdout = '';
  assert.equal(await main(['--help'], { stdout: { write: (text) => { stdout += text; } }, stderr: { write() {} } }), 0);
  assert.match(stdout, /\n {2}persona {4}Show, bind or unbind a persona's knowledge base\n/);
});
