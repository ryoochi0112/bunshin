'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const acceptance = require('../scripts/acceptance');
const hosts = require('../lib/hosts');

const search = 'mcp__claude_ai_Notion__notion-search';
const slack = 'mcp__claude_ai_Slack__slack_search_channels';
const init = (extra = {}) => ({
  type: 'system', subtype: 'init', tools: ['ToolSearch'],
  plugins: [{ name: 'telemetry', path: 'builtin', source: 'telemetry@builtin' }],
  slash_commands: ['debug', 'loop'], skills: ['debug'], ...extra,
});
const use = (id, name) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: {} }] } });
const res = (id, extra = {}) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'x' }], ...extra }] } });
const done = (denials = []) => ({ type: 'result', result: 'ok', is_error: false, permission_denials: denials });
const clean = () => [init(), use('n1', search), res('n1'),
  use('s1', slack), res('s1', { is_error: true }), done([{ tool_name: slack, tool_use_id: 's1', tool_input: {} }])];
const allow = hosts.allowedTools({});
const check = (raw) => acceptance.checkIsolation(raw, allow);

function stubs(raw) {
  const calls = [];
  const out = [];
  const io = { stdout: { write: (t) => out.push(t) }, stderr: { write() {} } };
  const runHost = async (options) => {
    calls.push(options);
    const n = calls.length - 1;
    const text = n === 1 ? 'Try a pilot. (priority: Reversibility)' : n === 2 ? 'わかりません。\nSources: none' : 'I do not know.\nSources: none';
    return { text, raw: n === 4 ? raw : clean() };
  };
  const processRun = async (command, args, options) => {
    if (command === 'claude') return 'I do not know.\nSources: none';
    if (args[1] === 'export') {
      const fs = require('node:fs');
      const path = require('node:path');
      const manifest = path.join(options.env.BUNSHIN_PERSONA, 'export', 'sample-v1', '.claude-plugin', 'plugin.json');
      fs.mkdirSync(path.dirname(manifest), { recursive: true });
      fs.writeFileSync(manifest, '{}');
      return JSON.stringify({ files: [manifest] });
    }
    if (args[2] === 'run') return 'ok';
    return 'drafter: claude default · judge: claude default\n';
  };
  return { calls, out, io, runHost, processRun };
}

test('checks 1 and 3 run the real drafter config; check 2 stays tool-less', async () => {
  const s = stubs(clean());
  assert.equal(await acceptance.main(['--host', 'claude'], s), 0);
  assert.match(s.out.join(''), /acceptance: 6\/6 passed\n$/);
  assert.deepEqual(s.calls.map((c) => c.tools), ['notion-read', 'none', 'notion-read', 'notion-read', 'notion-read']);
  for (const c of s.calls) assert.deepEqual(c.allowedTools, allow);
});

test('check 6 passes on a clean raw and fails (alone) on each bad raw', async () => {
  const bad = {
    plugin: [init({ plugins: [{ name: 'rstaff', path: '/u/p', source: 'rstaff@market' }] }), ...clean().slice(1)],
    command: [init({ slash_commands: ['debug', 'rstaff:review'] }), ...clean().slice(1)],
    slackOk: [init(), use('n1', search), res('n1'), use('s1', slack), res('s1'), done()],
    noNotion: [init(), use('s1', slack), res('s1', { is_error: true }), done()],
  };
  for (const [name, raw] of Object.entries(bad)) {
    const s = stubs(raw);
    assert.equal(await acceptance.main(['--host', 'claude'], s), 1, name);
    assert.match(s.out.join(''), /^FAIL 6 drafter isolation: /m, name);
    assert.match(s.out.join(''), /acceptance: 5\/6 passed\n$/, name);
  }
});

test('check 6 clauses each fail when violated and pass when satisfied', () => {
  check(clean());
  check([init(), use('n1', search), res('n1'), done()]); // no Slack attempt is fine
  check([init(), use('n1', search), res('n1'), use('s1', slack), done([{ tool_use_id: 's1' }])]); // denied, no result
  assert.throws(() => check(null), /event stream/);
  assert.throws(() => check(clean().slice(1)), /init event missing/);
  assert.throws(() => check([init({ plugins: [{ name: 'a', path: '/x', source: 'a@m' }] }), ...clean().slice(1)]), /non-builtin plugin/);
  assert.throws(() => check([init({ plugins: undefined }), ...clean().slice(1)]), /non-builtin plugin/);
  assert.throws(() => check([init({ slash_commands: ['superpowers:plan'] }), ...clean().slice(1)]), /slash_commands/);
  assert.throws(() => check([init({ skills: ['x:y'] }), ...clean().slice(1)]), /skills/);
  // Notion clause: missing, errored, or not matched to its tool_result.
  assert.throws(() => check([init(), use('s1', slack), res('s1', { is_error: true })]), /Notion/);
  assert.throws(() => check([init(), use('n1', search), res('n1', { is_error: true })]), /Notion/);
  assert.throws(() => check([init(), use('n1', search), res('other')]), /Notion/);
  assert.throws(() => check([init(), use('n1', 'mcp__claude_ai_Notion__notion-fetch'), res('n1')]), /Notion/);
  // Slack clause: succeeded (even if also listed as denied), or neither denied nor errored.
  const base = [init(), use('n1', search), res('n1')];
  assert.throws(() => check([...base, use('s1', slack), res('s1')]), /succeeded/);
  assert.throws(() => check([...base, use('s1', slack.toUpperCase()), res('s1'), done([{ tool_use_id: 's1' }])]), /succeeded/);
  assert.throws(() => check([...base, use('s1', slack), done([{ tool_use_id: 'zzz' }])]), /neither denied/);
});

