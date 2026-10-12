// Realtime Database-backed Yjs provider.
//
// There's no official `y-firebase` package, so this implements the same
// contract as the community Yjs providers (y-webrtc, y-websocket): apply
// remote updates as they arrive, broadcast local updates, and mirror the
// same transport for awareness (presence/cursors).
//
// Layout (see firebase/database.rules.json — members of the project only):
//   projects/{projectId}/b/{branchKey}/docs/{fileKey}/snapshot      merged Yjs state
//   projects/{projectId}/b/{branchKey}/docs/{fileKey}/updates/{id}  updates since the snapshot
//   projects/{projectId}/b/{branchKey}/docs/{fileKey}/awareness/{clientId}
// (each Git branch has its own live session; projects without Git use one)
//
// Safety:
// - Seeding: a file's live doc is created from disk exactly once, by a
//   transaction on `snapshot` — two people opening it at the same moment
//   can't both insert the text (which would duplicate it).
// - Compaction merges into the CURRENT snapshot (transaction) and deletes
//   only the update entries this client has applied, so edits that arrive
//   meanwhile, or another client compacting at the same time, lose nothing.
// - Every client follows `snapshot` live, so an update compacted between
//   loading and subscribing is still received (Yjs updates are idempotent).
import * as Y from 'yjs';
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import { ref, push, set, get, update, child, onChildAdded, onValue, off, onDisconnect, runTransaction } from 'firebase/database';
import { rtdb } from './firebase.js';

