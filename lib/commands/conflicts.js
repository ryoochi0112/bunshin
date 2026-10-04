'use strict';

const conflicts = require('../conflicts');
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

function evidenceFor(personaDir, conflict) {
  const answers = store.readJsonl(personaDir, 'interview.jsonl');
  const interview = answers.find((answer) => answer.id === conflict.interview_ref);
  if (!interview) throw new Error(`Conflict ${conflict.id} references an unknown interview answer.`);
  const assignments = store.readJson(personaDir, 'split.json').assignments;
  if (!assignments || typeof assignments !== 'object' || Array.isArray(assignments)) throw new Error('Invalid split.json.');
  const pairs = store.readJsonl(personaDir, 'pairs.jsonl');
  const behaviour = conflict.behaviour_refs.map((id) => {
    const pair = pairs.find((entry) => entry.id === id);
    if (!pair) throw new Error(`Conflict ${conflict.id} references an unknown behaviour pair.`);
    if (assignments[id] !== 'build') throw new Error(`Conflict ${conflict.id} references a pair outside the build set.`);
    if (!pair.answer || typeof pair.answer.text !== 'string' || typeof pair.permalink !== 'string') {
      throw new Error(`Invalid behaviour pair ${id}.`);
    }
    return { id, permalink: pair.permalink, answer: pair.answer.text };
  });
  return {
    ...conflict,
    interview: { id: interview.id, question: interview.question, answer: interview.answer },
    behaviour,
  };
}

function renderEvidence(record) {
  const lines = [
    `${record.id} [${record.status}]`,
    `Claim: ${record.claim}`,
    `Interview ${record.interview.id}`,
    `  Q: ${record.interview.question}`,
    `  A: ${record.interview.answer}`,
  ];
  for (const pair of record.behaviour) {
    lines.push(`Behaviour ${pair.id}`, `  Permalink: ${pair.permalink}`, `  A: ${pair.answer}`);
  }
  return lines.join('\n');
}

module.exports = {
  name: 'conflicts',
  summary: 'Record and resolve interview conflicts',
  run(argv, io) {
    let parsed;
    try { parsed = parsePersona(argv); } catch {
      io.stderr.write('Usage: bunshin conflicts add|list|resolve [options] [--persona <dir>]\n');
      return 2;
    }
    const [action, ...args] = parsed.args;
    let values;
    let openOnly = false;
    let json = false;
    if (action === 'add') {
      try { values = parseFlags(args, ['--claim', '--interview-ref', '--behaviour-refs']); } catch {
        io.stderr.write('Usage: bunshin conflicts add --claim <c> --interview-ref <iv-id> --behaviour-refs <id,id> [--persona <dir>]\n');
        return 2;
      }
      if (Object.keys(values).length !== 3) {
        io.stderr.write('Usage: bunshin conflicts add --claim <c> --interview-ref <iv-id> --behaviour-refs <id,id> [--persona <dir>]\n');
        return 2;
      }
    } else if (action === 'list') {
      for (const arg of args) {
        if (arg === '--open' && !openOnly) openOnly = true;
        else if (arg === '--json' && !json) json = true;
        else {
          io.stderr.write('Usage: bunshin conflicts list [--open] [--json] [--persona <dir>]\n');
          return 2;
        }
      }
    } else if (action === 'resolve') {
      const [id, ...flags] = args;
      try { values = parseFlags(flags, ['--as', '--note']); } catch {
        io.stderr.write('Usage: bunshin conflicts resolve <cf-id> --as behaviour|self_report|context [--note <n>] [--persona <dir>]\n');
        return 2;
      }
      if (!id || Object.keys(values).length < 1 || Object.keys(values).length > 2
        || !['behaviour', 'self_report', 'context'].includes(values['--as'])) {
        io.stderr.write('Usage: bunshin conflicts resolve <cf-id> --as behaviour|self_report|context [--note <n>] [--persona <dir>]\n');
        return 2;
      }
      values.id = id;
    } else {
      io.stderr.write('Usage: bunshin conflicts add|list|resolve [options] [--persona <dir>]\n');
      return 2;
    }

    try {
      const dir = store.resolvePersona({ persona: parsed.persona, env: io.env || process.env });
      const options = { probe: io.probe };
      if (action === 'add') {
        const added = conflicts.addConflict(dir, {
          claim: values['--claim'],
          interviewRef: values['--interview-ref'],
          behaviourRefs: values['--behaviour-refs'].split(','),
        }, options);
        io.stdout.write(`${JSON.stringify(added)}\n`);
      } else if (action === 'resolve') {
        const resolved = conflicts.resolveConflict(dir, values.id, values['--as'], values['--note'], options);
        io.stdout.write(`${JSON.stringify(resolved)}\n`);
      } else {
        const selected = conflicts.listConflicts(dir).filter((conflict) => !openOnly || conflict.status === 'open');
        const enriched = selected.map((conflict) => evidenceFor(dir, conflict));
        if (json) {
          if (enriched.length) io.stdout.write(`${enriched.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
        } else if (enriched.length) {
          io.stdout.write(`${enriched.map(renderEvidence).join('\n\n')}\n`);
        }
      }
      return 0;
    } catch (error) {
      io.stderr.write(`${error.message}\n`);
      return 1;
    }
  },
};
