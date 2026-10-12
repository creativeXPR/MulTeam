// MulTeam membership functions (codebase "multeam" — deploys never touch
// other apps' functions on the shared Firebase project).
//
// Every change to WHO is in a project goes through here, so the two member
// lists stay in step:
//   Firestore  projects/{projectId}.members / memberUids   (app UI, rules)
//   RTDB       projectMembers/{projectId}/{uid} = role      (live-edit rules)
// Owners create invites and links directly (Firestore rules check them);
// accepting, redeeming, approving, role changes and removals happen here.
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getDatabase } = require('firebase-admin/database');

initializeApp();
setGlobalOptions({ region: 'europe-west1', maxInstances: 5 });

const db = getFirestore('multeam');
const rtdb = getDatabase();
const GRANTABLE = ['editor', 'viewer'];
const RANK = { viewer: 1, editor: 2, owner: 3 };

// ---------- helpers ----------
function signedIn(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in to MulTeam first.');
  return req.auth;
}

const profileOf = (auth) => ({
  name: String(auth.token.name || auth.token.email || 'Someone').slice(0, 80),
  email: String(auth.token.email || '').toLowerCase(),
  photo: String(auth.token.picture || '').slice(0, 500)
});

const str = (v, what, max = 200) => {
  if (typeof v !== 'string' || !v || v.length > max) throw new HttpsError('invalid-argument', `Missing or invalid ${what}.`);
  return v;
};

async function projectFor(projectId) {
  const snap = await db.doc(`projects/${str(projectId, 'project')}`).get();
  if (!snap.exists) throw new HttpsError('not-found', 'This project no longer exists.');
  return { ref: snap.ref, data: snap.data() };
}

function requireOwner(project, uid) {
  if (project.data.members?.[uid]?.role !== 'owner') throw new HttpsError('permission-denied', 'Only the project owner can do that.');
}

// Mirror Firestore membership into RTDB (the live-edit rules read it there).
async function syncMirror(projectId) {
  const snap = await db.doc(`projects/${projectId}`).get();
  const members = snap.exists ? snap.data().members || {} : {};
  const mirror = Object.fromEntries(Object.entries(members).map(([uid, m]) => [uid, m.role]));
  await rtdb.ref(`projectMembers/${projectId}`).set(Object.keys(mirror).length ? mirror : null);
}

// Adds (or upgrades) a member; never downgrades an existing role.
async function addMember(projectId, auth, role) {
  const ref = db.doc(`projects/${projectId}`);
  const result = await db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'This project no longer exists.');
    const p = snap.data();
    const current = p.members?.[auth.uid];
    if (current && RANK[current.role] >= RANK[role]) return { name: p.name, role: current.role, already: true };
    t.update(ref, {
      [`members.${auth.uid}`]: { role, ...profileOf(auth), joinedAt: current?.joinedAt || FieldValue.serverTimestamp() },
      memberUids: FieldValue.arrayUnion(auth.uid),
      updatedAt: FieldValue.serverTimestamp()
    });
    return { name: p.name, role, already: false };
  });
  await syncMirror(projectId);
  return { projectId, ...result };
}

