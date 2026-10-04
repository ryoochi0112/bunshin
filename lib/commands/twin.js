'use strict';

const twin = require('../twin');
const store = require('../store');
const { parsePersona } = require('./pairs');

module.exports = {
  name: 'twin',
  summary: 'Compose a twin prompt from the committed identity',
  run(argv, io) {
    let parsed;
    try { parsed = parsePersona(argv); } catch { parsed = null; }
    if (!parsed || parsed.args.length !== 3 || parsed.args[0] !== 'prompt'
      || parsed.args[1] !== '--skill' || !['spec-answer', 'idea-discussion'].includes(parsed.args[2])) {
      io.stderr.write('Usage: bunshin twin prompt --skill spec-answer|idea-discussion [--persona <dir>]\n');
      return 2;
    }
    try {
      const dir = store.resolvePersona({ persona: parsed.persona, env: io.env || process.env });
      io.stdout.write(twin.composePrompt(dir, parsed.args[2]));
      return 0;
    } catch (error) {
      io.stderr.write(`${error.message}\n`);
      return 1;
    }
  },
};
