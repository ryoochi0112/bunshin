'use strict';

const fs = require('node:fs');
const path = require('node:path');
const kb = require('../kb');
const check = require('../kb-check');
const cite = require('../kb-cite');
const draft = require('../kb-draft');
const store = require('../store');

const usage = 'Usage: bunshin kb init <name> [--sample] | check <name> | list <name> [--status <s>] [--topic <t>] | show <name> <id> | approve <name> <id> [--resolve] | flag <name> <id> --reason <text> | unflag <name> <id> | cite <name> --draft <file> | sources add <name> | draft <name> | stale <name> --source S<nn> --changed-at <date> [--reason <text>] [--dry-run]\n';
const namePattern = /^[a-z0-9][a-z0-9-]*$/;
const idPattern = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/;
const statuses = new Set(['draft', 'verified', 'conflict', 'retired', 'flagged']);

function parse(argv) {
  if (argv[0] === 'sources') {
    if (argv[1] !== 'add') return null;
    argv = ['sources', ...argv.slice(2)];
  }
  const [action, name, ...rest] = argv;
  const allowed = {
    init: { '--sample': false }, check: {}, list: { '--status': true, '--topic': true },
    show: {}, approve: { '--resolve': false }, flag: { '--reason': true }, unflag: {},
    cite: { '--draft': true }, sources: {}, draft: {},
    stale: { '--source': true, '--changed-at': true, '--reason': true, '--dry-run': false },
  };
  if (!Object.hasOwn(allowed, action) || !namePattern.test(name || '')) return null;
  const needsId = ['show', 'approve', 'flag', 'unflag'].includes(action);
  const id = needsId ? rest.shift() : undefined;
  if (needsId && !idPattern.test(id || '')) return null;
  const options = {};
  while (rest.length) {
    const option = rest.shift();
    if (!Object.hasOwn(allowed[action], option) || Object.hasOwn(options, option)) return null;
    if (allowed[action][option]) {
      const value = rest.shift();
      if (!value || value.startsWith('--') || !value.trim()) return null;
      options[option] = value;
    } else options[option] = true;
  }
  if (action === 'flag' && !options['--reason']) return null;
  if (action === 'cite' && !options['--draft']) return null;
  if (action === 'stale' && (!options['--source'] || !options['--changed-at'])) return null;
  if (options['--status'] && !statuses.has(options['--status'])) return null;
  return { action, name, id, options };
}

async function ingest(dir, action, io) {
  try {
    const input = io.stdin === undefined ? process.stdin : io.stdin;
    let text = '';
    if (typeof input === 'string') text = input;
    else {
      if (typeof input.setEncoding === 'function') input.setEncoding('utf8');
      for await (const chunk of input) text += chunk.toString();
    }
    const rows = [];
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { throw new Error(`Line ${index + 1}: invalid JSON.`); }
    }
    if (action === 'sources') {
      const result = draft.addSources(dir, rows);
      for (const row of result.added) io.stdout.write(`${row.id}  ${row.label}\n`);
    } else {
      const result = draft.addEntries(dir, rows);
      for (const id of result.added) io.stdout.write(`${id}\n`);
      const checked = check.run(dir, { probe: io.probe });
      for (const finding of checked.findings) io.stdout.write(`${JSON.stringify(finding)}\n`);
      return checked.ok ? 0 : 1;
    }
    return 0;
  } catch (error) {
    io.stderr.write(`${error.message}\n`);
    return 1;
  }
}

