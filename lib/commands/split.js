'use strict';

const store = require('../store');
const split = require('../split');
const { parsePersona } = require('./pairs');

module.exports = {
  name: 'split',
  summary: 'Assign new pairs to build or held-out sets',
  run(argv, io) {
    let parsed;
    try { parsed = parsePersona(argv); } catch { parsed = null; }
    if (!parsed || parsed.args.length) {
      io.stderr.write('Usage: bunshin split [--persona <dir>]\n');
      return 2;
    }
    try {
      const dir = store.resolvePersona({ persona: parsed.persona, env: io.env || process.env });
      io.stdout.write(`${JSON.stringify(split.assign(dir, { probe: io.probe }))}\n`);
      return 0;
    } catch (error) {
      io.stderr.write(`${error.message}\n`);
      return 1;
    }
  },
};
