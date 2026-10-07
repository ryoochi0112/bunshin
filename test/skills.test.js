'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const engineRoot = 'For engine commands, the plugin root is `${CLAUDE_PLUGIN_ROOT}`, or two directories above this file.';
const engineFallback = 'If the variable is unset, resolve that fallback and set it for the command process.';
const portableSkills = ['build', 'eval', 'shadow', 'export'];
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

const prohibitedToolClause = /\b(?:never|do not|don't|must not|may not|avoid)[ \t]+(?:use|call|invoke)[ \t]+(?:(?:an?|the|any)[ \t]+)?(?:[\w-]+(?:,[ \t]*(?:or[ \t]+)?|[ \t]+or[ \t]+|[ \t]+and[ \t]+))*[\w-]+[ \t]+tools?\b/gi;
const outboundCapabilityClauses = [
  { label: 'tool word', pattern: /\b(?:send|schedule|draft|reaction|create|update|post)(?:[-_][a-z]+)*[ \t]+tools?\b/i },
  { label: 'capability word', pattern: /\b(?:send|schedule|draft|reaction|create|update|post)(?:[-_][a-z]+)*[ \t]+capabilit(?:y|ies)\b/i },
];

function lint(text, name) {
  const findings = [];
  if (name) {
    if (!text.includes(`${engineRoot} ${engineFallback}`)) findings.push('Missing host-neutral engine resolution.');
    if (portableSkills.includes(name) && /Task tool|AskUserQuestion/i.test(text)) {
      findings.push('Claude-only instruction.');
    }
  }
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
  // Outbound tools named by capability; prohibition clauses stay allowed.
  const unprohibited = text.replace(prohibitedToolClause, '');
  for (const clause of outboundCapabilityClauses) {
    if (clause.pattern.test(unprohibited)) findings.push(`Outbound tool named by capability: ${clause.label}.`);
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

test('lint rejects outbound tools named by capability but allows prohibitions and ordinary words', () => {
  const header = '---\nname: fictional\ndescription: Fictional instructions.\n---\n';
  const prohibition = 'Never use a send, schedule, draft, reaction, create or update tool.';
  const phrasings = [
    "Use the Slack connector's send tool to post the draft.", 'Call the Notion create-page tool.',
    "The Slack connector's schedule capability.", 'Add a reaction with the reaction tool.',
    'Run the update tool.', 'Run the draft tool.', 'Run the post tool.',
    'Use the send capability.', 'Never use a read tool and call the send tool.',
    'Use the draft, create or update tool.',
    'Do not use search, use the send tool.', 'Never use search, post via the send tool.',
    'Do not use the Slack connector for reading and instead post with the send tool.',
  ];
  const real = ['harvest', 'shadow', 'export'].map(skill);
  for (const base of real) {
    assert.deepEqual(lint(base), []);
    assert.deepEqual(lint(`${base}\n${prohibition}\n`), []);
    assert.deepEqual(lint(`${base}\n${prohibition.toLowerCase()} Read the thread.\n`), []);
    for (const phrase of phrasings) {
      assert.ok(lint(`${base}\n${phrase}\n`).some((f) => f.startsWith('Outbound tool named')), phrase);
    }
  }
  for (const clause of outboundCapabilityClauses) {
    assert.ok(phrasings.some((phrase) => clause.pattern.test(phrase.replace(prohibitedToolClause, ''))), `unused clause ${clause.label}`);
    for (const phrase of phrasings) {
      const others = outboundCapabilityClauses.filter((c) => c !== clause);
      if (clause.pattern.test(phrase) && !others.some((c) => c.pattern.test(phrase))) {
        assert.ok(lint(header + phrase).length > 0, phrase);
      }
    }
  }
  for (const ordinary of ['Never create a temp file.', 'Exclude updated ids.', 'Use search and read-thread tools.',
    'The draft comes only from shadow draft.', 'Post-mortem notes for the tool.']) {
    assert.deepEqual(lint(header + ordinary), [], ordinary);
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
  const findings = files.flatMap((file) => lint(fs.readFileSync(file, 'utf8'),
    path.basename(file) === 'SKILL.md' ? path.basename(path.dirname(file)) : undefined)
    .map((finding) => `${path.relative(root, file)}: ${finding}`));
  assert.deepEqual(findings, []);
});

test('host lint rejects removal of either engine clause and Claude-only instructions', () => {
  const names = instructionFiles(root).filter((file) => path.basename(file) === 'SKILL.md')
    .map((file) => path.basename(path.dirname(file)));
  assert.deepEqual(names, ['build', 'calibrate', 'diagnose', 'eval', 'examples', 'export', 'harvest',
    'idea-discussion', 'interview', 'shadow', 'spec-answer']);
  for (const name of names) {
    const text = skill(name);
    assert.deepEqual(lint(text, name), [], name);
    for (const clause of [engineRoot, engineFallback]) {
      assert.deepEqual(lint(text.replace(clause, ''), name), ['Missing host-neutral engine resolution.'],
        `${name}: removing ${clause}`);
    }
  }
  for (const name of portableSkills) {
    for (const instruction of ['Use the Task tool.', 'Call AskUserQuestion.']) {
      assert.deepEqual(lint(`${skill(name)}\n${instruction}`, name), ['Claude-only instruction.']);
    }
  }
});

test('harvest first checks the host before resolving fallback or using any connector', () => {
  const text = skill('harvest');
  const gate = 'First, before resolving the engine fallback or doing anything else, check whether `CODEX_THREAD_ID` or `CODEX_SESSION_ID` is set, or you otherwise know this host is outside Claude Code. Dispatcher shell-environment measurements on 2026-10-05 (codex-cli 0.159.0) found both Codex session variables set inside `codex exec`, while a Claude Code shell had `CLAUDECODE` set and no `CLAUDE_PLUGIN_ROOT`; inherited `CLAUDE_*` variables do not prove the host is Claude Code. If either Codex session variable is set or this host is otherwise known to be outside Claude Code, stop immediately and reply with only one sentence: "Harvest runs on Claude Code." Stop regardless of `${CLAUDE_PLUGIN_ROOT}` or Slack connector availability; do not try another route.';
  function assertGate(value) {
    const first = value.split('# Harvest\n\n')[1].split('\n\n')[0];
    assert.equal(first, gate);
    assert.ok(value.indexOf(first) < value.indexOf(engineRoot));
  }
  assertGate(text);
  for (const required of ['`CODEX_THREAD_ID`', '`CODEX_SESSION_ID`',
    '"Harvest runs on Claude Code."', 'Stop regardless of `${CLAUDE_PLUGIN_ROOT}` or Slack connector availability; do not try another route.']) {
    assert.throws(() => assertGate(text.replace(required, '')), assert.AssertionError,
      `Removing ${required} must fail the host guard.`);
  }
});

test('all eleven skills are user-invocable and follow the M2 engine conventions', () => {
  for (const name of [...operatorSkills, 'spec-answer', 'idea-discussion', 'shadow', 'eval', 'calibrate', 'examples', 'export']) {
    const text = skill(name);
    assert.match(text, new RegExp(`^name: ${name}$`, 'm'));
    assert.match(text, /^description: \S.*$/m);
    assert.match(text, /^user-invocable: true$/m);
    const roots = text.match(/For engine commands, the plugin root is `\$\{CLAUDE_PLUGIN_ROOT\}`, or two directories above this file\./g);
    assert.equal(roots && roots.length, 1, `${name}: plugin root stated once`);
    assert.match(text, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/bunshin\.js"/);
    assert.match(text, /BUNSHIN_PERSONA.*--persona <dir>/);
    assert.match(text, /user's language/i);
    assert.match(text, /never write (?:a |any )?persona file/i);
    assert.match(text, /never post or send anything/i);
    assert.doesNotMatch(text, /(?:read|open|load|cat).*\bevals\//i);
  }
});

function pinCommand(text, command, label) {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^[ \\t]*${escaped}[ \\t]*$`, 'gm');
  const matches = (value) => [...value.matchAll(new RegExp(pattern.source, pattern.flags))];
  const found = matches(text);
  assert.equal(found.length, 1, `${label}: exact command line appears once`);
  assert.equal(matches(text.replace(found[0][0], `leading-junk ${found[0][0]}`)).length, 0,
    `${label}: reject leading junk`);
  assert.equal(matches(text.replace(found[0][0], `${found[0][0]} trailing-junk`)).length, 0,
    `${label}: reject trailing junk`);
  return found[0].index;
}

function pinClauses(text, name, clauses) {
  for (const [label, pattern] of clauses) {
    assert.match(text, pattern, `${name}: ${label}`);
    assert.doesNotMatch(text.replace(pattern, ''), pattern, `${name}: removing ${label} must fail`);
  }
}

test('eval pins run options, host-error resume, report wording and the printed status', () => {
  const text = skill('eval');
  const run = 'node "${CLAUDE_PLUGIN_ROOT}/bin/bunshin.js" eval run';
  const resume = `${run} --run <run_id>`;
  const report = 'node "${CLAUDE_PLUGIN_ROOT}/bin/bunshin.js" eval report';
  const positions = [
    pinCommand(text, run, 'eval run'),
    pinCommand(text, resume, 'eval run resume'),
    pinCommand(text, report, 'eval report'),
  ];
  assert.ok(positions[0] < positions[1] && positions[1] < positions[2], 'Run precedes resume and separate report.');
  pinClauses(text, 'eval', [
    ['fresh run options', /Pass only the user's named `--judge <spec>`, `--drafter <spec>`, and `--limit <n>` options, plus `--persona <dir>` when the selected persona uses that flag\./],
    ['no fresh run id', /Do not pass `--run` on a fresh run\./],
    ['host error offer', /If the CLI exits 1 with `rerun with --run <run_id> to resume`, show its error as-is and offer to resume\./],
    ['resume same flags', /Append the same named options and persona flag from the interrupted invocation\./],
    ['no silent fresh run', /Never start a new run silently after a host error\./],
    ['other errors stop', /For any other non-zero exit, show the CLI error as-is and stop\./],
    ['report as-is', /The successful `eval run` output already includes `report\.md`; present its Markdown as-is without editing or summarizing it\./],
    ['separate report options', /Append `--run <run_id>` or `--persona <dir>` only when needed\./],
    ['one-sentence status rule', /After a successful report, use one sentence that repeats only the overall status word shown there—`MET`, `NOT MET`, or `sample too small`\./],
    ['sample too small: incomplete run', /If it says `sample too small` and the report shows an `incomplete:` line, say to run `eval run` without `--limit` \(or resume with `--run <run_id>`\)\./],
    ['sample too small: ratings basis', /Otherwise, if it shows a `launch bar basis: … ratings` line, say to run `\/bunshin:calibrate`\./],
    ['sample too small: more pairs', /Otherwise, say that more held-out pairs are needed\./],
    ['never restate an unshown result', /Never restate a launch-bar result that the report does not show/],
    ['never calculate rates', /never calculate or infer rates yourself\./],
    ['judge reasons stay within CLI output', /Do not add or paraphrase judge reasons beyond what the CLI output shows\./],
  ]);
});

test('calibrate pins sampling, owner-only ratings, the blinded loop and final score order', () => {
  const text = skill('calibrate');
  const base = 'node "${CLAUDE_PLUGIN_ROOT}/bin/bunshin.js" calibrate ';
  const positions = [
    pinCommand(text, `${base}sample`, 'calibrate sample'),
    pinCommand(text, `${base}next --run <run_id>`, 'calibrate next'),
    pinCommand(text, `${base}rate <case_id> <rating> --run <run_id>`, 'calibrate rate'),
    pinCommand(text, `${base}score --run <run_id>`, 'calibrate score'),
  ];
  assert.ok(positions[0] < positions[1] && positions[1] < positions[2] && positions[2] < positions[3],
    'Sampling precedes next, rate, and the final score.');
  pinClauses(text, 'calibrate', [
    ['sample options', /Append `--run <run_id>` and\/or `--n <n>` only when the user named them\./],
    ['zero queue guards', /If the output says `queued 0 items` or `queue exists for <run_id> \(0 items\)`, stop and tell the owner to finish an eval run that produces valid judgments before sampling again\./],
    ['loop completion', /Repeat the following until `calibrate next` prints `all <k> items rated — run calibrate score`/],
    ['show one printed item', /Show the CLI item output as printed, one item at a time/],
    ['exact owner options', /^\s*`A\) send as-is  B\) needs edits  C\) wrong`\s*$/m],
    ['owner choice mapping', /Map the owner's choice A\/B\/C to `send_as_is`\/`needs_edits`\/`wrong`\./],
    ['knowledge wrong follow-up', /For a knowledge item rated C, also ask exactly `Did the draft state a wrong fact without a citation\? A\) yes  B\) no`/],
    ['wrong uncited flag', /map the answer to `--wrong-uncited-fact yes` or `--wrong-uncited-fact no`\./],
    ['record only owner choice', /Record only the owner's choice/],
    ['wrong flag placement', /For a knowledge item rated `wrong`, put `--wrong-uncited-fact yes\|no` after `<rating>`\./],
    ['owner may stop and resume', /If the owner stops, stop without rating the current item\./],
    ['errors stop', /On any non-zero exit, show the CLI error as-is and stop\./],
    ['score line as-is', /print the score line as-is\./],
    ['never read judgments', /Never read `judgments\.jsonl`\./],
    ['never reveal judge rating', /Never reveal or guess the judge's rating/],
    ['never suggest a rating', /never suggest a rating/],
    ['judge reasons stay within CLI output', /never add or paraphrase judge reasons beyond what the CLI output shows\./],
  ]);
});

test('examples pins sampling, resume, the owner-only A/B/C loop and the final status', () => {
  const text = skill('examples');
  assert.match(text, /^description: Draft twin answers for build-split pairs and let the owner rate them as judge examples\.$/m);
  const base = 'node "${CLAUDE_PLUGIN_ROOT}/bin/bunshin.js" examples ';
  const positions = [
    pinCommand(text, `${base}sample`, 'examples sample'),
    pinCommand(text, `${base}next`, 'examples next'),
    pinCommand(text, `${base}rate <pair_id> <rating> --reason "<owner's words>"`, 'examples rate --reason'),
    pinCommand(text, `${base}rate <pair_id> <rating> --no-reason`, 'examples rate --no-reason'),
    pinCommand(text, `${base}status`, 'examples status'),
  ];
  assert.ok(positions[0] < positions[1] && positions[1] < positions[2] && positions[2] < positions[4],
    'Sampling precedes next, rate, and the final status.');
  assert.ok(positions[3] < positions[4], 'Both rate forms precede the final status.');
  pinClauses(text, 'examples', [
    ['reason prompt', /^\s*`Reason \(one line, optional — reply - to skip\):`\s*$/m],
    ['dash means skip', /A reply of exactly `-` means skip; run `--no-reason`\./],
    ['never suggest a reason', /Never suggest, complete or paraphrase a reason\./],
    ['never show previous rating', /Never show the previous rating\./],
    ['verbatim reason', /Pass the owner's words verbatim/],
    ['reason shell escaping', /Pass the reason as a safely escaped literal argument: inside the double quotes, put a backslash before each `"`, `\$`, `` ` `` and `\\`\./],
    ['invalid reason asks again', /`examples: invalid reason`, show the error and ask again/],
    ['sample options', /Append `--n <n>` and\/or `--drafter <spec>` only when the user named them\./],
    ['resume offer', /If the CLI exits 1 with `rerun examples sample to resume`, show its error as-is and offer to resume by running the same command again\./],
    ['rerun continues at served item', /running the skill again continues at the next item `examples next` serves\./],
    ['re-pass is expected', /After the unrated items, `examples next` serves rated items again for the reason step; this is expected, so rate each one like any other item\./],
    ['loop completion', /Repeat the following until `examples next` prints `all <n> items rated`/],
    ['show one printed item', /Show the CLI item output as printed, one item at a time/],
    ['exact owner options', /^\s*`A\) send as-is  B\) needs edits  C\) wrong`\s*$/m],
    ['owner choice mapping', /Map the owner's choice A\/B\/C to `send_as_is`\/`needs_edits`\/`wrong`\./],
    ['record only owner choice', /Record only the owner's choice/],
    ['owner may stop and resume', /If the owner stops, stop without rating the current item\./],
    ['errors stop', /On any non-zero exit, show the CLI error as-is and stop\./],
    ['status as-is then eval', /print the status line as-is, then say to run `\/bunshin:eval`\./],
    ['never read judgments', /Never read `judgments\.jsonl`\./],
    ['never reveal judge rating', /Never reveal or guess the judge's rating/],
    ['never suggest a rating', /never suggest a rating/],
    ['never post or send', /Never post or send anything\./],
  ]);
  assert.doesNotMatch(text, /next unrated item/, 'examples: old rerun wording is gone');
  assert.deepEqual(lint(text, 'examples'), []);
  assert.ok(lint(`${text}\nUse the send_message tool.`, 'examples').some((finding) => /Outbound/.test(finding)));
});

test('eval points to examples only when the report shows no judge examples', () => {
  pinClauses(skill('eval'), 'eval', [
    ['examples anchor sentence', /If the report shows `judge examples: none`, add one sentence that `\/bunshin:examples` anchors the judge to the owner's ratings\./],
  ]);
});

test('export pins the CLI, package path and both load instructions without installing', () => {
  const text = skill('export');
  assert.doesNotMatch(text, /~\/\.agents\/skills\//);
  assert.match(text, /For Claude Code, give the owner these two load instructions/);
  pinCommand(text, 'node "${CLAUDE_PLUGIN_ROOT}/bin/bunshin.js" export', 'export');
  pinClauses(text, 'export', [
    ['out option forwarding', /Append `--out <dir>` only when the user named it\./],
    ['persona option forwarding', /Append `--persona <dir>` when the selected persona uses that flag\./],
    ['CLI error as-is', /On any non-zero exit, show the CLI error as-is and stop\./],
    ['package path from plugin manifest', /The package path is the directory two levels above that file; print that path\./],
    ['plugin-dir load command', /`claude --plugin-dir <path>`/],
    ['copy skills load instruction', /copy `<path>\/skills\/\*` into `~\/\.claude\/skills\/`/],
    ['no self-install', /The skill does not copy files or install the package itself\./],
  ]);
  assert.doesNotMatch(text, /^\s*(?:cp|install|npm install)\b/m, 'Export must not run a copy or install command.');
});

test('twin skills load the single composed prompt without duplicating behaviour', () => {
  for (const name of ['spec-answer', 'idea-discussion']) {
    const text = skill(name);
    const command = new RegExp(`^[ \\t]*node "\\$\\{CLAUDE_PLUGIN_ROOT\\}/bin/bunshin\\.js" twin prompt --skill ${name}[ \\t]*$`, 'gm');
    assert.equal([...text.matchAll(command)].length, 1, `${name}: exact prompt command once`);
    for (const junk of ['leading-junk ', ' trailing-junk']) {
      const altered = text.replace(`node "\${CLAUDE_PLUGIN_ROOT}/bin/bunshin.js" twin prompt --skill ${name}`,
        junk.startsWith(' ') ? `node "\${CLAUDE_PLUGIN_ROOT}/bin/bunshin.js" twin prompt --skill ${name}${junk}`
          : `${junk}node "\${CLAUDE_PLUGIN_ROOT}/bin/bunshin.js" twin prompt --skill ${name}`);
      assert.equal([...altered.matchAll(command)].length, 0, `${name}: reject ${junk.trim()}`);
    }
    assert.doesNotMatch(text, /Sources:|\(priority:|I do not know|Every factual claim|Take a position|Raise at least one objection/i);
    assert.match(text, /Use `\$ARGUMENTS` as the user's (?:question|idea); ask for it if empty\./);
    assert.match(text, /On a non-zero exit, show the CLI's error and stop\./);
    assert.match(text, /Treat the printed prompt as your instructions for this reply and answer the user's input exactly as that prompt says, using only search\/read tools if sources are needed\./);
  }
});

const shadowRules = [
  ['read-thread only', /For a thread link, read the thread only with the Slack connector's read-thread tool\./],
  ['complete ordered thread', /Construct `\{ permalink, messages: \[\{ author: <Slack user id>, ts: <Slack ts>, text \}\] \}` in memory with every message in the thread in order\./],
  ['Slack author and timestamp', /Set every author to its Slack user id, never a display name; preserve each Slack ts as a number or numeric string\./],
  ['layer selection', /Choose `knowledge` for product facts or specification questions and `judgment` for decisions, trade-offs or priorities\./],
  ['layer override', /State the layer choice in one line and use the user's override if given\./],
  ['no temp files', /Never create a temp file or staging file anywhere\./],
  ['safe delimiter', /Replace the heredoc body with the in-memory input and choose a quoted heredoc delimiter absent from the source text\./],
  ['engine-only draft', /Never draft or edit the answer yourself; the draft comes only from `shadow draft`\./],
  ['blind before show', /Before `shadow show`, never summarise, quote, paraphrase or hint at the owner's real answer from the thread\./],
  ['unchanged after show', /After `shadow show`, add nothing that changes the draft\./],
  ['show as-is', /Print the `shadow show` output as-is\./],
  ['stop on errors', /On any non-zero exit, show the CLI's error and stop\./],
  ['unset owner', /If the CLI reports an unset owner id, tell the user to set `owner\.slack_user_id` in `persona\.json`; never guess it\./],
  ['drafter override', /If the user named a drafter, append `--drafter <spec>` with that exact specification as a quoted argument\./],
  ['never outbound', /Never post or send anything\. bunshin never posts or sends anything\./],
];

function outboundOffer(text) {
  return /\b(post|reply|send)\b.*\b(thread|slack|channel)\b/i.test(
    text.replace(/Never post or send anything\. bunshin never posts or sends anything\./g, '')
  );
}

test('shadow pins the CLI handoff, blinding and every required sentence', () => {
  const text = skill('shadow');
  rules('shadow', shadowRules);
  for (const [label, pattern] of shadowRules) {
    assert.doesNotMatch(text.replace(pattern, ''), pattern, `Removing ${label} must fail its rule.`);
  }
  for (const [delimiter, flag, body] of [
    ['BUNSHIN_THREAD', '--thread-json', '<generated thread JSON>'],
    ['BUNSHIN_QUESTION', '--question-file', '<pasted question text>'],
  ]) {
    const heredoc = new RegExp(`^[ \\t]*cat <<'${delimiter}' \\| node "\\$\\{CLAUDE_PLUGIN_ROOT\\}/bin/bunshin\\.js" shadow new --layer <layer> ${flag} -\\n[ \\t]*${body}\\n[ \\t]*${delimiter}$`, 'm');
    assert.match(text, heredoc);
    assert.doesNotMatch(text.replace(`<<'${delimiter}'`, `<<${delimiter}`), heredoc);
    assert.doesNotMatch(text.replace(`${flag} -`, `${flag} input.json`), heredoc);
  }
  const commands = [
    /cat <<'BUNSHIN_THREAD' \| node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/bunshin\.js" shadow new --layer <layer> --thread-json -/,
    /cat <<'BUNSHIN_QUESTION' \| node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/bunshin\.js" shadow new --layer <layer> --question-file -/,
    /^[ \t]*node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/bunshin\.js" shadow draft <id>[ \t]*$/m,
    /^[ \t]*node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/bunshin\.js" shadow show <id>[ \t]*$/m,
  ];
  const positions = commands.map((command) => {
    assert.match(text, command);
    return text.search(command);
  });
  assert.ok(positions.every((position, index) => index === 0 || positions[index - 1] < position),
    'Both new invocations must precede draft, which must precede show.');
  assert.equal(outboundOffer(text), false);
});

test('shadow outbound offer guard rejects added offers while allowing the prohibition', () => {
  const text = skill('shadow');
  assert.equal(outboundOffer('Never post or send anything. bunshin never posts or sends anything.'), false);
  for (const offer of ['Post this to the thread.', 'Reply in the Slack thread.', 'Send this draft to the channel.']) {
    assert.equal(outboundOffer(`${text}\n${offer}`), true, offer);
  }
});

test('harvest pins scope, owner authorship, thread boundaries, ingestion and label correction', () => {
  rules('harvest', [
    ['host restriction', /harvest runs on Claude Code/i],
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