test('check 6 failure reasons never print tool_result content', async () => {
  const secret = 'SECRET-NOTION-CONTENT-CANARY-123456';
  const raw = [init(), use('n1', search), res('n1'), use('s1', slack),
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 's1', content: [{ type: 'text', text: secret }] }] } }];
  const s = stubs(raw);
  await acceptance.main(['--host', 'claude'], s);
  assert.doesNotMatch(s.out.join(''), new RegExp(secret));
});

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

// Process boundary stub: no CLI/model/network spawn in these Codex checks.
function codexStub(mutate = () => {}) {
  const calls = [];
  const homes = new Set();
  let output = '';
  return {
    calls, homes, output: () => output,
    io: { stdout: { write: (s) => { output += s; } }, stderr: { write() {} } },
    runHost: async (options) => {
      calls.push({ host: options });
      assert.equal(options.tools, 'notion-read');
      assert.match(options.system, /Sources:/);
      const reply = { text: 'I do not know.\nSources: none', model: 'codex-measured' };
      mutate('spec', reply);
      return reply;
    },
    processRun: async (command, args, options) => {
      calls.push({ command, args, options });
      homes.add(options.env.BUNSHIN_HOME);
      assert.equal(options.env.BUNSHIN_PERSONA, path.join(options.env.BUNSHIN_HOME, 'sample'));
      assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 300000);
      const dir = options.env.BUNSHIN_PERSONA;
      if (command === 'codex') {
        assert.deepEqual(args.slice(0, 5), ['exec', '-s', 'workspace-write', '--skip-git-repo-check', '--ephemeral']);
        assert.deepEqual(args.slice(5, 14), ['--strict-config', '--ignore-user-config', '--ignore-rules',
          '--disable', 'apps', '--disable', 'plugins', '--disable', 'remote_plugin']);
        assert.deepEqual(args.slice(14, 26), ['--disable', 'view_image', '--disable', 'image_generation',
          '--disable', 'goals', '--disable', 'sleep_tool', '--disable', 'multi_agent', '-c', 'web_search="disabled"']);
        assert.equal(args[26], '-C');
        assert.equal(args[27], options.cwd);
        assert.deepEqual(args.slice(28, 32), ['-c', 'sandbox_workspace_write.exclude_slash_tmp=true',
          '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true']);
        assert.equal(args[32], '-c');
        const instructions = JSON.parse(args[33].slice('model_instructions_file='.length));
        assert.match(fs.readFileSync(instructions, 'utf8'), /Pipe the draft JSON directly into `identity commit -`/);
        assert.equal(options.env.HOME, options.cwd);
        assert.equal(options.env.CODEX_HOME, process.env.CODEX_HOME || path.join(require('node:os').homedir(), '.codex'));
        assert.ok(!options.env.CODEX_HOME.startsWith(options.cwd + path.sep));
        assert.ok(!('authHome' in options));
        assert.deepEqual(Object.keys(options.env).sort(),
          ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE'].filter(key => process.env[key] !== undefined)
            .concat(['HOME', 'TMPDIR', 'CODEX_HOME', 'BUNSHIN_HOME', 'BUNSHIN_PERSONA', 'CLAUDE_PLUGIN_ROOT']).sort());
        assert.equal(fs.existsSync(path.join(options.cwd, '.codex')), false);
        assert.equal(options.env.CLAUDE_PLUGIN_ROOT, path.join(options.cwd, 'engine'));
        assert.ok(dir.startsWith(options.cwd + path.sep));
        assert.ok(!('CODEX_THREAD_ID' in options.env));
        let checked = '';
        assert.equal(await require(path.join(options.env.CLAUDE_PLUGIN_ROOT, 'bin/bunshin.js'))
          .main(['check'], { env: options.env, stdout: { write: text => { checked += text; } },
            stderr: { write: text => { throw new Error(text); } } }), 0);
        assert.equal(checked, 'Held-out checks passed.\n');
        const draft = JSON.parse(fs.readFileSync(path.join(root, 'sample/persona/identity.json')));
        draft.voice[0].statement = 'Explain the answer plainly, including its limits.';
        mutate('build', draft);
        if (draft) require('../lib/identity').commit(dir, draft);
        return 'Agent claims success';
      }
      assert.equal(command, process.execPath);
      assert.equal(options.cwd, root);
      const action = args.slice(1);
      if (action[0] === 'eval' && action[1] === 'run') {
        assert.deepEqual(action, ['eval', 'run', '--drafter', action[3], '--judge', action[5], '--limit', '2']);
        assert.deepEqual([action[3].split(':')[0], action[5]], calls.filter(c => c.args?.[1] === 'eval').length === 1
          ? ['codex', 'claude'] : ['claude', 'codex']);
        const evalDir = path.join(dir, 'evals', `2026-10-05-0${action[5] === 'claude' ? 1 : 2}`);
        fs.mkdirSync(evalDir, { recursive: true });
        const report = { drafter: { host: action[3].split(':')[0], models: ['writer-measured'] },
          judge: { host: action[5], models: ['judge-measured'] }, judge_errors: 0 };
        mutate('eval', report);
        fs.writeFileSync(path.join(evalDir, 'report.json'), JSON.stringify(report));
        fs.writeFileSync(path.join(evalDir, 'drafts.jsonl'), '{}\n{}\n');
        fs.writeFileSync(path.join(evalDir, 'judgments.jsonl'), '{"rating":"send_as_is"}\n{"rating":"needs_edits"}\n');
        return 'drafted 2, judged 2, judge errors 0';
      }
      if (action[0] === 'eval') {
        const latest = fs.readdirSync(path.join(dir, 'evals')).sort().at(-1);
        const r = JSON.parse(fs.readFileSync(path.join(dir, 'evals', latest, 'report.json')));
        return `drafter: ${r.drafter.host} ${r.drafter.models?.join(', ')} · judge: ${r.judge.host} ${r.judge.models?.join(', ')}\n`;
      }
      if (action[0] === 'shadow' && action[1] === 'draft') {
        const draft = { draft: 'Try a reversible pilot.', drafter: { host: 'codex', model: 'codex-measured' } };
        mutate('shadow', draft);
        fs.writeFileSync(path.join(dir, 'shadow', action[2], 'draft.json'), JSON.stringify(draft));
        return draft.draft;
      }
      let stdout = '', stderr = '';
      const io = { env: options.env, stdout: { write: s => { stdout += s; } }, stderr: { write: s => { stderr += s; } } };
      const code = await require(`../lib/commands/${action[0]}`).run(action.slice(1), io);
      if (code !== 0) throw new Error(stderr);
      const result = { text: stdout };
      mutate(action[0], result);
      return result.text;
    },
  };
}

