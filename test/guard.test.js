'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const nodeTest = require('node:test');
const { GuardError, assertSafePersonaPath, anonymousProbe } = require('../lib/guard');

const remote = 'https://code.example.invalid/fictional/persona.git';

// Each synchronous test gets isolated user config; restoration also runs on failure.
function test(name, run) {
  nodeTest(name, (t) => {
    const root = temporaryDirectory(t);
    const home = path.join(root, 'home');
    const xdg = path.join(root, 'xdg');
    fs.mkdirSync(home);
    fs.mkdirSync(xdg);
    return withEnvironment({ HOME: home, XDG_CONFIG_HOME: xdg }, () => run(t));
  });
}

function temporaryDirectory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync(dir);
}

function git(dir, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return childProcess.execFileSync('git', ['-C', dir, ...args], { cwd: dir, env, stdio: 'pipe' });
}

function withEnvironment(values, run) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, values);
    return run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function createRepo(dir, url) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '--quiet');
  if (url) git(dir, 'remote', 'add', 'origin', url);
  return dir;
}

function isRefusal(repo, url) {
  return (error) => {
    assert.ok(error instanceof GuardError);
    assert.equal(error.name, 'GuardError');
    assert.ok(error.message.includes(repo));
    assert.ok(error.message.includes(url));
    assert.ok(!error.message.includes('PRIVATE_FILE_CONTENT'));
    return true;
  };
}

test('no repository allows an existing or missing persona without probing', (t) => {
  const dir = temporaryDirectory(t);
  let calls = 0;
  const probe = () => { calls += 1; return 'public'; };

  assert.doesNotThrow(() => assertSafePersonaPath(dir, { probe }));
  assert.doesNotThrow(() => assertSafePersonaPath(path.join(dir, 'missing', 'persona'), { probe }));
  assert.equal(calls, 0);
});

test('a repository with no remote allows writes without probing', (t) => {
  const repo = createRepo(temporaryDirectory(t));
  let calls = 0;

  assert.doesNotThrow(() => assertSafePersonaPath(path.join(repo, 'persona'), {
    probe: () => { calls += 1; return 'public'; },
  }));
  assert.equal(calls, 0);
});

test('private remote allows writes and fetch/push duplicates are probed once', (t) => {
  const repo = createRepo(temporaryDirectory(t), remote);
  const urls = [];

  assert.doesNotThrow(() => assertSafePersonaPath(path.join(repo, 'persona'), {
    probe: (url) => { urls.push(url); return 'private'; },
  }));
  assert.deepEqual(urls, [remote]);
});

for (const verdict of ['public', 'unknown', undefined, 'unexpected']) {
  test(`a ${String(verdict)} remote verdict refuses and names the repository and URL`, (t) => {
    const repo = createRepo(temporaryDirectory(t), remote);
    fs.writeFileSync(path.join(repo, 'private.json'), 'PRIVATE_FILE_CONTENT');

    assert.throws(() => assertSafePersonaPath(repo, { probe: () => verdict }), isRefusal(repo, remote));
  });
}

test('a thrown probe or timeout fails closed without exposing its message', (t) => {
  const repo = createRepo(temporaryDirectory(t), remote);
  const error = new Error('PRIVATE_FILE_CONTENT');
  error.code = 'ETIMEDOUT';

  assert.throws(() => assertSafePersonaPath(repo, { probe: () => { throw error; } }), isRefusal(repo, remote));
});

test('every fetch and push URL is probed, including later unsafe remotes', (t) => {
  const repo = createRepo(temporaryDirectory(t), remote);
  const push = 'https://code.example.invalid/fictional/push.git';
  const second = 'https://code.example.invalid/fictional/second.git';
  const extraFetch = 'https://code.example.invalid/fictional/extra-fetch.git';
  const extraPush = 'https://code.example.invalid/fictional/extra-push.git';
  git(repo, 'remote', 'set-url', '--push', 'origin', push);
  git(repo, 'config', '--add', 'remote.origin.url', extraFetch);
  git(repo, 'config', '--add', 'remote.origin.pushurl', extraPush);
  git(repo, 'remote', 'add', 'second', second);
  const urls = [];

  assert.throws(() => assertSafePersonaPath(repo, {
    probe: (url) => { urls.push(url); return url === push ? 'public' : 'private'; },
  }), isRefusal(repo, push));
  assert.deepEqual(new Set(urls), new Set([remote, extraFetch, push, extraPush, second]));
});

for (const rule of ['insteadOf', 'pushInsteadOf']) {
  test(`a private remote rewritten to public via ${rule} refuses`, (t) => {
    const repo = createRepo(temporaryDirectory(t), remote);
    const prefix = 'https://public.example.invalid/fictional/';
    const rewritten = `${prefix}persona.git`;
    git(repo, 'config', `url.${prefix}.${rule}`, 'https://code.example.invalid/fictional/');
    const fetchUrls = git(repo, 'remote', 'get-url', '--all', 'origin').toString().trim().split('\n');
    const pushUrls = git(repo, 'remote', 'get-url', '--push', '--all', 'origin').toString().trim().split('\n');
    assert.ok((rule === 'insteadOf' ? fetchUrls : pushUrls).includes(rewritten));
    const urls = [];

    assert.throws(() => assertSafePersonaPath(repo, {
      probe: (url) => { urls.push(url); return url === rewritten ? 'public' : 'private'; },
    }), isRefusal(repo, rewritten));
    assert.deepEqual(new Set(urls), new Set([remote, ...fetchUrls, ...pushUrls]));
    assert.equal(urls.length, 2);
  });
}

