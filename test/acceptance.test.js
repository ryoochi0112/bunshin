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
