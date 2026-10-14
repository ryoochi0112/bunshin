'use strict';

const hosts = require('../lib/hosts');
const support = require('../lib/support');

const usage = 'Usage: node scripts/harness.js --host <claude|codex|fake:<file>>\n';

function entry(id, claim, select) {
  return { id, claim, select, status: 'verified' };
}

function makeCheck(kind, number, sentence, first, second, expected) {
  return {
    name: `${kind} pair ${number}`,
    sentence,
    entries: [first, second],
    expected,
  };
}

const checks = [
  makeCheck('flip', 1, 'Cloudberry Lantern provides 8 hours of light.',
    entry('demo.harness.p1a', 'Cloudberry Lantern provides 8 hours of light.', { runtime_hours: 8 }),
    entry('demo.harness.p1b', 'Cloudberry Lantern charges through a USB-C port.', { charging: 'USB-C' }),
    ['supported', 'not_supported']),
  makeCheck('flip', 2, 'Cloudberry Lantern weighs 420 grams.',
    entry('demo.harness.p2a', 'Cloudberry Lantern weighs 420 grams.', { weight_grams: 420 }),
    entry('demo.harness.p2b', 'Cloudberry Lantern has a folding carry handle.', { handle: 'folding' }),
    ['supported', 'not_supported']),
  makeCheck('flip', 3, 'Cloudberry Lantern charges through a USB-C port.',
    entry('demo.harness.p3a', 'Cloudberry Lantern charges through a USB-C port.', { charging: 'USB-C' }),
    entry('demo.harness.p3b', 'Cloudberry Lantern provides 8 hours of light.', { runtime_hours: 8 }),
    ['supported', 'not_supported']),
  makeCheck('flip', 4, 'Cloudberry Lantern produces 300 lumens of light.',
    entry('demo.harness.p4a', 'Cloudberry Lantern produces 300 lumens of light.', { brightness_lumens: 300 }),
    entry('demo.harness.p4b', 'Cloudberry Lantern weighs 420 grams.', { weight_grams: 420 }),
    ['supported', 'not_supported']),
  makeCheck('flip', 5, 'Cloudberry Lantern has a folding handle.',
    entry('demo.harness.p5a', 'Cloudberry Lantern has a folding handle.', { handle: 'folding' }),
    entry('demo.harness.p5b', 'Cloudberry Lantern produces 300 lumens of light.', { brightness_lumens: 300 }),
    ['supported', 'not_supported']),
  makeCheck('length', 1, 'Cloudberry Lantern provides 8 hours of light.',
    entry('demo.harness.p6a', 'Cloudberry Lantern provides 8 hours of light.', { runtime_hours: 8 }),
    entry('demo.harness.p6b', 'Cloudberry Lantern provides 8 hours of light. It has a rechargeable cell and a warm white beam.',
      { runtime_hours: 8, charging: 'rechargeable', color: 'warm white' }),
    ['supported', 'supported']),
  makeCheck('length', 2, 'Cloudberry Lantern weighs 420 grams.',
    entry('demo.harness.p7a', 'Cloudberry Lantern weighs 420 grams.', { weight_grams: 420 }),
    entry('demo.harness.p7b', 'Cloudberry Lantern weighs 420 grams. Its metal body has a folding handle and a frosted diffuser.',
      { weight_grams: 420, handle: 'folding', diffuser: 'frosted' }),
    ['supported', 'supported']),
  makeCheck('length', 3, 'Cloudberry Lantern charges through a USB-C port.',
    entry('demo.harness.p8a', 'Cloudberry Lantern charges through a USB-C port.', { charging: 'USB-C' }),
    entry('demo.harness.p8b', 'Cloudberry Lantern charges through a USB-C port. A full charge takes about three hours and the cable is sold separately.',
      { charging: 'USB-C', charge_time_hours: 3, cable_included: false }),
    ['supported', 'supported']),
  makeCheck('length', 4, 'Cloudberry Lantern produces 300 lumens of light.',
    entry('demo.harness.p9a', 'Cloudberry Lantern produces 300 lumens of light.', { brightness_lumens: 300 }),
    entry('demo.harness.p9b', 'Cloudberry Lantern produces 300 lumens of light. It also offers two lower brightness settings and a low-battery indicator.',
      { brightness_lumens: 300, brightness_settings: 3, low_battery_indicator: true }),
    ['supported', 'supported']),
  makeCheck('length', 5, 'Cloudberry Lantern has a folding handle.',
    entry('demo.harness.p10a', 'Cloudberry Lantern has a folding handle.', { handle: 'folding' }),
    entry('demo.harness.p10b', 'Cloudberry Lantern has a folding handle. Its base includes a rubber grip ring.',
      { handle: 'folding', base: 'rubber grip ring' }),
    ['supported', 'supported']),
];

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== '--host' || !argv[1] || argv[1].startsWith('--')) {
    throw new Error(usage);
  }
  return hosts.parseSpec(argv[1]);
}

async function judge(host, model, sentence, citedEntry) {
  const result = await support.judgeDraft({ host, model, draft: {},
    sentences: [{ text: sentence, ids: [citedEntry.id], exempt: false, problems: [] }],
    kbData: { entries: [citedEntry], flags: new Map() },
  });
  if (result.sentences.length !== 1) return null;
  return result.sentences[0].verdict;
}

async function main(argv, { io = process } = {}) {
  let spec;
  try { spec = parseArgs(argv); } catch {
    io.stderr.write(usage);
    return 2;
  }
  const host = hosts.get(spec.host);
  let passed = 0;
  let hostErrorLogged = false;
  for (const [index, check] of checks.entries()) {
    let ok = false;
    try {
      const actual = [];
      for (const citedEntry of check.entries) actual.push(await judge(host, spec.model, check.sentence, citedEntry));
      ok = actual.every((verdict, side) => verdict === check.expected[side]);
    } catch {
      if (!hostErrorLogged) {
        io.stderr.write('harness: host call failed; affected checks are marked FAIL\n');
        hostErrorLogged = true;
      }
    }
    if (ok) {
      passed += 1;
      io.stdout.write(`PASS ${index + 1} ${check.name}\n`);
    } else {
      io.stdout.write(`FAIL ${index + 1} ${check.name}\n`);
    }
  }
  io.stdout.write(`harness: ${passed}/${checks.length} passed\n`);
  return passed === checks.length ? 0 : 1;
}

module.exports = { main, parseArgs };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch(() => {
    process.stderr.write('harness: could not complete checks\n');
    process.exitCode = 1;
  });
}
