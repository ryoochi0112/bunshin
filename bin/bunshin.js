#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const commandsDirectory = path.join(__dirname, '..', 'lib', 'commands');

function loadCommands() {
  return fs.readdirSync(commandsDirectory)
    .filter((file) => file.endsWith('.js'))
    .sort()
    .map((file) => require(path.join(commandsDirectory, file)));
}

function helpText(commands) {
  const lines = [
    'Usage: bunshin <command> [args]',
    '',
    'Commands:',
  ];

  for (const command of commands) {
    lines.push(`  ${command.name.padEnd(10)} ${command.summary}`);
  }

  return `${lines.join('\n')}\n`;
}

async function main(argv, io) {
  const commands = loadCommands();
  const [name, ...args] = argv;

  if (!name || name === '--help' || name === '-h') {
    io.stdout.write(helpText(commands));
    return 0;
  }

  const command = commands.find((candidate) => candidate.name === name);
  if (!command) {
    io.stderr.write(`Unknown command: ${name}\nRun "bunshin --help" to see available commands.\n`);
    return 2;
  }

  return command.run(args, io);
}

if (require.main === module) {
  main(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = { main };
