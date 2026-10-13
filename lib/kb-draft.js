'use strict';

const fs = require('node:fs');
const path = require('node:path');
const kb = require('./kb');
const check = require('./kb-check');
const { normalize } = require('./leak');
const store = require('./store');

const sourceId = /^S\d+$/;
const entryId = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/;
const sourceRef = /^(S\d+)#([^\s,#]+)$/;
const sourceKeys = new Set(['id', 'kind', 'label', 'ref', 'answered_at', 'file_sha256', 'superseded_by']);
const entryKeys = new Set(['id', 'claim', 'sources', 'select', 'note', 'answers']);
const kinds = new Set(['sheet', 'slack', 'notion']);

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function lineText(value, empty = false) {
  return typeof value === 'string' && (empty || Boolean(value.trim()))
    && !/[\r\n\0]/.test(value) && !/ {2,}#/.test(value);
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function context(dir, rows, scrubFile) {
  if (!Array.isArray(rows)) throw new Error('Expected an array of rows.');
  const data = kb.load(dir);
  if (data.errors.length) throw new Error('Cannot use KB with parse errors; run "bunshin kb check".');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(data.manifest.name || '')) throw new Error('Invalid KB name.');
  const scrub = check.readScrubList(dir, scrubFile);
  const scan = (text, field, fail) => {
    if (scrub.some((needle) => normalize(text).includes(needle))) fail(`${field} contains a scrub-list match.`);
    if (check.matchesPii(text)) fail(`${field} contains an email address or phone number.`);
  };
  return { data, scan, options: { synthetic: data.manifest.synthetic === true } };
}

function validateRows(rows, keys, validate) {
  return rows.map((row, index) => {
    const fail = (reason) => { throw new Error(`Row ${index + 1}: ${reason}`); };
    if (!object(row)) fail('Expected an object.');
    if (Object.keys(row).some((key) => !keys.has(key))) fail('Unexpected row field.');
    return validate(row, fail);
  });
}

function addSources(dir, rows, { scrubFile } = {}) {
  const { scan, options } = context(dir, rows, scrubFile);
  // Inspect every registry row, including ids overwritten in the loader's map.
  const existing = store.readJsonl(dir, 'sources.jsonl');
  const ids = new Set(existing.map((row) => row.id));
  const refs = new Set(existing.map((row) => row.ref));
  const shas = new Set(existing.filter((row) => typeof row.file_sha256 === 'string').map((row) => row.file_sha256.toLowerCase()));
  let highest = 0n;
  for (const id of ids) {
    if (sourceId.test(id) && BigInt(id.slice(1)) > highest) highest = BigInt(id.slice(1));
  }
  const added = validateRows(rows, sourceKeys, (row, fail) => {
    let id = row.id;
    if (!Object.hasOwn(row, 'id')) id = `S${String(highest + 1n).padStart(2, '0')}`;
    if (typeof id !== 'string' || !sourceId.test(id)) fail('Invalid source id; expected S<nn>.');
    if (ids.has(id)) fail('Source id already exists.');
    if (!kinds.has(row.kind)) fail('Invalid kind; expected sheet, slack or notion.');
    for (const field of ['label', 'ref']) {
      if (!lineText(row[field])) fail(`${field} must be a nonempty single-line string.`);
      scan(row[field], field, fail);
    }
    if (refs.has(row.ref)) fail('Source ref already exists.');
    if (!validDate(row.answered_at)) fail('Invalid answered_at; expected YYYY-MM-DD.');
    if (Object.hasOwn(row, 'file_sha256')) {
      if (typeof row.file_sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(row.file_sha256)) fail('Invalid file_sha256; expected a SHA-256 hex digest.');
      if (shas.has(row.file_sha256.toLowerCase())) fail('Source file_sha256 already exists.');
      shas.add(row.file_sha256.toLowerCase());
    }
    if (Object.hasOwn(row, 'superseded_by') && (typeof row.superseded_by !== 'string' || !sourceId.test(row.superseded_by))) {
      fail('Invalid superseded_by; expected S<nn>.');
    }
    ids.add(id);
    refs.add(row.ref);
    if (BigInt(id.slice(1)) > highest) highest = BigInt(id.slice(1));
    return { ...row, id };
  });
  for (const row of added) store.appendJsonl(dir, 'sources.jsonl', row, options);
  return { added };
}

