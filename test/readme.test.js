'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const acceptance = require('../scripts/acceptance');

const root = path.resolve(__dirname, '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const commands = [
  'node bin/bunshin.js init --sample',
  'node bin/bunshin.js eval run --drafter fake:test/fixtures/hosts/eval-drafts.json --judge fake:test/fixtures/hosts/judge-replies.json',
  'node bin/bunshin.js eval report',
];

function temporaryHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-readme-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function capture() {
  const output = { stdout: '', stderr: '' };
  return {
    output,
    stdout: { write(text) { output.stdout += text; } },
    stderr: { write(text) { output.stderr += text; } },
  };
}

test('README sections, installation and whole limit sentences are pinned', () => {
  assert.deepEqual([...readme.matchAll(/^## (.+)$/gm)].map((match) => match[1]), [
    'What it is', 'Install', 'Codex', 'Privacy boundary', '5-minute sample path', 'Your own persona', 'Formats', 'Status',
  ]);
  const lines = readme.split('\n');
  for (const sentence of [
    '/plugin marketplace add ryoochi0112/bunshin',
    '/plugin install bunshin',
    'git clone https://github.com/ryoochi0112/bunshin && cd bunshin',
    'Persona data lives only in `~/bunshin-personas/<name>`, never in the repo.',
    "The repo's `.gitignore` and a test guard this privacy boundary.",
    "Commands refuse to write persona data into a git repo with a public remote, and refuse when the remote's privacy cannot be verified.",
    'Persona data goes to `~/bunshin-personas/sample` (or `$BUNSHIN_HOME/sample` when configured).',
    'The fake host needs no model or connector.',
    'Harvest needs the Slack connector and runs on Claude Code only.',
    'Spec answers need the Notion connector for live sources, otherwise the twin says it does not know.',
    'The sample report says "sample too small" because the sample has 3 held-out pairs.',
    'Two judge replies are deliberately invalid, counted as `judge_error` and excluded from rates.',
    'A real launch-bar claim needs about 100 pairs (at least 34 per layer at the default 0.3 held-out ratio).',
    'bunshin never posts or sends anything.',
    'See [docs/codex.md](docs/codex.md) for local plugin installation, supported commands and the online acceptance run.',
    'M2: Claude Code path covers criteria 1–14: harvest, held-out split, build, interview, diagnose, spec answers, idea discussion, shadow, eval, calibration, launch-bar checks, export, privacy and open formats.',
  ]) assert.ok(lines.includes(sentence), `Missing complete line: ${sentence}`);
});

test('README sample commands execute and produce a report in a temporary home', (t) => {
  const block = readme.match(/<!-- sample-path -->\r?\n```sh\r?\n([\s\S]*?)\r?\n```/);
  assert.ok(block, 'sample-path must directly precede a sh block');
  const extracted = block[1].split(/\r?\n/).filter((line) => line.startsWith('node bin/bunshin.js '));
  assert.deepEqual(extracted, commands);
  const home = temporaryHome(t);
  const env = { ...process.env, BUNSHIN_HOME: home, BUNSHIN_PERSONA: '' };
  for (const [index, line] of extracted.entries()) {
    const result = spawnSync(process.execPath, line.split(/\s+/).slice(1), {
      cwd: root, env, encoding: 'utf8', timeout: 30000,
    });
    assert.equal(result.error, undefined, line);
    assert.equal(result.status, 0, `${line}: ${result.stderr}`);
    if (index === 1) {
      const runs = fs.readdirSync(path.join(home, 'sample', 'evals'));
      assert.equal(runs.length, 1);
      assert.ok(fs.statSync(path.join(home, 'sample', 'evals', runs[0], 'report.md')).isFile());
    }
    if (index === 2) {
      assert.match(result.stdout, /sample too small/);
      const shape = readme.match(/```text\r?\n(held-out: [\s\S]*?)\r?\n```/);
      assert.ok(shape, 'README must show the expected report shape');
      const shapeLines = shape[1].split(/\r?\n/);
      const judgeErrors = shapeLines.filter((line) => line.startsWith('judge errors:'));
      assert.deepEqual(judgeErrors, ['judge errors: 2 (excluded from rates)']);
      const reportLines = result.stdout.split(/\r?\n/);
      assert.deepEqual(reportLines.filter((line) => line.startsWith('judge errors:')), judgeErrors);
      for (const line of shapeLines) {
        assert.ok(reportLines.includes(line), `README report line differs from actual output: ${line}`);
      }
    }
  }
});

test('sample walkthrough commands also work in process', async (t) => {
  const home = temporaryHome(t);
  const io = capture();
  io.env = { ...process.env, BUNSHIN_HOME: home, BUNSHIN_PERSONA: '' };
  assert.equal(require('../lib/commands/init').run(['--sample'], io), 0);
  assert.match(io.output.stdout, /Created persona sample/);
  const command = require('../lib/commands/eval');
  assert.equal(await command.run(commands[1].split(/\s+/).slice(3), io), 0);
  assert.match(io.output.stdout, /drafted 3, judged 3, judge errors [0-9]+/);
  io.output.stdout = '';
  assert.equal(await command.run(['report'], io), 0);
  assert.match(io.output.stdout, /sample too small/);
  assert.equal(io.output.stderr, '');
});

test('acceptance usage rejects other hosts end to end without a model call', () => {
  const result = spawnSync(process.execPath, ['scripts/acceptance.js', '--host', 'unsupported'], {
    cwd: root, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^Usage: node scripts\/acceptance\.js --host claude\|codex/);
});

test('Makefile keeps online acceptance separate from verify', () => {
  const makefile = fs.readFileSync(path.join(root, 'Makefile'), 'utf8');
  assert.match(makefile, /^acceptance-codex:\n\tnode scripts\/acceptance\.js --host codex$/m);
  assert.match(makefile, /^verify: syntax test$/m);
  assert.match(makefile, /^acceptance:\n\tnode scripts\/acceptance\.js --host claude$/m);
  assert.match(makefile, /^\.PHONY: verify syntax test acceptance acceptance-codex$/m);
});

test('acceptance argument validation rejects malformed and duplicate values', async () => {
  assert.deepEqual(acceptance.parseArgs(['--host', 'claude']), { host: 'claude', timeoutMs: 300000 });
  assert.deepEqual(acceptance.parseArgs(['--host', 'claude', '--timeout', '1.5', '--model', 'haiku']), {
    host: 'claude', timeoutMs: 1500, model: 'haiku',
  });
  for (const args of [[], ['--host', 'fake'], ['--host', 'xclaude'], ['--host', 'claudex'],
    ['--host', 'claude', '--host', 'claude'], ['--host'], ['--host', 'claude', '--wat', 'x'],
    ...['0', '0.0001', '2147484', '9'.repeat(400), 'x5', '5x', '-1', 'Infinity', ''].map((value) => ['--host', 'claude', '--timeout', value]),
    ['--host', 'claude', '--model', ' '], ['--host', '--model'],
  ]) {
    assert.throws(() => acceptance.parseArgs(args), /Usage:/, JSON.stringify(args));
    const io = capture();
    assert.equal(await acceptance.main(args, { io }), 2);
    assert.equal(io.output.stdout, '');
    assert.match(io.output.stderr, /Usage:/);
  }
});

test('acceptance spec checks reject invalid blocks and missing abstention', () => {
  acceptance.requireSpec('I do not know.\nSources: none', true);
  acceptance.requireSpec('A sourced answer.\nSources:\n- Sample — https://example.invalid/page');
  for (const reply of ['I do not know.', 'I do not know.\nxSources: none',
    'I do not know.\nSources: nonex', 'I do not know.\nSources: none\njunk',
    'I know.\nSources: none', 'xI do not know.\nSources: none', 'I do not know.x\nSources: none',
    'わかりません。\nSources: none', '']) {
    assert.throws(() => acceptance.requireSpec(reply, true), undefined, reply);
  }
  assert.throws(() => acceptance.requireSpec('Answer.\nSources:\n- Sample — https://example.invalid/page', true), /exactly Sources: none/);
});

function cleanRaw() {
  const search = 'mcp__claude_ai_Notion__notion-search';
  return [
    { type: 'system', subtype: 'init', plugins: [{ name: 'telemetry', path: 'builtin', source: 'telemetry@builtin' }], slash_commands: ['debug'], skills: ['debug'] },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'n1', name: search, input: {} }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'n1', content: [] }] } },
    { type: 'result', result: 'ok', permission_denials: [] },
  ];
}