function init(dir, name, sample, probe) {
  if (fs.existsSync(dir)) throw new Error('KB directory already exists.');
  const options = { probe, synthetic: sample };
  if (sample) {
    const source = path.resolve(__dirname, '../../sample/kb/demo');
    const manifest = JSON.parse(fs.readFileSync(path.join(source, 'kb.json'), 'utf8'));
    if (manifest.synthetic !== true) throw new Error('Sample KB must be synthetic.');
    store.writeJson(dir, 'kb.json', { ...manifest, name }, options);
    const copy = (relative) => {
      for (const entry of fs.readdirSync(path.join(source, relative), { withFileTypes: true })) {
        const file = path.join(relative, entry.name);
        if (entry.isDirectory()) {
          fs.mkdirSync(path.join(dir, file), { recursive: true, mode: 0o700 });
          copy(file);
        } else if (entry.isFile() && file !== 'kb.json') {
          let text = fs.readFileSync(path.join(source, file), 'utf8');
          if (file.endsWith('.md')) {
            text = text.replace(/^(\s*###\s+)demo\./gm, `$1${name}.`);
          }
          store.writeText(dir, file, text, options);
        } else if (!entry.isFile()) throw new Error('Sample KB contains an unsupported file.');
      }
    };
    copy('');
  } else {
    store.writeJson(dir, 'kb.json', {
      format_version: 1, name, product: name, synthetic: false, languages: ['ja'],
    }, options);
    store.writeText(dir, 'sources.jsonl', '', options);
    fs.mkdirSync(path.join(dir, 'entries'), { mode: 0o700 });
  }
}

// Use the parser's line number and heading grammar to retain all surrounding bytes.
function block(dir, entry) {
  const text = fs.readFileSync(path.join(dir, entry.file), 'utf8');
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
  let start = 0;
  for (let index = 0; index < entry.line - 1; index += 1) start += lines[index].length;
  let end = start + lines[entry.line - 1].length;
  for (let index = entry.line; index < lines.length; index += 1) {
    const content = lines[index].replace(/ {2,}#.*$/, '').trim();
    if (/^#{1,6}(?:\s|$)/.test(content)) break;
    end += lines[index].length;
  }
  return { text, start, end, lines: (text.slice(start, end).match(/[^\n]*\n|[^\n]+$/g) || []) };
}

function approve(dir, entry, selected, resolve, options) {
  if (entry.status === 'conflict' && !resolve) throw new Error('Conflict entry requires --resolve.');
  if (entry.status !== 'draft' && entry.status !== 'conflict') {
    throw new Error('Only draft or resolved conflict entries can be approved.');
  }
  const claims = selected.lines.filter((line) => /^claim:/.test(line.replace(/ {2,}#.*$/, '').trim()));
  if (claims.length !== 1) throw new Error('Approval requires exactly one claim: line.');
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const newline = selected.text.includes('\r\n') ? '\r\n' : '\n';
  const hasDate = selected.lines.some((line) => /^verified:/.test(line.trim()));
  const replacement = selected.lines.map((line) => {
    if (/^status:/.test(line.trim())) {
      const updated = line.replace(/^([ \t]*status:[ \t]*)(draft|conflict)/, '$1verified');
      return hasDate ? updated : `${updated.replace(/\r?\n$/, '')}${newline}verified: ${today}${line.endsWith('\n') ? newline : ''}`;
    }
    if (/^verified:/.test(line.trim())) {
      return line.replace(/^([ \t]*verified:[ \t]*)\d{4}-\d{2}-\d{2}/, `$1${today}`);
    }
    return line;
  }).join('');
  store.writeText(dir, entry.file, selected.text.slice(0, selected.start) + replacement + selected.text.slice(selected.end), options);
}

module.exports = {
  name: 'kb',
  summary: 'Create, check and review a knowledge base',
  run(argv, io) {
    if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
      io.stdout.write(usage);
      return 0;
    }
    const args = parse(argv);
    if (!args) { io.stderr.write(usage); return 2; }
    const { action, name, id, options } = args;
    try {
      const dir = kb.resolve({ name, env: io.env || process.env });
      if (action === 'sources' || action === 'draft') return ingest(dir, action, io);
      if (action === 'stale') {
        const result = draft.stale(dir, {
          source: options['--source'], changedAt: options['--changed-at'],
          reason: options['--reason'], dryRun: options['--dry-run'] === true,
        });
        for (const id of result.flagged) io.stdout.write(`flagged ${id}\n`);
        for (const id of result.skipped) io.stdout.write(`skipped ${id}\n`);
        return 0;
      }
      if (action === 'init') {
        init(dir, name, options['--sample'] === true, io.probe);
        io.stdout.write(`Created KB ${name} at ${dir}\n`);
        return 0;
      }
      if (action === 'check') {
        const result = check.run(dir, { probe: io.probe });
        for (const finding of result.findings) io.stdout.write(`${JSON.stringify(finding)}\n`);
        if (result.ok) io.stdout.write('KB check passed.\n');
        return result.ok ? 0 : 1;
      }
      const loaded = kb.load(dir);
      const matches = id ? loaded.entries.filter((entry) => entry.id === id) : [];
      const entry = matches.length === 1 ? matches[0] : null;
      // A conflict can have duplicate claim fields while awaiting resolution.
      // Check the raw block before reporting the loader's general parse failure.
      const selected = action === 'approve' && entry ? block(dir, entry) : null;
      if (selected && selected.lines.filter((line) => /^claim:/.test(line.trim())).length !== 1) {
        throw new Error('Approval requires exactly one claim: line.');
      }
      if (loaded.errors.length) throw new Error('Cannot use KB with parse errors; run "bunshin kb check".');
      if (action === 'cite') {
        const scrub = check.readScrubList(dir);
        const result = cite.check(loaded, fs.readFileSync(options['--draft'], 'utf8'), { scrub });
        for (const [index, sentence] of result.sentences.entries()) {
          if (sentence.problems.includes('scrub')) {
            for (const problem of sentence.problems) io.stdout.write(`sentence ${index + 1}: ${problem}\n`);
          } else if (sentence.problems.length) {
            const { text, ids, problems } = sentence;
            io.stdout.write(`${JSON.stringify({ text, ids, problems })}\n`);
          }
        }
        return result.ok ? 0 : 1;
      }
      if (action === 'list') {
        for (const item of loaded.entries) {
          const flag = loaded.flags.get(item.id);
          const status = flag && flag.flagged !== false ? 'flagged' : item.status;
          if (options['--status'] && status !== options['--status']) continue;
          if (options['--topic'] && item.topic !== options['--topic']) continue;
          io.stdout.write(`${item.id}  ${status}  ${item.claim.slice(0, 60)}\n`);
        }
        return 0;
      }
      if (!entry) throw new Error('Entry not found or entry id is ambiguous.');
      const writeOptions = { probe: io.probe, synthetic: loaded.manifest?.synthetic === true };
      if (action === 'show') {
        const selectedBlock = block(dir, entry);
        io.stdout.write(selectedBlock.text.slice(selectedBlock.start, selectedBlock.end));
      } else if (action === 'approve') {
        approve(dir, entry, selected, options['--resolve'], writeOptions);
        io.stdout.write(`Approved ${id}.\n`);
      } else {
        store.appendJsonl(dir, 'flags.jsonl', {
          id, flagged: action === 'flag', reason: action === 'flag' ? options['--reason'] : null,
          at: new Date().toISOString(),
        }, writeOptions);
        io.stdout.write(`${action === 'flag' ? 'Flagged' : 'Unflagged'} ${id}.\n`);
      }
      return 0;
    } catch (error) {
      io.stderr.write(`${error.message}\n`);
      return 1;
    }
  },
};