const COMPACT_AFTER_UPDATES = 200;

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromBase64(str) {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Firebase keys can't contain . # $ [ ] / — encode a project-relative path
// REVERSIBLY (so "a/b.js" and "a_b.js" never share a live document).
export function fileKeyFor(relativePath) {
  return encodeURIComponent(String(relativePath).replace(/\\/g, '/'))
    .replace(/[.!~*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%/g, '~');
}

export class FirebaseProvider {
  // seedText: the file's text on disk, used only if nobody has a live doc yet
  constructor({ projectId, branchKey, fileKey, seedText = '' }, ydoc, { onDenied, db = rtdb } = {}) {
    this.doc = ydoc;
    this.awareness = new Awareness(ydoc);
    this.connected = false;
    this.onDenied = onDenied;

    this.docRef = ref(db, `projects/${projectId}/b/${branchKey}/docs/${fileKey}`);
    this.updatesRef = child(this.docRef, 'updates');
    this.snapshotRef = child(this.docRef, 'snapshot');
    this.awarenessRef = child(this.docRef, 'awareness');

    this._appliedKeys = new Set(); // update entries already reflected in this.doc
    this._compacting = false;
    this._destroyed = false;
    this._clientAwarenessRef = null;

    this._onDocUpdate = this._onDocUpdate.bind(this);
    this._onAwarenessUpdate = this._onAwarenessUpdate.bind(this);

    // resolves (true) once the live doc has content — right away for an
    // existing doc or one this client seeded; later for a viewer opening a
    // file no editor has opened yet (viewers can't create live docs)
    this.hasState = false;
    this.firstState = new Promise((resolve) => { this._resolveFirstState = resolve; });
    // resolves false as soon as it's known there's no live doc yet and this
    // client can't create one (a viewer) — no need to wait for a timeout
    this.noLiveDocYet = new Promise((resolve) => { this._resolveNoLiveDoc = resolve; });
    this.synced = this._connect(seedText).catch((err) => this._denied(err));
  }

  _gotState() {
    if (this.hasState) return;
    this.hasState = true;
    this._resolveFirstState(true);
  }

  _denied(err) {
    if (this._destroyed) return;
    console.warn('[sync] live document unavailable:', err?.message || err);
    this.onDenied?.(err);
  }

  async _seedIfNew(seedText) {
    const [snap, updates] = await Promise.all([get(this.snapshotRef), get(this.updatesRef)]);
    if (snap.exists() || updates.exists()) return true;
    const seed = new Y.Doc();
    if (seedText) seed.getText('monaco').insert(0, seedText);
    const state = toBase64(Y.encodeStateAsUpdate(seed));
    seed.destroy();
    // only the first writer wins; everyone else aborts and receives theirs.
    // Viewers aren't allowed to create it — they wait for an editor.
    try {
      await runTransaction(this.snapshotRef, (cur) => (cur ? undefined : { state, updatedAt: Date.now() }));
      return true;
    } catch (err) {
      if (!/permission/i.test(err?.message || '')) throw err;
      return false;
    }
  }

  async _connect(seedText) {
    const exists = await this._seedIfNew(seedText);
    if (this._destroyed) return;
    if (!exists) this._resolveNoLiveDoc(false);

    const fail = (err) => this._denied(err);
    onValue(this.snapshotRef, (snap) => {
      const v = snap.val();
      if (v?.state) { Y.applyUpdate(this.doc, fromBase64(v.state), this); this._gotState(); }
    }, fail);

    // Firebase fires onChildAdded once per existing child on attach, then live.
    onChildAdded(this.updatesRef, (snap) => {
      const { state, origin } = snap.val() || {};
      this._appliedKeys.add(snap.key);
      if (origin !== this.doc.clientID && state) Y.applyUpdate(this.doc, fromBase64(state), this);
      this._gotState();
      this._maybeCompact();
    }, fail);

    onValue(this.awarenessRef, (snap) => {
      const val = snap.val() || {};
      for (const clientId of Object.keys(val)) {
        if (Number(clientId) === this.doc.clientID) continue;
        try { applyAwarenessUpdate(this.awareness, fromBase64(val[clientId]), this); } catch { /* malformed entry */ }
      }
    }, fail);

    this.doc.on('update', this._onDocUpdate);
    this.awareness.on('update', this._onAwarenessUpdate);

    this._clientAwarenessRef = child(this.awarenessRef, String(this.doc.clientID));
    onDisconnect(this._clientAwarenessRef).remove();

    this.connected = true;
  }

  _onDocUpdate(updateBytes, origin) {
    if (origin === this) return; // came from a remote apply, don't echo it back
    const r = push(this.updatesRef, { state: toBase64(updateBytes), origin: this.doc.clientID });
    this._appliedKeys.add(r.key);
    r.catch((err) => this._denied(err));
  }

  _onAwarenessUpdate({ added, updated, removed }, origin) {
    if (origin === this || !this._clientAwarenessRef) return;
    const changed = added.concat(updated, removed);
    const enc = encodeAwarenessUpdate(this.awareness, changed);
    const value = removed.length && changed.every((id) => removed.includes(id)) ? null : toBase64(enc);
    set(this._clientAwarenessRef, value).catch(() => { /* viewers/offline: presence is best-effort */ });
  }

  async _maybeCompact() {
    if (this._compacting || this._appliedKeys.size < COMPACT_AFTER_UPDATES) return;
    this._compacting = true;
    // a little jitter so peers seeing the same count don't all compact at once
    await new Promise((r) => setTimeout(r, Math.random() * 3000));
    try {
      if (this._destroyed || this._appliedKeys.size < COMPACT_AFTER_UPDATES) return;
      const keys = [...this._appliedKeys];
      const ours = Y.encodeStateAsUpdate(this.doc);
      await runTransaction(this.snapshotRef, (cur) => {
        const merged = cur?.state ? Y.mergeUpdates([fromBase64(cur.state), ours]) : ours;
        return { state: toBase64(merged), updatedAt: Date.now() };
      });
      await update(this.updatesRef, Object.fromEntries(keys.map((k) => [k, null])));
      for (const k of keys) this._appliedKeys.delete(k);
    } catch (err) {
      console.warn('[sync] compaction skipped:', err?.message || err); // viewers can't compact; harmless
    } finally {
      this._compacting = false;
    }
  }

  destroy() {
    this._destroyed = true;
    this._resolveFirstState(false);
    this.doc.off('update', this._onDocUpdate);
    this.awareness.off('update', this._onAwarenessUpdate);

    off(this.snapshotRef);
    off(this.updatesRef);
    off(this.awarenessRef);

    removeAwarenessStates(this.awareness, [this.doc.clientID], this);
    if (this._clientAwarenessRef) set(this._clientAwarenessRef, null).catch(() => {});

    this.connected = false;
  }
}
