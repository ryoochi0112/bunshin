'use strict';

const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');
const guard = require('./guard');
const pairs = require('./pairs');
const split = require('./split');
const conflicts = require('./conflicts');
const interview = require('./interview');
const { findLeaks, normalize, defaultWindow } = require('./leak');

const sections = ['voice', 'priorities', 'objections', 'context_rules'];

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function failure(name, message) {
  return { ok: false, findings: [{ name, message }] };
}

function readManifest(personaDir) {
  const manifest = store.readJson(personaDir, 'persona.json');
  if (!object(manifest) || manifest.format_version !== 1
    || typeof manifest.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(manifest.name)
    || typeof manifest.display_name !== 'string' || !manifest.display_name.trim()
    || !Number.isSafeInteger(manifest.version) || manifest.version < 0) {
    throw new Error('Invalid persona manifest.');
  }
  return manifest;
}

// Store reads JSON/JSONL; raw Markdown and export files also need a text scan.
// Extra file names are relative to the persona directory, including exports.
function textPath(personaDir, name) {
  if (typeof name !== 'string' || !name || path.isAbsolute(name)
    || name.split(/[\\/]/).includes('..')) throw new Error('Invalid check file path.');
  const root = guard.resolveRealPath(personaDir);
  const target = guard.resolveRealPath(path.resolve(root, name));
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Invalid check file path.');
  }
  return target;
}

function decodedText(identityObj) {
  const strings = [];
  function visit(value) {
    if (typeof value === 'string') strings.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (object(value)) {
      for (const [key, child] of Object.entries(value)) {
        strings.push(key);
        visit(child);
      }
    }
  }
  visit(identityObj);
  return strings.join('\n');
}

function privateTexts(personaDir, manifest, { allowInterviewReferences = false } = {}) {
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
    // Identity evidence can contain an id-only reference with no private text to scan.
    if (allowInterviewReferences && object(answer) && Object.keys(answer).length === 1
      && typeof answer.id === 'string' && /^iv-\d{4,}$/.test(answer.id)) continue;
    if (interview.validateAnswer(answer).length) throw new Error('Invalid interview answer in interview.jsonl.');
    verbatim.push({ id: answer.id, text: answer.answer });
  }
  return { windows, verbatim };
}

// Only a real http(s) link at least one leak window long may be masked; a short or
// placeholder permalink such as "e" would otherwise cut every match apart.
function maskableLink(value) {
  if (typeof value !== 'string' || /\s/u.test(value) || Array.from(value).length < defaultWindow) return false;
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
}

