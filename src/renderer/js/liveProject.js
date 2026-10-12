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
import { ref, child, onChildAdded, onChildChanged, set, remove } from 'firebase/database';
import { rtdb } from './firebase.js';
import { FirebaseProvider, fileKeyFor } from './sync.js';

// Not shared: VCS/deps/build output/caches, secrets, OS junk.
const IGNORED_DIR = /(^|\/)(\.git|node_modules|dist|build|out|\.next|\.nuxt|\.svelte-kit|coverage|\.cache|\.parcel-cache|\.turbo|__pycache__|\.venv|venv|env|target|bin|obj|\.idea|\.vs)(\/|$)/i;
const IGNORED_FILE = /(^|\/)(\.env(\..*)?|\.DS_Store|Thumbs\.db|desktop\.ini|.*\.log|.*\.swp|.*~)$/i;
export const MAX_LIVE_BYTES = 512 * 1024;
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
      d.onUpdate = (_u, origin) => { if (origin !== provider && !d.markedLive && canEdit) { d.markedLive = true; markLive(rel, 'file'); } };
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
    lastSynced.set(rel, text);
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
      lastSynced.set(rel, null);
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
    const live = await Promise.race([d.provider.firstState, d.provider.noLiveDocYet]);
    if (disposed || !live || !docs.has(rel)) return;
    const text = d.ydoc.getText('monaco').toString();
    if (disk !== null && disk !== text && lastSynced.get(rel) !== disk) {
      // my copy differs and I haven't synced it: keep it before replacing
      try {
        const saved = await api.backupFile(projectId, rel, disk);
        toast?.(`${rel} was updated from the live session. Your previous copy was backed up to ${saved}`);
      } catch { /* best effort */ }
    }
    await writeDisk(rel, text);
  }

  unsubs.push(onChildAdded(filesRef, (snap) => applyEntry(snap.val()), (err) => onDenied?.(err)));
  unsubs.push(onChildChanged(filesRef, (snap) => applyEntry(snap.val())));

  // ---------- local disk → team ----------
  function onDiskEvent({ filename, git }) {
    if (disposed) return;
    if (git) { lastGitSignal = Date.now(); return; }
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
      lastSynced.set(rel, null);
      if (!known || gitBusy) return;
      if (backgrounds.has(rel)) { backgrounds.delete(rel); release(rel); }
      await markDeleted(rel);
      return;
    }
    if (!isText(text) || lastSynced.get(rel) === text) return;
    if (gitBusy) { lastSynced.set(rel, text); return; } // Git wrote it
    const d = docs.get(rel);
    if (d) {
      lastSynced.set(rel, text);
      applyTextDiff(d.ydoc.getText('monaco'), text, LOCAL);
      return;
    }
    // A file with no live doc yet: unchanged from the last commit = nothing to share
    if (isGit && index.get(rel)?.state !== 'live') {
      const head = await api.headContent(root, rel);
      if (head === text) { lastSynced.set(rel, text); return; }
    }
    lastSynced.set(rel, text);
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
    noteWritten: (rel, text) => lastSynced.set(rel, text),
    onDiskEvent,
    isShared: isSharedPath,
    dispose() {
      disposed = true;
      unsubs.forEach((u) => { try { u(); } catch { /* */ } });
      for (const t of diskTimers.values()) clearTimeout(t);
      for (const rel of [...backgrounds]) release(rel);
      backgrounds.clear();
    },
    // for tests/diagnostics
    _state: () => ({ docs: [...docs.keys()], backgrounds: [...backgrounds], index: [...index.values()] })
  };
}