test('Codex acceptance runs six checks on one synthetic home and cleans up', async () => {
  assert.deepEqual(acceptance.parseArgs(['--host', 'codex']), { host: 'codex', timeoutMs: 300000 });
  const s = codexStub();
  assert.equal(await acceptance.main(['--host', 'codex'], s), 0, s.output());
  assert.equal(s.output(), 'PASS 1 build identity commit\nPASS 2 codex drafter / claude judge\nPASS 3 claude drafter / codex judge\nPASS 4 shadow pasted text\nPASS 5 export and check\nPASS 6 spec no-source\nacceptance: 6/6 passed\n');
  assert.equal(s.homes.size, 1);
  for (const home of s.homes) assert.equal(fs.existsSync(home), false);
  assert.deepEqual(s.calls.filter(c => c.args?.[1] === 'check').map(c => c.args.slice(1)),
    [['check'], ['check'], ['check'], ['check']]);
});

test('Codex acceptance fails on file/CLI outcomes, never the agent success claim', async () => {
  for (const [stage, change, check] of [
    ['build', d => { delete d.voice; }, 1],
    ['build', d => { for (const key of ['voice', 'priorities', 'objections', 'context_rules']) d[key] = []; }, 1],
    ['eval', r => { r.drafter.models = [null]; }, 2],
    ['eval', r => { r.judge.host = 'fake'; }, 2],
    ['eval', r => { r.judge_errors = 2; }, 2],
    ['shadow', d => { d.drafter.host = 'fake'; }, 4],
    ['export', r => { r.text = '{}'; }, 5],
    ['spec', r => { r.text = 'A guess.\nSources: none'; }, 6],
  ]) {
    const s = codexStub((name, value) => { if (name === stage) change(value); });
    assert.equal(await acceptance.main(['--host', 'codex'], s), 1, stage);
    assert.match(s.output(), new RegExp(`^FAIL ${check} `, 'm'), stage);
    assert.doesNotMatch(s.output(), /codex unavailable \/ over quota/, stage);
    for (const home of s.homes) assert.equal(fs.existsSync(home), false);
  }
});

