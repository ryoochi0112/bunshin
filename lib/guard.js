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
  const result = { urls: [], targets: [], pushRewrites: new Map() };
  let listing;
  try {
    // Preserve every target, including unused URLs and branch/push defaults.
    listing = childProcess.execFileSync('git', [
      '-C', repo, 'config', '--includes', '--null', '--get-regexp',
      '^remote\\..*\\.(url|pushurl)$|^branch\\..*\\.(remote|pushremote)$|^remote\\.pushdefault$|^url\\..*\\.pushinsteadof$',
    ], {
      cwd: repo, env: listingEnvironment(),
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    // git config exits 1 with no output when there are no matching entries.
    if (error.status === 1 && !error.code && !error.signal && error.stdout?.length === 0
      && error.stderr?.length === 0) return result;
    throw new GuardError(`Cannot list remotes for Git repository ${repo}; refusing to write persona data.`);
  }

  if (typeof listing !== 'string' || !listing.endsWith('\0')) {
    throw new GuardError(`Cannot read remotes for Git repository ${repo}; refusing to write persona data.`);
  }
  for (const entry of listing.slice(0, -1).split('\0')) {
    const separator = entry.indexOf('\n');
    const key = entry.slice(0, separator);
    if (separator < 0 || !/^(?:remote\..+\.(?:url|pushurl)|branch\..+\.(?:remote|pushremote)|remote\.pushdefault|url\..+\.pushinsteadof)$/.test(key)) {
      throw new GuardError(`Cannot read remotes for Git repository ${repo}; refusing to write persona data.`);
    }
    const value = entry.slice(separator + 1);
    if (/[\r\n]/.test(value)) throw targetRefusal(repo, key, '<unparseable>');
    const rewrite = /^url\.(.+)\.pushinsteadof$/.exec(key);
    if (rewrite) {
      // Git groups rewrites by base, preserving the first base's order on ties.
      const base = rewrite[1];
      if (!result.pushRewrites.has(base)) result.pushRewrites.set(base, []);
      result.pushRewrites.get(base).push(value);
    } else if (!value) {
      throw targetRefusal(repo, key, '<unparseable>');
    } else if (/^remote\..+\.(?:url|pushurl)$/.test(key)) {
      result.urls.push(value);
    } else {
      result.targets.push({ key, value });
    }
  }
  return result;
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

function targetRefusal(repo, key, target, verdict) {
  return new GuardError(`Target ${redactRemote(target)} from config key ${redactRemote(key)} in Git repository ${repo} is ${verdict === 'public' ? 'public' : 'unverifiable'}; refusing to write persona data.`);
}

function resolvedTarget(repo, key, target) {
  try {
    const urls = gitLines(repo, ['ls-remote', '--get-url', '--', target]);
    if (urls.length !== 1) throw new Error();
    return urls[0];
  } catch {
    throw targetRefusal(repo, key, target);
  }
}

function pushTarget(target, rewrites) {
  let longest;
  for (const [base, prefixes] of rewrites) {
    for (const prefix of prefixes) {
      const length = Buffer.byteLength(prefix);
      if (target.startsWith(prefix) && (!longest || length > longest.length)) {
        longest = { base, prefix, length };
      }
    }
  }
  return longest ? longest.base + target.slice(longest.prefix.length) : null;
}

function isHttpTarget(target) {
  if (!/^https?:\/\//i.test(target) || /[\s\\]/.test(target)) return false;
  try {
    return Boolean(new URL(target).hostname);
  } catch {
    return false;
  }
}

function assertSafePersonaPath(dir, { probe = anonymousProbe, synthetic = false } = {}) {
  const repo = findRepo(dir);
  if (!repo || synthetic === true) return;

  assertNoLegacyRemotes(repo);
  const raw = rawRemoteUrls(repo);
  const remotes = new Set(raw.urls);
  const names = new Set(gitLines(repo, ['remote'], true));
  // Ask Git for effective URLs so includes, all scopes and URL rewrites agree.
  for (const name of names) {
    for (const url of gitLines(repo, ['remote', 'get-url', '--all', '--', name])) remotes.add(url);
    for (const url of gitLines(repo, ['remote', 'get-url', '--push', '--all', '--', name])) remotes.add(url);
  }
  const targetKeys = new Map();
  for (const { key, value } of raw.targets) {
    if (names.has(value)) continue;
    const resolved = resolvedTarget(repo, key, value);
    const push = pushTarget(value, raw.pushRewrites);
    // Git rewrites the local repository value just like any other target.
    if (value === '.' && resolved === '.' && push === null) continue;
    const urls = [value, resolved];
    if (push !== null) urls.push(push);
    for (const url of urls) {
      remotes.add(url);
      if (!targetKeys.has(url)) targetKeys.set(url, key);
    }
  }

  let refusal;
  for (const remote of remotes) {
    let verdict;
    try {
      verdict = probe(remote);
    } catch {
      verdict = 'unknown';
    }
    const key = targetKeys.get(remote);
    if (key && !isHttpTarget(remote)) verdict = 'unknown';
    if (verdict !== 'private' && !refusal) {
      refusal = key ? targetRefusal(repo, key, remote, verdict)
        : new GuardError(`Remote ${redactRemote(remote)} in Git repository ${repo} is ${verdict === 'public' ? 'public' : 'unverifiable'}; refusing to write persona data.`);
    }
  }
  if (refusal) throw refusal;
}

module.exports = { GuardError, assertSafePersonaPath, resolveRealPath, anonymousProbe };
