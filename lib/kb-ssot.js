'use strict';

const crypto = require('node:crypto');
const { parseSelect } = require('./kb');

const sectionPattern = /^[a-z0-9][a-z0-9-]*$/;
const statementKeys = new Set(['text', 'backs', 'select']);

function parse(text, kbName) {
  const result = { title: '', sections: [], errors: [] };
  const error = (line, message) => result.errors.push({ file: 'ssot.md', line, message });
  const sections = new Set();
  const ids = new Set();
  let section;
  let statement;
  let seen;
  let sectionSeen;
  let titleSeen = false;
  const finish = () => {
    if (!statement) return;
    for (const key of ['text', 'backs']) {
      if (!seen.has(key)) error(statement.line, `Missing ${key}.`);
    }
    statement = null;
  };

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    const content = raw.trim();
    if (!content) return;
    const heading = /^(#{1,3})(?:\s+(.*))?$/.exec(content);
    if (heading) {
      finish();
      const value = (heading[2] || '').trim();
      if (heading[1] === '#') {
        if (section || titleSeen) error(line, 'Unexpected title outside the document title line.');
        else {
          result.title = value;
          titleSeen = true;
        }
      } else if (heading[1] === '##') {
        section = { section: value, title: '', line, statements: [] };
        sectionSeen = new Set();
        if (!sectionPattern.test(value)) error(line, 'Invalid section slug; expected lowercase letters, digits or hyphens.');
        else if (sections.has(value)) error(line, 'Duplicate section.');
        sections.add(value);
        result.sections.push(section);
      } else {
        if (!section) {
          error(line, 'Statement outside a section.');
          return;
        }
        statement = { id: value, text: '', backs: [], select: {}, line };
        seen = new Set();
        const parts = value.split('.');
        if (parts.length !== 3 || parts[0] !== kbName || parts[1] !== section.section || !/^s[1-9][0-9]*$/.test(parts[2])) {
          error(line, 'Invalid statement id; expected <kb>.<section>.s<n> for this section and KB.');
        } else if (ids.has(value)) error(line, 'Duplicate statement id.');
        ids.add(value);
        section.statements.push(statement);
      }
      return;
    }
    const field = /^([a-z][a-z0-9_-]*):\s*(.*)$/.exec(content);
    if (!section || !field) {
      error(line, 'Expected key: value inside a section or statement.');
      return;
    }
    const [, key, value] = field;
    const target = statement || section;
    const targetSeen = statement ? seen : sectionSeen;
    if (statement ? !statementKeys.has(key) : key !== 'title') {
      error(line, 'Unknown key.');
      return;
    }
    if (targetSeen.has(key)) {
      error(line, `Duplicate key: ${key}.`);
      return;
    }
    targetSeen.add(key);
    if (key === 'select') {
      parseSelect(value, target.select, (message) => error(line, message));
    } else if (key === 'backs') {
      const backs = value.split(',').map((id) => id.trim());
      if (backs.some((id) => !id)) error(line, 'Missing or empty backs.');
      else target.backs = backs;
    } else {
      target[key] = value;
      if (key === 'text' && !value) error(line, 'Missing text.');
    }
  });
  finish();
  return result;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      Object.defineProperty(sorted, key, { value: canonical(value[key]), enumerable: true });
    }
    return sorted;
  }
  return value;
}

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function textHash(section) {
  return hash({ section: section.section, title: section.title,
    statements: section.statements.map(({ id, text, backs, select }) => ({ id, text, backs, select })) });
}

function backingIds(section) {
  return new Set(section.statements.flatMap((statement) => statement.backs));
}

function flagged(kbData, id) {
  return kbData.flags.has(id) && kbData.flags.get(id).flagged !== false;
}

function backingHash(section, kbData) {
  const ids = backingIds(section);
  return hash(kbData.entries.filter((entry) => ids.has(entry.id))
    .map(({ id, claim, select, status }) => ({ id, claim, select, status, flagged: flagged(kbData, id) }))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function states(kbData) {
  const result = new Map();
  const entries = new Map();
  const counts = new Map();
  for (const entry of kbData.entries) {
    entries.set(entry.id, entry);
    counts.set(entry.id, (counts.get(entry.id) || 0) + 1);
  }
  for (const section of kbData.ssot.sections) {
    const row = kbData.ssot.approvals.get(section.section);
    let state;
    if (!row) state = 'draft';
    else if ([...backingIds(section)].some((id) => counts.get(id) !== 1
      || entries.get(id).status !== 'verified' || flagged(kbData, id))) state = 'blocked';
    else if (textHash(section) !== row.text_hash) state = 'changed';
    else if (backingHash(section, kbData) !== row.backing_hash) state = 'stale';
    else state = 'approved';
    result.set(section.section, state);
  }
  return result;
}

module.exports = { parse, textHash, backingHash, states };
