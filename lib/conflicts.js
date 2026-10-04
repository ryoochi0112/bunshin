'use strict';

const store = require('./store');
const CONFLICT_FIELDS = [
  'id', 'claim', 'interview_ref', 'behaviour_refs', 'status', 'resolution', 'note',
];

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateConflict(conflict) {
  if (!object(conflict)) return ['conflict must be an object'];
  const errors = [];
  if (typeof conflict.id !== 'string' || !/^cf-\d{4,}$/.test(conflict.id)) errors.push('invalid id');
  if (typeof conflict.claim !== 'string' || !conflict.claim.trim()) errors.push('invalid claim');
  if (typeof conflict.interview_ref !== 'string' || !/^iv-\d{4,}$/.test(conflict.interview_ref)) errors.push('invalid interview_ref');
  if (!Array.isArray(conflict.behaviour_refs) || !conflict.behaviour_refs.length
    || conflict.behaviour_refs.some((id) => typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id))
    || new Set(conflict.behaviour_refs).size !== conflict.behaviour_refs.length) {
    errors.push('invalid behaviour_refs');
  }
  if (!['open', 'resolved'].includes(conflict.status)) errors.push('invalid status');
  if (!(conflict.resolution === null || ['behaviour', 'self_report', 'context'].includes(conflict.resolution))) {
    errors.push('invalid resolution');
  }
  if (!(conflict.note === null || typeof conflict.note === 'string')) errors.push('invalid note');
  if (conflict.status === 'open' && (conflict.resolution !== null || conflict.note !== null)) errors.push('invalid open resolution');
  if (conflict.status === 'resolved' && conflict.resolution === null) errors.push('missing resolution');
  return errors;
}

function listConflicts(personaDir) {
  return store.readJsonl(personaDir, 'conflicts.jsonl');
}

function openInterviewRefs(personaDir) {
  return new Set(listConflicts(personaDir)
    .filter((conflict) => conflict.status === 'open')
    .map((conflict) => conflict.interview_ref));
}

function recordsById(records, label) {
  const result = new Map();
  for (const record of records) {
    if (!record || typeof record.id !== 'string' || result.has(record.id)) {
      throw new Error(`Invalid ${label} record id.`);
    }
    result.set(record.id, record);
  }
  return result;
}

function splitAssignments(personaDir) {
  const split = store.readJson(personaDir, 'split.json');
  if (!split || split.format_version !== 1 || !split.assignments
    || typeof split.assignments !== 'object' || Array.isArray(split.assignments)) {
    throw new Error('Invalid split.json.');
  }
  return split.assignments;
}

function addConflict(personaDir, { claim, interviewRef, behaviourRefs }, options = {}) {
  if (typeof claim !== 'string' || !claim.trim()) throw new Error('Conflict claim must not be empty.');
  if (typeof interviewRef !== 'string' || !/^iv-\d{4,}$/.test(interviewRef)) {
    throw new Error('Invalid interview ref.');
  }
  if (!Array.isArray(behaviourRefs) || behaviourRefs.length === 0
    || behaviourRefs.some((id) => typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id))
    || new Set(behaviourRefs).size !== behaviourRefs.length) {
    throw new Error('Invalid behaviour refs.');
  }

  const answers = recordsById(store.readJsonl(personaDir, 'interview.jsonl'), 'interview.jsonl');
  if (!answers.has(interviewRef)) throw new Error(`Unknown interview ref ${interviewRef}.`);
  const pairs = recordsById(store.readJsonl(personaDir, 'pairs.jsonl'), 'pairs.jsonl');
  const assignments = splitAssignments(personaDir);
  for (const id of behaviourRefs) {
    if (!pairs.has(id)) throw new Error(`Unknown behaviour pair ${id}.`);
    if (assignments[id] !== 'build') throw new Error(`Behaviour pair ${id} is not in the build set.`);
  }

  const conflicts = listConflicts(personaDir);
  let largest = 0;
  const ids = new Set();
  for (const conflict of conflicts) {
    if (typeof conflict.id !== 'string' || !/^cf-\d{4,}$/.test(conflict.id) || ids.has(conflict.id)) {
      throw new Error('Invalid conflicts.jsonl id.');
    }
    ids.add(conflict.id);
    largest = Math.max(largest, Number(conflict.id.slice(3)));
  }
  const record = {
    id: `cf-${String(largest + 1).padStart(4, '0')}`,
    claim,
    interview_ref: interviewRef,
    behaviour_refs: behaviourRefs,
    status: 'open',
    resolution: null,
    note: null,
  };
  store.appendJsonl(personaDir, 'conflicts.jsonl', record, options);
  return record;
}

function resolveConflict(personaDir, id, resolution, note, options = {}) {
  if (typeof id !== 'string' || !/^cf-\d{4,}$/.test(id)) throw new Error('Invalid conflict id.');
  if (!['behaviour', 'self_report', 'context'].includes(resolution)) throw new Error('Invalid conflict resolution.');
  if (note !== undefined && typeof note !== 'string') throw new Error('Invalid conflict note.');
  const conflicts = listConflicts(personaDir);
  const matches = conflicts.filter((conflict) => conflict.id === id);
  if (!matches.length) throw new Error(`Unknown conflict ${id}.`);
  if (matches.length !== 1) throw new Error('Duplicate conflict id in conflicts.jsonl.');
  if (matches[0].status !== 'open') throw new Error(`Conflict ${id} is already resolved.`);
  const updated = conflicts.map((conflict) => conflict.id === id ? {
    ...conflict,
    status: 'resolved',
    resolution,
    note: note === undefined ? null : note,
  } : conflict);
  store.writeJsonl(personaDir, 'conflicts.jsonl', updated, options);
  return updated.find((conflict) => conflict.id === id);
}

module.exports = { CONFLICT_FIELDS, validateConflict, listConflicts, openInterviewRefs, addConflict, resolveConflict };
