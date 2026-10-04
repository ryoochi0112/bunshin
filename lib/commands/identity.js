'use strict';

const fs = require('node:fs');
const identity = require('../identity');
const store = require('../store');
const { parsePersona } = require('./pairs');

async function inputText(input) {
  if (typeof input === 'string') return input;
  if (typeof input.setEncoding === 'function') input.setEncoding('utf8');
  let text = '';
  for await (const chunk of input) text += chunk.toString();
  return text;
}

module.exports = {
  name: 'identity',
  summary: 'Validate, commit or show an identity',
  async run(argv, io) {
    let parsed;
    try { parsed = parsePersona(argv); } catch { parsed = { args: [] }; }
    const [action, ...args] = parsed.args;
    if (!(action === 'show' && args.length === 0)
      && !(['validate', 'commit'].includes(action) && args.length === 1 && !args[0].startsWith('--'))) {
      io.stderr.write('Usage: bunshin identity validate|commit <file|-> | show [--persona <dir>]\n');
      return 2;
    }
    try {
      const dir = store.resolvePersona({ persona: parsed.persona, env: io.env || process.env });
      if (action === 'show') {
        const manifest = store.readJson(dir, 'persona.json');
        io.stdout.write(identity.render({ ...store.readJson(dir, 'identity.json'), display_name: manifest.display_name }));
        return 0;
      }
      const text = args[0] === '-'
        ? await inputText(io.stdin === undefined ? process.stdin : io.stdin)
        : fs.readFileSync(args[0], 'utf8');
      let draft;
      try { draft = JSON.parse(text); } catch { throw new Error('Invalid identity draft JSON.'); }
      if (action === 'validate') {
        const result = identity.validate(dir, draft);
        if (!result.ok) {
          for (const { trait, message } of result.errors) io.stderr.write(`${trait}: ${message}\n`);
          return 1;
        }
        io.stdout.write('Identity is valid.\n');
      } else {
        const committed = identity.commit(dir, draft, { probe: io.probe });
        io.stdout.write(`Committed identity v${committed.version}.\n`);
      }
      return 0;
    } catch (error) {
      io.stderr.write(`${error.message}\n`);
      return 1;
    }
  },
};
