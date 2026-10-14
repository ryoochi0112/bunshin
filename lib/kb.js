'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const store = require('./store');
const { readManifest } = require('./check');

const namePattern = /^[a-z0-9][a-z0-9-]*$/;
const idPattern = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/;
const keys = new Set(['claim', 'status', 'verified', 'sources', 'select', 'note']);
const statuses = new Set(['draft', 'verified', 'conflict', 'retired']);

function resolve({ name, env = process.env } = {}) {
  if (typeof name !== 'string' || !namePattern.test(name)) {
    throw new Error('KB name must match /^[a-z0-9][a-z0-9-]*$/.');
  }
  return path.join(store.kbHome(env), name);
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function parseSelect(value, select, error) {
  for (const item of value ? value.split(';') : []) {
    const pair = /^([^=]+)=(.*)$/.exec(item.trim());
    if (!pair || !pair[1].trim() || !pair[2].trim()) {
      error('Invalid select; expected key=value pairs.');
      break;
    }
    const selectKey = pair[1].trim();
    if (Object.hasOwn(select, selectKey)) {
      error(`Duplicate select key: ${selectKey}.`);
      break;
    }
    Object.defineProperty(select, selectKey, { value: pair[2].trim(), enumerable: true, configurable: true, writable: true });
  }
}

function parseEntries(text, file, entries, ids, error) {
  const topic = path.basename(file, '.md');
  let entry;
  let seen;
  const finish = () => {
    if (!entry) return;
    for (const key of ['claim', 'status', 'sources']) {
      if (!seen.has(key)) error(file, entry.line, `Missing ${key}.`);
    }
    if (entry.status === 'verified' && !seen.has('verified')) {
      error(file, entry.line, 'Verified entry requires a verified date.');
    }
    entries.push(entry);
    entry = null;
  };

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    const content = raw.replace(/ {2,}#.*$/, '').trim();
    if (/^#{1,6}(?:\s|$)/.test(content)) {
      finish();
      const heading = /^###(?:\s+(.*))?$/.exec(content);
      if (!heading) return;
      const id = (heading[1] || '').trim();
      entry = { id, topic, file, line, claim: '', status: '', verified: null, sources: [], select: {}, note: null };
      seen = new Set();
      if (!idPattern.test(id)) error(file, line, 'Invalid entry id; expected <kb>.<topic>.<slug>.');
      else if (ids.has(id)) error(file, line, `Duplicate entry id: ${id}.`);
      ids.add(id);
      return;
    }
    if (!entry || !content || content.startsWith('#')) return;
    const field = /^([a-z][a-z0-9_-]*):\s*(.*)$/.exec(content);
    if (!field) {
      error(file, line, 'Expected key: value.');
      return;
    }
    const [, key, value] = field;
    if (!keys.has(key)) {
      error(file, line, `Unknown key: ${key}.`);
      return;
    }
    if (seen.has(key)) {
      error(file, line, `Duplicate key: ${key}.`);
      return;
    }
    seen.add(key);
    if (key === 'sources') {
      const refs = value.split(',').map((ref) => /^([S]\d+)#([^\s,#]+)$/.exec(ref.trim()));
      if (refs.some((ref) => !ref)) error(file, line, 'Invalid sources; expected at least one S<nn>#<anchor> reference.');
      else entry.sources = refs.map((ref) => ({ source: ref[1], anchor: ref[2] }));
    } else if (key === 'select') {
      parseSelect(value, entry.select, (message) => error(file, line, message));
    } else {
      entry[key] = value;
      if (key === 'claim' && !value) error(file, line, 'Missing claim.');
      if (key === 'status' && !statuses.has(value)) error(file, line, 'Invalid status; expected draft, verified, conflict or retired.');
      if (key === 'verified' && !validDate(value)) error(file, line, 'Invalid verified date; expected YYYY-MM-DD.');
    }
  });
  finish();
}

function load(dir) {
  const result = { manifest: null, entries: [], sources: new Map(), flags: new Map(), errors: [] };
  const error = (file, line, message) => result.errors.push({ file, line, message });
  const read = (file, optional = false) => {
    try {
      const target = path.join(dir, file);
      if (!fs.lstatSync(target).isFile()) throw new Error('Expected a regular file.');
      return fs.readFileSync(target, 'utf8');
    } catch (cause) {
      if (!optional || cause.code !== 'ENOENT') error(file, 1, `Cannot read file: ${cause.message}`);
      return null;
    }
  };
  const manifestText = read('kb.json');
  if (manifestText !== null) {
    try {
      const manifest = JSON.parse(manifestText);
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error();
      result.manifest = manifest;
    } catch {
      error('kb.json', 1, 'Invalid JSON manifest.');
    }
  }
  try { mode(result); } catch (cause) { error('kb.json', 1, cause.message); }
  const registry = (file, map, optional) => {
    const text = read(file, optional);
    if (text === null) return;
    text.split(/\r?\n/).forEach((line, index) => {
      if (!line.trim()) return;
      let row;
      try { row = JSON.parse(line); } catch {
        error(file, index + 1, 'Invalid JSONL row.');
        return;
      }
      if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.id !== 'string' || !row.id) {
        error(file, index + 1, 'Registry row requires an id.');
        return;
      }
      map.set(row.id, row);
    });
  };
  registry('sources.jsonl', result.sources, false);
  registry('flags.jsonl', result.flags, true);
  result.ssot = { present: false, sections: [], approvals: new Map() };
  const ssotText = read('ssot.md', true);
  if (ssotText !== null) {
    const parsed = require('./kb-ssot').parse(ssotText, result.manifest?.name || path.basename(dir));
    result.ssot = { present: true, title: parsed.title, sections: parsed.sections, approvals: result.ssot.approvals };
    result.errors.push(...parsed.errors);
  }
  registry('ssot-approvals.jsonl', result.ssot.approvals, true);
  let files = [];
  try {
    const directory = path.join(dir, 'entries');
    if (!fs.lstatSync(directory).isDirectory()) throw new Error('Expected a regular directory.');
    files = fs.readdirSync(directory, { withFileTypes: true })
      .filter((file) => file.name.endsWith('.md') && !file.isDirectory())
      .map((file) => file.name).sort();
  } catch (cause) {
    error('entries', 1, `Cannot read entries: ${cause.message}`);
  }
  const ids = new Set();
  for (const name of files) {
    const file = `entries/${name}`;
    const text = read(file);
    if (text !== null) parseEntries(text, file, result.entries, ids, error);
  }
  return result;
}

