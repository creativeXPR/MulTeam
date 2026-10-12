import { initializeApp } from 'firebase/app';
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as firebaseSignOut,
  updateProfile,
  sendEmailVerification,
  connectAuthEmulator,
  signInWithCredential
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  getDocs,
  deleteDoc,
  updateDoc,
  collection,
  query,
  orderBy,
  limit,
  writeBatch,
  increment,
  serverTimestamp,
  addDoc,
  where,
  onSnapshot,
  Timestamp,
  connectFirestoreEmulator
} from 'firebase/firestore';
import { getFunctions, httpsCallable, connectFunctionsEmulator } from 'firebase/functions';
import { getDatabase, ref, onValue, get, set, remove, connectDatabaseEmulator } from 'firebase/database';
import { isSupported as analyticsIsSupported, getAnalytics } from 'firebase/analytics';
import { firebaseConfig, FIRESTORE_DATABASE_ID } from './firebaseConfig.js';
import { COLLECTIONS, ROLES } from '../../shared/constants.js';

// Developer/test mode: localStorage 'multeam:emulators' = '1' points the app
// at the local Firebase emulators (npm run test:members ports) instead of
// production. Never set by the app itself.
const EMULATORS = (() => { try { return localStorage.getItem('multeam:emulators') === '1'; } catch { return false; } })();
const app = initializeApp(EMULATORS
  ? { ...firebaseConfig, projectId: 'demo-multeam', databaseURL: 'http://127.0.0.1:9411?ns=demo-multeam' }
  : firebaseConfig);
export const auth = getAuth(app);
export const firestore = getFirestore(app, FIRESTORE_DATABASE_ID);
export const rtdb = getDatabase(app);
if (EMULATORS) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9109', { disableWarnings: true });
  connectFirestoreEmulator(firestore, '127.0.0.1', 8187);
  connectDatabaseEmulator(rtdb, '127.0.0.1', 9411);
  console.info('[firebase] using local emulators');
}

// Analytics assumes a real browser (cookies, gtag, etc.) and isn't reliably
// supported inside an Electron renderer — isSupported() resolves false
// there instead of throwing, so this just quietly no-ops in that case.
analyticsIsSupported().then((supported) => {
  if (supported) getAnalytics(app);
});

// Realtime Database's built-in `.info/connected` flag — true only while the
// SDK holds a live socket to Firebase, so it reflects whether cloud sync can
// actually reach the server (navigator.onLine only knows about the adapter).
export function watchCloudConnection(callback) {
  return onValue(ref(rtdb, '.info/connected'), (snap) => callback(snap.val() === true));
}

export function watchAuthState(callback) {
  return onAuthStateChanged(auth, callback);
}

export async function signIn(email, password) {
  const { user } = await signInWithEmailAndPassword(auth, email, password);
  return user;
}

export async function signUp(email, password, displayName) {
  const { user } = await createUserWithEmailAndPassword(auth, email, password);
  if (displayName) await updateProfile(user, { displayName });
  // invites can only be accepted with a verified email
  sendEmailVerification(user).catch(() => {});

  await setDoc(doc(firestore, COLLECTIONS.USERS, user.uid), {
    uid: user.uid,
    displayName: displayName || '',
    email: user.email,
    photoURL: user.photoURL || '',
    createdAt: serverTimestamp()
  });

  return user;
}

export async function signInWithGoogle() {
  const { user } = await signInWithPopup(auth, new GoogleAuthProvider());

  const userRef = doc(firestore, COLLECTIONS.USERS, user.uid);
  if (!(await getDoc(userRef)).exists()) {
    await setDoc(userRef, {
      uid: user.uid,
      displayName: user.displayName || '',
      email: user.email,
      photoURL: user.photoURL || '',
      createdAt: serverTimestamp()
    });
  }

  return user;
}

// Emulator mode only: sign in as a test account (the Auth emulator accepts
// a fake Google credential).
export async function signInForTests({ uid, email, name }) {
  if (!EMULATORS) throw new Error('Only available with the emulators.');
  return (await signInWithCredential(auth, GoogleAuthProvider.credential(JSON.stringify({ sub: uid, email, email_verified: true, name })))).user;
}
if (EMULATORS) window.__multeamTest = { signIn: signInForTests };

export function signOut() {
  return firebaseSignOut(auth);
}

