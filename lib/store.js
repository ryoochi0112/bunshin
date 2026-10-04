'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const guard = require('./guard');

const guardCache = new Map();

function personaHome(env = process.env) {
  return path.resolve(env.BUNSHIN_HOME || path.join(os.homedir(), 'bunshin-personas'));
}

function resolvePersona({ persona, env = process.env } = {}) {
  if (persona || env.BUNSHIN_PERSONA) return path.resolve(persona || env.BUNSHIN_PERSONA);

  const home = personaHome(env);
  let directories;
  try {
    directories = fs.readdirSync(home, { withFileTypes: true })
      .filter((entry) => entry.isDirectory());
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    directories = [];
  }
  if (directories.length !== 1) {
    throw new Error(`Expected one persona directory in ${home}; found ${directories.length}. Use --persona <dir> or run "bunshin init <name>".`);
  }
  return path.join(home, directories[0].name);
}

function filePath(personaDir, relPath) {
  if (typeof relPath !== 'string' || !relPath || path.isAbsolute(relPath)
    || relPath.split(/[\\/]/).includes('..')) {
    throw new Error('Persona file path must be relative and stay inside the persona directory.');
  }
  const root = guard.resolveRealPath(personaDir);
  const target = guard.resolveRealPath(path.resolve(root, relPath));
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) {
    throw new Error('Persona file path must stay inside the persona directory.');
  }
  return { root, target };
}

function readJson(personaDir, relPath) {
  const { target } = filePath(personaDir, relPath);
  const text = fs.readFileSync(target, 'utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON in ${target}.`);
  }
}

function readJsonl(personaDir, relPath) {
  const { target } = filePath(personaDir, relPath);
  let text;
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return text.split('\n').flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line)];
    } catch {
      throw new Error(`Invalid JSONL in ${target} at line ${index + 1}.`);
    }
  });
}

function assertWritable(root, options) {
  if (guardCache.has(root)) {
    const error = guardCache.get(root);
    if (error) throw error;
    return;
  }
  let synthetic = options.synthetic === true;
  try {
    synthetic = readJson(root, 'persona.json').synthetic === true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    guard.assertSafePersonaPath(root, { probe: options.probe, synthetic });
    guardCache.set(root, null);
  } catch (error) {
    guardCache.set(root, error);
    throw error;
  }
}

// Writers accept an optional { probe, synthetic } for offline tests and sample initialization.
function writeAtomic(personaDir, relPath, text, options = {}) {
  const { root, target } = filePath(personaDir, relPath);
  assertWritable(root, options);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temporary, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, target);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function writeJson(personaDir, relPath, value, options) {
  writeAtomic(personaDir, relPath, `${JSON.stringify(value, null, 2)}\n`, options);
}

function writeJsonl(personaDir, relPath, values, options) {
  const lines = values.map((value) => JSON.stringify(value));
  writeAtomic(personaDir, relPath, lines.length ? `${lines.join('\n')}\n` : '', options);
}

function appendJsonl(personaDir, relPath, value, options) {
  writeJsonl(personaDir, relPath, [...readJsonl(personaDir, relPath), value], options);
}

function _resetGuardCache() {
  guardCache.clear();
}

module.exports = {
  personaHome, resolvePersona, readJson, writeJson, readJsonl, appendJsonl, writeJsonl,
  _resetGuardCache,
};
