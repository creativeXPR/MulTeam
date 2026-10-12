import { initializeApp } from 'firebase/app';
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as firebaseSignOut,
  updateProfile
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
  serverTimestamp
} from 'firebase/firestore';
import { getDatabase, ref, onValue, get, set, remove } from 'firebase/database';
import { isSupported as analyticsIsSupported, getAnalytics } from 'firebase/analytics';
import { firebaseConfig, FIRESTORE_DATABASE_ID } from './firebaseConfig.js';
import { COLLECTIONS, ROLES } from '../../shared/constants.js';

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const firestore = getFirestore(app, FIRESTORE_DATABASE_ID);
export const rtdb = getDatabase(app);

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

export function signOut() {
  return firebaseSignOut(auth);
}

// Lives at users/{ownerId}/projects/{projectId} rather than a top-level
// collection — projectId is the *local* registry id (see main/projects.js)
// so a cloud-enabled project's local record and Firestore doc share one id.
// bootstrapFiles is a stub for now (meant to eventually hold manifest
// contents like package.json so a collaborator's machine can set itself up).
export async function createCloudProject(projectId, name, ownerId) {
  const projectRef = doc(firestore, COLLECTIONS.USERS, ownerId, COLLECTIONS.PROJECTS, projectId);
  await setDoc(projectRef, {
    name,
    ownerId,
    collaborators: { [ownerId]: ROLES.OWNER },
    bootstrapFiles: {},
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
  await ensureLiveMembership(projectId, ownerId);
  return projectId;
}

// Realtime Database rules can't read Firestore, so live-edit access is
// checked against a mirror: projectMembers/{projectId}/{uid} = role. The
// owner creates it (and, from stage 1, keeps it in step with invites).
// For cloud projects made before the mirror existed, the owner back-fills
// it the first time they open the project.
const liveMembership = new Map();
export function ensureLiveMembership(projectId, uid) {
  const key = `${projectId}/${uid}`;
  if (!liveMembership.has(key)) {
    liveMembership.set(key, (async () => {
      try {
        const mine = await get(ref(rtdb, `projectMembers/${projectId}/${uid}`));
        if (mine.exists()) return mine.val();
      } catch { /* not readable = not a member yet */ }
      // only the owner of the Firestore project may claim ownership
      const owned = await getDoc(doc(firestore, COLLECTIONS.USERS, uid, COLLECTIONS.PROJECTS, projectId));
      if (!owned.exists()) return null;
      await set(ref(rtdb, `projectMembers/${projectId}`), { [uid]: ROLES.OWNER });
      return ROLES.OWNER;
    })().catch((err) => { liveMembership.delete(key); throw err; }));
  }
  return liveMembership.get(key);
}

export async function deleteCloudProject(projectId, ownerId) {
  // live docs first (needs the owner's membership), then the mirror, then Firestore
  try {
    await remove(ref(rtdb, `projects/${projectId}`));
    await remove(ref(rtdb, `projectMembers/${projectId}`));
  } catch (err) { console.warn('[cloud] live data cleanup skipped:', err?.message || err); }
  liveMembership.delete(`${projectId}/${ownerId}`);
  const projectRef = doc(firestore, COLLECTIONS.USERS, ownerId, COLLECTIONS.PROJECTS, projectId);
  await deleteDoc(projectRef);
}

export async function upsertDocumentMeta(docId, { projectId, ownerId, path, language, userId }) {
  await setDoc(
    doc(firestore, COLLECTIONS.DOCUMENTS, docId),
    { projectId, ownerId, path, language, lastSavedBy: userId, updatedAt: serverTimestamp() },
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
