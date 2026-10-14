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
    let skill;
    let json = false;
    let valid = parsed && parsed.args[0] === 'prompt';
    if (valid) {
      for (let index = 1; index < parsed.args.length; index += 1) {
        if (parsed.args[index] === '--skill' && skill === undefined
          && ['spec-answer', 'idea-discussion'].includes(parsed.args[index + 1])) skill = parsed.args[++index];
        else if (parsed.args[index] === '--json' && !json) json = true;
        else valid = false;
      }
    }
    if (!valid || !skill) {
      io.stderr.write('Usage: bunshin twin prompt --skill spec-answer|idea-discussion [--json] [--persona <dir>]\n');
      return 2;
    }
    try {
      const env = io.env || process.env;
      const dir = store.resolvePersona({ persona: parsed.persona, env });
      const composed = twin.compose(dir, skill, { env });
      io.stdout.write(json ? `${JSON.stringify(composed)}\n` : composed.text);
      return 0;
    } catch (error) {
      io.stderr.write(`${error.message}\n`);
      return 1;
    }
  },
};
