'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const store = require('./store');
const kb = require('./kb');
const pairs = require('./pairs');

const LABELS = ['C', 'P', 'N', 'X'];
const caseId = /^[a-z0-9-]+$/;
const entryId = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/;

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validEntries(entries) {
  return Array.isArray(entries) && entries.every((id) => typeof id === 'string' && entryId.test(id));
}

function read(personaDir) {
  let value;
  try {
    value = store.readJson(personaDir, 'coverage.json');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!object(value) || value.format_version !== 1
    || typeof value.kb !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(value.kb)
    || typeof value.kb_digest_hash !== 'string' || !/^[0-9a-f]{64}$/.test(value.kb_digest_hash)
    || typeof value.imported_at !== 'string' || !Number.isFinite(Date.parse(value.imported_at))
    || !object(value.cases)) {
    throw new Error('Invalid coverage.json format.');
  }
  for (const [id, row] of Object.entries(value.cases)) {
    if (!caseId.test(id) || !object(row) || !LABELS.includes(row.coverage) || !validEntries(row.entries)) {
      throw new Error('Invalid coverage.json case.');
    }
  }
  return value;
}

function importFile(personaDir, file, { env = process.env } = {}) {
  const refuse = (index, message) => { throw new Error(`coverage import: row ${index + 1}: ${message}`); };
  let bound;
  let incoming;
  let heldout;
  try {
    bound = kb.loadBound(personaDir, env);
    incoming = JSON.parse(fs.readFileSync(file, 'utf8'));
    heldout = new Set(pairs.listPairs(personaDir, { set: 'heldout' }).map((pair) => pair.id));
  } catch (error) {
    refuse(0, error instanceof SyntaxError ? 'Invalid import JSON.' : error.message);
  }
  if (!bound) refuse(0, 'Persona has no bound KB.');
  if (!object(incoming) || !Array.isArray(incoming.cases)) refuse(0, 'Expected cases array.');
  const verified = kb.citable({ ...bound.data,
    manifest: { ...bound.data.manifest, digest: 'entries' },
  });
  const cases = {};
  const labels = { C: 0, P: 0, N: 0, X: 0 };
  incoming.cases.forEach((row, index) => {
    if (!object(row)) refuse(index, 'Expected case object.');
    if (!LABELS.includes(row.coverage)) refuse(index, 'Unknown coverage label; expected C, P, N or X.');
    if (typeof row.id !== 'string' || !heldout.has(row.id)) refuse(index, 'Case id is not a held-out pair.');
    if (Object.hasOwn(cases, row.id)) refuse(index, 'Duplicate case id.');
    const entries = Object.hasOwn(row, 'entries') ? row.entries : [];
    if (!validEntries(entries)) refuse(index, 'Expected entry id array.');
    if (entries.some((id) => !verified.has(id))) refuse(index, 'Entry id is not verified and unflagged in the bound KB.');
    cases[row.id] = { coverage: row.coverage, entries };
    labels[row.coverage] += 1;
  });
  store.writeJson(personaDir, 'coverage.json', {
    format_version: 1, kb: bound.name, kb_digest_hash: bound.digest.hash,
    imported_at: new Date().toISOString(), cases,
  });
  return { count: incoming.cases.length, labels };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error('Coverage hash requires a JSON value.');
  return json;
}

function hash(value) {
  return crypto.createHash('sha256').update(canonical(value)).digest('hex').slice(0, 16);
}

module.exports = { LABELS, read, importFile, hash };
