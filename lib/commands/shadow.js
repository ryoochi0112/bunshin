'use strict';

const fs = require('node:fs');
const store = require('../store');
const shadow = require('../shadow');

const usage = 'Usage: bunshin shadow new --layer knowledge|judgment (--thread-json <file|-> | --question-file <file|-> [--answer-file <file>]) [--persona <dir>] | draft <id> [--drafter <spec>] [--persona <dir>] | show <id> [--persona <dir>]\n';

async function inputText(input) {
  if (typeof input === 'string') return input;
  if (typeof input.setEncoding === 'function') input.setEncoding('utf8');
  let text = '';
  for await (const chunk of input) text += chunk.toString();
  return text;
}

module.exports = {
  name: 'shadow', summary: 'Store a question, draft privately and compare the real answer',
  async run(argv, io) {
    const [action, ...args] = argv;
    if (!['new', 'draft', 'show'].includes(action)) { io.stderr.write(usage); return 2; }
    const id = action === 'new' ? undefined : args.shift();
    const keys = Object.assign(Object.create(null), { '--persona': 'persona' });
    if (action === 'new') Object.assign(keys, { '--layer': 'layer', '--thread-json': 'threadFile',
      '--question-file': 'questionFile', '--answer-file': 'answerFile' });
    if (action === 'draft') keys['--drafter'] = 'drafter';
    const opts = {};
    for (let index = 0; index < args.length; index += 2) {
      const key = keys[args[index]];
      const value = args[index + 1];
      if (!key || Object.hasOwn(opts, key) || !value || value.startsWith('--')) {
        io.stderr.write(usage); return 2;
      }
      opts[key] = value;
    }
    if (action === 'new' && (!['knowledge', 'judgment'].includes(opts.layer)
      || (opts.threadFile !== undefined) === (opts.questionFile !== undefined)
      || (opts.answerFile !== undefined && (opts.questionFile === undefined || opts.answerFile === '-')))) {
      io.stderr.write(usage); return 2;
    }
    try {
      // Reject ids before persona resolution or any filesystem access.
      if (action !== 'new') shadow.validateId(id);
      const dir = store.resolvePersona({ persona: opts.persona, env: io.env || process.env });
      if (action === 'new') {
        const read = async (file) => file === '-'
          ? inputText(io.stdin === undefined ? process.stdin : io.stdin) : fs.readFileSync(file, 'utf8');
        if (opts.threadFile !== undefined) {
          const text = await read(opts.threadFile);
          try { opts.thread = JSON.parse(text); } catch { throw new Error('shadow: invalid thread JSON'); }
        } else {
          opts.question = await read(opts.questionFile);
          if (opts.answerFile !== undefined) opts.answer = await read(opts.answerFile);
        }
        io.stdout.write(`${shadow.create(dir, opts)}\n`);
      } else if (action === 'draft') {
        const result = await shadow.draft(dir, id, { drafter: opts.drafter, hosts: io.hosts });
        io.stdout.write(`${result.draft}\n`);
      } else io.stdout.write(shadow.show(dir, id));
      return 0;
    } catch (error) {
      io.stderr.write(`${error.message}\n`);
      return 1;
    }
  },
};