// ------------------------------------------------------------------
// Cloud projects + members (collaboration stage 1)
//   projects/{projectId}   { name, ownerId, repoUrl, members: { uid: { role,
//                            name, email, photo, joinedAt } }, memberUids }
// projectId is the LOCAL registry id (main/projects.js) for the owner; people
// who join link a local folder to the same id. Membership changes go through
// the Cloud Functions (functions/index.js), which also mirror roles into
// RTDB projectMembers/{projectId} for the live-edit rules.
// ------------------------------------------------------------------
const functions = getFunctions(app, 'europe-west1');
if (EMULATORS) connectFunctionsEmulator(functions, '127.0.0.1', 5011);
const callable = (name) => {
  const fn = httpsCallable(functions, name);
  return async (data) => {
    try { return (await fn(data)).data; } catch (err) { throw new Error(err?.message || String(err)); }
  };
};
export const cloudCalls = {
  acceptInvite: callable('acceptInvite'),
  declineInvite: callable('declineInvite'),
  redeemCode: callable('redeemCode'),
  respondJoinRequest: callable('respondJoinRequest'),
  setMemberRole: callable('setMemberRole'),
  removeMember: callable('removeMember'),
  syncMembers: callable('syncMembers')
};

const projectDoc = (projectId) => doc(firestore, COLLECTIONS.PROJECTS, projectId);
const profileOf = (user) => ({ name: user.displayName || user.email || 'Someone', email: (user.email || '').toLowerCase(), photo: user.photoURL || '' });

export async function createCloudProject(projectId, name, owner) {
  await setDoc(projectDoc(projectId), {
    name,
    ownerId: owner.uid,
    repoUrl: '',
    members: { [owner.uid]: { role: ROLES.OWNER, ...profileOf(owner), joinedAt: serverTimestamp() } },
    memberUids: [owner.uid],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
  await ensureLiveMembership(projectId, owner.uid);
  return projectId;
}

// The project record, or null when it doesn't exist / you're not a member.
export async function getCloudProject(projectId) {
  try {
    const snap = await getDoc(projectDoc(projectId));
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
  } catch { return null; }
}

export function watchCloudProject(projectId, cb) {
  return onSnapshot(projectDoc(projectId), (snap) => cb(snap.exists() ? { id: snap.id, ...snap.data() } : null), () => cb(null));
}

// Every cloud project you're a member of (owned or joined).
export function watchMyCloudProjects(uid, cb) {
  return onSnapshot(query(collection(firestore, COLLECTIONS.PROJECTS), where('memberUids', 'array-contains', uid)),
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))), (err) => { console.warn('[cloud] projects:', err.message); cb([]); });
}

// Cloud projects made before members/invites lived at users/{uid}/projects;
// the owner moves theirs to projects/{id} the first time they open it.
const migrated = new Map();
export function migrateLegacyCloudProject(projectId, user) {
  if (!migrated.has(projectId)) {
    migrated.set(projectId, (async () => {
      const legacyRef = doc(firestore, COLLECTIONS.USERS, user.uid, COLLECTIONS.PROJECTS, projectId);
      let legacy;
      try { legacy = await getDoc(legacyRef); } catch { return false; }
      if (!legacy.exists()) return false;
      if (!(await getCloudProject(projectId))) {
        await setDoc(projectDoc(projectId), {
          name: legacy.data().name || 'Project',
          ownerId: user.uid,
          repoUrl: '',
          members: { [user.uid]: { role: ROLES.OWNER, ...profileOf(user), joinedAt: serverTimestamp() } },
          memberUids: [user.uid],
          createdAt: legacy.data().createdAt || serverTimestamp(),
          updatedAt: serverTimestamp()
        });
      }
      await deleteDoc(legacyRef);
      return true;
    })().catch((err) => { migrated.delete(projectId); throw err; }));
  }
  return migrated.get(projectId);
}

