'use strict';

const crypto = require('node:crypto');
const store = require('../store');
const twin = require('../twin');
const judge = require('../judge');
const calibrate = require('../calibrate');
const examples = require('../examples');
const defaultHosts = require('../hosts');

const usage = 'Usage: bunshin examples sample [--n <n>] [--drafter <spec>] [--persona <dir>]\n'
  + '       bunshin examples next|status [--persona <dir>]\n'
  + '       bunshin examples rate <pair_id> <rating> [--persona <dir>]\n';

function parseOptions(args, allowed) {
  const opts = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]; const value = args[i + 1];
    if (!allowed.includes(key) || Object.hasOwn(opts, key) || !value || value.startsWith('--')) throw new Error('examples: invalid options');
    opts[key] = value;
  }
  return opts;
}

function counts(rows) {
  const k = rows.filter((row) => row.layer === 'knowledge').length;
  return { k, j: rows.length - k };
}

async function sample(dir, opts, adapters) {
  const raw = opts['--n'] ?? String(examples.DEFAULT_N);
  if (!/^[1-9][0-9]*$(?![\s\S])/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error('examples: n must be a positive integer');
  let state = examples.readSet(dir);
  const existed = state !== null;
  let set = state?.set;
  if (!existed) {
    set = {
      format_version: 1, seed: crypto.randomBytes(8).toString('hex'), n: Number(raw),
      drafter: (({ host, model }) => ({ host, model: model ?? null }))(adapters.parseSpec(opts['--drafter'] ?? 'claude')),
      created_at: new Date().toISOString(),
    };
  }
  // Selection and prompts are resolved before any write, so a failure leaves no set.
  const chosen = examples.selectSet(dir, { seed: set.seed, n: set.n });
  const have = new Set((state?.examples ?? []).map((row) => row.position));
  const pending = chosen.map((pair, index) => ({ pair, position: index + 1 })).filter(({ position }) => !have.has(position));
  const systems = new Map();
  for (const { pair } of pending) {
    const skill = twin.skillForLayer(pair.layer);
    if (!systems.has(skill)) systems.set(skill, twin.composePrompt(dir, skill));
  }
  const allowedTools = adapters.allowedTools(store.readJson(dir, 'persona.json'));
  const host = pending.length ? adapters.get(set.drafter.host) : null;
  if (!existed) store.writeJson(dir, `${examples.DIR}/set.json`, set);
  for (const { pair, position } of pending) {
    let reply;
    try {
      reply = await host.run({
        system: systems.get(twin.skillForLayer(pair.layer)), prompt: judge.questionPrompt({ question: pair.question, context: pair.context }),
        tools: 'notion-read', allowedTools, model: set.drafter.model ?? undefined,
      });
    } catch {
      throw new Error(`examples: host error on pair ${pair.id} (${set.drafter.host}); rerun examples sample to resume`);
    }
    store.appendJsonl(dir, `${examples.DIR}/examples.jsonl`, {
      pair_id: pair.id, position, layer: pair.layer, question: pair.question, context: pair.context,
      reference_answer: pair.answer.text, draft: reply.text, drafter: { host: set.drafter.host, model: reply.model },
      drafted_at: new Date().toISOString(),
    });
  }
  state = examples.readSet(dir);
  const rows = state.examples;
  let output = '';
  if (rows.length === set.n) {
    const placeholder = rows.map((row) => ({ ...row, rating: 'send_as_is' }));
    if (judge.examplesBlock(placeholder).length > judge.MAX_BLOCK_CHARS) {
      const longest = [...rows].sort((a, b) => judge.examplesBlock([{ ...b, rating: 'send_as_is' }]).length
        - judge.examplesBlock([{ ...a, rating: 'send_as_is' }]).length).slice(0, 3).map((row) => row.pair_id);
      throw new Error(`examples: rendered examples exceed ${judge.MAX_BLOCK_CHARS} chars; longest: ${longest.join(', ')}`);
    }
  }
  const { k, j } = counts(rows);
  output += `examples: drafted ${rows.length} of ${set.n} (knowledge ${k}, judgment ${j}); skipped ${examples.eligible(dir).skipped} oversized pairs\n`;
  if (existed && !pending.length) output += `examples: set exists (${rows.length} drafted, ${state.status.rated} rated)\n`;
  return output;
}

async function run(argv, io) {
  const adapters = io.hosts ?? defaultHosts;
  const [sub, ...rest] = argv;
  if (!['sample', 'next', 'status', 'rate'].includes(sub)) { io.stderr.write(usage); return 2; }
  if (sub === 'rate' && (rest.length < 2 || rest[0].startsWith('--') || rest[1].startsWith('--'))) { io.stderr.write(usage); return 2; }
  try {
    const pairId = sub === 'rate' ? rest.shift() : undefined;
    const rating = sub === 'rate' ? rest.shift() : undefined;
    const opts = parseOptions(rest, ['--persona', ...(sub === 'sample' ? ['--n', '--drafter'] : [])]);
    const dir = store.resolvePersona({ persona: opts['--persona'], env: io.env || process.env });
    if (sub === 'sample') {
      io.stdout.write(await sample(dir, opts, { parseSpec: defaultHosts.parseSpec, allowedTools: defaultHosts.allowedTools, get: adapters.get.bind(adapters) }));
      return 0;
    }
    const state = examples.readSet(dir);
    if (sub === 'status') {
      if (!state) { io.stdout.write('examples: no set\n'); return 0; }
      const { n, drafted, rated, labels } = state.status;
      io.stdout.write(`examples: ${drafted}/${n} drafted · ${rated}/${n} rated (send_as_is ${labels.send_as_is} · needs_edits ${labels.needs_edits} · wrong ${labels.wrong})\n`);
      return 0;
    }
    if (!state) throw new Error('examples: no set — run examples sample');
    const { n, unrated } = state.status;
    if (sub === 'next') {
      const item = state.examples.find((row) => unrated.includes(row.pair_id));
      if (!item) io.stdout.write(`examples: all ${n} items rated — run eval run\n`);
      else io.stdout.write(`item ${item.position}/${n} — ${item.pair_id} (${item.layer})\n\n## Question\n${item.question.text}\n\n## Twin draft\n${item.draft}\n\n## Reference answer\n${item.reference_answer}\n`);
      return 0;
    }
    if (!calibrate.idPattern.test(pairId)) throw new Error('examples: invalid pair id');
    if (!state.examples.some((row) => row.pair_id === pairId)) throw new Error(`examples: ${pairId} is not in the example set`);
    if (!calibrate.validRatings.includes(rating)) throw new Error('examples: invalid rating');
    store.appendJsonl(dir, `${examples.DIR}/ratings.jsonl`, { pair_id: pairId, rating, rated_at: new Date().toISOString() });
    io.stdout.write(`examples: rated ${pairId} (${examples.readSet(dir).status.rated}/${n})\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`${error.message}\n`);
    return 1;
  }
}

module.exports = { name: 'examples', summary: 'Draft and rate judge examples from build pairs', run };
