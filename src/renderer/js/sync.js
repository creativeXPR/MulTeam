// Realtime Database-backed Yjs provider.
//
// There's no official `y-firebase` package, so this implements the same
// contract as the community Yjs providers (y-webrtc, y-websocket): apply
// remote updates as they arrive, broadcast local updates, and mirror the
// same transport for awareness (presence/cursors). Document updates are
// appended under `docs/{docId}/updates` and periodically squashed into a
// single `docs/{docId}/snapshot` (see `compactIfNeeded`) so the update log
// doesn't grow unbounded for long-lived documents.
import * as Y from 'yjs';
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import {
  ref,
  push,
  set,
  get,
  child,
  onChildAdded,
  onValue,
  off,
  onDisconnect,
  serverTimestamp
} from 'firebase/database';
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

export class FirebaseProvider {
  constructor(docId, ydoc) {
    this.docId = docId;
    this.doc = ydoc;
    this.awareness = new Awareness(ydoc);
    this.connected = false;

    this.docRef = ref(rtdb, `docs/${docId}`);
    this.updatesRef = child(this.docRef, 'updates');
    this.snapshotRef = child(this.docRef, 'snapshot');
    this.awarenessRef = child(this.docRef, 'awareness');

    this._appliedUpdateCount = 0;
    this._clientAwarenessRef = null;

    this._onDocUpdate = this._onDocUpdate.bind(this);
    this._onAwarenessUpdate = this._onAwarenessUpdate.bind(this);

    this._connect();
  }

  async _connect() {
    const snapshotSnap = await get(this.snapshotRef);
    if (snapshotSnap.exists()) {
      Y.applyUpdate(this.doc, fromBase64(snapshotSnap.val().state), this);
    }

    // Stream in updates written after the snapshot was taken. Firebase
    // fires onChildAdded once per existing child on attach, then live.
    onChildAdded(this.updatesRef, (snap) => {
      const { state, origin } = snap.val();
      if (origin === this.doc.clientID) return;
      Y.applyUpdate(this.doc, fromBase64(state), this);
      this._appliedUpdateCount += 1;
      this._maybeCompact();
    });

    onValue(this.awarenessRef, (snap) => {
      const val = snap.val() || {};
      for (const clientId of Object.keys(val)) {
        if (Number(clientId) === this.doc.clientID) continue;
        applyAwarenessUpdate(this.awareness, fromBase64(val[clientId]), this);
      }
    });

    this.doc.on('update', this._onDocUpdate);
    this.awareness.on('update', this._onAwarenessUpdate);

    this._clientAwarenessRef = child(this.awarenessRef, String(this.doc.clientID));
    onDisconnect(this._clientAwarenessRef).remove();

    this.connected = true;
  }

  _onDocUpdate(update, origin) {
    if (origin === this) return; // came from a remote apply, don't echo it back
    push(this.updatesRef, { state: toBase64(update), origin: this.doc.clientID });
  }

  _onAwarenessUpdate({ added, updated, removed }, origin) {
    if (origin === this) return;
    const changed = added.concat(updated, removed);
    const update = encodeAwarenessUpdate(this.awareness, changed);

    if (removed.length && changed.every((id) => removed.includes(id))) {
      set(this._clientAwarenessRef, null);
    } else {
      set(this._clientAwarenessRef, toBase64(update));
    }
  }

  async _maybeCompact() {
    if (this._appliedUpdateCount < COMPACT_AFTER_UPDATES) return;
    this._appliedUpdateCount = 0;

    const state = Y.encodeStateAsUpdate(this.doc);
    await set(this.snapshotRef, { state: toBase64(state), updatedAt: serverTimestamp() });
    await set(this.updatesRef, null);
  }

  destroy() {
    this.doc.off('update', this._onDocUpdate);
    this.awareness.off('update', this._onAwarenessUpdate);

    off(this.updatesRef);
    off(this.awarenessRef);

    removeAwarenessStates(this.awareness, [this.doc.clientID], this);
    if (this._clientAwarenessRef) set(this._clientAwarenessRef, null);

    this.connected = false;
  }
}
