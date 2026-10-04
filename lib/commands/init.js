'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const store = require('../store');

module.exports = {
  name: 'init',
  summary: 'Create a persona directory',
  run(argv, io) {
    const [name] = argv;
    if (argv.length !== 1 || !/^[a-z0-9-]+$/.test(name || '')) {
      io.stderr.write('Usage: bunshin init <name> (lowercase letters, digits and hyphens only)\n');
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
      io.stdout.write(`Created persona ${name} at ${dir}\n`);
      return 0;
    } catch (error) {
      io.stderr.write(`${error.message}\n`);
      return 1;
    }
  },
};