test('URL rewriting from include.path is resolved by Git and refuses public access', (t) => {
  const repo = createRepo(temporaryDirectory(t), remote);
  const prefix = 'https://public.example.invalid/fictional/';
  const rewritten = `${prefix}persona.git`;
  fs.writeFileSync(path.join(repo, '.git', 'rewrites.inc'), `[url "${prefix}"]\n\tinsteadOf = https://code.example.invalid/fictional/\n`);
  git(repo, 'config', 'include.path', 'rewrites.inc');
  assert.equal(git(repo, 'remote', 'get-url', '--all', 'origin').toString().trim(), rewritten);
  const urls = [];

  assert.throws(() => assertSafePersonaPath(repo, {
    probe: (url) => { urls.push(url); return url === rewritten ? 'public' : 'private'; },
  }), isRefusal(repo, rewritten));
  assert.deepEqual(urls, [remote, rewritten]);
});

test('a private HTTP remote rewritten to SSH refuses an unknown probe verdict', (t) => {
  const repo = createRepo(temporaryDirectory(t), remote);
  const prefix = 'ssh://git@code.example.invalid/fictional/';
  const rewritten = `${prefix}persona.git`;
  git(repo, 'config', `url.${prefix}.insteadOf`, 'https://code.example.invalid/fictional/');
  assert.equal(git(repo, 'remote', 'get-url', '--all', 'origin').toString().trim(), rewritten);
  const urls = [];

  assert.throws(() => assertSafePersonaPath(repo, {
    probe: (url) => { urls.push(url); return url === rewritten ? 'unknown' : 'private'; },
  }), isRefusal(repo, rewritten.replace('ssh://git@', 'ssh://***@')));
  assert.deepEqual(urls, [remote, rewritten]);
});

test('an unsafe raw URL is still probed when Git rewrites it to a private URL', (t) => {
  const repo = createRepo(temporaryDirectory(t), remote);
  const prefix = 'https://private.example.invalid/fictional/';
  git(repo, 'config', `url.${prefix}.insteadOf`, 'https://code.example.invalid/fictional/');
  const rewritten = git(repo, 'remote', 'get-url', '--all', 'origin').toString().trim();
  assert.equal(rewritten, `${prefix}persona.git`);
  const urls = [];

  assert.throws(() => assertSafePersonaPath(repo, {
    probe: (url) => { urls.push(url); return url === remote ? 'public' : 'private'; },
  }), isRefusal(repo, remote));
  assert.deepEqual(urls, [remote, rewritten]);
});

for (const source of ['HOME .gitconfig', 'XDG git/config', 'global includeIf.gitdir']) {
  test(`a remote from ${source} is visible to Git and refused`, (t) => {
    const repo = createRepo(temporaryDirectory(t));
    const config = `[remote "origin"]\n\turl = ${remote}\n`;
    if (source === 'XDG git/config') {
      const dir = path.join(process.env.XDG_CONFIG_HOME, 'git');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'config'), config);
    } else if (source === 'global includeIf.gitdir') {
      fs.writeFileSync(path.join(process.env.HOME, 'remotes.inc'), config);
      fs.writeFileSync(path.join(process.env.HOME, '.gitconfig'), `[includeIf "gitdir:${repo}/.git"]\n\tpath = remotes.inc\n`);
    } else {
      fs.writeFileSync(path.join(process.env.HOME, '.gitconfig'), config);
    }
    assert.equal(git(repo, 'remote').toString(), 'origin\n');
    assert.ok(git(repo, 'remote', '-v').toString().includes(remote));
    assert.ok(git(repo, 'config', '--includes', '--get-regexp', '^remote\\..*\\.url$').toString().includes(remote));
    // Some Git versions list global remotes but reject their get-url lookup.
    let resolutionFailed = false;
    for (const args of [['--all'], ['--push', '--all']]) {
      try {
        assert.equal(git(repo, 'remote', 'get-url', ...args, 'origin').toString().trim(), remote);
      } catch (error) {
        assert.ok(Number.isInteger(error.status) && error.status > 0);
        resolutionFailed = true;
      }
    }
    const urls = [];

    assert.throws(() => assertSafePersonaPath(repo, {
      probe: (url) => { urls.push(url); return 'public'; },
    }), (error) => {
      assert.ok(error instanceof GuardError);
      assert.ok(error.message.includes(repo));
      if (!resolutionFailed) assert.ok(error.message.includes(remote));
      return true;
    });
    assert.deepEqual(urls, resolutionFailed ? [] : [remote]);
  });
}

