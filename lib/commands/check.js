'use strict';

const check = require('../check');
const store = require('../store');
const { parsePersona } = require('./pairs');

module.exports = {
  name: 'check',
  summary: 'Check identity and conflict evidence for held-out leaks',
  run(argv, io) {
    let parsed;
    try { parsed = parsePersona(argv); } catch { parsed = null; }
    const extraFiles = [];
    let valid = parsed !== null;
    if (parsed) for (let index = 0; index < parsed.args.length; index += 1) {
      if (parsed.args[index] === '--extra-file' && parsed.args[index + 1]
        && !parsed.args[index + 1].startsWith('--')) extraFiles.push(parsed.args[++index]);
      else valid = false;
    }
    if (!valid) {
      io.stderr.write('Usage: bunshin check [--persona <dir>] [--extra-file <relative-path>]\n');
      return 2;
    }
    try {
      const dir = store.resolvePersona({ persona: parsed.persona, env: io.env || process.env });
      const result = check.runChecks(dir, { extraFiles });
      if (!result.ok) {
        io.stderr.write(`${check.formatFindings(result.findings)}\n`);
        return 1;
      }
      io.stdout.write('Held-out checks passed.\n');
      return 0;
    } catch (error) {
      io.stderr.write(`${error.message}\n`);
      return 1;
    }
  },
};