function mode(kbData) {
  if (!kbData.manifest || !Object.hasOwn(kbData.manifest, 'digest')) return 'entries';
  const digest = kbData.manifest.digest;
  if (digest !== 'entries' && digest !== 'ssot') {
    throw new Error('Invalid digest; expected entries or ssot.');
  }
  return digest;
}

function citable(kbData) {
  const result = new Map();
  if (mode(kbData) === 'ssot') {
    const states = require('./kb-ssot').states(kbData);
    for (const section of kbData.ssot.sections) {
      if (states.get(section.section) !== 'approved') continue;
      for (const { id, text, select } of section.statements) {
        result.set(id, { id, claim: text, select });
      }
    }
    return result;
  }
  const counts = new Map();
  for (const entry of kbData.entries) counts.set(entry.id, (counts.get(entry.id) || 0) + 1);
  for (const entry of kbData.entries) {
    if (entry.status !== 'verified' || !idPattern.test(entry.id) || counts.get(entry.id) !== 1
      || (kbData.flags.has(entry.id) && kbData.flags.get(entry.id).flagged !== false)) continue;
    const { id, claim, select } = entry;
    result.set(id, { id, claim, select });
  }
  return result;
}

function digest(kbData) {
  const facts = citable(kbData);
  const topics = new Map();
  if (mode(kbData) === 'ssot') {
    for (const section of kbData.ssot.sections) {
      const statements = section.statements.filter(({ id }) => facts.has(id)).map(({ id }) => facts.get(id));
      if (statements.length) topics.set(`${section.section} — ${section.title}`, statements);
    }
  } else {
    for (const entry of kbData.entries) {
      if (!facts.has(entry.id)) continue;
      if (!topics.has(entry.topic)) topics.set(entry.topic, []);
      topics.get(entry.topic).push(facts.get(entry.id));
    }
  }
  const lines = [];
  const ids = [];
  for (const [topic, entries] of topics) {
    lines.push(`## ${topic}`);
    for (const entry of entries) {
      lines.push(`- [${entry.id}] ${entry.claim}`);
      const select = Object.entries(entry.select);
      if (select.length) lines.push(`  select: ${select.map(([key, value]) => `${key}=${value}`).join('; ')}`);
      ids.push(entry.id);
    }
  }
  const text = lines.length ? `${lines.join('\n')}\n` : '';
  return { text, hash: crypto.createHash('sha256').update(text).digest('hex'), ids };
}

function loadBound(personaDir, env = process.env) {
  const manifest = readManifest(personaDir);
  if (!Object.hasOwn(manifest, 'kb')) return null;
  return loadBindable(manifest.kb, env);
}

// Loads a KB by name with every check a persona binding needs.
function loadBindable(name, env = process.env) {
  const dir = resolve({ name, env });
  if (!fs.existsSync(dir)) throw new Error(`KB ${name} not found`);
  const data = load(dir);
  if (data.errors.length) {
    const { file, line, message } = data.errors[0];
    throw new Error(`KB ${name} has parse errors: ${file}:${line} ${message}`);
  }
  // Load the checker lazily because it requires this module to parse the KB.
  const checked = require('./kb-check').run(dir);
  if (!checked.ok) {
    const { name: finding, message } = checked.findings[0];
    throw new Error(`KB ${name} fails kb check: ${finding}: ${message}`);
  }
  return { name, dir, data, digest: digest(data) };
}

module.exports = { resolve, load, parseEntries, parseSelect, mode, citable, digest, loadBound, loadBindable, ENTRY_KEYS: [...keys] };
