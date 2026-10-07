'use strict';

const crypto = require('node:crypto');
const store = require('../store');
const twin = require('../twin');
const judge = require('../judge');
const calibrate = require('../calibrate');
const examples = require('../examples');
const pairs = require('../pairs');
const defaultHosts = require('../hosts');

const usage = 'Usage: bunshin examples sample [--n <n>] [--drafter <spec>] [--persona <dir>]\n'
  + '       bunshin examples next|status|balance [--persona <dir>]\n'
  + '       bunshin examples rate <pair_id> <rating> [--reason <text> | --no-reason] [--persona <dir>]\n';

function parseOptions(args, allowed) {
  const opts = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]; const value = args[i + 1];
    if (!allowed.includes(key) || Object.hasOwn(opts, key) || !value || value.startsWith('--')) throw new Error('examples: invalid options');
    opts[key] = value;
  }
  return opts;
}

// Pulled out before parseOptions, which rejects empty and `--`-prefixed values.
function extractReason(args) {
  const rest = [];
  let reason; let none = false; let bad = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--reason') {
      if (reason !== undefined || i + 1 >= args.length) bad = true;
      else reason = args[++i];
    } else if (args[i] === '--no-reason') {
      if (none) bad = true;
      none = true;
    } else rest.push(args[i]);
  }
  return { rest, reason, none, bad };
}

function counts(rows) {
  const k = rows.filter((row) => row.layer === 'knowledge').length;
  return { k, j: rows.length - k };
}

// One drafter call, shared by `sample` and `next`; callers own the error wording and the write.
function draftOne(host, drafter, { system, pair, allowedTools }) {
  return host.run({
    system, prompt: judge.questionPrompt({ question: pair.question, context: pair.context }),
    tools: 'notion-read', allowedTools, model: drafter.model ?? undefined,
  });
}

function exampleRow(pair, position, drafter, reply) {
  return {
    pair_id: pair.id, position, layer: pair.layer, question: pair.question, context: pair.context,
    reference_answer: pair.answer.text, draft: reply.text, drafter: { host: drafter.host, model: reply.model },
    drafted_at: new Date().toISOString(),
  };
}

function renderItem(row, n) {
  const head = n === undefined ? `item ${row.position} — ${row.pair_id} (${row.layer})` : `item ${row.position}/${n} — ${row.pair_id} (${row.layer})`;
  return `${head}\n\n## Question\n${row.question.text}\n\n## Twin draft\n${row.draft}\n\n## Reference answer\n${row.reference_answer}\n`;
}

