'use strict';

const { exportPersona } = require('../export');
const store = require('../store');
const { parsePersona } = require('./pairs');

module.exports = {
  name: 'export',
  summary: 'Export a standalone Claude Code persona package',
  run(argv, io) {
    let parsed;
    try { parsed = parsePersona(argv); } catch { parsed = null; }
    if (!parsed || !(parsed.args.length === 0 || (parsed.args.length === 2
      && parsed.args[0] === '--out' && parsed.args[1] && !parsed.args[1].startsWith('--')))) {
      io.stderr.write('Usage: bunshin export [--out <dir>] [--persona <dir>]\n');
      return 2;
    }
    try {
      const dir = store.resolvePersona({ persona: parsed.persona, env: io.env || process.env });
      const result = exportPersona(dir, parsed.args[1], { probe: io.probe });
      io.stdout.write(`${JSON.stringify(result)}\n`);
      return 0;
    } catch (error) {
      io.stderr.write(`${error.message}\n`);
      return 1;
    }
  },
};
