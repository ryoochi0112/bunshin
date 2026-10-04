'use strict';

const store = require('../store');
const pairs = require('../pairs');
const { parsePersona } = require('./pairs');

module.exports = {
  name: 'cases',
  summary: 'Build evaluation cases from held-out pairs',
  run(argv, io) {
    let parsed;
    try { parsed = parsePersona(argv); } catch { parsed = null; }
    if (!parsed || parsed.args.length !== 1 || parsed.args[0] !== 'build') {
      io.stderr.write('Usage: bunshin cases build [--persona <dir>]\n');
      return 2;
    }
    try {
      const dir = store.resolvePersona({ persona: parsed.persona, env: io.env || process.env });
      const cases = pairs.listPairs(dir, { set: 'heldout' })
        .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
        .map((pair) => ({
          id: pair.id, layer: pair.layer, question: pair.question, context: pair.context,
          reference_answer: pair.answer.text, permalink: pair.permalink,
        }));
      store.writeJsonl(dir, 'cases.jsonl', cases, { probe: io.probe });
      io.stdout.write(`Built ${cases.length} cases\n`);
      return 0;
    } catch (error) {
      io.stderr.write(`${error.message}\n`);
      return 1;
    }
  },
};
