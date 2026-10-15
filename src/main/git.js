// Source control backend (simple-git over the system `git`). Every call is
// scoped to a project root the renderer passes in; errors are rethrown with
// git's own message so the UI can show something actionable.
const fs = require('node:fs');
const path = require('node:path');
const { simpleGit } = require('simple-git');
const { gitEnv, isGitHubHttps, normalizeRepoUrl } = require('./github');

function git(root) {
  if (!root || !fs.existsSync(root)) throw new Error('Project folder not found.');
  return simpleGit({ baseDir: root, maxConcurrentProcesses: 4, trimmed: true });
}

function clean(err) {
  const msg = String(err?.message || err).trim();
  // git prints hints after the real error; keep the first meaningful lines
  return new Error(msg.split('\n').filter((l) => l && !l.startsWith('hint:')).slice(0, 4).join('\n') || 'Git command failed.');
}

async function wrap(fn) {
  try { return await fn(); } catch (err) { throw clean(err); }
}

// For commands that talk to a remote: a GitHub https remote gets the
// MulTeam GitHub login (if connected); git never prompts in the background.
// simple-git refuses some environment variables unless allowed explicitly:
// the GitHub login travels in GIT_CONFIG_*, and people's own SSH/askpass/
// proxy settings must keep working. Editors/pagers are never needed for
// remote commands, so they're dropped rather than allowed.
const REMOTE_UNSAFE = { allowUnsafeConfigEnvCount: true, allowUnsafeSshCommand: true, allowUnsafeAskPass: true, allowUnsafeGitProxy: true };
// Of the GIT_* variables, remote commands keep only these (anything else —
// editors, pagers, GIT_DIR overrides… — is dropped, not passed through).
const KEEP_GIT = /^(GIT_SSH|GIT_SSH_COMMAND|GIT_ASKPASS|GIT_TERMINAL_PROMPT|GIT_PROXY_COMMAND|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+)$/;
const DROP_OTHER = ['PAGER', 'EDITOR', 'VISUAL'];
function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const k of Object.keys(env)) {
    if ((/^GIT_/i.test(k) && !KEEP_GIT.test(k.toUpperCase())) || DROP_OTHER.includes(k.toUpperCase())) delete env[k];
  }
  return env;
}
const allowedEnv = (env) => Object.keys(env).filter((k) => /^GIT_/i.test(k) || k.toUpperCase() === 'SSH_ASKPASS');

async function remoteGit(root) {
  if (!root || !fs.existsSync(root)) throw new Error('Project folder not found.');
  let remotes = [];
  try { remotes = await git(root).getRemotes(true); } catch { /* none */ }
  const usesGitHub = remotes.some((r) => isGitHubHttps(r.refs?.fetch) || isGitHubHttps(r.refs?.push));
  const env = cleanEnv(usesGitHub ? await gitEnv() : { GIT_TERMINAL_PROMPT: '0' });
  const g = simpleGit({ baseDir: root, maxConcurrentProcesses: 4, trimmed: true, unsafe: REMOTE_UNSAFE, allowEnvironment: allowedEnv(env) });
  g.env(env);
  return g;
}

// Pull that works with live collaboration: uncommitted changes that are
// already exactly what the incoming commits bring (typically live edits a
// teammate has just committed) are set aside first, so git applies them
// instead of refusing with "your local changes would be overwritten".
// Anything that really differs is left alone for git to report.
const sameText = (a, b) => a !== null && b !== null && a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');
async function pullLiveSafe(root) {
  const g = await remoteGit(root);
  await g.fetch();
  const st = await g.status();
  let setAside = 0;
  if (st.tracking && st.files.length) {
    const top = path.resolve(await g.revparse(['--show-toplevel']));
    const rawEnv = cleanEnv({ GIT_TERMINAL_PROMPT: '0' });
    const raw = simpleGit({ baseDir: top, trimmed: false, unsafe: REMOTE_UNSAFE, allowEnvironment: allowedEnv(rawEnv) }).env(rawEnv);
    const incomingChanged = new Set(String(await raw.raw(['diff', '--name-only', 'HEAD', st.tracking])).split(/\r?\n/).filter(Boolean));
    for (const f of st.files) {
      if (!incomingChanged.has(f.path)) continue;
      let incoming = null;
      let local = null;
      try { incoming = await raw.show([`${st.tracking}:${f.path}`]); } catch { /* deleted upstream */ }
      try { local = await fs.promises.readFile(path.join(top, f.path), 'utf8'); } catch { /* deleted here */ }
      if (!sameText(incoming, local)) continue;
      if (f.index === '?') await fs.promises.rm(path.join(top, f.path), { force: true });
      else await raw.raw(['checkout', 'HEAD', '--', f.path]);
      setAside++;
    }
  }
  const r = await g.pull();
  return { ...r.summary, setAside };
}

