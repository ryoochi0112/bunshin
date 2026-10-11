'use strict';

const fs = require('node:fs');
const path = require('node:path');
const kb = require('./kb');
const guard = require('./guard');
const { normalize } = require('./leak');

const sourceId = /^S\d+$/;
const kinds = new Set(['sheet', 'slack', 'notion']);
const sampleRoot = path.resolve(__dirname, '../sample');
const email = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/;
// Dates have fewer digits; decimal timestamps must not match in fragments.
const phone = /(?<![\d.])\+?(?:\d[ ()-]*){9,14}\d(?![\d.])/u;
// Source refs (s01, s12#c14) and ISO dates carry digits that look like phones.
const mask = (text) => text.replace(/(?<![a-z\d])s\d+(?:#[^\s,]+)?/gu, ' ').replace(/\d{4}-\d{2}-\d{2}/gu, ' ');

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonempty(value) {
  return typeof value === 'string' && Boolean(value.trim());
}

function registryRows(dir, file) {
  let text;
  try {
    const target = path.join(dir, file);
    if (!fs.lstatSync(target).isFile()) return [];
    text = fs.readFileSync(target, 'utf8');
  } catch {
    return [];
  }
  // kb.load reports JSON/read errors. Keep every decoded row here, including
  // rows discarded or overwritten by its registry maps.
  return text.split(/\r?\n/).flatMap((text, index) => {
    if (!text.trim()) return [];
    try { return [{ row: JSON.parse(text), line: index + 1 }]; } catch { return []; }
  });
}

function* entryLines(text) {
  let id = null;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    // Follow the parser's block boundaries only to attribute findings. Scan
    // the original line, including comments, headings and non-entry text.
    const content = raw.replace(/ {2,}#.*$/, '').trim();
    let field;
    if (/^#{1,6}(?:\s|$)/.test(content)) {
      const heading = /^###(?:\s+(.*))?$/.exec(content);
      id = heading ? (heading[1] || '').trim() : null;
      field = heading ? 'id' : 'heading';
    } else {
      const match = /^([a-z][a-z0-9_-]*):\s*(.*)$/.exec(content);
      field = match ? match[1] : 'content';
    }
    yield { id, field, text: raw, line: index + 1 };
  }
}

function run(dir, { scrubFile, probe } = {}) {
  const findings = [];
  let scrubStrings = [];
  const matchesScrub = (text) => scrubStrings.some((needle) => normalize(text).includes(needle));
  const redact = (text) => matchesScrub(text) ? '[redacted]' : text;
  const add = (name, message, file, line) => {
    const finding = { name, message: redact(message) };
    if (file !== undefined) finding.file = redact(file);
    if (line !== undefined) finding.line = line;
    findings.push(finding);
  };

  try {
    const target = scrubFile === undefined ? `${path.resolve(dir)}.scrub.txt` : scrubFile;
    if (!fs.lstatSync(target).isFile()) throw new Error();
    scrubStrings = [...new Set(fs.readFileSync(target, 'utf8').split(/\r?\n/)
      .map((text) => normalize(text).trim()).filter(Boolean))];
  } catch (error) {
    if (scrubFile !== undefined || error.code !== 'ENOENT') {
      add('scrub-file', 'Cannot read scrub list.');
    }
  }

  const loaded = kb.load(dir);
  for (const error of loaded.errors) {
    const message = error.message
      .replace(/^(Duplicate entry id|Unknown key|Duplicate key|Duplicate select key):.*$/, '$1.')
      .replace(/^Cannot read file:.*$/, 'Cannot read KB file.')
      .replace(/^Cannot read entries:.*$/, 'Cannot read KB entries.');
    add('parse', message, error.file, error.line);
  }

  const synthetic = loaded.manifest?.synthetic === true;
  if (loaded.manifest && typeof loaded.manifest.synthetic !== 'boolean') {
    add('synthetic', 'KB manifest synthetic must be boolean.', 'kb.json', 1);
  }
  try {
    const relative = path.relative(guard.resolveRealPath(sampleRoot), guard.resolveRealPath(dir));
    if (loaded.manifest?.synthetic === false && relative !== '..'
      && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      add('synthetic', 'Non-synthetic KB cannot live under the repository sample directory.', 'kb.json', 1);
    }
    guard.assertSafePersonaPath(dir, { probe, synthetic });
  } catch {
    add('guard', 'KB path is unsafe or its repository visibility cannot be verified.');
  }

  const scan = (text, owner, field, file, line, checkPii = true) => {
    const context = `${owner} field ${redact(field)}`;
    if (matchesScrub(text)) add('scrub', `${context} contains a scrub-list match.`, file, line);
    if (checkPii) {
      const normalized = normalize(text);
      if (email.test(normalized) || phone.test(mask(normalized))) {
        add('pii', `${context} contains an email address or phone number.`, file, line);
      }
    }
  };

  const sources = new Set();
  for (const { row, line } of registryRows(dir, 'sources.jsonl')) {
    const validId = object(row) && typeof row.id === 'string' && sourceId.test(row.id);
    if (validId) sources.add(row.id);
    const owner = `Source ${validId ? redact(row.id) : '<row>'}`;
    if (!validId || !kinds.has(row.kind) || !nonempty(row.label) || !nonempty(row.ref)) {
      add('source-row', `${owner} requires id S<nn>, kind sheet/slack/notion, label and ref.`, 'sources.jsonl', line);
    }
    if (!object(row)) continue;
    for (const field of ['label', 'ref']) {
      if (typeof row[field] === 'string') scan(row[field], owner, field, 'sources.jsonl', line, field === 'label');
    }
  }

  for (const entry of loaded.entries) {
    const owner = `Entry ${redact(entry.id)}`;
    for (const ref of entry.sources) {
      if (!sources.has(ref.source)) {
        add('source-ref', `${owner} sources references unknown source ${redact(ref.source)}.`, entry.file, entry.line);
      }
    }
  }

  let files = [];
  try {
    const directory = path.join(dir, 'entries');
    if (!fs.lstatSync(directory).isDirectory()) throw new Error();
    files = fs.readdirSync(directory, { withFileTypes: true })
      .filter((file) => file.name.endsWith('.md') && !file.isDirectory())
      .map((file) => `entries/${file.name}`).sort();
  } catch {
    add('parse', 'Cannot read KB entries.', 'entries', 1);
  }
  for (const file of files) {
    let text;
    try {
      const target = path.join(dir, file);
      if (!fs.lstatSync(target).isFile()) throw new Error();
      text = fs.readFileSync(target, 'utf8');
    } catch {
      add('parse', 'Cannot read KB entry text.', file, 1);
      continue;
    }
    for (const { id, field, text: raw, line } of entryLines(text)) {
      const owner = id === null ? 'File' : `Entry ${redact(id || '<unnamed>')}`;
      scan(raw, owner, field, file, line);
    }
    if (matchesScrub(path.basename(file, '.md'))) {
      add('scrub', 'Entry file name contains a scrub-list match.', file, 1);
    }
  }

  const ids = new Set(loaded.entries.map((entry) => entry.id));
  for (const { row, line } of registryRows(dir, 'flags.jsonl')) {
    if (!object(row) || typeof row.id !== 'string' || !ids.has(row.id)) {
      const id = object(row) && typeof row.id === 'string' ? redact(row.id) : '<row>';
      add('flag-ref', `Flag references unknown entry ${id}.`, 'flags.jsonl', line);
    }
  }

  return { ok: findings.length === 0, findings };
}

module.exports = { run };
