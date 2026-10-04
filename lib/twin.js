'use strict';

const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');
const guard = require('./guard');
const identity = require('./identity');
const check = require('./check');

function skillForLayer(layer) {
  if (layer === 'knowledge') return 'spec-answer';
  if (layer === 'judgment') return 'idea-discussion';
  throw new Error('Unknown twin layer. Expected knowledge or judgment.');
}

function stripTemplateFrontmatter(text) {
  // Remove one metadata block and its optional blank separator; keep body bytes.
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)(?:\r?\n)?/, '');
}

function composePrompt(personaDir, skill) {
  if (!['spec-answer', 'idea-discussion'].includes(skill)) {
    throw new Error('Unknown twin skill. Expected spec-answer or idea-discussion.');
  }
  let manifest;
  let value;
  let markdown;
  try {
    // Store reads recover an interrupted identity commit before consuming it.
    manifest = store.readJson(personaDir, 'persona.json');
    value = store.readJson(personaDir, 'identity.json');
    const root = guard.resolveRealPath(personaDir);
    const target = guard.resolveRealPath(path.join(root, 'identity.md'));
    if (path.dirname(target) !== root) throw new Error('Identity must stay inside the persona directory.');
    markdown = fs.readFileSync(target, 'utf8');
    if (!Number.isSafeInteger(manifest.version) || manifest.version < 1
      || value.version !== manifest.version || !markdown.trim()) throw new Error('Identity is not committed.');
  } catch {
    throw new Error('Twin prompt requires a committed identity. Run identity commit first.');
  }
  const validated = identity.validate(personaDir, value);
  if (!validated.ok) throw new Error(validated.errors.map(({ trait, message }) => `${trait}: ${message}`).join('\n'));
  const checked = check.runChecks(personaDir);
  if (!checked.ok) throw new Error(check.formatFindings(checked.findings));
  const templates = path.join(__dirname, '..', 'templates', 'twin');
  return [stripTemplateFrontmatter(fs.readFileSync(path.join(templates, 'core.md'), 'utf8')), markdown,
    stripTemplateFrontmatter(fs.readFileSync(path.join(templates, `${skill}.md`), 'utf8'))].join('\n\n');
}

module.exports = { composePrompt, skillForLayer, stripTemplateFrontmatter };
