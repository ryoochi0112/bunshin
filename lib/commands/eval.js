'use strict';

const store = require('../store');
const evalRun = require('../eval-run');

const usage = 'Usage: bunshin eval run [--drafter <spec>] [--judge <spec>] [--limit <n>] [--run <run_id>] [--persona <dir>]\n';

async function runEval(argv, io) {
  const opts = {};
  const keys = { '--drafter': 'drafter', '--judge': 'judge', '--limit': 'limit', '--run': 'runId', '--persona': 'persona' };
  for (let index = 0; index < argv.length; index += 2) {
    const key = keys[argv[index]];
    const value = argv[index + 1];
    if (!key || Object.hasOwn(opts, key) || !value || value.startsWith('--')
      || (key === 'limit' && (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))))) {
      io.stderr.write(usage);
      return 2;
    }
    opts[key] = key === 'limit' ? Number(value) : value;
  }
  try {
    const dir = store.resolvePersona({ persona: opts.persona, env: io.env || process.env });
    const result = await evalRun.run(dir, opts);
    io.stdout.write(`run ${result.run_id}: drafted ${result.drafted}, judged ${result.judged}, judge errors ${result.errors}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`${error.message}\n`);
    return 1;
  }
}

module.exports = {
  name: 'eval', summary: 'Run held-out drafts and judgments',
  async run(argv, io) {
    if (argv[0] === 'run') return runEval(argv.slice(1), io);
    io.stderr.write(usage);
    return 2;
  },
};