for (const kind of ['fetch', 'push']) {
  test(`every resolved ${kind} URL is probed when a later URL rewrites to public`, (t) => {
    const repo = createRepo(temporaryDirectory(t), remote);
    const extra = 'https://code.example.invalid/extra/persona.git';
    const prefix = 'https://public.example.invalid/extra/';
    const rewritten = `${prefix}persona.git`;
    if (kind === 'push') git(repo, 'config', '--add', 'remote.origin.pushurl', remote);
    git(repo, 'config', '--add', `remote.origin.${kind === 'push' ? 'pushurl' : 'url'}`, extra);
    git(repo, 'config', `url.${prefix}.insteadOf`, 'https://code.example.invalid/extra/');
    const fetchUrls = git(repo, 'remote', 'get-url', '--all', 'origin').toString().trim().split('\n');
    const pushUrls = git(repo, 'remote', 'get-url', '--push', '--all', 'origin').toString().trim().split('\n');
    assert.deepEqual(kind === 'push' ? pushUrls : fetchUrls, [remote, rewritten]);
    const urls = [];

    assert.throws(() => assertSafePersonaPath(repo, {
      probe: (url) => { urls.push(url); return url === rewritten ? 'public' : 'private'; },
    }), isRefusal(repo, rewritten));
    assert.deepEqual(new Set(urls), new Set([remote, extra, ...fetchUrls, ...pushUrls]));
    assert.equal(urls.length, 3);
  });
}

for (const conditional of [false, true]) {
  test(`a remote from ${conditional ? 'includeIf.gitdir' : 'include.path'} is probed and refused`, (t) => {
    const repo = createRepo(temporaryDirectory(t));
    fs.writeFileSync(path.join(repo, '.git', 'remotes.inc'), `[remote "origin"]\n\turl = ${remote}\n`);
    const key = conditional ? `includeIf.gitdir:${repo}/.git.path` : 'include.path';
    git(repo, 'config', key, 'remotes.inc');
    assert.ok(git(repo, 'remote', '-v').toString().includes(remote));
    const urls = [];

    assert.throws(() => assertSafePersonaPath(repo, {
      probe: (url) => { urls.push(url); return 'public'; },
    }), isRefusal(repo, remote));
    assert.deepEqual(urls, [remote]);
  });
}

test('a remote from worktree config is probed and refused', (t) => {
  const repo = createRepo(temporaryDirectory(t));
  git(repo, 'config', 'extensions.worktreeConfig', 'true');
  git(repo, 'config', '--worktree', 'remote.origin.url', remote);
  assert.ok(git(repo, 'remote', '-v').toString().includes(remote));
  const urls = [];

  assert.throws(() => assertSafePersonaPath(repo, {
    probe: (url) => { urls.push(url); return 'public'; },
  }), isRefusal(repo, remote));
  assert.deepEqual(urls, [remote]);
});

for (const kind of ['remotes', 'branches']) {
  test(`legacy Git ${kind}/origin refuses as unverifiable before probing`, (t) => {
    const repo = createRepo(temporaryDirectory(t));
    fs.mkdirSync(path.join(repo, '.git', kind), { recursive: true });
    fs.writeFileSync(path.join(repo, '.git', kind, 'origin'), kind === 'remotes' ? `URL: ${remote}\n` : `${remote}\n`);
    // Some Git versions omit legacy names from remote -v but still resolve them.
    assert.equal(git(repo, 'remote', 'get-url', 'origin').toString().trim(), remote);
    let calls = 0;

    assert.throws(() => assertSafePersonaPath(repo, {
      probe: () => { calls += 1; return 'public'; },
    }), (error) => {
      assert.ok(error instanceof GuardError);
      assert.ok(error.message.includes(repo));
      assert.ok(error.message.includes(`${kind}/origin`));
      assert.match(error.message, /unverifiable/);
      assert.ok(!error.message.includes(remote));
      return true;
    });
    assert.equal(calls, 0);
  });
}

