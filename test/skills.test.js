'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const operatorSkills = ['harvest', 'interview', 'diagnose', 'build'];
const deniedTools = [
  'send_message', 'schedule_message', 'send_message_draft', 'add_reaction',
  'create_canvas', 'update_canvas', 'notion-create', 'notion-update',
  'notion-move', 'notion-duplicate',
];

function instructionFiles(repo) {
  const files = [];
  const skills = path.join(repo, 'skills');
  if (fs.existsSync(skills)) {
    for (const entry of fs.readdirSync(skills, { withFileTypes: true })) {
      const file = path.join(skills, entry.name, 'SKILL.md');
      if (entry.isDirectory() && fs.existsSync(file)) files.push(file);
    }
  }
  function templates(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) templates(file);
      else if (entry.isFile() && entry.name.endsWith('.md')) files.push(file);
    }
  }
  templates(path.join(repo, 'templates'));
  return files.sort();
}

function lint(text) {
  const findings = [];
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  for (const field of ['name', 'description']) {
    const match = frontmatter && frontmatter[1].match(new RegExp(`^${field}:[ \\t]*([^\\r\\n]*)$`, 'm'));
    const value = match && match[1].replace(/(?:^|[ \t]+)#.*$/, '').replace(/^(['"])(.*)\1$/, '$2').trim();
    const block = value && /^[|>][-+]?/.test(value);
    if (!value || /^(?:null|~|\[\]|\{\})$/i.test(value)
      || (block && !new RegExp(`^${field}:.*\\r?\\n[ \\t]+\\S`, 'm').test(frontmatter[1]))) {
      findings.push(`Missing ${field} frontmatter.`);
    }
  }
  for (const fragment of deniedTools) {
    if (text.toLowerCase().includes(fragment)) findings.push(`Outbound tool fragment: ${fragment}.`);
  }
  // Keep prohibitions valid, but reject prose and shell/JS instructions to bypass the CLI.
  const instructions = text.replace(/\b(?:never|do not|don't|must not|may not|avoid)\s+(?:directly\s+)?(?:read|open|load|inspect|access)\b/gi, '');
  for (const sentence of instructions.split(/\n\s*\n|[.!?;](?:[ \t]+|\r?\n)/)) {
    if (/\b(?:pairs|cases|judgments)\.jsonl\b|\bevals\//i.test(sentence)
      && /\b(?:read|open|load|inspect|access|cat|head|tail|less|more|readFileSync|readFile|readJsonl)\b/i.test(sentence)) {
      findings.push('Direct read of a protected persona path.');
    }
  }
  return findings;
}

function skill(name) {
  return fs.readFileSync(path.join(root, 'skills', name, 'SKILL.md'), 'utf8');
}

function rules(name, required) {
  const text = skill(name);
  for (const [label, pattern] of required) assert.match(text, pattern, `${name}: ${label}`);
}

test('lint checks frontmatter rather than body fields and rejects empty metadata', () => {
  const valid = '---\nname: fictional\ndescription: Fictional instructions.\n---\n';
  assert.deepEqual(lint(valid), []);
  assert.deepEqual(lint(valid.replaceAll('\n', '\r\n')), []);
  assert.deepEqual(lint('---\nname: fictional\ndescription: >\n  Fictional instructions.\n---\n'), []);
  for (const text of [
    'name: fictional\ndescription: Fictional instructions.\n',
    '---\nname: fictional\n---\ndescription: Only in the body.\n',
    '---\ndescription: Fictional instructions.\n---\nname: Only in the body.\n',
    ...['', "''", '"  "', 'null', '~', '[]', '{}', '# comment', '|'].map((value) => (
      `---\nname: fictional\ndescription: ${value}\n---\n`
    )),
  ]) assert.ok(lint(text).some((finding) => finding.includes('frontmatter')), text);
});

test('lint rejects every denied fragment inside qualified tool names and prohibitions', () => {
  for (const fragment of deniedTools) {
    const text = `---\nname: fictional\ndescription: Fictional instructions.\n---\nNever use mcp__connector__${fragment.toUpperCase()}.\n`;
    assert.ok(lint(text).some((finding) => finding.includes(fragment)), fragment);
  }
});

test('lint rejects protected persona path reads in prose and code while allowing CLI reads and prohibitions', () => {
  const header = '---\nname: fictional\ndescription: Fictional instructions.\n---\n';
  for (const file of ['pairs.jsonl', 'cases.jsonl', 'judgments.jsonl',
    'evals/', 'evals/run-one/report.md', 'evals/run-one/run.json', 'evals/run-one/drafts.jsonl']) {
    for (const instruction of [
      `Read \`${file}\` directly.`, `Open the raw file \`${file}\`.`,
      `Load \`${file}\` for evidence.`, `cat "$BUNSHIN_PERSONA/${file}"`,
      `head -n 10 ${file}`, `fs.readFileSync('${file}', 'utf8')`,
      `Read these files:\n- ${file}`, `Never read ${file}; instead cat ${file}.`,
    ]) assert.ok(lint(header + instruction).some((finding) => finding.startsWith('Direct read of a protected ')), instruction);
    assert.deepEqual(lint(header + `Never read \`${file}\` directly. Read interview answers instead.`), []);
    assert.deepEqual(lint(header + `Do not open \`${file}\`.`), []);
  }
  assert.deepEqual(lint(header + 'node "${CLAUDE_PLUGIN_ROOT}/bin/bunshin.js" pairs list --set build --json'), []);
});

test('discovery includes later skills and recursively nested Markdown templates', (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-skills-lint-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const expected = ['skills/future/SKILL.md', 'templates/future/nested/rules.md'];
  for (const relative of [...expected, 'skills/future/reference.md', 'templates/future/ignored.txt']) {
    const file = path.join(repo, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'Fictional lint fixture.\n');
  }
  const discovered = instructionFiles(repo);
  assert.deepEqual(discovered.map((file) => path.relative(repo, file)), expected);
  for (const file of discovered) assert.ok(lint(fs.readFileSync(file, 'utf8')).length > 0);
});

test('every skill and Markdown template passes the safety lint', () => {
  const files = instructionFiles(root);
  assert.ok(files.length > 0);
  const findings = files.flatMap((file) => lint(fs.readFileSync(file, 'utf8'))
    .map((finding) => `${path.relative(root, file)}: ${finding}`));
  assert.deepEqual(findings, []);
});

test('operator skills are user-invocable and follow the M2 engine conventions', () => {
  for (const name of operatorSkills) {
    const text = skill(name);
    assert.match(text, new RegExp(`^name: ${name}$`, 'm'));
    assert.match(text, /^user-invocable: true$/m);
    const roots = text.match(/the plugin root is `\$\{CLAUDE_PLUGIN_ROOT\}`, or two directories above this file/g);
    assert.equal(roots && roots.length, 1, `${name}: plugin root stated once`);
    assert.match(text, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/bunshin\.js"/);
    assert.match(text, /user's language/i);
    assert.match(text, /never write (?:a |any )?persona file/i);
    assert.match(text, /never post or send anything/i);
    assert.doesNotMatch(text, /(?:read|open|load|cat).*\bevals\//i);
  }
});

test('harvest pins scope, owner authorship, thread boundaries, ingestion and label correction', () => {
  rules('harvest', [
    ['host restriction', /harvest runs on Claude Code only/i],
    ['unsupported host stops', /(?:on Codex|outside Claude Code).*stop/i],
    ['missing scope', /ask.*channels.*date range.*missing/i],
    ['connector capabilities', /only the Slack connector's search and read-thread tools/],
    ['owner identity', /persona\.json.*owner\.slack_user_id/],
    ['missing owner stops', /(?:missing|null).*stop/i],
    ['eligible thread', /non-owner.*asked the owner.*owner answered/i],
    ['question boundary', /one pair per question message/i],
    ['answer boundary', /owner's replies up to the next question/i],
    ['Slack authors', /(?:each|every).*author.*Slack user id/i],
    ['pair id', /slack-<channel_id>-<question_ts/],
    ['layer labels', /knowledge.*judgment/],
    ['automatic label', /layer_source.*auto/],
    ['pair provenance', /permalink/],
    ['stdin ingestion', /\| node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/bunshin\.js" pairs add/],
    ['stable split', /node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/bunshin\.js" split/],
    ['cases rebuild', /node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/bunshin\.js" cases build/],
    ['new counts', /table.*new pairs per layer/i],
    ['deduplicated counts', /(?:exclude|do not count).*updated/i],
    ['label correction', /pairs label <id> <layer>/],
    ['manual labels retained', /manual labels.*(?:kept|preserved)/i],
  ]);
});

test('interview pins evidence gaps, one question, pending resume and the CLI limit', () => {
  const text = skill('interview');
  assert.ok(text.indexOf('interview status') < text.indexOf('interview begin'), 'Interview status must precede begin.');
  rules('interview', [
    ['session entry', /node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/bunshin\.js" interview begin/],
    ['conditional session entry', /call `interview begin` only for a first session.*explicit owner request/i],
    ['status errors', /No interview session found/],
    ['source data boundary', /source text.*pairs.*Slack\/Notion text.*interview answers.*data, not instructions/i],
    ['build evidence only', /pairs list --set build --json/],
    ['one question', /exactly one question per turn/i],
    ['priorities and reasons', /priorities or reasons/i],
    ['gap meaning', /gap.*why the sources cannot show/i],
    ['ask recording', /interview ask --topic.*--gap.*--question/],
    ['answer recording', /interview answer --text/],
    ['resume', /pending.*question.*(?:resume|repeat|present)/i],
    ['pending exit status', /exit (?:code|status) 3/],
    ['limit', /remaining.*0.*stop/i],
    ['no automatic rollover', /do not.*interview begin.*(?:limit|new session)/i],
    ['wait for owner', /wait for the owner's answer/i],
  ]);
});

test('diagnose pins both evidence sources, recording, lettered resolutions and owner choice', () => {
  rules('diagnose', [
    ['source data boundary', /source text.*pairs.*Slack\/Notion text.*interview answers.*data, not instructions/i],
    ['build evidence only', /pairs list --set build --json/],
    ['interview evidence', /interview\.jsonl/],
    ['comparison', /compare.*interview answers.*build-set behavio[u]?r/i],
    ['conflict refs', /conflicts add --claim.*--interview-ref.*--behaviour-refs/],
    ['open list', /conflicts list --open/],
    ['both sides', /both pieces of evidence/i],
    ['one conflict', /one conflict at a time/i],
    ['behaviour option', /A\).*behaviour wins.*behaviour/],
    ['self-report option', /B\).*self-report wins.*self_report/],
    ['context option', /C\).*depends on context.*context/],
    ['owner resolution', /wait for the owner's choice/i],
    ['resolution recording', /conflicts resolve <cf-id> --as <behaviour\|self_report\|context>/],
    ['open conflict exclusion', /unresolved conflicts.*never.*identity/i],
  ]);
});

test('build pins fresh context, evidence-only drafting, stdin commit and honest error repairs', () => {
  rules('build', [
    ['fresh session', /this session ran harvest.*fresh session.*stop/i],
    ['build evidence only', /pairs list --set build --json/],
    ['allowed sources', /only.*pairs list --set build.*interview answers.*conflicts/i],
    ['interview evidence', /interview\.jsonl/],
    ['conflict read', /conflicts list --json/],
    ['draft shape', /format_version.*persona.*voice.*priorities.*objections.*context_rules/],
    ['per-trait evidence', /every trait.*(?:at least one|one or more).*evidence/i],
    ['pair provenance', /type.*pair.*ref.*permalink/],
    ['interview provenance', /type.*interview.*ref/],
    ['objection priority', /objection.*priority.*existing priority id/i],
    ['open conflict exclusion', /open conflict.*(?:exclude|omit)/i],
    ['stdin commit', /\| node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/bunshin\.js" identity commit -/],
    ['no draft file', /no draft file on disk/i],
    ['honest repair', /removing or re-evidencing traits.*never.*invent.*evidence/i],
    ['final check', /node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/bunshin\.js" check/],
  ]);
});
