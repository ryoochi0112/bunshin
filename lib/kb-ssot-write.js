'use strict';

const fs = require('node:fs');
const path = require('node:path');
const kb = require('./kb');
const ssot = require('./kb-ssot');
const check = require('./kb-check');
const { normalize } = require('./leak');
const store = require('./store');

function context(dir, options) {
  const data = kb.load(dir);
  if (data.errors.length) throw new Error('Cannot use KB with parse errors; run "bunshin kb check".');
  const scrub = check.readScrubList(dir);
  const privateText = (text) => check.matchesPii(text) || scrub.some((needle) => normalize(text).includes(needle));
  const label = (section) => /^[a-z0-9][a-z0-9-]*$/.test(section) && !privateText(section) ? section : '<section>';
  const fail = (section, message) => { throw new Error(`Section ${label(section)}: ${message}`); };
  const scan = (text, section, field) => {
    if (scrub.some((needle) => normalize(text).includes(needle))) fail(section, `${field} contains a scrub-list match.`);
    if (check.matchesPii(text)) fail(section, `${field} contains an email address or phone number.`);
  };
  return { data, fail, scan, options: { ...options, synthetic: data.manifest.synthetic === true } };
}

function validate(section, { data, fail, scan }) {
  scan(section.section, section.section, 'section');
  scan(section.title, section.section, 'title');
  for (const statement of section.statements) {
    scan(statement.text, section.section, 'text');
    for (const value of Object.entries(statement.select).flat()) scan(value, section.section, 'select');
    if (data.entries.some((entry) => entry.id === statement.id)) fail(section.section, 'Statement id equals an entry id.');
    for (const id of statement.backs) {
      const entries = data.entries.filter((entry) => entry.id === id);
      if (entries.length !== 1) fail(section.section, 'Unknown or ambiguous backing entry.');
      if (entries[0].status !== 'verified') fail(section.section, 'Backing entry is not verified.');
      if (data.flags.has(id) && data.flags.get(id).flagged !== false) fail(section.section, 'Backing entry is flagged.');
    }
  }
}

// The parser's line numbers delimit raw blocks, retaining other sections' bytes.
function blocks(text, sections) {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
  const offsets = [0];
  for (const line of lines) offsets.push(offsets.at(-1) + line.length);
  return sections.map((section, index) => ({ section: section.section,
    start: offsets[section.line - 1],
    end: index + 1 < sections.length ? offsets[sections[index + 1].line - 1] : text.length }));
}

function draft(dir, stdinText, options = {}) {
  const ctx = context(dir, options);
  const parsed = ssot.parse(stdinText, ctx.data.manifest.name);
  if (parsed.errors.length) {
    const error = parsed.errors[0];
    const section = parsed.sections.filter((item) => item.line <= error.line).at(-1);
    ctx.fail(section?.section || '<section>', `Invalid SSOT block at line ${error.line}.`);
  }
  if (!parsed.sections.length || stdinText.split(/\r?\n/).some((line) => /^#(?:\s|$)/.test(line.trim()))) {
    ctx.fail(parsed.sections[0]?.section || '<section>', 'Expected one or more section blocks only.');
  }
  const refusals = [];
  for (const section of parsed.sections) {
    try { validate(section, ctx); } catch (error) { refusals.push(error.message); }
  }
  if (refusals.length) throw new Error(refusals.join('\n'));
  if (ctx.data.entries.some((entry) => /^s[1-9][0-9]*$/.test(entry.id.split('.').at(-1)))) {
    ctx.fail(parsed.sections[0].section, 'Entry slug s<n> is reserved when ssot.md exists.');
  }
  const incoming = new Map(blocks(stdinText, parsed.sections)
    .map(({ section, start, end }) => [section, stdinText.slice(start, end).trimEnd() + '\n']));
  const original = ctx.data.ssot.present ? fs.readFileSync(path.join(dir, 'ssot.md'), 'utf8') : `# ${ctx.data.manifest.name} SSOT\n\n`;
  ctx.scan(ctx.data.ssot.present ? ctx.data.ssot.title : `${ctx.data.manifest.name} SSOT`, parsed.sections[0].section, 'document title');
  const existing = blocks(original, ctx.data.ssot.sections);
  const replaced = [];
  let text = '';
  let position = 0;
  for (const { section, start, end } of existing) {
    text += original.slice(position, start);
    if (incoming.has(section)) {
      const trailing = /(?:\r?\n[ \t]*)+$/.exec(original.slice(start, end))?.[0] || '\n';
      text += incoming.get(section).trimEnd() + trailing;
      incoming.delete(section);
      replaced.push(section);
    } else text += original.slice(start, end);
    position = end;
  }
  text += original.slice(position);
  const added = [...incoming.keys()];
  for (const block of incoming.values()) {
    if (text && !/\n\s*\n$/.test(text)) text += text.endsWith('\n') ? '\n' : '\n\n';
    text += block;
  }
  store.writeText(dir, 'ssot.md', text, ctx.options);
  return { added, replaced };
}

function approve(dir, section, options = {}) {
  const ctx = context(dir, options);
  const selected = ctx.data.ssot.sections.find((item) => item.section === section);
  if (!selected) ctx.fail(section, 'Section not found.');
  ctx.scan(ctx.data.ssot.title || '', section, 'document title');
  validate(selected, ctx);
  const row = { id: section, approved_at: new Date().toISOString(),
    text_hash: ssot.textHash(selected), backing_hash: ssot.backingHash(selected, ctx.data) };
  store.appendJsonl(dir, 'ssot-approvals.jsonl', row, ctx.options);
  return row;
}

function setMode(dir, mode, options = {}) {
  if (mode !== 'entries' && mode !== 'ssot') throw new Error('Invalid digest; expected entries or ssot.');
  const ctx = context(dir, options);
  if (mode === 'ssot' && ![...ssot.states(ctx.data).values()].includes('approved')) {
    throw new Error('No approved SSOT section.');
  }
  store.writeJson(dir, 'kb.json', { ...ctx.data.manifest, digest: mode }, ctx.options);
}

module.exports = { draft, approve, setMode };