function authHint(err) {
  const msg = String(err?.message || err);
  if (/Authentication failed|could not read Username|terminal prompts disabled|403/i.test(msg)) {
    return new Error('GitHub needs a login for this. Connect GitHub in Settings → Accounts (or check you have access to the repository).');
  }
  return err;
}

async function status(root) {
  const g = git(root);
  let isRepo;
  try { isRepo = await g.checkIsRepo('root'); } catch { isRepo = false; }
  if (!isRepo) {
    // inside a parent repo counts too (project = subfolder of a repo)
    try { isRepo = await g.checkIsRepo(); } catch { isRepo = false; }
  }
  if (!isRepo) return { isRepo: false };

  return wrap(async () => {
    const s = await g.status();
    const top = await g.revparse(['--show-toplevel']);
    let remotes = [];
    try { remotes = await g.getRemotes(true); } catch { /* none */ }
    const origin = remotes.find((r) => r.name === 'origin') || remotes[0];
    return {
      isRepo: true,
      repoRoot: path.resolve(top),
      branch: s.current || '(detached)',
      tracking: s.tracking,
      ahead: s.ahead,
      behind: s.behind,
      hasRemote: remotes.length > 0,
      remoteUrl: origin ? normalizeRepoUrl(origin.refs?.fetch || origin.refs?.push) : '',
      files: s.files.map((f) => ({
        path: f.path,            // relative to repo root, forward slashes
        index: f.index,          // staged status letter (' ' = none, '?' = untracked)
        workingDir: f.working_dir
      }))
    };
  });
}

// A file's text at HEAD (null if untracked/no commits). Untrimmed: live
// collaboration compares it byte-for-byte with the working copy.
async function headContent(root, relPath) {
  try {
    const g = simpleGit({ baseDir: root, trimmed: false });
    return await g.show([`HEAD:./${String(relPath).split('\\').join('/')}`]);
  } catch { return null; }
}

function setupGitHandlers(ipcMain, IPC) {
  ipcMain.handle(IPC.GIT_HEAD_CONTENT, (_e, root, relPath) => headContent(root, relPath));
  ipcMain.handle(IPC.GIT_STATUS, (_e, root) => status(root));
  ipcMain.handle(IPC.GIT_INIT, (_e, root) => wrap(() => git(root).init()));
  ipcMain.handle(IPC.GIT_STAGE, (_e, root, paths) => wrap(() => git(root).add(paths)));
  ipcMain.handle(IPC.GIT_UNSTAGE, (_e, root, paths) => wrap(async () => {
    const g = git(root);
    // a repo with no commits has no HEAD to reset to
    try { await g.revparse(['--verify', 'HEAD']); } catch { return g.raw(['rm', '--cached', '-q', '--', ...paths]); }
    return g.raw(['reset', '-q', 'HEAD', '--', ...paths]);
  }));
  // Throws away working-tree changes. Tracked files are restored from the
  // index/HEAD; untracked ones are deleted (git clean). The renderer always
  // confirms first.
  ipcMain.handle(IPC.GIT_DISCARD, (_e, root, { tracked = [], untracked = [] }) => wrap(async () => {
    const g = git(root);
    if (tracked.length) await g.raw(['checkout', '--', ...tracked]);
    if (untracked.length) await g.raw(['clean', '-f', '-q', '--', ...untracked]);
  }));
  ipcMain.handle(IPC.GIT_COMMIT, (_e, root, message) => wrap(async () => {
    const r = await git(root).commit(message);
    return { commit: r.commit, summary: r.summary };
  }));
  ipcMain.handle(IPC.GIT_PULL, (_e, root) => wrap(async () => {
    try { return await pullLiveSafe(root); } catch (err) { throw authHint(err); }
  }));
  ipcMain.handle(IPC.GIT_PUSH, (_e, root) => wrap(async () => {
    try { return await push(root); } catch (err) { throw authHint(err); }
  }));
  async function push(root) {
    const g = await remoteGit(root);
    const s = await g.status();
    if (s.tracking) return g.push();
    // first push of a new branch: publish it and set upstream
    const remotes = await g.getRemotes();
    if (!remotes.length) throw new Error('This repository has no remote to push to.');
    const remote = remotes.find((r) => r.name === 'origin')?.name || remotes[0].name;
    return g.push(['-u', remote, s.current]);
  }
  ipcMain.handle(IPC.GIT_FETCH, (_e, root) => wrap(async () => { try { return await (await remoteGit(root)).fetch(); } catch (err) { throw authHint(err); } }));
  ipcMain.handle(IPC.GIT_BRANCHES, (_e, root) => wrap(async () => {
    const b = await git(root).branchLocal();
    return { current: b.current, all: b.all };
  }));
  ipcMain.handle(IPC.GIT_CHECKOUT, (_e, root, branch) => wrap(() => git(root).checkout(branch)));
  ipcMain.handle(IPC.GIT_CREATE_BRANCH, (_e, root, name) => wrap(() => git(root).checkoutLocalBranch(name)));
}

module.exports = { setupGitHandlers, pullLiveSafe };