// Realtime Database rules can't read Firestore, so live-edit access is
// checked against a mirror: projectMembers/{projectId}/{uid} = role. The
// functions keep it in step with membership; the owner creates it when the
// project goes cloud (or back-fills it for older cloud projects).
// Resolves to your role (owner/editor/viewer) or null.
const liveMembership = new Map();
export function ensureLiveMembership(projectId, uid) {
  const key = `${projectId}/${uid}`;
  if (!liveMembership.has(key)) {
    liveMembership.set(key, (async () => {
      try {
        const mine = await get(ref(rtdb, `projectMembers/${projectId}/${uid}`));
        if (mine.exists()) return mine.val();
      } catch { /* not readable = not a member yet */ }
      const p = await getCloudProject(projectId);
      if (!p || p.ownerId !== uid) return null;
      await set(ref(rtdb, `projectMembers/${projectId}`), { [uid]: ROLES.OWNER });
      return ROLES.OWNER;
    })().catch((err) => { liveMembership.delete(key); throw err; }));
  }
  return liveMembership.get(key);
}
export function forgetLiveMembership(projectId, uid) { liveMembership.delete(`${projectId}/${uid}`); }

// Owner turns cloud off / deletes: live data, invites, links, then the record.
export async function deleteCloudProject(projectId, ownerId) {
  try {
    await remove(ref(rtdb, `projects/${projectId}`));
    await remove(ref(rtdb, `projectMembers/${projectId}`));
  } catch (err) { console.warn('[cloud] live data cleanup skipped:', err?.message || err); }
  liveMembership.delete(`${projectId}/${ownerId}`);
  const mine = (name) => query(collection(firestore, name), where('ownerId', '==', ownerId), where('projectId', '==', projectId));
  for (const name of ['invites', 'inviteLinks']) {
    try { for (const d of (await getDocs(mine(name))).docs) await deleteDoc(d.ref); } catch { /* best effort */ }
  }
  try { await deleteDoc(doc(firestore, COLLECTIONS.USERS, ownerId, COLLECTIONS.PROJECTS, projectId)); } catch { /* no legacy doc */ }
  try { await deleteDoc(projectDoc(projectId)); } catch (err) { if (!/permission|not.found/i.test(err.message)) throw err; }
}

// ---------- invites (owner side) ----------
export async function inviteByEmail(project, owner, email, role) {
  const clean = String(email).trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) throw new Error('Enter a valid email address.');
  if (clean === (owner.email || '').toLowerCase()) throw new Error("That's your own email.");
  if (Object.values(project.members || {}).some((m) => m.email === clean)) throw new Error('They are already a member.');
  await addDoc(collection(firestore, 'invites'), {
    projectId: project.id,
    projectName: project.name,
    ownerId: owner.uid,
    email: clean,
    role,
    status: 'pending',
    invitedBy: { uid: owner.uid, name: owner.displayName || owner.email || 'Someone' },
    createdAt: serverTimestamp()
  });
}

export function watchProjectInvites(projectId, ownerId, cb) {
  return onSnapshot(query(collection(firestore, 'invites'), where('ownerId', '==', ownerId), where('projectId', '==', projectId), where('status', '==', 'pending')),
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))), () => cb([]));
}

export const revokeInvite = (inviteId) => deleteDoc(doc(firestore, 'invites', inviteId));

// ---------- invite links / codes (owner side) ----------
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const newCode = () => Array.from(crypto.getRandomValues(new Uint32Array(8)), (n) => CODE_CHARS[n % CODE_CHARS.length]).join('');
export const formatCode = (code) => `${code.slice(0, 4)}-${code.slice(4)}`;

export async function createInviteLink(projectId, ownerId, { role = 'editor', expiresInDays = 7, requiresApproval = false } = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const code = newCode();
    try {
      await setDoc(doc(firestore, 'inviteLinks', code), {
        projectId,
        ownerId,
        role,
        requiresApproval: !!requiresApproval,
        revoked: false,
        expiresAt: expiresInDays ? Timestamp.fromMillis(Date.now() + expiresInDays * 86400000) : null,
        createdAt: serverTimestamp()
      });
      return code;
    } catch (err) {
      if (attempt === 3) throw err; // (a taken code fails the create rule — try another)
    }
  }
  return null;
}

export function watchInviteLinks(projectId, ownerId, cb) {
  return onSnapshot(query(collection(firestore, 'inviteLinks'), where('ownerId', '==', ownerId), where('projectId', '==', projectId)),
    (snap) => cb(snap.docs.map((d) => ({ code: d.id, ...d.data() })).filter((l) => !l.revoked)), () => cb([]));
}

export const revokeInviteLink = (code) => updateDoc(doc(firestore, 'inviteLinks', code), { revoked: true });