test('Codex unavailable or quota failures produce six FAIL lines and nonzero exit', async () => {
  const s = codexStub();
  s.processRun = async () => { throw new Error('process exited 1'); };
  s.runHost = async () => { throw new Error('codex host: could not start'); };
  assert.equal(await acceptance.main(['--host', 'codex'], s), 1);
  assert.equal(s.output().split('\n').filter(l => l.startsWith('FAIL ')).length, 6);
  assert.match(s.output(), /codex unavailable \/ over quota/);
  assert.match(s.output(), /acceptance: 0\/6 passed/);
});

test('Codex process runner supports a spawn stub without a model call', async () => {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  let spawned = false;
  const output = await acceptance.runProcess('codex', ['exec', '-s', 'workspace-write'], {
    cwd: root, env: { BUNSHIN_HOME: '/synthetic-only' }, timeoutMs: 1000,
    spawnProcess(command, args, options) {
      spawned = true;
      assert.equal(command, 'codex');
      assert.deepEqual(args, ['exec', '-s', 'workspace-write']);
      assert.deepEqual(options.env, { BUNSHIN_HOME: '/synthetic-only' });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      process.nextTick(() => { child.stdout.end('stub output'); child.emit('close', 0); });
      return child;
    },
  });
  assert.equal(spawned, true);
  assert.equal(output, 'stub output');
});


test('build passes through a configured credential home without reading or copying it', async () => {
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = '/nonexistent-synthetic-codex-home';
  try {
    const s = codexStub();
    assert.equal(await acceptance.main(['--host', 'codex'], s), 0, s.output());
    assert.equal(s.calls[0].options.env.CODEX_HOME, process.env.CODEX_HOME);
    assert.equal(fs.existsSync(process.env.CODEX_HOME), false);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});

test('Codex signals kill the detached build group, remove workspace and exit nonzero', async () => {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
    const signalSource = new EventEmitter();
    const killed = [];
    const exits = [];
    let workspace;
    let spawnCount = 0;
    const s = codexStub();
    s.signalSource = signalSource;
    s.exit = value => {
      assert.equal(fs.existsSync(workspace), false, 'cleanup precedes exit');
      assert.deepEqual(killed, [[-12345, 'SIGKILL']]);
      exits.push(value);
    };
    s.processRun = (command, args, options) => acceptance.runProcess(command, args, {
      ...options, timeoutMs: 50,
      killProcess: (pid, sig) => killed.push([pid, sig]),
      spawnProcess(cmd, argv, settings) {
        spawnCount++;
        assert.equal(cmd, 'codex');
        assert.equal(settings.detached, process.platform !== 'win32');
        workspace = settings.cwd;
        assert.equal(fs.existsSync(workspace), true);
        const child = new EventEmitter();
        child.pid = 12345;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        process.nextTick(() => signalSource.emit(signal));
        // No close event: cleanup must also work when a child never reports exit.
        return child;
      },
    });
    assert.equal(await acceptance.main(['--host', 'codex'], s), 1);
    assert.deepEqual(exits, [code]);
    assert.equal(spawnCount, 1);
    assert.doesNotMatch(s.output(), /PASS /);
    assert.equal(s.calls.length, 0, 'no model call after interruption');
    for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) assert.equal(signalSource.listenerCount(name), 0);
  }
});

test('a generic Codex process failure does not claim an unavailable host or quota', async () => {
  const s = codexStub();
  s.processRun = async () => { throw new Error('process exited 1'); };
  s.runHost = async () => { throw new Error('codex host: exited with code 1'); };
  assert.equal(await acceptance.main(['--host', 'codex'], s), 1);
  assert.doesNotMatch(s.output(), /codex unavailable \/ over quota/);
  assert.match(s.output(), /FAIL 1 build identity commit: process exited 1/);
});


test('Codex docs describe the build read boundary and credential passthrough', () => {
  const doc = fs.readFileSync(path.join(root, 'docs/codex.md'), 'utf8');
  for (const line of [
    '`workspace-write` restricts writes, not reads: this shell-enabled build agent can',
    'read outside its temporary workspace, including the real Codex credential home.',
    'The runner never reads or copies credentials. It passes the real `CODEX_HOME`',
    'SIGINT, SIGTERM and SIGHUP kill active child process groups, remove the temporary',
  ]) assert.ok(doc.split('\n').includes(line), `Missing boundary: ${line}`);
  assert.doesNotMatch(doc, /copies only `auth.json`|including the authentication copy/);
});
