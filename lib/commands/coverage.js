'use strict';

const coverage = require('../coverage');
const kb = require('../kb');
const store = require('../store');

const usage = 'Usage: bunshin coverage import <file> [--persona <dir>] | show [--persona <dir>]\n';

function parse(argv) {
  const [action, ...rest] = argv;
  if (!['import', 'show'].includes(action)) return null;
  const file = action === 'import' ? rest.shift() : undefined;
  if (action === 'import' && (!file || !file.trim() || file.startsWith('-'))) return null;
  let persona;
  if (rest.length) {
    if (rest.length !== 2 || rest[0] !== '--persona' || !rest[1].trim() || rest[1].startsWith('-')) return null;
    persona = rest[1];
  }
  return { action, file, persona };
}

function counts(count, labels, name) {
  return `${count} labels (C ${labels.C} · P ${labels.P} · N ${labels.N} · X ${labels.X}) for kb ${name}`;
}

module.exports = {
  name: 'coverage',
  summary: 'Import and show held-out KB coverage labels',
  run(argv, io) {
    if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
      io.stdout.write(usage);
      return 0;
    }
    const args = parse(argv);
    if (!args) { io.stderr.write(usage); return 2; }
    try {
      const env = io.env || process.env;
      const dir = store.resolvePersona({ persona: args.persona, env });
      if (args.action === 'import') {
        const result = coverage.importFile(dir, args.file, { env });
        const value = coverage.read(dir);
        io.stdout.write(`Imported ${counts(result.count, result.labels, value.kb)}\n`);
      } else {
        const value = coverage.read(dir);
        if (!value) { io.stdout.write('No coverage labels\n'); return 0; }
        const bound = kb.loadBound(dir, env);
        if (!bound) throw new Error('coverage show: Persona has no bound KB.');
        const labels = { C: 0, P: 0, N: 0, X: 0 };
        const rows = Object.values(value.cases);
        for (const row of rows) labels[row.coverage] += 1;
        const stale = value.kb !== bound.name || value.kb_digest_hash !== bound.digest.hash;
        io.stdout.write(`${counts(rows.length, labels, value.kb)}\nkb digest ${value.kb_digest_hash}${stale ? ' · stale' : ''}\n`);
      }
      return 0;
    } catch (error) {
      io.stderr.write(`${error.message}\n`);
      return 1;
    }
  },
};
