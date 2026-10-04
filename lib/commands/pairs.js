'use strict';

const store = require('../store');
const pairs = require('../pairs');

// Also shared by the split and cases commands so persona flags behave consistently.
function parsePersona(argv) {
  const args = [];
  let persona;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--persona') {
      if (persona !== undefined || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('Expected --persona <dir> once.');
      persona = argv[++index];
    } else args.push(argv[index]);
  }
  return { args, persona };
}

async function inputText(input) {
  if (typeof input === 'string') return input;
  if (typeof input.setEncoding === 'function') input.setEncoding('utf8');
  let text = '';
  for await (const chunk of input) text += chunk.toString();
  return text;
}

module.exports = {
  name: 'pairs',
  summary: 'Add, list or label question-answer pairs',
  parsePersona,
  async run(argv, io) {
    let parsed;
    try {
      parsed = parsePersona(argv);
    } catch {
      io.stderr.write('Usage: bunshin pairs add|list|label [--persona <dir>]\n');
      return 2;
    }
    const [action, ...args] = parsed.args;
    let set = 'build';
    let json = false;
    let valid = action === 'add' && args.length === 0;
    if (action === 'label') valid = args.length === 2 && /^[a-z0-9-]+$/.test(args[0]) && ['knowledge', 'judgment'].includes(args[1]);
    if (action === 'list') {
      valid = true;
      let sawSet = false;
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] === '--json' && !json) json = true;
        else if (args[index] === '--set' && !sawSet && ['build', 'all'].includes(args[index + 1])) {
          sawSet = true;
          set = args[++index];
        } else valid = false;
      }
    }
    if (!valid) {
      io.stderr.write('Usage: bunshin pairs add | list [--set build|all] [--json] | label <id> knowledge|judgment [--persona <dir>]\n');
      return 2;
    }
    try {
      const dir = store.resolvePersona({ persona: parsed.persona, env: io.env || process.env });
      const options = { probe: io.probe };
      if (action === 'add') {
        const text = await inputText(io.stdin === undefined ? process.stdin : io.stdin);
        const incoming = [];
        const errors = [];
        text.split('\n').forEach((line, index) => {
          if (!line.trim()) return;
          let pair;
          try { pair = JSON.parse(line); } catch {
            errors.push(`Line ${index + 1}: invalid JSON.`);
            return;
          }
          const findings = pairs.validatePair(pair);
          if (findings.length) errors.push(`Line ${index + 1}: ${findings.join('; ')}.`);
          else incoming.push(pair);
        });
        if (errors.length) throw new Error(errors.join('\n'));
        const result = pairs.addPairs(dir, incoming, options);
        io.stdout.write(`${JSON.stringify(result)}\n`);
      } else if (action === 'label') {
        pairs.labelPair(dir, args[0], args[1], options);
        io.stdout.write(`Labeled ${args[0]} ${args[1]} (manual)\n`);
      } else {
        const records = pairs.listPairs(dir, { set });
        const lines = records.map((pair) => json ? JSON.stringify(pair) : `${pair.id}\t${pair.layer}`);
        if (lines.length) io.stdout.write(`${lines.join('\n')}\n`);
      }
      return 0;
    } catch (error) {
      io.stderr.write(`${error.message}\n`);
      return 1;
    }
  },
};