test('legacy remotes are checked in the common Git directory of a linked worktree', (t) => {
  const root = temporaryDirectory(t);
  const repo = createRepo(path.join(root, 'repo'));
  const commonDir = path.join(repo, '.git');
  const worktree = path.join(root, 'worktree');
  const gitDir = path.join(commonDir, 'worktrees', 'sample');
  fs.mkdirSync(worktree);
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${gitDir}\n`);
  fs.writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
  fs.writeFileSync(path.join(gitDir, 'gitdir'), `${worktree}/.git\n`);
  fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/sample\n');
  fs.mkdirSync(path.join(commonDir, 'remotes'), { recursive: true });
  fs.writeFileSync(path.join(commonDir, 'remotes', 'origin'), `URL: ${remote}\n`);
  assert.equal(fs.realpathSync(git(worktree, 'rev-parse', '--git-common-dir').toString().trim()), commonDir);
  assert.equal(git(worktree, 'remote', 'get-url', 'origin').toString().trim(), remote);
  let calls = 0;

  assert.throws(() => assertSafePersonaPath(worktree, {
    probe: () => { calls += 1; return 'public'; },
  }), (error) => {
    assert.ok(error instanceof GuardError);
    assert.ok(error.message.includes(worktree));
    assert.match(error.message, /remotes\/origin.*unverifiable/);
    return true;
  });
  assert.equal(calls, 0);
});

for (const output of ['', '.git', '.git\nextra\n', '\0\n', null, 'PRIVATE_FILE_CONTENT\n']) {
  test(`unverifiable common Git directory ${JSON.stringify(output)} fails closed`, (t) => {
    const repo = createRepo(temporaryDirectory(t));
    const spy = t.mock.method(childProcess, 'execFileSync', () => output);
    let calls = 0;

    assert.throws(() => assertSafePersonaPath(repo, {
      probe: () => { calls += 1; return 'private'; },
    }), (error) => {
      assert.ok(error instanceof GuardError);
      assert.ok(error.message.includes(repo));
      assert.match(error.message, /Cannot resolve common Git directory/);
      assert.ok(!error.message.includes('PRIVATE_FILE_CONTENT'));
      return true;
    });
    assert.deepEqual(spy.mock.calls[0].arguments[1], ['-C', repo, 'rev-parse', '--git-common-dir']);
    assert.equal(calls, 0);
  });
}

test('a failed common Git directory lookup refuses even with no configured remotes', (t) => {
  const repo = createRepo(temporaryDirectory(t));
  const spy = t.mock.method(childProcess, 'execFileSync', () => {
    throw Object.assign(new Error('PRIVATE_FILE_CONTENT'), { status: 1, stdout: '', stderr: '' });
  });
  let calls = 0;

  assert.throws(() => assertSafePersonaPath(repo, {
    probe: () => { calls += 1; return 'private'; },
  }), (error) => {
    assert.ok(error instanceof GuardError);
    assert.ok(error.message.includes(repo));
    assert.match(error.message, /Cannot resolve common Git directory/);
    assert.ok(!error.message.includes('PRIVATE_FILE_CONTENT'));
    return true;
  });
  assert.equal(spy.mock.callCount(), 1);
  assert.equal(calls, 0);
});

for (const operation of ['lstatSync', 'readdirSync']) {
  test(`an unreadable legacy directory during ${operation} fails closed`, (t) => {
    const repo = createRepo(temporaryDirectory(t));
    const legacyDir = path.join(repo, '.git', 'remotes');
    fs.mkdirSync(legacyDir, { recursive: true });
    const original = fs[operation];
    let inspections = 0;
    t.mock.method(fs, operation, (dir, ...args) => {
      if (dir === legacyDir) {
        inspections += 1;
        throw Object.assign(new Error('PRIVATE_FILE_CONTENT'), { code: 'EACCES' });
      }
      return original(dir, ...args);
    });
    let calls = 0;

    assert.throws(() => assertSafePersonaPath(repo, {
      probe: () => { calls += 1; return 'private'; },
    }), (error) => {
      assert.ok(error instanceof GuardError);
      assert.ok(error.message.includes(repo));
      assert.match(error.message, /Cannot inspect legacy remotes/);
      assert.ok(!error.message.includes('PRIVATE_FILE_CONTENT'));
      return true;
    });
    assert.equal(inspections, 1);
    assert.equal(calls, 0);
  });
}

test('remote userinfo is redacted from public and unverifiable refusals', (t) => {
  const credentialUrl = 'https://sample-user:SAMPLE_SECRET@code.example.invalid/fictional/persona.git';
  const repo = createRepo(temporaryDirectory(t), credentialUrl);

  for (const verdict of ['public', 'unknown']) {
    const urls = [];
    assert.throws(() => assertSafePersonaPath(repo, {
      probe: (url) => { urls.push(url); return verdict; },
    }), (error) => {
      assert.ok(error instanceof GuardError);
      assert.ok(error.message.includes(repo));
      assert.ok(error.message.includes('https://***@code.example.invalid/fictional/persona.git'));
      assert.ok(!error.message.includes('sample-user'));
      assert.ok(!error.message.includes('SAMPLE_SECRET'));
      return true;
    });
    assert.deepEqual(urls, [credentialUrl]);
  }
});

test('remote query strings and fragments are redacted from refusals', (t) => {
  const credentialUrl = `${remote}?access_token=SAMPLE_QUERY_SECRET#SAMPLE_FRAGMENT_SECRET`;
  const repo = createRepo(temporaryDirectory(t), credentialUrl);

  for (const verdict of ['public', 'unknown']) {
    const urls = [];
    assert.throws(() => assertSafePersonaPath(repo, {
      probe: (url) => { urls.push(url); return verdict; },
    }), (error) => {
      assert.ok(error instanceof GuardError);
      assert.ok(error.message.includes(repo));
      assert.ok(error.message.includes(`${remote}?***#***`));
      assert.ok(!error.message.includes('SAMPLE_QUERY_SECRET'));
      assert.ok(!error.message.includes('SAMPLE_FRAGMENT_SECRET'));
      return true;
    });
    assert.deepEqual(urls, [credentialUrl]);
  }
});

test('only literal synthetic: true skips the remote probe', (t) => {
  const repo = createRepo(temporaryDirectory(t), remote);
  let calls = 0;

  assert.doesNotThrow(() => assertSafePersonaPath(repo, {
    synthetic: true, probe: () => { calls += 1; return 'public'; },
  }));
  assert.equal(calls, 0);
  for (const synthetic of [false, 'true', 1, undefined]) {
    assert.throws(() => assertSafePersonaPath(repo, {
      synthetic, probe: () => 'public',
    }), isRefusal(repo, remote));
  }
});

test('environment variables cannot disable the guard', (t) => {
  const repo = createRepo(temporaryDirectory(t), remote);
  withEnvironment({ BUNSHIN_DISABLE_GUARD: 'true', BUNSHIN_SKIP_GUARD: 'true', BUNSHIN_SYNTHETIC: 'true' }, () => {
    assert.throws(() => assertSafePersonaPath(repo, { probe: () => 'public' }), isRefusal(repo, remote));
  });
});