function readText(dir, file, fallback) {
  try {
    const target = path.join(dir, file);
    if (!fs.lstatSync(target).isFile()) throw new Error('Expected a regular KB file.');
    return fs.readFileSync(target, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function addEntries(dir, rows, { scrubFile } = {}) {
  const { data, scan, options } = context(dir, rows, scrubFile);
  const ids = new Set(data.entries.map((entry) => entry.id));
  const validated = validateRows(rows, entryKeys, (row, fail) => {
    if (typeof row.id !== 'string' || !entryId.test(row.id)) fail('Invalid entry id; expected <kb>.<topic>.<slug>.');
    if (!row.id.startsWith(`${data.manifest.name}.`)) fail('Entry id prefix must match the KB name.');
    if (ids.has(row.id)) fail('Entry id already exists.');
    scan(row.id, 'id', fail);
    if (!lineText(row.claim)) fail('claim must be a nonempty single-line string without inline comments.');
    scan(row.claim, 'claim', fail);
    if (!Array.isArray(row.sources) || !row.sources.length) fail('sources must be a nonempty array.');
    const sources = row.sources.map((ref) => {
      const match = typeof ref === 'string' && sourceRef.exec(ref);
      if (!match) fail('Invalid source reference; expected S<nn>#<anchor>.');
      if (!data.sources.has(match[1])) fail('Reference to unknown source.');
      scan(ref, 'sources', fail);
      return match[1];
    });
    const lines = [`\n### ${row.id}`, `claim: ${row.claim}`, 'status: draft', `sources: ${row.sources.join(', ')}`];
    if (Object.hasOwn(row, 'select')) {
      if (!object(row.select)) fail('select must be an object of key=value pairs.');
      const keys = new Set();
      const pairs = Object.entries(row.select).map(([key, value]) => {
        if (!lineText(key) || /[=;]/.test(key) || !lineText(value) || value.includes(';') || keys.has(key.trim())) {
          fail('Invalid select; expected distinct single-line key=value pairs without semicolons.');
        }
        keys.add(key.trim());
        return `${key}=${value}`;
      });
      const select = pairs.join('; ');
      scan(select, 'select', fail);
      if (pairs.length) lines.push(`select: ${select}`);
    }
    if (Object.hasOwn(row, 'note')) {
      if (!lineText(row.note, true)) fail('note must be a single-line string without inline comments.');
      scan(row.note, 'note', fail);
      lines.push(`note: ${row.note}`);
    }
    const answers = [];
    if (Object.hasOwn(row, 'answers')) {
      if (!Array.isArray(row.answers)) fail('answers must be an array.');
      for (const answer of row.answers) {
        if (!object(answer) || !(typeof answer.row_id === 'string' && answer.row_id.trim()
          || Number.isSafeInteger(answer.row_id) && answer.row_id >= 0)
          || ['cell', 'question', 'answer', 'answer_type'].some((key) => typeof answer[key] !== 'string' || !answer[key].trim())) {
          fail('Invalid answers row; expected row_id, cell, question, answer and answer_type.');
        }
        answers.push({ ...answer, source: sources[0], entry: row.id, excluded: null, why: '' });
      }
    }
    ids.add(row.id);
    return { id: row.id, topic: row.id.split('.')[1], block: `${lines.join('\n')}\n`, answers };
  });
  // Prepare every file before the first write so validation/read failures cannot
  // leave a partial batch, including a malformed existing extraction log.
  const files = new Map();
  for (const row of validated) {
    const file = `entries/${row.topic}.md`;
    if (!files.has(file)) files.set(file, readText(dir, file, `# ${row.topic}\n`));
    files.set(file, files.get(file) + row.block);
  }
  const answers = validated.flatMap((row) => row.answers);
  if (answers.length) {
    readText(dir, 'answers.jsonl', '');
    store.readJsonl(dir, 'answers.jsonl');
  }
  for (const [file, text] of files) store.writeText(dir, file, text, options);
  for (const answer of answers) store.appendJsonl(dir, 'answers.jsonl', answer, options);
  return { added: validated.map((row) => row.id) };
}

module.exports = { addSources, addEntries };
