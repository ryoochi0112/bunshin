'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const check = require('./check');
const guard = require('./guard');
const interview = require('./interview');
const leak = require('./leak');
const pairs = require('./pairs');
const split = require('./split');
const store = require('./store');
const twin = require('./twin');

const skills = [
  ['spec-answer', 'Answer product questions using current Notion sources.'],
  ['idea-discussion', 'Discuss an idea using the persona priorities and objections.'],
];

function refusal(findings, stageName) {
  const lines = findings.map(({ name, id, message }) => {
    const file = stageName && name.startsWith(`${stageName}/`) ? name.slice(stageName.length + 1) : name;
    return id ? `${file} (${id})` : `${file}: ${message}`;
  });
  return new Error([...new Set(lines)].join('\n'));
}

function assertAbsent(outDir) {
  try { fs.lstatSync(outDir); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('Export destination already exists. Choose a new --out directory.');
}

function packageContents(personaDir, manifest) {
  let prompts;
  try {
    prompts = skills.map(([skill, description]) => ({
      name: `skills/${skill}/SKILL.md`,
      text: `---\nname: ${skill}\ndescription: ${description}\n---\n${twin.composePrompt(personaDir, skill)}`,
    }));
  } catch (error) {
    // The composer may refuse held-out evidence or text before a package exists.
    const checked = check.runChecks(personaDir);
    if (!checked.ok && checked.findings.some((finding) => finding.id)) throw refusal(checked.findings);
    throw error;
  }
  const root = guard.resolveRealPath(personaDir);
  const markdown = guard.resolveRealPath(path.join(root, 'identity.md'));
  if (path.dirname(markdown) !== root) throw new Error('Identity must stay inside the persona directory.');
  const readme = fs.readFileSync(path.join(__dirname, '..', 'templates', 'export', 'README.md'), 'utf8')
    .replaceAll('{{name}}', manifest.name).replaceAll('{{version}}', String(manifest.version));
  return [
    { name: '.claude-plugin/plugin.json', text: `${JSON.stringify({ name: `${manifest.name}-twin`, version: String(manifest.version) }, null, 2)}\n` },
    ...prompts,
    { name: 'identity.md', text: fs.readFileSync(markdown, 'utf8') },
    { name: 'README.md', text: readme },
  ];
}

function privateTexts(personaDir, manifest) {
  const assignments = split.readSplit(personaDir).assignments;
  const owner = manifest.owner?.slack_user_id ?? manifest.display_name;
  const windows = [];
  const verbatim = [];
  for (const pair of pairs.listPairs(personaDir, { set: 'all' })) {
    for (const message of [pair.question, ...pair.context]) {
      const needle = { id: pair.id, text: message.text };
      if (message.author !== owner) windows.push(needle);
      verbatim.push(needle);
    }
    const answer = { id: pair.id, text: pair.answer.text };
    if (assignments[pair.id] === 'heldout') windows.push(answer);
    verbatim.push(answer);
  }
  for (const answer of interview.listAnswers(personaDir)) {
    if (interview.validateAnswer(answer).length) throw new Error('Invalid interview answer in interview.jsonl.');
    verbatim.push({ id: answer.id, text: answer.answer });
  }
  return { windows, verbatim };
}

function exportPersona(personaDir, outDir, options = {}) {
  const manifest = store.readJson(personaDir, 'persona.json');
  const contents = packageContents(personaDir, manifest);
  if (outDir !== undefined && (typeof outDir !== 'string' || !outDir.trim())) {
    throw new Error('Export destination must be a directory path.');
  }
  const destination = guard.resolveRealPath(outDir === undefined
    ? path.join(personaDir, 'export', `${manifest.name}-v${manifest.version}`) : outDir);
  const writeOptions = { ...options, synthetic: manifest.synthetic === true };
  // An explicit destination can be outside the persona, so guard it separately.
  guard.assertSafePersonaPath(destination, writeOptions);
  assertAbsent(destination);
  const texts = privateTexts(personaDir, manifest);
  const stageName = `.export-${crypto.randomBytes(8).toString('hex')}.tmp`;
  const stage = path.join(guard.resolveRealPath(personaDir), stageName);
  let writingDestination = false;
  try {
    for (const file of contents) store.writeText(personaDir, `${stageName}/${file.name}`, file.text, options);
    const checked = check.runChecks(personaDir, { extraFiles: contents.map((file) => `${stageName}/${file.name}`) });
    // Scan the actual staged bytes, including frontmatter, manifest and README.
    const staged = contents.map(({ name }) => ({ name, text: fs.readFileSync(path.join(stage, name), 'utf8') }));
    const findings = [...checked.findings, ...leak.findLeaks(staged, texts.windows)];
    const verbatim = texts.verbatim.map(({ id, text }) => ({ id, text: leak.normalize(text) }))
      .filter(({ text }) => Array.from(text).length >= 24);
    for (const file of staged) {
      const normalized = leak.normalize(file.text);
      for (const needle of verbatim) {
        if (normalized.includes(needle.text)) findings.push({ name: file.name, id: needle.id });
      }
    }
    if (findings.length) throw refusal(findings, stageName);
    assertAbsent(destination);
    writingDestination = true;
    for (const file of staged) store.writeText(destination, file.name, file.text, writeOptions);
    return { files: staged.map((file) => path.join(destination, file.name)) };
  } catch (error) {
    if (writingDestination) fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

module.exports = { exportPersona };