test('Git repository and config environment variables cannot hide a public remote', (t) => {
  const root = temporaryDirectory(t);
  const repo = createRepo(path.join(root, 'public'), remote);
  const decoy = createRepo(path.join(root, 'no-remotes'));
  const decoyConfig = path.join(decoy, '.git', 'config');
  for (const values of [
    { GIT_DIR: path.join(decoy, '.git') },
    { GIT_WORK_TREE: decoy },
    { GIT_DIR: path.join(decoy, '.git'), GIT_WORK_TREE: decoy },
    { GIT_COMMON_DIR: path.join(decoy, '.git') },
    { GIT_CONFIG: decoyConfig },
    { GIT_CONFIG_GLOBAL: decoyConfig, GIT_CONFIG_SYSTEM: decoyConfig },
    { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'remote.origin.url', GIT_CONFIG_VALUE_0: 'ssh://git@code.example.invalid/decoy.git' },
    { GIT_CONFIG_PARAMETERS: "'remote.origin.url=ssh://git@code.example.invalid/decoy.git'" },
  ]) {
    withEnvironment(values, () => {
      const urls = [];
      assert.throws(() => assertSafePersonaPath(repo, {
        probe: (url) => { urls.push(url); return url === remote ? 'public' : 'private'; },
      }), isRefusal(repo, remote));
      assert.deepEqual(urls, [remote]);
    });
  }
});

test('repository search resolves symlinks for existing and missing targets', (t) => {
  const root = temporaryDirectory(t);
  const repo = createRepo(path.join(root, 'repo'), remote);
  const persona = path.join(repo, 'persona');
  fs.mkdirSync(persona);
  const alias = path.join(root, 'alias');
  fs.symlinkSync(persona, alias, 'dir');

  for (const target of [alias, path.join(alias, 'missing', 'child')]) {
    assert.throws(() => assertSafePersonaPath(target, { probe: () => 'public' }), isRefusal(repo, remote));
  }
});

test('repository search uses the real location when a symlink leaves a repository', (t) => {
  const root = temporaryDirectory(t);
  const repo = createRepo(path.join(root, 'repo'), remote);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  const alias = path.join(repo, 'alias');
  fs.symlinkSync(outside, alias, 'dir');
  let calls = 0;

  assert.doesNotThrow(() => assertSafePersonaPath(path.join(alias, 'new'), {
    probe: () => { calls += 1; return 'public'; },
  }));
  assert.equal(calls, 0);
});

test('repository search stops at the first .git directory', (t) => {
  const outer = createRepo(temporaryDirectory(t), remote);
  const inner = createRepo(path.join(outer, 'inner'));
  let calls = 0;

  assert.doesNotThrow(() => assertSafePersonaPath(path.join(inner, 'persona'), {
    probe: () => { calls += 1; return 'public'; },
  }));
  assert.equal(calls, 0);
  const innerRemote = 'https://code.example.invalid/fictional/inner.git';
  git(inner, 'remote', 'add', 'origin', innerRemote);
  const urls = [];
  assert.doesNotThrow(() => assertSafePersonaPath(inner, {
    probe: (url) => { urls.push(url); return 'private'; },
  }));
  assert.deepEqual(urls, [innerRemote]);
});

test('repository search recognizes and stops at a .git file', (t) => {
  const outer = createRepo(temporaryDirectory(t), remote);
  const inner = createRepo(path.join(outer, 'inner'));
  const gitDir = path.join(outer, 'inner-git');
  fs.renameSync(path.join(inner, '.git'), gitDir);
  fs.writeFileSync(path.join(inner, '.git'), `gitdir: ${gitDir}\n`);
  let calls = 0;

  assert.doesNotThrow(() => assertSafePersonaPath(path.join(inner, 'persona'), {
    probe: () => { calls += 1; return 'public'; },
  }));
  assert.equal(calls, 0);
  const innerRemote = 'https://code.example.invalid/fictional/file-repo.git';
  git(inner, 'remote', 'add', 'origin', innerRemote);
  assert.throws(() => assertSafePersonaPath(inner, { probe: () => 'public' }), isRefusal(inner, innerRemote));
});

test('an unreadable Git repository fails closed without printing Git output', (t) => {
  const repo = temporaryDirectory(t);
  fs.writeFileSync(path.join(repo, '.git'), 'PRIVATE_FILE_CONTENT');

  assert.throws(() => assertSafePersonaPath(repo, { probe: () => 'private' }), (error) => {
    assert.ok(error instanceof GuardError);
    assert.ok(error.message.includes(repo));
    assert.ok(!error.message.includes('PRIVATE_FILE_CONTENT'));
    return true;
  });
});

test('a raw URL listing without its trailing NUL refuses before probing', (t) => {
  const repo = createRepo(temporaryDirectory(t), remote);
  const originalExec = childProcess.execFileSync;
  let listings = 0;
  t.mock.method(childProcess, 'execFileSync', (command, args, options) => {
    if (args.includes('config')) {
      listings += 1;
      return `remote.origin.url\n${remote}`;
    }
    return originalExec(command, args, options);
  });
  let calls = 0;

  assert.throws(() => assertSafePersonaPath(repo, {
    probe: () => { calls += 1; return 'private'; },
  }), GuardError);
  assert.equal(listings, 1);
  assert.equal(calls, 0);
});

