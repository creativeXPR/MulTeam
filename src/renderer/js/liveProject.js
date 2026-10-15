// Whole-project live sync for an open cloud project (collaboration stage 2.1).
//
// One instance per open project + Git branch. It keeps a live Yjs document
// for every file that has live (uncommitted) edits on this branch — open in
// an editor or not — and keeps everyone's disk in step with them:
//
//   RTDB projects/{projectId}/b/{branchKey}/files/{fileKey}
//        { path, kind: 'file'|'dir', state: 'live'|'deleted', by, client, at }
//        the branch's index of files/folders touched live (created, edited,
//        deleted) — every client follows it
//   RTDB projects/{projectId}/b/{branchKey}/docs/{fileKey}
//        the Yjs document of each file (see sync.js)
//
// Local → team: the project folder is watched, so edits, new files, renames
// and deletes made anywhere (MulTeam, terminal, other apps) are shared.
// Changes Git makes (checkout, pull, reset…) are recognised and NOT shared.
// Team → local: teammates' changes are written to disk straight away;
// deletions go to the Recycle Bin; a differing local copy is backed up
// before a live version first replaces it.
import * as Y from 'yjs';
import { ref, child, get, onChildAdded, onChildChanged, onChildRemoved, set, remove } from 'firebase/database';
import { rtdb } from './firebase.js';
import { FirebaseProvider, fileKeyFor } from './sync.js';

// Not shared: VCS/deps/build output/caches, secrets, OS junk.
const IGNORED_DIR = /(^|\/)(\.git|node_modules|dist|build|out|\.next|\.nuxt|\.svelte-kit|coverage|\.cache|\.parcel-cache|\.turbo|__pycache__|\.venv|venv|env|target|bin|obj|\.idea|\.vs)(\/|$)/i;
const IGNORED_FILE = /(^|\/)(\.env(\..*)?|\.DS_Store|Thumbs\.db|desktop\.ini|.*\.log|.*\.swp|.*~)$/i;
export const MAX_LIVE_BYTES = 512 * 1024;
// Projects without Git are synced whole; past this many files, use Git.
export const MAX_TREE_FILES = 400;
const GIT_QUIET_MS = 3000;    // changes this close to a Git HEAD move are Git's
const DISK_DEBOUNCE_MS = 400;
const WRITE_DEBOUNCE_MS = 250;

export const isSharedPath = (rel) => !!rel && !IGNORED_DIR.test(rel) && !IGNORED_FILE.test(rel);
const isText = (s) => typeof s === 'string' && !s.includes('\u0000') && s.length <= MAX_LIVE_BYTES;

// Replace ytext's content with `next` as one minimal edit (keeps cursors).
export function applyTextDiff(ytext, next, origin) {
  const cur = ytext.toString();
  if (cur === next) return false;
  let start = 0;
  while (start < cur.length && start < next.length && cur[start] === next[start]) start++;
  let endCur = cur.length;
  let endNext = next.length;
  while (endCur > start && endNext > start && cur[endCur - 1] === next[endNext - 1]) { endCur--; endNext--; }
  ytext.doc.transact(() => {
    if (endCur > start) ytext.delete(start, endCur - start);
    if (endNext > start) ytext.insert(start, next.slice(start, endNext));
  }, origin);
  return true;
}

// The single changed span between two texts: a[s, e) became `ins`.
function hunk(a, b) {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  return { s, e: ea, ins: b.slice(s, eb) };
}

// Three-way: `local` is `base` plus an edit made on disk; ytext is `base`
// plus teammates' edits. Apply the local edit on top so both survive.
export function mergeLocalEdit(ytext, base, local, origin) {
  const remote = ytext.toString();
  if (base == null || remote === base) return applyTextDiff(ytext, local, origin);
  if (local === base || local === remote) return false;
  const h = hunk(base, local);
  const r = hunk(base, remote);
  let pos = h.s;
  let del = h.e - h.s;
  if (h.e <= r.s) pos = h.s;                                     // mine is before theirs
  else if (h.s >= r.e) pos = h.s + (r.ins.length - (r.e - r.s)); // mine is after theirs
  else { pos = r.s + r.ins.length; del = 0; }                    // overlap: keep theirs, add mine after
  ytext.doc.transact(() => {
    if (del > 0) ytext.delete(pos, del);
    if (h.ins) ytext.insert(pos, h.ins);
  }, origin);
  return true;
}

