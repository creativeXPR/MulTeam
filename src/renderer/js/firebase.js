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
  deleteDoc,
  serverTimestamp
} from 'firebase/firestore';
import { getDatabase, ref, onValue } from 'firebase/database';
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
  return projectId;
}

export async function deleteCloudProject(projectId, ownerId) {
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