for (const listing of [
  '', 'PRIVATE_FILE_CONTENT', 'remote.origin.url\n\0',
  'remote.origin.url\nhttps://code.example.invalid/fictional/first.git\nPRIVATE_FILE_CONTENT\0',
  `remote.origin.url\n${remote}\0PRIVATE_FILE_CONTENT\0`,
]) {
  test(`unparseable remote listing ${JSON.stringify(listing)} fails closed`, (t) => {
    const repo = createRepo(temporaryDirectory(t), remote);
    const originalExec = childProcess.execFileSync;
    const spy = t.mock.method(childProcess, 'execFileSync', (command, args, options) => (
      args.includes('config') ? listing : originalExec(command, args, options)
    ));
    let calls = 0;

    assert.throws(() => assertSafePersonaPath(repo, { probe: () => { calls += 1; return 'private'; } }), (error) => {
      assert.ok(error instanceof GuardError);
      assert.ok(error.message.includes(repo));
      assert.ok(!error.message.includes('PRIVATE_FILE_CONTENT'));
      return true;
    });
    assert.ok(spy.mock.calls.some(({ arguments: args }) => args[1].includes('config')));
    assert.equal(calls, 0);
  });
}

for (const failure of [
  { code: 'ENOENT' }, { code: 'ETIMEDOUT', signal: 'SIGTERM' },
  { code: 'ENOENT', status: 1, stdout: '', stderr: '' },
  { status: 1, stdout: 'PRIVATE_FILE_CONTENT', stderr: '' },
  { status: 1, stdout: '', stderr: 'PRIVATE_FILE_CONTENT' },
]) {
  test(`remote listing failure ${JSON.stringify(failure)} refuses without exposing subprocess output`, (t) => {
    const repo = createRepo(temporaryDirectory(t), remote);
    const originalExec = childProcess.execFileSync;
    const spy = t.mock.method(childProcess, 'execFileSync', (command, args, options) => {
      if (args.includes('config')) throw Object.assign(new Error('PRIVATE_FILE_CONTENT'), failure);
      return originalExec(command, args, options);
    });
    let calls = 0;

    assert.throws(() => assertSafePersonaPath(repo, { probe: () => { calls += 1; return 'private'; } }), (error) => {
      assert.ok(error instanceof GuardError);
      assert.ok(error.message.includes(repo));
      assert.ok(!error.message.includes('PRIVATE_FILE_CONTENT'));
      return true;
    });
    assert.ok(spy.mock.calls.some(({ arguments: args }) => args[1].includes('config')));
    assert.equal(calls, 0);
  });
}

for (const [label, matches] of [
  ['remote names', (args) => args[2] === 'remote' && args.length === 3],
  ['resolved fetch URLs', (args) => args.includes('get-url') && !args.includes('--push')],
  ['resolved push URLs', (args) => args.includes('get-url') && args.includes('--push')],
]) {
  for (const failure of [
    { status: 1, stdout: '', stderr: '' }, { status: 128, stderr: 'PRIVATE_FILE_CONTENT' },
    { code: 'ENOENT' }, { code: 'ETIMEDOUT', signal: 'SIGTERM' },
  ]) {
    test(`${label} failure ${JSON.stringify(failure)} refuses before probing`, (t) => {
      const repo = createRepo(temporaryDirectory(t), remote);
      const originalExec = childProcess.execFileSync;
      let listings = 0;
      t.mock.method(childProcess, 'execFileSync', (command, args, options) => {
        if (matches(args)) {
          listings += 1;
          throw Object.assign(new Error('PRIVATE_FILE_CONTENT'), failure);
        }
        return originalExec(command, args, options);
      });
      let calls = 0;

      assert.throws(() => assertSafePersonaPath(repo, {
        probe: () => { calls += 1; return 'private'; },
      }), (error) => {
        assert.ok(error instanceof GuardError);
        assert.ok(error.message.includes(repo));
        assert.ok(!error.message.includes('PRIVATE_FILE_CONTENT'));
        return true;
      });
      assert.equal(listings, 1);
      assert.equal(calls, 0);
    });
  }

  const outputs = [null, 'PRIVATE_FILE_CONTENT', '\0\n', '\r\n', '\n', `${remote}\n\n`];
  if (label !== 'remote names') outputs.push('');
  for (const output of outputs) {
    test(`unparseable ${label} output ${JSON.stringify(output)} refuses before probing`, (t) => {
      const repo = createRepo(temporaryDirectory(t), remote);
      const originalExec = childProcess.execFileSync;
      let listings = 0;
      t.mock.method(childProcess, 'execFileSync', (command, args, options) => {
        if (matches(args)) {
          listings += 1;
          return output;
        }
        return originalExec(command, args, options);
      });
      let calls = 0;

      assert.throws(() => assertSafePersonaPath(repo, {
        probe: () => { calls += 1; return 'private'; },
      }), (error) => {
        assert.ok(error instanceof GuardError);
        assert.ok(error.message.includes(repo));
        assert.ok(!error.message.includes('PRIVATE_FILE_CONTENT'));
        return true;
      });
      assert.equal(listings, 1);
      assert.equal(calls, 0);
    });
  }
}