async function sample(dir, opts, adapters) {
  const raw = opts['--n'] ?? String(examples.DEFAULT_N);
  if (!/^[1-9][0-9]*$(?![\s\S])/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error('examples: n must be a positive integer');
  let state = examples.readSet(dir);
  const existed = state !== null;
  let set = state?.set;
  const have = new Set((state?.examples ?? []).map((row) => row.position));
  let pending;
  if (existed) {
    // The pinned ids are never re-selected: a grown build pool must not shift a half-drafted set.
    const build = new Map(pairs.listPairs(dir, { set: 'build' }).map((pair) => [pair.id, pair]));
    pending = set.pair_ids.map((id, index) => ({ id, position: index + 1 })).filter(({ position }) => !have.has(position))
      .map(({ id, position }) => {
        if (!build.has(id)) throw new Error(`examples: pair ${id} is not in the build split`);
        return { pair: build.get(id), position };
      });
  } else {
    const seed = crypto.randomBytes(8).toString('hex');
    const chosen = examples.selectSet(dir, { seed, n: Number(raw) });
    set = {
      format_version: 1, seed, n: Number(raw), pair_ids: chosen.map((pair) => pair.id),
      drafter: (({ host, model }) => ({ host, model: model ?? null }))(adapters.parseSpec(opts['--drafter'] ?? 'claude')),
      created_at: new Date().toISOString(),
    };
    pending = chosen.map((pair, index) => ({ pair, position: index + 1 }));
  }
  // Selection and prompts are resolved before any write, so a failure leaves no set.
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
      reply = await draftOne(host, set.drafter, { system: systems.get(twin.skillForLayer(pair.layer)), pair, allowedTools });
    } catch {
      throw new Error(`examples: host error on pair ${pair.id} (${set.drafter.host}); rerun examples sample to resume`);
    }
    store.appendJsonl(dir, `${examples.DIR}/examples.jsonl`, exampleRow(pair, position, set.drafter, reply));
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

async function draftExtra(dir, state, serve, adapters) {
  const { set } = state;
  const { pair, position } = serve;
  const system = twin.composePrompt(dir, twin.skillForLayer(pair.layer));
  const allowedTools = defaultHosts.allowedTools(store.readJson(dir, 'persona.json'));
  let reply;
  try {
    reply = await draftOne(adapters.get(set.drafter.host), set.drafter, { system, pair, allowedTools });
  } catch {
    throw new Error(`examples: host error on pair ${pair.id} (${set.drafter.host}); rerun examples next to resume`);
  }
  const row = exampleRow(pair, position, set.drafter, reply);
  store.appendJsonl(dir, `${examples.DIR}/extras.jsonl`, row);
  return row;
}

async function run(argv, io) {
  const adapters = io.hosts ?? defaultHosts;
  const [sub, ...rest] = argv;
  if (!['sample', 'next', 'status', 'rate', 'balance'].includes(sub)) { io.stderr.write(usage); return 2; }
  if (sub === 'rate' && (rest.length < 2 || rest[0].startsWith('--') || rest[1].startsWith('--'))) { io.stderr.write(usage); return 2; }
  const flags = extractReason(rest);
  if (flags.bad || (flags.none && flags.reason !== undefined) || (sub !== 'rate' && (flags.none || flags.reason !== undefined))) {
    io.stderr.write(usage); return 2;
  }
  rest.splice(0, rest.length, ...flags.rest);
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
      if (state.balance) { io.stdout.write(`${examples.statusLine(state)}\n`); return 0; }
      const { n, drafted, rated, labels } = state.status;
      io.stdout.write(`examples: ${drafted}/${n} drafted · ${rated}/${n} rated (send_as_is ${labels.send_as_is} · needs_edits ${labels.needs_edits} · wrong ${labels.wrong})\n`);
      return 0;
    }
    if (!state) throw new Error('examples: no set — run examples sample');
    const { n, unrated, needsReason } = state.status;
    if (sub === 'balance') {
      if (state.status.drafted < n || unrated.length) throw new Error('examples: rate all items before balance');
      if (!state.balance) {
        store.writeJson(dir, `${examples.DIR}/balance.json`, {
          format_version: 1, seed: crypto.randomBytes(8).toString('hex'), started_at: new Date().toISOString(),
        });
      }
      io.stdout.write(`${examples.statusLine(examples.readSet(dir))}\n`);
      return 0;
    }
    if (sub === 'next') {
      const item = state.examples.find((row) => unrated.includes(row.pair_id))
        ?? state.examples.find((row) => needsReason.includes(row.pair_id));
      if (item) { io.stdout.write(renderItem(item, n)); return 0; }
      const serve = state.balance?.serve;
      if (serve?.kind === 'extra') io.stdout.write(renderItem(serve.row));
      else if (serve?.kind === 'topup') io.stdout.write(renderItem(serve.row, n));
      else if (serve?.kind === 'draft') io.stdout.write(renderItem(await draftExtra(dir, state, serve, adapters)));
      else if (state.balance?.phase === 'done') io.stdout.write(`${examples.statusLine(state)}\n`);
      else io.stdout.write(`examples: all ${n} items rated — run eval run\n`);
      return 0;
    }
    if (!calibrate.idPattern.test(pairId)) throw new Error('examples: invalid pair id');
    if (![...state.examples, ...state.extras].some((row) => row.pair_id === pairId)) throw new Error(`examples: ${pairId} is not in the example set`);
    if (!calibrate.validRatings.includes(rating)) throw new Error('examples: invalid rating');
    if (flags.reason !== undefined && !examples.validReason(flags.reason)) throw new Error('examples: invalid reason');
    const row = { pair_id: pairId, rating };
    if (flags.none) row.reason = null;
    else if (flags.reason !== undefined) row.reason = flags.reason;
    store.appendJsonl(dir, `${examples.DIR}/ratings.jsonl`, { ...row, rated_at: new Date().toISOString() });
    io.stdout.write(`examples: rated ${pairId} (${examples.readSet(dir).status.rated}/${n})\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`${error.message}\n`);
    return 1;
  }
}

module.exports = { name: 'examples', summary: 'Draft and rate judge examples from build pairs', run };
