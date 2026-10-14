'use strict';

const kb = require('../kb');
const store = require('../store');
const { readManifest } = require('../check');
const { parsePersona } = require('./pairs');

const usage = 'Usage: bunshin persona kb [<name> | --unset] [--persona <dir>]\n';
const namePattern = /^[a-z0-9][a-z0-9-]*$/;

function parse(argv) {
  let parsed;
  try { parsed = parsePersona(argv); } catch { return null; }
  const [action, target, ...rest] = parsed.args;
  if (action !== 'kb' || rest.length) return null;
  if (target === undefined) return { mode: 'show', persona: parsed.persona };
  if (target === '--unset') return { mode: 'unset', persona: parsed.persona };
  if (!namePattern.test(target)) return null;
  return { mode: 'bind', name: target, persona: parsed.persona };
}

module.exports = {
  name: 'persona',
  summary: "Show, bind or unbind a persona's knowledge base",
  run(argv, io) {
    const parsed = parse(argv);
    if (!parsed) {
      io.stderr.write(usage);
      return 2;
    }
    try {
      const env = io.env || process.env;
      const dir = store.resolvePersona({ persona: parsed.persona, env });
      const manifest = readManifest(dir);
      if (parsed.mode === 'show') {
        io.stdout.write(`${Object.hasOwn(manifest, 'kb') ? manifest.kb : 'unbound'}\n`);
      } else if (parsed.mode === 'unset') {
        store.updateManifest(dir, ({ kb: _removed, ...rest }) => rest, { probe: io.probe });
        io.stdout.write(`Unbound persona ${manifest.name}\n`);
      } else {
        // Validate before writing, so a refused KB leaves persona.json unchanged.
        kb.loadBindable(parsed.name, env);
        store.updateManifest(dir, (current) => ({ ...current, kb: parsed.name }), { probe: io.probe });
        io.stdout.write(`Bound persona ${manifest.name} to KB ${parsed.name}\n`);
      }
      return 0;
    } catch (error) {
      io.stderr.write(`${error.message}\n`);
      return 1;
    }
  },
};