export function createLiveProject({ projectId, root, branch, isGit, uid, canEdit, api, toast, onDenied, db = rtdb }) {
  const sep = root.includes('\\') ? '\\' : '/';
  const abs = (rel) => root.replace(/[\\/]+$/, '') + sep + rel.split('/').join(sep);
  const branchKey = fileKeyFor(isGit ? branch || 'HEAD' : '_project');
  const base = `projects/${projectId}/b/${branchKey}`;
  const filesRef = ref(db, `${base}/files`);
  const client = Math.random().toString(36).slice(2, 10);
  const LOCAL = { local: true }; // transaction origin for changes made here

  const docs = new Map();        // rel → { ydoc, provider, refs, observer, writeTimer, markedLive }
  const index = new Map();       // rel → latest index entry
  const lastSynced = new Map();  // rel → text we know is on disk (null = known missing)
  const diskTimers = new Map();
  const backgrounds = new Set(); // rels kept live without an editor
  let lastGitSignal = 0;
  let disposed = false;
  const unsubs = [];
  // Git changed a file that has no live edits: follow it, but don't mark it live
  const RESET = { reset: true };
  const sameText = (a, b) => typeof a === 'string' && typeof b === 'string' && a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');

  // The text last agreed with the live session, per file. Also kept on disk
  // (main/liveBase.js) so that after MulTeam was closed or offline, a file
  // changed here can be merged instead of overwritten.
  const baseTimers = new Map();
  function setSynced(rel, text) {
    lastSynced.set(rel, text);
    if (typeof text !== 'string' || !api.liveBase) return;
    clearTimeout(baseTimers.get(rel));
    baseTimers.set(rel, setTimeout(() => {
      baseTimers.delete(rel);
      api.liveBase.set(projectId, branchKey, fileKeyFor(rel), text).catch(() => {});
    }, 500));
  }
  async function storedBase(rel) {
    if (lastSynced.has(rel)) return lastSynced.get(rel);
    if (!api.liveBase) return null;
    try { return await api.liveBase.get(projectId, branchKey, fileKeyFor(rel)); } catch { return null; }
  }

  // ---------- live documents (shared by editors and background sync) ----------
  function acquire(rel, seedText = '') {
    let d = docs.get(rel);
    if (!d) {
      const ydoc = new Y.Doc();
      const provider = new FirebaseProvider({ projectId, branchKey, fileKey: fileKeyFor(rel), seedText }, ydoc, { onDenied, db });
      d = { ydoc, provider, refs: 0, writeTimer: null, markedLive: false };
      const ytext = ydoc.getText('monaco');
      // teammates' changes → disk
      d.observer = (_e, tr) => { if (tr.origin === provider) scheduleWrite(rel, d); };
      ytext.observe(d.observer);
      // my changes (typing or a disk edit) → mark the file live on this branch
      d.onUpdate = (_u, origin) => { if (origin !== provider && origin !== RESET && !d.markedLive && canEdit) { d.markedLive = true; markLive(rel, 'file'); } };
      ydoc.on('update', d.onUpdate);
      docs.set(rel, d);
    }
    d.refs++;
    return d;
  }

  function release(rel) {
    const d = docs.get(rel);
    if (!d || --d.refs > 0) return;
    clearTimeout(d.writeTimer);
    d.ydoc.getText('monaco').unobserve(d.observer);
    d.ydoc.off('update', d.onUpdate);
    d.provider.destroy();
    d.ydoc.destroy();
    docs.delete(rel);
  }

  function scheduleWrite(rel, d) {
    clearTimeout(d.writeTimer);
    d.writeTimer = setTimeout(() => writeDisk(rel, d.ydoc.getText('monaco').toString()), WRITE_DEBOUNCE_MS);
  }

  async function writeDisk(rel, text) {
    if (disposed || lastSynced.get(rel) === text) return;
    // An edit made on disk that hasn't been picked up yet must not be
    // overwritten: merge it into the live doc first, then write the result.
    const d = docs.get(rel);
    if (d && lastSynced.has(rel) && lastSynced.get(rel) !== null) {
      let cur = null;
      try { cur = await api.readFile(abs(rel)); } catch { /* missing */ }
      const base = lastSynced.get(rel);
      if (cur !== null && cur !== base && isText(cur)) {
        clearTimeout(diskTimers.get(rel));
        diskTimers.delete(rel);
        setSynced(rel, cur);
        mergeLocalEdit(d.ydoc.getText('monaco'), base, cur, LOCAL);
        text = d.ydoc.getText('monaco').toString();
        if (text === cur) return;
      }
    }
    setSynced(rel, text);
    try { await api.writeFile(abs(rel), text); } catch (err) { console.warn('[live] write failed', rel, err?.message || err); }
  }

  // ---------- the branch index ----------
  function entryFor(kind, state, rel) { return { path: rel, kind, state, by: uid, client, at: Date.now() }; }

  function markLive(rel, kind) {
    if (!canEdit) return;
    const cur = index.get(rel);
    if (cur?.state === 'live' && cur.kind === kind) return;
    const e = entryFor(kind, 'live', rel);
    index.set(rel, e);
    set(child(filesRef, fileKeyFor(rel)), e).catch((err) => console.warn('[live] index', err?.message || err));
  }

  async function markDeleted(rel) {
    if (!canEdit) return;
    const kind = index.get(rel)?.kind || 'file';
    const e = entryFor(kind, 'deleted', rel);
    index.set(rel, e);
    await set(child(filesRef, fileKeyFor(rel)), e).catch(() => {});
    // the doc goes too, so re-creating the file later starts fresh
    remove(ref(db, `${base}/docs/${fileKeyFor(rel)}`)).catch(() => {});
  }

  async function applyEntry(e) {
    if (!e?.path || !isSharedPath(e.path) || disposed) return;
    index.set(e.path, e);
    const rel = e.path;
    if (e.state === 'deleted') {
      if (e.client === client) return;
      if (backgrounds.has(rel)) { backgrounds.delete(rel); release(rel); }
      setSynced(rel, null);
      try { if (await api.trashEntry(abs(rel))) toast?.(`${rel} was deleted by a teammate (moved to the Recycle Bin)`); } catch { /* gone */ }
      return;
    }
    if (e.kind === 'dir') {
      try { await api.createDirectory(abs(rel)); } catch { /* exists */ }
      return;
    }
    ensureBackground(rel);
  }

  // Keep a file's live doc synced to disk even when no editor has it open.
  async function ensureBackground(rel) {
    if (backgrounds.has(rel)) return;
    backgrounds.add(rel);
    let disk = null;
    try { disk = await api.readFile(abs(rel)); } catch { /* not on this disk yet */ }
    const d = acquire(rel, isText(disk) ? disk : '');
    await reconcile(rel, d, disk);
  }

  // Bring disk and the live doc together when a file joins sync:
  // - disk unchanged since we were last in sync → take the live version;
  // - changed here while away (closed/offline) → merge with the team's edits;
  // - an unknown local copy → back it up, then take the live version.
  async function reconcile(rel, d, disk) {
    const live = await Promise.race([d.provider.firstState, d.provider.noLiveDocYet]);
    if (disposed || !live || !docs.has(rel)) return;
    const ytext = d.ydoc.getText('monaco');
    const text = ytext.toString();
    if (disk === null || disk === text) { await writeDisk(rel, text); return; }
    const agreed = await storedBase(rel);
    if (canEdit && typeof agreed === 'string' && disk !== agreed) {
      mergeLocalEdit(ytext, agreed, disk, LOCAL);
      setSynced(rel, disk);
      await writeDisk(rel, ytext.toString());
      toast?.(`Merged the changes you made to ${rel} while away with the live session`);
      return;
    }
    if (agreed !== disk) {
      try {
        const saved = await api.backupFile(projectId, rel, disk);
        toast?.(`${rel} was updated from the live session. Your previous copy was backed up to ${saved}`);
      } catch { /* best effort */ }
    }
    await writeDisk(rel, text);
  }

  // ---------- Git: commits retire live files; files without live edits follow Git ----------
  function dropEntry(rel) {
    index.delete(rel);
    const d = docs.get(rel);
    if (d) d.markedLive = false; // the next edit makes it live again
    if (backgrounds.has(rel)) { backgrounds.delete(rel); release(rel); }
  }

  // A live file whose text is now exactly the last commit has nothing
  // uncommitted left: it leaves the live session (for everyone).
  async function retireIfClean(rel) {
    if (!isGit || !canEdit || disposed) return;
    const e = index.get(rel);
    if (!e || e.kind !== 'file' || e.state !== 'live') return;
    const head = await api.headContent(root, rel);
    if (head === null) return;
    const d = docs.get(rel);
    const live = d ? d.ydoc.getText('monaco').toString() : null;
    let disk = null;
    try { disk = await api.readFile(abs(rel)); } catch { /* missing */ }
    if (sameText(disk, head) && (live === null || sameText(live, head))) {
      dropEntry(rel);
      remove(child(filesRef, fileKeyFor(rel))).catch(() => {});
    }
  }

  // After Git moved HEAD on this branch (commit, pull, reset, stash…):
  // live edits always win; files without live edits follow Git.
  let gitMoveTimer = null;
  async function afterGitMove() {
    if (disposed) return;
    if (api.currentBranch) {
      const now = await api.currentBranch(root).catch(() => branch);
      if (now !== branch || disposed) return; // a branch switch: a new session takes over
    }
    for (const [rel, d] of [...docs]) {
      let disk = null;
      try { disk = await api.readFile(abs(rel)); } catch { /* missing */ }
      const ytext = d.ydoc.getText('monaco');
      const live = ytext.toString();
      if (disk === null || !isText(disk) || sameText(disk, live)) continue;
      if (index.get(rel)?.state === 'live' && canEdit) {
        setSynced(rel, disk);
        await writeDisk(rel, live);
        toast?.(`Git changed ${rel}, but it has live edits from the team, so the live version was kept.`);
      } else {
        setSynced(rel, disk);
        applyTextDiff(ytext, disk, RESET);
      }
    }
    for (const rel of [...index.keys()]) await retireIfClean(rel);
  }

  // Files changed here while MulTeam was closed (Git projects): share them.
  async function shareChangedFiles() {
    let changed;
    let known;
    try { changed = await api.changedFiles(root); } catch { return; }
    try { known = new Map(Object.values((await get(filesRef)).val() || {}).map((e) => [e.path, e])); } catch { return; }
    for (const rel of changed) {
      if (disposed) return;
      if (!isSharedPath(rel) || known.has(rel)) continue;
      await processDiskChange(rel);
    }
  }

  // ---------- projects without Git: the whole tree is live ----------
  // Every shared text file the session doesn't know yet is shared once.
  // Files a teammate deleted (index: deleted) are not brought back.
  async function shareWholeTree() {
    let known;
    try { known = new Map(Object.values((await get(filesRef)).val() || {}).map((e) => [e.path, e])); } catch { return; }
    let listing;
    try { listing = await api.listFiles(root); } catch { return; }
    const rels = listing.files.map((f) => String(f).split('\\').join('/')).filter(isSharedPath);
    if (rels.length > MAX_TREE_FILES || listing.truncated) {
      toast?.(`This project has ${rels.length}+ files, too many to sync without Git (limit ${MAX_TREE_FILES}). Put it in a Git repository to share it.`, 'error');
      return;
    }
    const todo = rels.filter((rel) => !known.has(rel));
    let shared = 0;
    const worker = async () => {
      while (todo.length && !disposed) {
        const rel = todo.shift();
        let text;
        try { text = await api.readFile(abs(rel)); } catch { continue; }
        if (!isText(text) || backgrounds.has(rel)) continue;
        setSynced(rel, text);
        backgrounds.add(rel);
        const d = acquire(rel, text);
        await d.provider.synced;
        if (disposed) return;
        if (!d.markedLive) { d.markedLive = true; markLive(rel, 'file'); }
        await reconcile(rel, d, text); // someone may have shared it first
        shared++;
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    if (shared && !disposed) toast?.(`Shared ${shared} file${shared === 1 ? '' : 's'} with the project`);
  }

  unsubs.push(onChildAdded(filesRef, (snap) => applyEntry(snap.val()), (err) => onDenied?.(err)));
  unsubs.push(onChildChanged(filesRef, (snap) => applyEntry(snap.val())));
  unsubs.push(onChildRemoved(filesRef, (snap) => { const e = snap.val(); if (e?.path) dropEntry(e.path); }));
  const treeShared = !canEdit ? Promise.resolve()
    : !isGit ? shareWholeTree()
      : api.changedFiles ? shareChangedFiles() : Promise.resolve();

  // ---------- local disk → team ----------
  function onDiskEvent({ filename, git }) {
    if (disposed) return;
    if (git) {
      lastGitSignal = Date.now();
      clearTimeout(gitMoveTimer);
      gitMoveTimer = setTimeout(afterGitMove, 1500);
      return;
    }
    if (!filename || !canEdit) return;
    const rel = String(filename).split('\\').join('/');
    if (!isSharedPath(rel)) return;
    clearTimeout(diskTimers.get(rel));
    diskTimers.set(rel, setTimeout(() => { diskTimers.delete(rel); processDiskChange(rel); }, DISK_DEBOUNCE_MS));
  }

  async function processDiskChange(rel) {
    if (disposed) return;
    const gitBusy = Date.now() - lastGitSignal < GIT_QUIET_MS;
    let text = null;
    let isDir = false;
    try { text = await api.readFile(abs(rel)); } catch {
      try { await api.readDir(abs(rel)); isDir = true; } catch { /* missing */ }
    }
    if (isDir) {
      if (!gitBusy && !index.has(rel)) markLive(rel, 'dir');
      return;
    }
    if (text === null) {
      // gone: share the delete only if it was something we knew about
      const known = lastSynced.has(rel) ? lastSynced.get(rel) !== null : index.get(rel)?.state === 'live';
      setSynced(rel, null);
      if (!known || gitBusy) return;
      if (backgrounds.has(rel)) { backgrounds.delete(rel); release(rel); }
      await markDeleted(rel);
      return;
    }
    if (!isText(text) || lastSynced.get(rel) === text) return;
    // Right after a Git HEAD move this is probably Git's own write: look again
    // once Git is quiet. By then afterGitMove has dealt with open files, and a
    // file that matches the last commit isn't shared (below) — so only real
    // edits made in that window go out, and none are lost.
    if (gitBusy) {
      clearTimeout(diskTimers.get(rel));
      diskTimers.set(rel, setTimeout(() => { diskTimers.delete(rel); processDiskChange(rel); }, GIT_QUIET_MS));
      return;
    }
    const d = docs.get(rel);
    if (d) {
      const base = lastSynced.get(rel);
      setSynced(rel, text);
      mergeLocalEdit(d.ydoc.getText('monaco'), base, text, LOCAL);
      // teammates' edits that arrived meanwhile go back to disk too
      if (d.ydoc.getText('monaco').toString() !== text) scheduleWrite(rel, d);
      if (isGit) setTimeout(() => retireIfClean(rel), 1000);
      return;
    }
    // A file with no live doc yet: unchanged from the last commit = nothing to share
    if (isGit && index.get(rel)?.state !== 'live') {
      const head = await api.headContent(root, rel);
      if (head === text) { setSynced(rel, text); return; }
    }
    setSynced(rel, text);
    backgrounds.add(rel);
    const nd = acquire(rel, text);
    await nd.provider.synced;
    if (disposed) return;
    const live = await Promise.race([nd.provider.firstState, new Promise((r) => setTimeout(() => r(false), 6000))]);
    if (live) applyTextDiff(nd.ydoc.getText('monaco'), text, LOCAL);
    if (!nd.markedLive) { nd.markedLive = true; markLive(rel, 'file'); }
  }

  return {
    branch,
    branchKey,
    acquire,
    release,
    // MulTeam wrote this text itself (save/autosave): not a new external change
    noteWritten: (rel, text) => setSynced(rel, text),
    onDiskEvent,
    isShared: isSharedPath,
    treeShared,
    dispose() {
      disposed = true;
      clearTimeout(gitMoveTimer);
      for (const t of baseTimers.values()) clearTimeout(t);
      unsubs.forEach((u) => { try { u(); } catch { /* */ } });
      for (const t of diskTimers.values()) clearTimeout(t);
      for (const rel of [...backgrounds]) release(rel);
      backgrounds.clear();
    },
    // for tests/diagnostics
    _state: () => ({ docs: [...docs.keys()], backgrounds: [...backgrounds], index: [...index.values()] })
  };
}