// ---------- email invites ----------
exports.acceptInvite = onCall(async (req) => {
  const auth = signedIn(req);
  const ref = db.doc(`invites/${str(req.data?.inviteId, 'invite')}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'This invite was withdrawn.');
  const inv = snap.data();
  if (inv.status !== 'pending') throw new HttpsError('failed-precondition', 'This invite was already used.');
  if (inv.inviteeUid) {
    // invited by account (picked from user search): the uid proves who it is
    if (inv.inviteeUid !== auth.uid) throw new HttpsError('permission-denied', 'This invite is for a different account.');
  } else {
    if (!auth.token.email_verified) throw new HttpsError('permission-denied', 'Verify your email address first (check your inbox), then accept the invite.');
    if (inv.email !== String(auth.token.email || '').toLowerCase()) throw new HttpsError('permission-denied', 'This invite was sent to a different email address.');
  }
  const res = await addMember(inv.projectId, auth, GRANTABLE.includes(inv.role) ? inv.role : 'viewer');
  await ref.update({ status: 'accepted', acceptedBy: auth.uid, respondedAt: FieldValue.serverTimestamp() });
  return res;
});

exports.declineInvite = onCall(async (req) => {
  const auth = signedIn(req);
  const ref = db.doc(`invites/${str(req.data?.inviteId, 'invite')}`);
  const snap = await ref.get();
  if (!snap.exists) return { ok: true };
  const inv = snap.data();
  const mine = inv.inviteeUid ? inv.inviteeUid === auth.uid : inv.email === String(auth.token.email || '').toLowerCase();
  if (!mine) throw new HttpsError('permission-denied', 'This invite is for someone else.');
  await ref.update({ status: 'declined', respondedAt: FieldValue.serverTimestamp() });
  return { ok: true };
});

// ---------- user search (like GitHub's collaborator search) ----------
// Finds MulTeam users by name (prefix) or by EXACT email. Results never
// include anyone's email address — only name and photo — so the directory
// can't be used to harvest emails. users/{uid} keeps nameLower/emailLower
// (written by each user's app on sign-in).
const toResult = (d) => ({ uid: d.id, name: d.get('displayName') || '', photo: d.get('photoURL') || '' });

exports.searchUsers = onCall(async (req) => {
  const auth = signedIn(req);
  const q = String(req.data?.q || '').trim().toLowerCase().slice(0, 100);
  if (q.length < 2) return { users: [] };
  const found = new Map();
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(q)) {
    const byEmail = await db.collection('users').where('emailLower', '==', q).limit(1).get();
    byEmail.forEach((d) => found.set(d.id, { ...toResult(d), exactEmail: true }));
  }
  if (!q.includes('@')) {
    const byName = await db.collection('users').where('nameLower', '>=', q).where('nameLower', '<=', q + '\uf8ff').limit(10).get();
    byName.forEach((d) => { if (!found.has(d.id) && d.get('displayName')) found.set(d.id, toResult(d)); });
  }
  found.delete(auth.uid);
  let members = {};
  if (typeof req.data?.projectId === 'string' && req.data.projectId) {
    const p = await db.doc(`projects/${req.data.projectId}`).get();
    if (p.exists && p.data().members?.[auth.uid]) members = p.data().members || {};
  }
  return { users: [...found.values()].slice(0, 8).map((u) => ({ ...u, member: members[u.uid]?.role || null })) };
});

// Owner invites a user picked from search. The invite is addressed to the
// account (inviteeUid), so the owner never learns their email.
exports.inviteUser = onCall(async (req) => {
  const auth = signedIn(req);
  const project = await projectFor(req.data?.projectId);
  requireOwner(project, auth.uid);
  const uid = str(req.data?.uid, 'user');
  const role = GRANTABLE.includes(req.data?.role) ? req.data.role : 'editor';
  if (uid === auth.uid) throw new HttpsError('failed-precondition', "You're already the owner.");
  if (project.data.members?.[uid]) throw new HttpsError('already-exists', 'They are already a member.');
  const user = await db.doc(`users/${uid}`).get();
  if (!user.exists) throw new HttpsError('not-found', 'That MulTeam user no longer exists.');
  const dup = await db.collection('invites').where('projectId', '==', project.ref.id).where('inviteeUid', '==', uid).where('status', '==', 'pending').limit(1).get();
  if (!dup.empty) throw new HttpsError('already-exists', 'They already have a pending invite to this project.');
  await db.collection('invites').add({
    projectId: project.ref.id,
    projectName: project.data.name,
    ownerId: auth.uid,
    inviteeUid: uid,
    inviteeName: user.get('displayName') || 'MulTeam user',
    inviteePhoto: user.get('photoURL') || '',
    email: null,
    role,
    status: 'pending',
    invitedBy: { uid: auth.uid, name: profileOf(auth).name },
    createdAt: FieldValue.serverTimestamp()
  });
  return { ok: true, name: user.get('displayName') || 'MulTeam user' };
});

// ---------- invite links / codes ----------
async function linkFor(code) {
  const clean = str(code, 'code', 40).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const snap = await db.doc(`inviteLinks/${clean}`).get();
  if (!snap.exists) throw new HttpsError('not-found', "That code doesn't exist. Check it, or ask for a new link.");
  const link = snap.data();
  if (link.revoked) throw new HttpsError('failed-precondition', 'This link was turned off by the owner.');
  if (link.expiresAt && link.expiresAt.toMillis() < Date.now()) throw new HttpsError('deadline-exceeded', 'This link has expired. Ask for a new one.');
  return { code: clean, link };
}

// { code, preview?: true } → preview: { name, ownerName, role, requiresApproval, member? }
//                          → join:    { projectId, name, role } | { pending: true, name }
exports.redeemCode = onCall(async (req) => {
  const auth = signedIn(req);
  const { code, link } = await linkFor(req.data?.code);
  const project = await projectFor(link.projectId);
  const p = project.data;
  const owner = Object.values(p.members || {}).find((m) => m.role === 'owner');
  const member = p.members?.[auth.uid]?.role || null;
  if (req.data?.preview) return { projectId: link.projectId, name: p.name, ownerName: owner?.name || '', role: link.role, requiresApproval: !!link.requiresApproval, member };
  if (member) return { projectId: link.projectId, name: p.name, role: member, already: true };
  if (link.requiresApproval) {
    await project.ref.collection('joinRequests').doc(auth.uid).set({
      ...profileOf(auth), uid: auth.uid, role: link.role, code, status: 'pending', createdAt: FieldValue.serverTimestamp()
    });
    return { pending: true, projectId: link.projectId, name: p.name };
  }
  return addMember(link.projectId, auth, GRANTABLE.includes(link.role) ? link.role : 'viewer');
});

// ---------- owner actions ----------
exports.respondJoinRequest = onCall(async (req) => {
  const auth = signedIn(req);
  const project = await projectFor(req.data?.projectId);
  requireOwner(project, auth.uid);
  const uid = str(req.data?.uid, 'user');
  const reqRef = project.ref.collection('joinRequests').doc(uid);
  const snap = await reqRef.get();
  if (!snap.exists) throw new HttpsError('not-found', 'That request was already handled.');
  const r = snap.data();
  await reqRef.delete();
  if (!req.data?.approve) return { ok: true, approved: false };
  const role = GRANTABLE.includes(req.data?.role) ? req.data.role : (GRANTABLE.includes(r.role) ? r.role : 'viewer');
  // add them using the profile they joined with
  await addMember(project.ref.id, { uid, token: { name: r.name, email: r.email, picture: r.photo } }, role);
  return { ok: true, approved: true };
});

exports.setMemberRole = onCall(async (req) => {
  const auth = signedIn(req);
  const project = await projectFor(req.data?.projectId);
  requireOwner(project, auth.uid);
  const uid = str(req.data?.uid, 'user');
  const role = req.data?.role;
  if (!GRANTABLE.includes(role)) throw new HttpsError('invalid-argument', 'Role must be editor or viewer.');
  if (uid === auth.uid) throw new HttpsError('failed-precondition', "You can't change your own role as owner.");
  if (!project.data.members?.[uid]) throw new HttpsError('not-found', "They aren't a member of this project.");
  await project.ref.update({ [`members.${uid}.role`]: role, updatedAt: FieldValue.serverTimestamp() });
  await syncMirror(project.ref.id);
  return { ok: true };
});

// Owner removes someone, or a member leaves (uid = themselves).
exports.removeMember = onCall(async (req) => {
  const auth = signedIn(req);
  const project = await projectFor(req.data?.projectId);
  const uid = str(req.data?.uid || auth.uid, 'user');
  const leaving = uid === auth.uid;
  if (!leaving) requireOwner(project, auth.uid);
  if (project.data.members?.[uid]?.role === 'owner') throw new HttpsError('failed-precondition', "The owner can't leave their own project. Delete it or turn off cloud instead.");
  await project.ref.update({
    [`members.${uid}`]: FieldValue.delete(),
    memberUids: FieldValue.arrayRemove(uid),
    updatedAt: FieldValue.serverTimestamp()
  });
  await syncMirror(project.ref.id);
  return { ok: true };
});

// Owner's project record moved/created: make sure the RTDB mirror matches.
exports.syncMembers = onCall(async (req) => {
  const auth = signedIn(req);
  const project = await projectFor(req.data?.projectId);
  requireOwner(project, auth.uid);
  await syncMirror(project.ref.id);
  return { ok: true };
});