function scan(personaDir, identityObj, haystacks, manifest) {
  let assignments;
  try { assignments = split.readSplit(personaDir).assignments; } catch {
    return failure('split.json', 'Cannot read valid split assignments.');
  }
  let heldout;
  try {
    // readJsonl treats a missing file as empty; the firewall must refuse it.
    if (!fs.statSync(textPath(personaDir, 'pairs.jsonl')).isFile()) throw new Error('Invalid pairs file.');
    heldout = pairs.listPairs(personaDir, { set: 'heldout' });
  } catch {
    return failure('pairs.jsonl', 'Cannot read held-out pairs.');
  }
  let records;
  try { records = conflicts.listConflicts(personaDir); } catch {
    return failure('conflicts.jsonl', 'Cannot read conflict evidence.');
  }
  let texts;
  try { texts = privateTexts(personaDir, manifest, { allowInterviewReferences: true }); } catch {
    return failure('interview.jsonl', 'Cannot read private interview answers.');
  }
  const findings = [];
  const statements = [];
  const seen = new Set();
  const add = (finding) => {
    const key = JSON.stringify(finding);
    if (!seen.has(key)) { findings.push(finding); seen.add(key); }
  };
  if (!object(identityObj) || identityObj.format_version !== 1) {
    add({ name: 'identity.json', message: 'Invalid identity format.' });
  } else for (const field of sections) {
    if (!Array.isArray(identityObj[field])) {
      add({ name: 'identity.json', message: `Invalid evidence in ${field}.` });
      continue;
    }
    identityObj[field].forEach((trait, index) => {
      const label = object(trait) && typeof trait.id === 'string' && /^[a-z0-9-]+$/.test(trait.id)
        ? trait.id : `${field}[${index}]`;
      if (object(trait) && typeof trait.statement === 'string') {
        statements.push({ name: label, text: trait.statement });
      }
      if (!object(trait) || !Array.isArray(trait.evidence)) {
        add({ name: 'identity.json', message: `Invalid evidence in trait ${label}.` });
        return;
      }
      for (const evidence of trait.evidence) {
        if (!object(evidence) || !['pair', 'interview'].includes(evidence.type)
          || typeof evidence.ref !== 'string' || !/^[a-z0-9-]+$/.test(evidence.ref)) {
          add({ name: 'identity.json', message: `Invalid evidence in trait ${label}.` });
        } else if (evidence.type === 'pair' && assignments[evidence.ref] === 'heldout') {
          add({ name: 'identity.json', id: evidence.ref, message: `Held-out evidence in trait ${label}.` });
        } else if (evidence.type === 'pair' && assignments[evidence.ref] !== 'build') {
          add({ name: 'identity.json', id: evidence.ref, message: `Unassigned evidence in trait ${label}.` });
        }
      }
    });
  }
  records.forEach((conflict, index) => {
    const label = object(conflict) && typeof conflict.id === 'string' && /^cf-[0-9]+$/.test(conflict.id)
      ? conflict.id : `conflict[${index}]`;
    if (!object(conflict) || (conflict.behaviour_refs !== undefined && !Array.isArray(conflict.behaviour_refs))) {
      add({ name: 'conflicts.jsonl', message: `Invalid evidence in ${label}.` });
      return;
    }
    for (const ref of conflict.behaviour_refs || []) {
      if (typeof ref !== 'string' || !/^[a-z0-9-]+$/.test(ref)) {
        add({ name: 'conflicts.jsonl', message: `Invalid evidence in ${label}.` });
      } else if (assignments[ref] === 'heldout') {
        add({ name: 'conflicts.jsonl', id: ref, message: `Held-out evidence in ${label}.` });
      } else if (assignments[ref] !== 'build') {
        add({ name: 'conflicts.jsonl', id: ref, message: `Unassigned evidence in ${label}.` });
      }
    }
  });
  const reportedText = new Set();
  const addText = (finding, message, traitMatches) => {
    const key = JSON.stringify([finding.name, finding.id]);
    if (reportedText.has(key)) return;
    reportedText.add(key);
    const labels = [...new Set(traitMatches.filter(({ id }) => id === finding.id).map(({ name }) => name))];
    add({ ...finding, message: labels.length ? `${message} In trait ${labels.join(', trait ')}.` : message });
  };
  // A cited link is the build pair's own permalink, not private text. A shared host prefix
  // such as https://<workspace>.slack.com/ is 24 characters, so mask exact cited links only.
  let sourceLinks;
  try {
    sourceLinks = new Map(pairs.listPairs(personaDir, { set: 'build' }).map((pair) => [pair.id, pair.permalink]));
  } catch {
    return failure('pairs.jsonl', 'Cannot read build pairs.');
  }
  const cited = new Set();
  if (object(identityObj)) for (const field of sections) {
    for (const trait of Array.isArray(identityObj[field]) ? identityObj[field] : []) {
      for (const evidence of object(trait) && Array.isArray(trait.evidence) ? trait.evidence : []) {
        if (object(evidence) && evidence.type === 'pair' && assignments[evidence.ref] === 'build'
          && maskableLink(evidence.permalink)
          && evidence.permalink === sourceLinks.get(evidence.ref)) cited.add(evidence.permalink);
      }
    }
  }
  const links = [...cited].sort((a, b) => b.length - a.length);
  haystacks = haystacks.map(({ name, text }) => ({
    name, text: links.reduce((masked, link) => masked.split(link).join('\n'), text),
  }));
  const answerWindows = heldout.map((pair) => ({ id: pair.id, text: pair.answer.text }));
  for (const [needles, message] of [
    [answerWindows, 'Held-out answer window.'],
    [texts.windows, 'Colleague message window.'],
  ]) {
    const traitMatches = findLeaks(statements, needles);
    for (const finding of findLeaks(haystacks, needles)) addText(finding, message, traitMatches);
  }
  const verbatim = texts.verbatim.map(({ id, text }) => ({ id, text: normalize(text) }))
    .filter(({ text }) => Array.from(text).length >= 24);
  const normalizedStatements = statements.map(({ name, text }) => ({ name, text: normalize(text) }));
  for (const file of haystacks) {
    const normalized = normalize(file.text);
    for (const needle of verbatim) {
      if (normalized.includes(needle.text)) {
        const traitMatches = normalizedStatements.filter(({ text }) => text.includes(needle.text))
          .map(({ name }) => ({ name, id: needle.id }));
        addText({ name: file.name, id: needle.id }, 'Verbatim private text.', traitMatches);
      }
    }
  }
  return { ok: findings.length === 0, findings };
}

function formatFindings(findings) {
  return findings.map(({ name, id, message }) => `${name}${id ? ` (${id})` : ''}: ${message}`).join('\n');
}

function runChecks(personaDir, { extraFiles = [] } = {}) {
  let identityObj;
  try { identityObj = store.readJson(personaDir, 'identity.json'); } catch {
    return failure('identity.json', 'Cannot read identity file.');
  }
  let manifest;
  try { manifest = readManifest(personaDir); } catch {
    return failure('persona.json', 'Cannot read persona manifest.');
  }
  if (!Array.isArray(extraFiles) || extraFiles.some((name) => typeof name !== 'string' || !name)) {
    return failure('extraFiles', 'Invalid extra file list.');
  }
  const haystacks = [];
  for (const name of ['identity.json', 'identity.md', ...extraFiles]) {
    try { haystacks.push({ name, text: fs.readFileSync(textPath(personaDir, name), 'utf8') }); } catch {
      return failure(name, 'Cannot read check file.');
    }
  }
  try { haystacks.push({ name: 'identity.json', text: decodedText(identityObj) }); } catch {
    return failure('identity.json', 'Cannot prepare identity files for checking.');
  }
  return scan(personaDir, identityObj, haystacks, manifest);
}

function checkDraft(personaDir, identityObj) {
  let manifest;
  try { manifest = readManifest(personaDir); } catch {
    throw new Error(formatFindings(failure('persona.json', 'Cannot read persona manifest.').findings));
  }
  let haystacks;
  try {
    haystacks = [
      { name: 'identity.json', text: `${JSON.stringify(identityObj, null, 2)}\n` },
      { name: 'identity.json', text: decodedText(identityObj) },
      { name: 'identity.md', text: require('./identity').render({ ...identityObj, display_name: manifest.display_name }) },
    ];
  } catch {
    throw new Error('identity.json: Cannot prepare identity files for checking.');
  }
  const result = scan(personaDir, identityObj, haystacks, manifest);
  if (!result.ok) {
    const error = new Error(formatFindings(result.findings));
    error.findings = result.findings;
    throw error;
  }
  return result;
}

module.exports = { runChecks, checkDraft, formatFindings, privateTexts };