test('no raw URL matches still checks the effective URLs of a named remote', (t) => {
  const repo = createRepo(temporaryDirectory(t));
  git(repo, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
  assert.equal(git(repo, 'remote').toString(), 'origin\n');
  const fetchUrls = git(repo, 'remote', 'get-url', '--all', 'origin').toString().trim().split('\n');
  const pushUrls = git(repo, 'remote', 'get-url', '--push', '--all', 'origin').toString().trim().split('\n');
  const urls = [];

  assert.throws(() => assertSafePersonaPath(repo, {
    probe: (url) => { urls.push(url); return 'unknown'; },
  }), GuardError);
  assert.deepEqual(new Set(urls), new Set([...fetchUrls, ...pushUrls]));
  assert.equal(urls.length, new Set(urls).size);
});

test('all repository inspection commands use the real repo and only strip GIT_* environment keys', (t) => {
  const repo = createRepo(temporaryDirectory(t), remote);
  const originalExec = childProcess.execFileSync;
  const spy = t.mock.method(childProcess, 'execFileSync', (...args) => originalExec(...args));

  const values = {
    GIT_DIR: '/fictional/decoy', GIT_WORK_TREE: '/fictional/decoy', GIT_COMMON_DIR: '/fictional/decoy',
    GIT_CONFIG_GLOBAL: '/fictional/config', GIT_CONFIG_SYSTEM: '/fictional/config', GIT_CONFIG_NOSYSTEM: '0',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'remote.origin.url', GIT_CONFIG_VALUE_0: 'file:///fictional/decoy',
    GIT_UNRECOGNIZED_KEY: 'fictional',
  };
  let expectedEnv;
  withEnvironment(values, () => {
    expectedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    assert.throws(() => assertSafePersonaPath(repo, { probe: () => 'public' }), isRefusal(repo, remote));
  });
  assert.equal(spy.mock.callCount(), 5);
  assert.deepEqual(spy.mock.calls.map(({ arguments: args }) => args[1]), [
    ['-C', repo, 'rev-parse', '--git-common-dir'],
    ['-C', repo, 'config', '--includes', '--null', '--get-regexp', '^remote\\..*\\.(url|pushurl)$'],
    ['-C', repo, 'remote'],
    ['-C', repo, 'remote', 'get-url', '--all', '--', 'origin'],
    ['-C', repo, 'remote', 'get-url', '--push', '--all', '--', 'origin'],
  ]);
  for (const { arguments: [command, _args, options] } of spy.mock.calls) {
    assert.equal(command, 'git');
    assert.equal(options.cwd, repo);
    assert.deepEqual(options.env, expectedEnv);
    assert.equal(options.env.GIT_CONFIG_GLOBAL, undefined);
    assert.equal(options.env.GIT_CONFIG_NOSYSTEM, undefined);
    assert.equal(options.env.GIT_DIR, undefined);
    assert.equal(options.env.GIT_WORK_TREE, undefined);
    assert.equal(options.env.GIT_COMMON_DIR, undefined);
    assert.equal(options.env.GIT_CONFIG_SYSTEM, undefined);
    assert.equal(options.env.GIT_CONFIG_COUNT, undefined);
    assert.equal(options.env.GIT_CONFIG_KEY_0, undefined);
    assert.equal(options.env.GIT_CONFIG_VALUE_0, undefined);
    assert.equal(options.env.GIT_UNRECOGNIZED_KEY, undefined);
  }
});

test('a dangling persona symlink fails closed', (t) => {
  const dir = temporaryDirectory(t);
  const alias = path.join(dir, 'alias');
  fs.symlinkSync(path.join(dir, 'missing'), alias, 'dir');

  assert.throws(() => assertSafePersonaPath(path.join(alias, 'child'), { probe: () => 'private' }), GuardError);
});

test('default probe disables credentials and prompts, uses argv and a five second timeout', (t) => {
  const repo = createRepo(temporaryDirectory(t), remote);
  const spy = t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
    assert.equal(command, 'git');
    assert.ok(args.includes('credential.helper='));
    assert.ok(args.includes('core.askPass='));
    assert.ok(args.includes('ls-remote'));
    assert.ok(args.includes('--heads'));
    assert.equal(args.at(-1), remote);
    assert.equal(options.timeout, 5000);
    assert.equal(options.cwd, os.tmpdir());
    assert.ok(!options.shell);
    assert.equal(options.env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(options.env.GIT_ASKPASS, '/bin/echo');
    assert.equal(options.env.GCM_INTERACTIVE, 'never');
    assert.equal(options.env.SSH_ASKPASS, undefined);
    assert.equal(options.env.SSH_AUTH_SOCK, undefined);
    assert.equal(options.env.GIT_CONFIG_GLOBAL, '/dev/null');
    assert.equal(options.env.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(options.env.GIT_CEILING_DIRECTORIES, path.dirname(fs.realpathSync(os.tmpdir())));
    assert.equal(options.env.GIT_DIR, undefined);
    assert.equal(options.env.GIT_WORK_TREE, undefined);
    assert.equal(options.env.GIT_COMMON_DIR, undefined);
    assert.equal(options.env.GIT_CONFIG_SYSTEM, undefined);
    assert.equal(options.env.GIT_CONFIG_COUNT, undefined);
    assert.equal(options.env.GIT_CONFIG_KEY_0, undefined);
    assert.equal(options.env.GIT_CONFIG_VALUE_0, undefined);
    assert.equal(options.env.GIT_UNRECOGNIZED_KEY, undefined);
    assert.match(options.env.GIT_SSH_COMMAND, /BatchMode=yes/);
    assert.match(options.env.GIT_SSH_COMMAND, /StrictHostKeyChecking=accept-new/);
    return { status: 128, stderr: 'fatal: Authentication failed' };
  });

  withEnvironment({
    GIT_DIR: '/fictional/decoy', GIT_WORK_TREE: '/fictional/decoy', GIT_COMMON_DIR: '/fictional/decoy',
    GIT_TERMINAL_PROMPT: '1', GIT_ASKPASS: '/fictional/helper', GIT_SSH_COMMAND: '/fictional/ssh',
    GIT_CONFIG_GLOBAL: '/fictional/config', GIT_CONFIG_SYSTEM: '/fictional/config', GIT_CONFIG_NOSYSTEM: '0',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '/fictional/helper',
    GIT_UNRECOGNIZED_KEY: 'fictional', SSH_ASKPASS: '/fictional/helper', SSH_AUTH_SOCK: '/fictional/socket',
    GCM_INTERACTIVE: 'always', GIT_CEILING_DIRECTORIES: '/fictional/ceiling',
  }, () => assert.doesNotThrow(() => assertSafePersonaPath(repo)));
  assert.equal(spy.mock.callCount(), 1);
});

for (const url of [
  'ssh://git@code.example.invalid/fictional/persona.git',
  'git@code.example.invalid:fictional/persona.git',
  'git://code.example.invalid/fictional/persona.git',
  'file:///fictional/persona.git', '/fictional/persona.git', '../fictional/persona.git',
  'not-a-url', 'https://', 'https://[invalid]/persona.git', 'https://code.example.invalid/\nfictional',
]) {
  test(`default probe refuses unsupported or malformed transport ${url} without spawning`, (t) => {
    const repo = createRepo(temporaryDirectory(t), url);
    const spy = t.mock.method(childProcess, 'spawnSync', () => ({ status: 0, stdout: '' }));

    assert.equal(anonymousProbe(url), 'unknown');
    // Malformed multiline URLs are refused while parsing the listing.
    if (url.includes('\n')) assert.throws(() => assertSafePersonaPath(repo), GuardError);
    else assert.throws(() => assertSafePersonaPath(repo), isRefusal(repo, url.replace('ssh://git@', 'ssh://***@')));
    assert.equal(spy.mock.callCount(), 0);
  });
}

test('default HTTP(S) probes strip embedded credentials before spawning', (t) => {
  const spy = t.mock.method(childProcess, 'spawnSync', (_command, args) => {
    assert.equal(args.at(-1), remote);
    assert.ok(!args.join(' ').includes('SAMPLE_SECRET'));
    return { status: 0, stdout: '' };
  });

  assert.equal(anonymousProbe(remote.replace('https://', 'https://sample-user:SAMPLE_SECRET@')), 'public');
  assert.equal(spy.mock.callCount(), 1);
});

test('HTTP is probed anonymously too', (t) => {
  const url = remote.replace('https://', 'http://');
  const spy = t.mock.method(childProcess, 'spawnSync', (_command, args) => {
    assert.equal(args.at(-1), url);
    return { status: 0, stdout: '' };
  });

  assert.equal(anonymousProbe(url), 'public');
  assert.equal(spy.mock.callCount(), 1);
});

test('a thrown default probe fails closed without exposing subprocess details', (t) => {
  const repo = createRepo(temporaryDirectory(t), remote);
  t.mock.method(childProcess, 'spawnSync', () => { throw new Error('PRIVATE_FILE_CONTENT'); });

  assert.equal(anonymousProbe(remote), 'unknown');
  assert.throws(() => assertSafePersonaPath(repo), isRefusal(repo, remote));
});

for (const [label, result, allowed] of [
  ['anonymous success', { status: 0, stdout: '' }, false],
  ['missing repository', { status: 128, stderr: 'fatal: repository not found' }, true],
  ['SSH authentication failure on HTTP', { status: 128, stderr: 'Permission denied (publickey).' }, false],
  ['HTTP credentials required', { status: 128, stderr: "fatal: could not read Username for 'https://code.example.invalid': terminal prompts disabled" }, true],
  ['HTTP 401', { status: 128, stderr: `fatal: unable to access '${remote}': The requested URL returned error: 401` }, true],
  ['HTTP 403', { status: 128, stderr: `fatal: unable to access '${remote}': The requested URL returned error: 403` }, true],
  ['HTTP 404', { status: 128, stderr: `fatal: unable to access '${remote}': The requested URL returned error: 404` }, true],
  ['HTTP 500', { status: 128, stderr: `fatal: unable to access '${remote}': The requested URL returned error: 500` }, false],
  ['network failure', { status: 128, stderr: 'Could not resolve host: code.example.invalid' }, false],
  ['proxy authentication failure', { status: 128, stderr: 'fatal: Proxy authentication failed' }, false],
  ['other failure', { status: 128, stderr: 'fatal: PRIVATE_FILE_CONTENT' }, false],
  ['timeout', { status: null, error: { code: 'ETIMEDOUT' }, stderr: 'Authentication failed' }, false],
  ['spawn failure', { status: null, error: { code: 'ENOENT' } }, false],
  ['terminated probe', { status: 128, signal: 'SIGTERM', stderr: 'repository not found' }, false],
  ['missing exit status', { stderr: 'fatal: Authentication failed' }, false],
  ['invalid subprocess result', null, false],
]) {
  test(`default probe handles ${label} without network access`, (t) => {
    const repo = createRepo(temporaryDirectory(t), remote);
    t.mock.method(childProcess, 'spawnSync', () => result);

    if (allowed) assert.doesNotThrow(() => assertSafePersonaPath(repo));
    else assert.throws(() => assertSafePersonaPath(repo), isRefusal(repo, remote));
  });
}