// Inject model/process results so verify remains offline; the real CLI path is tested above.
function offlineAcceptance({ hostReply, processReply } = {}) {
  const io = capture();
  const calls = [];
  const homes = new Set();
  let hostIndex = 0;
  return {
    io, calls, homes,
    runHost: async (options) => {
      calls.push(options);
      const index = hostIndex++;
      const fallback = index === 1 ? 'Try a small pilot. How can it be rolled back? (priority: Reversibility)'
        : index === 2 ? 'わかりません。\nSources: none' : 'I do not know.\nSources: none';
      return { text: hostReply ? await hostReply(index, fallback) : fallback, raw: cleanRaw() };
    },
    processRun: async (command, args, options) => {
      homes.add(options.env.BUNSHIN_HOME);
      if (processReply) {
        const reply = await processReply(command, args, options);
        if (reply !== undefined) return reply;
      }
      if (command === 'claude') {
        assert.deepEqual(fs.readdirSync(options.cwd), []);
        assert.deepEqual(args.slice(0, 2), ['-p', '--plugin-dir']);
        assert.match(args[3], /^\/sample-twin:spec-answer /);
        assert.deepEqual(args.slice(4, 10), ['--setting-sources', '', '--permission-mode', 'dontAsk',
          '--allowedTools', require('../lib/hosts').allowedTools({}).join(',')]);
        assert.deepEqual(args.slice(10), calls[0].model ? ['--model', calls[0].model] : []);
        assert.ok(!Object.keys(options.env).some((key) => key.startsWith('CLAUDE')));
        return 'I do not know.\nSources: none';
      }
      assert.equal(command, process.execPath);
      assert.equal(options.cwd, root);
      assert.equal(options.env.BUNSHIN_PERSONA, path.join(options.env.BUNSHIN_HOME, 'sample'));
      if (args[1] === 'export') {
        const manifest = path.join(options.env.BUNSHIN_PERSONA, 'export', 'sample-v1', '.claude-plugin', 'plugin.json');
        fs.mkdirSync(path.dirname(manifest), { recursive: true });
        fs.writeFileSync(manifest, '{"name":"sample-twin"}');
        return JSON.stringify({ files: [manifest] });
      }
      if (args[2] === 'run') {
        assert.deepEqual(args.slice(1), ['eval', 'run', '--limit', '2']);
        return 'run complete';
      }
      assert.deepEqual(args.slice(1), ['eval', 'report']);
      return 'drafter: claude default · judge: claude default\n';
    },
  };
}

