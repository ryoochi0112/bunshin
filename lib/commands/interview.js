'use strict';

const interview = require('../interview');
const store = require('../store');
const { parsePersona } = require('./pairs');

function parseFlags(args, allowed) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!allowed.includes(flag) || Object.hasOwn(values, flag)
      || index + 1 >= args.length || args[index + 1].startsWith('--')) throw new Error('Invalid options.');
    values[flag] = args[++index];
  }
  return values;
}

module.exports = {
  name: 'interview',
  summary: 'Ask and record targeted interview questions',
  run(argv, io) {
    let parsed;
    try { parsed = parsePersona(argv); } catch {
      io.stderr.write('Usage: bunshin interview begin|ask|answer|status [--persona <dir>]\n');
      return 2;
    }
    const [action, ...args] = parsed.args;
    let values;
    if (['begin', 'status'].includes(action)) {
      if (args.length) {
        io.stderr.write('Usage: bunshin interview begin|status [--persona <dir>]\n');
        return 2;
      }
    } else if (action === 'ask') {
      try { values = parseFlags(args, ['--topic', '--gap', '--question']); } catch {
        io.stderr.write('Usage: bunshin interview ask --topic <t> --gap <why> --question <q> [--persona <dir>]\n');
        return 2;
      }
      if (Object.keys(values).length !== 3) {
        io.stderr.write('Usage: bunshin interview ask --topic <t> --gap <why> --question <q> [--persona <dir>]\n');
        return 2;
      }
    } else if (action === 'answer') {
      try { values = parseFlags(args, ['--text']); } catch {
        io.stderr.write('Usage: bunshin interview answer --text <a> [--persona <dir>]\n');
        return 2;
      }
      if (Object.keys(values).length !== 1) {
        io.stderr.write('Usage: bunshin interview answer --text <a> [--persona <dir>]\n');
        return 2;
      }
    } else {
      io.stderr.write('Usage: bunshin interview begin|ask|answer|status [--persona <dir>]\n');
      return 2;
    }

    try {
      const dir = store.resolvePersona({ persona: parsed.persona, env: io.env || process.env });
      const options = { probe: io.probe };
      if (action === 'begin') {
        io.stdout.write(`${JSON.stringify(interview.begin(dir, options))}\n`);
      } else if (action === 'status') {
        const state = interview.readState(dir);
        if (!state) throw new Error('No interview session found; run "bunshin interview begin" first.');
        io.stdout.write(`${JSON.stringify(interview.status(state))}\n`);
      } else if (action === 'ask') {
        const result = interview.ask(dir, {
          topic: values['--topic'], gap: values['--gap'], question: values['--question'],
        }, options);
        io.stdout.write(`${JSON.stringify(result.status)}\n`);
        if (result.alreadyPending) return 3;
      } else {
        const result = interview.answer(dir, values['--text'], options);
        io.stdout.write(`${JSON.stringify(result)}\n`);
      }
      return 0;
    } catch (error) {
      io.stderr.write(`${error.message}\n`);
      return 1;
    }
  },
};
