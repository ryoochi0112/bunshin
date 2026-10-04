'use strict';

const packageJson = require('../../package.json');

module.exports = {
  name: 'version',
  summary: 'Print the Bunshin version',
  run(_argv, io) {
    io.stdout.write(`${packageJson.version}\n`);
    return 0;
  },
};
