'use strict';

const store = require('./store');
const pairs = require('./pairs');
const split = require('./split');
const interview = require('./interview');
const conflicts = require('./conflicts');

const sections = [
  ['voice', 'Voice'], ['priorities', 'Priorities'],
  ['objections', 'Typical objections'], ['context_rules', 'Context rules'],
];

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validate(personaDir, identityObj) {
  const errors = [];
  const add = (trait, message) => errors.push({ trait, message });
  if (!object(identityObj)) return { ok: false, errors: [{ trait: 'identity', message: 'Identity must be an object.' }] };
  if (identityObj.format_version !== 1) add('identity', 'Invalid format_version.');
  const manifest = store.readJson(personaDir, 'persona.json');
  if (identityObj.persona !== manifest.name) add('identity', 'Persona does not match persona.json.');
  const build = new Map(pairs.listPairs(personaDir, { set: 'build' }).map((pair) => [pair.id, pair]));
  const answers = new Set(interview.listAnswers(personaDir).map((answer) => answer.id));
  const conflictMap = new Map(conflicts.listConflicts(personaDir).map((conflict) => [conflict.id, conflict]));
  const openRefs = conflicts.openInterviewRefs(personaDir);
  const priorityIds = new Set(Array.isArray(identityObj.priorities)
    ? identityObj.priorities.filter(object).map((trait) => trait.id) : []);
  const ids = new Set();
  for (const [field] of sections) {
    if (!Array.isArray(identityObj[field])) {
      add(field, 'Traits must be an array.');
      continue;
    }
    identityObj[field].forEach((trait, index) => {
      const label = object(trait) && typeof trait.id === 'string' && /^[a-z0-9-]+$/.test(trait.id)
        ? trait.id : `${field}[${index}]`;
      if (!object(trait)) { add(label, 'Trait must be an object.'); return; }
      if (label !== trait.id) add(label, 'Invalid trait id.');
      else if (ids.has(trait.id)) add(label, 'Duplicate trait id.');
      else ids.add(trait.id);
      if (typeof trait.statement !== 'string' || !trait.statement.trim()) add(label, 'Statement must not be empty.');
      if (field === 'priorities' && (typeof trait.name !== 'string' || !trait.name.trim())) add(label, 'Priority name must not be empty.');
      if (field === 'objections' && !priorityIds.has(trait.priority)) add(label, 'Objection must name an existing priority id.');
      if (!Array.isArray(trait.evidence) || !trait.evidence.length) add(label, 'Evidence must not be empty.');
      else for (const evidence of trait.evidence) {
        if (!object(evidence) || typeof evidence.ref !== 'string') {
          add(label, 'Invalid evidence reference.');
        } else if (evidence.type === 'pair') {
          if (!build.has(evidence.ref)) {
            const set = split.setOf(personaDir, evidence.ref);
            add(label, set === 'heldout' ? 'Evidence references a held-out pair.' : 'Evidence references an unknown or non-build pair.');
          } else if (evidence.permalink !== build.get(evidence.ref).permalink) {
            add(label, 'Pair evidence permalink does not match its source.');
          }
        } else if (evidence.type === 'interview') {
          if (!answers.has(evidence.ref)) add(label, 'Evidence references an unknown interview answer.');
          if (openRefs.has(evidence.ref)) add(label, 'Interview evidence is tied to an open conflict.');
        } else add(label, 'Unknown evidence type.');
      }
      if (trait.conflict !== undefined) {
        const conflict = conflictMap.get(trait.conflict);
        if (!conflict) add(label, 'Unknown conflict reference.');
        else if (conflict.status !== 'resolved') add(label, 'Conflict is open or has an invalid status.');
      }
    });
  }
  return { ok: errors.length === 0, errors };
}

function render(identityObj) {
  const lines = [`# ${identityObj.display_name || identityObj.persona} — identity v${identityObj.version}`];
  for (const [field, title] of sections) {
    lines.push('', `## ${title}`, '');
    for (const trait of identityObj[field]) {
      lines.push(`- ${trait.statement}`);
      for (const evidence of trait.evidence) {
        const target = evidence.type === 'pair' ? evidence.permalink : `interview.jsonl#${evidence.ref}`;
        lines.push(`  - [${evidence.ref}](${target})`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

function commit(personaDir, draftObj, options = {}) {
  const result = validate(personaDir, draftObj);
  if (!result.ok) {
    const error = new Error(result.errors.map(({ trait, message }) => `${trait}: ${message}`).join('\n'));
    error.errors = result.errors;
    throw error;
  }
  const manifest = store.readJson(personaDir, 'persona.json');
  if (!Number.isSafeInteger(manifest.version) || manifest.version < 0 || manifest.version === Number.MAX_SAFE_INTEGER) {
    throw new Error('Invalid persona.json version.');
  }
  const committed = { ...draftObj, version: manifest.version + 1, built_at: new Date().toISOString() };
  for (const check of module.exports.preCommitChecks) {
    const checked = check(personaDir, committed);
    if (checked === false || (checked && checked.ok === false)) throw new Error('Identity pre-commit check failed.');
    if (checked && typeof checked.then === 'function') throw new Error('Identity pre-commit checks must be synchronous.');
  }
  const markdown = render({ ...committed, display_name: manifest.display_name });
  store.writeIdentity(personaDir, committed, markdown, { ...manifest, version: committed.version }, options);
  return committed;
}

module.exports = { validate, render, commit, preCommitChecks: [require('./check').checkDraft] };
