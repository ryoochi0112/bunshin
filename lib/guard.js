'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

class GuardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GuardError';
  }
}

function resolveRealPath(dir) {
  const missing = [];
  let current = path.resolve(dir);

  while (true) {
    try {
      return path.join(fs.realpathSync(current), ...missing);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new GuardError(`Cannot resolve persona path ${path.resolve(dir)}.`);
      }
      // A dangling symlink is not a missing directory that we can safely create.
      try {
        fs.lstatSync(current);
        throw new GuardError(`Cannot resolve persona path ${path.resolve(dir)}.`);
      } catch (entryError) {
        if (entryError.code !== 'ENOENT') throw entryError;
      }
      missing.unshift(path.basename(current));
      current = path.dirname(current);
    }
  }
}

function findRepo(dir) {
  let current = resolveRealPath(dir);

  while (true) {
    try {
      fs.lstatSync(path.join(current, '.git'));
      return current;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new GuardError(`Cannot inspect Git repository at ${current}.`);
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function listingEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
}

function gitEnvironment() {
  const env = {
    ...listingEnvironment(),
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/echo',
    GCM_INTERACTIVE: 'never',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o IdentityAgent=none -o IdentitiesOnly=yes -o IdentityFile=none',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  delete env.SSH_ASKPASS;
  delete env.SSH_AUTH_SOCK;
  return env;
}

function redactRemote(remoteUrl) {
  return remoteUrl.replace(/(\/\/)[^/?#]*@/g, '$1***@')
    .replace(/\?[^#]*/g, '?***').replace(/#.*/g, '#***');
}

function anonymousProbe(remoteUrl) {
  // Only HTTP(S) can establish anonymous access; other transports fail closed.
  if (typeof remoteUrl !== 'string' || !/^https?:\/\//i.test(remoteUrl)
    || /[\s\\]/.test(remoteUrl)) return 'unknown';
  let url;
  try {
    url = new URL(remoteUrl);
  } catch {
    return 'unknown';
  }
  if (!url.hostname) return 'unknown';
  if (url.username || url.password) {
    url.username = '';
    url.password = '';
    remoteUrl = url.href;
  }

  let result;
  try {
    result = childProcess.spawnSync('git', [
      '-c', 'credential.helper=', '-c', 'core.askPass=',
      'ls-remote', '--heads', '--', remoteUrl,
    ], {
      cwd: os.tmpdir(),
      env: { ...gitEnvironment(), GIT_CEILING_DIRECTORIES: path.dirname(fs.realpathSync(os.tmpdir())) },
      timeout: 5000,
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return 'unknown';
  }
  if (!result || result.error || result.signal || !Number.isInteger(result.status)
    || result.status < 0 || result.status > 255) return 'unknown';
  if (result.status === 0) return 'public';

  const authOrMissing = /^(?:fatal: )?(?:authentication failed(?: for .*)?|authorization failed(?: for .*)?|could not read (?:username|password)(?: for .*)?|repository(?: .+)? (?:not found|does not exist))\.?$/im;
  const httpStatus = /^fatal: unable to access .+: (?:the )?requested URL returned error: (?:401|403|404)\s*$/im;
  return authOrMissing.test(result.stderr || '') || httpStatus.test(result.stderr || '') ? 'private' : 'unknown';
}

function assertNoLegacyRemotes(repo) {
  let commonDir;
  try {
    const output = childProcess.execFileSync('git', ['-C', repo, 'rev-parse', '--git-common-dir'], {
      cwd: repo, env: listingEnvironment(),
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (typeof output !== 'string' || !/^[^\0\r\n]+\n$/.test(output)) throw new Error();
    commonDir = fs.realpathSync(path.resolve(repo, output.slice(0, -1)));
  } catch {
    throw new GuardError(`Cannot resolve common Git directory for Git repository ${repo}; refusing to write persona data.`);
  }

  // Git also reads legacy remote files, whose formats we cannot safely verify.
  for (const kind of ['remotes', 'branches']) {
    const dir = path.join(commonDir, kind);
    try {
      fs.lstatSync(dir);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw new GuardError(`Cannot inspect legacy ${kind} for Git repository ${repo}; refusing to write persona data.`);
    }
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      throw new GuardError(`Cannot inspect legacy ${kind} for Git repository ${repo}; refusing to write persona data.`);
    }
    if (entries.length) {
      throw new GuardError(`Legacy remote ${kind}/${entries[0]} in Git repository ${repo} is unverifiable; refusing to write persona data.`);
    }
  }
}

function rawRemoteUrls(repo) {
  let listing;
  try {
    // Preserve every configured URL, including unused fetch and push URLs.
    listing = childProcess.execFileSync('git', [
      '-C', repo, 'config', '--includes', '--null', '--get-regexp', '^remote\\..*\\.(url|pushurl)$',
    ], {
      cwd: repo, env: listingEnvironment(),
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    // git config exits 1 with no output when there are no matching entries.
    if (error.status === 1 && !error.code && !error.signal && error.stdout?.length === 0
      && error.stderr?.length === 0) return [];
    throw new GuardError(`Cannot list remotes for Git repository ${repo}; refusing to write persona data.`);
  }

  if (typeof listing !== 'string' || !listing.endsWith('\0')) {
    throw new GuardError(`Cannot read remotes for Git repository ${repo}; refusing to write persona data.`);
  }
  const urls = [];
  for (const entry of listing.slice(0, -1).split('\0')) {
    const match = /^remote\..+\.(?:url|pushurl)\n([^\r\n]+)$/.exec(entry);
    if (!match) {
      throw new GuardError(`Cannot read remotes for Git repository ${repo}; refusing to write persona data.`);
    }
    urls.push(match[1]);
  }
  return urls;
}

function gitLines(repo, args, allowEmpty = false) {
  let output;
  try {
    output = childProcess.execFileSync('git', ['-C', repo, ...args], {
      cwd: repo, env: listingEnvironment(),
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new GuardError(`Cannot list remotes for Git repository ${repo}; refusing to write persona data.`);
  }
  if (allowEmpty && output === '') return [];
  if (typeof output !== 'string' || !/^(?:[^\0\r\n]+\n)+$/.test(output)) {
    throw new GuardError(`Cannot read remotes for Git repository ${repo}; refusing to write persona data.`);
  }
  return output.slice(0, -1).split('\n');
}

function assertSafePersonaPath(dir, { probe = anonymousProbe, synthetic = false } = {}) {
  const repo = findRepo(dir);
  if (!repo || synthetic === true) return;

  assertNoLegacyRemotes(repo);
  const remotes = new Set(rawRemoteUrls(repo));
  // Ask Git for effective URLs so includes, all scopes and URL rewrites agree.
  for (const name of gitLines(repo, ['remote'], true)) {
    for (const url of gitLines(repo, ['remote', 'get-url', '--all', '--', name])) remotes.add(url);
    for (const url of gitLines(repo, ['remote', 'get-url', '--push', '--all', '--', name])) remotes.add(url);
  }

  let refusal;
  for (const remote of remotes) {
    let verdict;
    try {
      verdict = probe(remote);
    } catch {
      verdict = 'unknown';
    }
    if (verdict !== 'private' && !refusal) {
      refusal = new GuardError(`Remote ${redactRemote(remote)} in Git repository ${repo} is ${verdict === 'public' ? 'public' : 'unverifiable'}; refusing to write persona data.`);
    }
  }
  if (refusal) throw refusal;
}

module.exports = { GuardError, assertSafePersonaPath, resolveRealPath, anonymousProbe };
