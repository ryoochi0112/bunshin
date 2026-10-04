'use strict';

const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');
const guard = require('./guard');
const pairs = require('./pairs');
const split = require('./split');
const conflicts = require('./conflicts');
const leak = require('./leak');

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
    || typeof manifest.name !== 'string' || !/^[a-z0-9-]+$/.test(manifest.name)
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

function scan(personaDir, identityObj, haystacks) {
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
  const findings = [];
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
  for (const finding of leak.findLeaks(haystacks, heldout.map((pair) => ({ id: pair.id, text: pair.answer.text })))) {
    add({ ...finding, message: 'Held-out answer window.' });
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
  try { readManifest(personaDir); } catch {
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
  return scan(personaDir, identityObj, haystacks);
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
  const result = scan(personaDir, identityObj, haystacks);
  if (!result.ok) {
    const error = new Error(formatFindings(result.findings));
    error.findings = result.findings;
    throw error;
  }
  return result;
}

module.exports = { runChecks, checkDraft, formatFindings };