test('acceptance performs all six checks with composed prompts and cleans up', async () => {
  const stub = offlineAcceptance();
  assert.equal(await acceptance.main(['--host', 'claude', '--model', 'haiku'], stub), 0);
  assert.equal(stub.io.output.stdout, 'PASS 1 spec no-source\nPASS 2 idea priority\nPASS 3 language\nPASS 4 eval provenance\nPASS 5 export package\nPASS 6 drafter isolation\nacceptance: 6/6 passed\n');
  assert.equal(stub.calls.length, 5);
  for (const [index, call] of stub.calls.entries()) {
    assert.equal(call.tools, index === 1 ? 'none' : 'notion-read');
    assert.equal(call.model, 'haiku');
    assert.deepEqual(call.allowedTools, require('../lib/hosts').allowedTools({}));
    assert.ok(call.timeoutMs > 0 && call.timeoutMs <= 300000);
    assert.doesNotMatch(call.system, /^---\nname:/);
    assert.doesNotMatch(call.system, /\n---\nname: (?:core|spec-answer|idea-discussion)/);
  }
  for (const home of stub.homes) assert.equal(fs.existsSync(home), false);
});

test('acceptance reports every failure and cleans up after host and process errors', async () => {
  const stub = offlineAcceptance({
    hostReply() { throw new Error('claude host: could not start'); },
    processReply() { throw new Error('process timed out'); },
  });
  assert.equal(await acceptance.main(['--host', 'claude'], stub), 1);
  const lines = stub.io.output.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 7);
  for (let i = 0; i < 6; i++) assert.match(lines[i], new RegExp(`^FAIL ${i + 1} .+: .+`));
  assert.equal(lines[6], 'acceptance: 0/6 passed');
  for (const home of stub.homes) assert.equal(fs.existsSync(home), false);
});

test('acceptance fails individual semantic and output conditions', async () => {
  const scenarios = [
    { check: 1, hostReply: (i, fallback) => i === 0 ? 'A guess.\nSources: none' : fallback },
    { check: 2, hostReply: (i, fallback) => i === 1 ? '(priority: Invented priority)' : fallback },
    { check: 3, hostReply: (i, fallback) => i === 2 ? 'English only' : fallback },
    { check: 3, hostReply: (i, fallback) => i === 3 ? 'English and 日本語' : fallback },
    { check: 3, hostReply: (i, fallback) => i === 3 ? '' : fallback },
    ...['drafter: fake default · judge: claude default', 'drafter: claude default · judge: fake default',
      'junkdrafter: claude default · judge: claude default', 'drafter: claude default · judge: claude default\rjunk']
      .map((report) => ({ check: 4, processReply: (cmd, args) => args[2] === 'report' ? report : undefined })),
    ...['not JSON', '{}', '{"files":[]}'].map((reply) => ({
      check: 5, processReply: (cmd, args) => args[1] === 'export' ? reply : undefined,
    })),
    { check: 5, processReply: (cmd, args) => args[1] === 'export'
      ? '{"files":["/nonexistent-bunshin-package/.claude-plugin/plugin.json"]}' : undefined },
    { check: 5, processReply: (cmd) => cmd === 'claude' ? 'I do not know.\nSources: none\ntrailing junk' : undefined },
  ];
  for (const scenario of scenarios) {
    const stub = offlineAcceptance(scenario);
    assert.equal(await acceptance.main(['--host', 'claude'], stub), 1);
    assert.match(stub.io.output.stdout, new RegExp(`^FAIL ${scenario.check} `, 'm'));
    assert.match(stub.io.output.stdout, /acceptance: 5\/6 passed\n$/);
    for (const home of stub.homes) assert.equal(fs.existsSync(home), false);
  }
});

test('process runner fails closed on missing executables, nonzero exits and timeouts', async () => {
  const options = { cwd: root, env: process.env, timeoutMs: 10000 };
  await assert.rejects(acceptance.runProcess('/nonexistent-bunshin-executable', [], options), /could not start/);
  await assert.rejects(acceptance.runProcess(process.execPath, ['-e', 'process.exit(7)'], options), /exited 7/);
  await assert.rejects(acceptance.runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    ...options, timeoutMs: 100,
  }), /timed out/);
});
