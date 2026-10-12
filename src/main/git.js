// Source control backend (simple-git over the system `git`). Every call is
// scoped to a project root the renderer passes in; errors are rethrown with
// git's own message so the UI can show something actionable.
const fs = require('node:fs');
const path = require('node:path');
const { simpleGit } = require('simple-git');

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
    try { remotes = await g.getRemotes(); } catch { /* none */ }
    return {
      isRepo: true,
      repoRoot: path.resolve(top),
      branch: s.current || '(detached)',
      tracking: s.tracking,
      ahead: s.ahead,
      behind: s.behind,
      hasRemote: remotes.length > 0,
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
    const r = await git(root).pull();
    return r.summary;
  }));
  ipcMain.handle(IPC.GIT_PUSH, (_e, root) => wrap(async () => {
    const g = git(root);
    const s = await g.status();
    if (s.tracking) return g.push();
    // first push of a new branch: publish it and set upstream
    const remotes = await g.getRemotes();
    if (!remotes.length) throw new Error('This repository has no remote to push to.');
    const remote = remotes.find((r) => r.name === 'origin')?.name || remotes[0].name;
    return g.push(['-u', remote, s.current]);
  }));
  ipcMain.handle(IPC.GIT_FETCH, (_e, root) => wrap(() => git(root).fetch()));
  ipcMain.handle(IPC.GIT_BRANCHES, (_e, root) => wrap(async () => {
    const b = await git(root).branchLocal();
    return { current: b.current, all: b.all };
  }));
  ipcMain.handle(IPC.GIT_CHECKOUT, (_e, root, branch) => wrap(() => git(root).checkout(branch)));
  ipcMain.handle(IPC.GIT_CREATE_BRANCH, (_e, root, name) => wrap(() => git(root).checkoutLocalBranch(name)));
}

module.exports = { setupGitHandlers };
