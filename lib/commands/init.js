'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const identity = require('../identity');
const store = require('../store');

function copySample(dir, name, probe) {
  const source = path.join(__dirname, '..', '..', 'sample', 'persona');
  const manifest = store.readJson(source, 'persona.json');
  if (manifest.synthetic !== true) throw new Error('Sample persona must be synthetic.');
  const identityObj = { ...store.readJson(source, 'identity.json'), persona: name };
  const json = [
    ['persona.json', { ...manifest, name }],
    ['split.json', store.readJson(source, 'split.json')],
    ['identity.json', identityObj],
  ];
  const jsonl = ['pairs.jsonl', 'cases.jsonl', 'interview.jsonl', 'conflicts.jsonl']
    .map((file) => [file, store.readJsonl(source, file)]);
  const markdown = identity.render({ ...identityObj, display_name: manifest.display_name });
  const home = path.dirname(dir);
  // Keep interrupted staging directories outside the home that resolvePersona lists.
  const stage = path.join(path.dirname(home), `.${path.basename(home)}-${name}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  const options = { probe, synthetic: true };
  try {
    for (const [file, value] of json) store.writeJson(stage, file, value, options);
    for (const [file, values] of jsonl) store.writeJsonl(stage, file, values, options);
    store.writeText(stage, 'identity.md', markdown, options);
    // Publish all eight files together, so interrupted copies never look complete.
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.renameSync(stage, dir);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

module.exports = {
  name: 'init',
  summary: 'Create a persona directory',
  run(argv, io) {
    const sample = argv[0] === '--sample';
    const name = sample ? (argv.length === 1 ? 'sample' : argv[2]) : argv[0];
    const validArgs = sample
      ? argv.length === 1 || (argv.length === 3 && argv[1] === '--name')
      : argv.length === 1;
    // A leading letter or digit keeps flags such as --help from becoming directory names.
    if (!validArgs || !/^[a-z0-9][a-z0-9-]*$/.test(name || '')) {
      io.stderr.write('Usage: bunshin init <name> | --sample [--name <name>] (lowercase letters, digits and hyphens; must start with a letter or digit)\n');
      return 2;
    }

    // io.env selects a temporary home; io.probe injects an offline remote probe in tests.
    const dir = path.join(store.personaHome(io.env || process.env), name);
    try {
      try {
        if (fs.readdirSync(dir).length) {
          throw new Error(`Persona directory ${dir} is not empty.`);
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }

      if (sample) {
        copySample(dir, name, io.probe);
      } else {
        const options = { probe: io.probe, synthetic: false };
        store.writeJson(dir, 'persona.json', {
          format_version: 1,
          name,
          display_name: name,
          synthetic: false,
          owner: { slack_user_id: null },
          version: 0,
          launch_bar: { send_as_is: 0.5, min_heldout: 30, min_per_layer: 10, min_agreement: 0.8 },
          hosts: { claude: { allowed_tools: [] } },
        }, options);
        store.writeJson(dir, 'split.json', {
          format_version: 1,
          salt: crypto.randomBytes(8).toString('hex'),
          heldout_ratio: 0.3,
          assignments: {},
        }, options);
      }
      io.stdout.write(`Created persona ${name} at ${dir}\n`);
      return 0;
    } catch (error) {
      io.stderr.write(`${error.message}\n`);
      return 1;
    }
  },
};
