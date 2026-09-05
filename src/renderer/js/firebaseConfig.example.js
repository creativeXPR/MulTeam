// Copy this file to `firebaseConfig.js` (gitignored) and fill in the values
// from your Firebase project settings -> General -> "Your apps" -> SDK setup.
// Realtime Database is used as the Yjs signaling/relay transport (see sync.js),
// so `databaseURL` must point at a Realtime Database instance, not just Firestore.

export const firebaseConfig = {
  apiKey: 'REPLACE_ME',
  authDomain: 'REPLACE_ME.firebaseapp.com',
  projectId: 'REPLACE_ME',
  storageBucket: 'REPLACE_ME.appspot.com',
  messagingSenderId: 'REPLACE_ME',
  appId: 'REPLACE_ME',
  measurementId: 'REPLACE_ME',
  databaseURL: 'https://REPLACE_ME-default-rtdb.firebaseio.com'
};

// Only needed if Firestore was created as a named database instead of
// "(default)" — see the Firebase console's Firestore database list.
export const FIRESTORE_DATABASE_ID = '(default)';