export function watchJoinRequests(projectId, cb) {
  return onSnapshot(collection(firestore, COLLECTIONS.PROJECTS, projectId, 'joinRequests'),
    (snap) => cb(snap.docs.map((d) => ({ uid: d.id, ...d.data() }))), () => cb([]));
}

// ---------- invites (invitee side) ----------
// Only verified emails can see/accept invites (otherwise anyone could sign
// up with a teammate's address and take their invite).
export function watchMyInvites(user, cb) {
  if (!user?.email || !user.emailVerified) { cb([]); return () => {}; }
  return onSnapshot(query(collection(firestore, 'invites'), where('email', '==', user.email.toLowerCase()), where('status', '==', 'pending')),
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))), () => cb([]));
}

export async function resendVerification() {
  if (auth.currentUser && !auth.currentUser.emailVerified) await sendEmailVerification(auth.currentUser);
}

// Picks up "verified" after the user clicks the link in their email.
export async function refreshUser() {
  if (!auth.currentUser) return null;
  await auth.currentUser.reload();
  await auth.currentUser.getIdToken(true);
  return auth.currentUser;
}

export async function upsertDocumentMeta(docId, { projectId, path, language, userId }) {
  await setDoc(
    doc(firestore, COLLECTIONS.DOCUMENTS, docId),
    { projectId, path, language, lastSavedBy: userId, updatedAt: serverTimestamp() },
    { merge: true }
  );
}

// ------------------------------------------------------------------
// Plugin gallery (Firestore, MulTeam's own database)
//   pluginGallery/{pluginId}                  listing — public to read
//   pluginGallery/{pluginId}/versions/{ver}   the .mtplugin (base64) + sha256,
//                                             immutable once published
// Only the first publisher of an id may publish new versions of it. Authors
// are shown by display name only (never email).
// ------------------------------------------------------------------
const GALLERY = 'pluginGallery';

export async function galleryList(max = 60) {
  const snap = await getDocs(query(collection(firestore, GALLERY), orderBy('downloads', 'desc'), limit(max)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function galleryVersion(pluginId, version) {
  const snap = await getDoc(doc(firestore, GALLERY, pluginId, 'versions', version));
  if (!snap.exists()) throw new Error('That version is no longer in the gallery.');
  return snap.data();
}

export async function galleryPublish({ manifest, base64, sha256, size, changelog = '' }) {
  const user = auth.currentUser;
  if (!user) throw new Error('Sign in to publish plugins.');
  const ref = doc(firestore, GALLERY, manifest.id);
  const existing = await getDoc(ref);
  if (existing.exists() && existing.data().authorUid !== user.uid) {
    throw new Error(`The id "${manifest.id}" already belongs to another publisher — change "id" in multeam-plugin.json.`);
  }
  const vref = doc(firestore, GALLERY, manifest.id, 'versions', manifest.version);
  if ((await getDoc(vref)).exists()) {
    throw new Error(`Version ${manifest.version} is already published — raise "version" in multeam-plugin.json first.`);
  }
  const batch = writeBatch(firestore);
  batch.set(ref, {
    name: manifest.name,
    description: manifest.description || '',
    authorUid: user.uid,
    authorName: user.displayName || 'MulTeam publisher',
    latestVersion: manifest.version,
    permissions: manifest.permissions || [],
    size,
    downloads: existing.exists() ? existing.data().downloads || 0 : 0,
    createdAt: existing.exists() ? existing.data().createdAt : serverTimestamp(),
    updatedAt: serverTimestamp()
  });
  batch.set(vref, {
    version: manifest.version,
    permissions: manifest.permissions || [],
    size,
    sha256,
    package: base64,
    changelog: String(changelog).slice(0, 2000),
    publishedAt: serverTimestamp()
  });
  await batch.commit();
}

export async function galleryCountDownload(pluginId) {
  try { await updateDoc(doc(firestore, GALLERY, pluginId), { downloads: increment(1) }); } catch { /* counting is best-effort */ }
}

export async function galleryUnpublish(pluginId) {
  const versions = await getDocs(collection(firestore, GALLERY, pluginId, 'versions'));
  const batch = writeBatch(firestore);
  versions.docs.forEach((v) => batch.delete(v.ref));
  batch.delete(doc(firestore, GALLERY, pluginId));
  await batch.commit();
}
