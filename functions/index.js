// MulTeam membership functions (codebase "multeam" — deploys never touch
// other apps' functions on the shared Firebase project).
//
// Two kinds of shared thing ("targets"), each with members + roles:
//   projects/{projectId}  direct members: owner / editor / viewer
//   teams/{teamId}        team workspace: owner / admin / editor / viewer
// A project in a team (project.teamId) is reachable by the team's members
// too; everyone gets the HIGHER of their project role and their team role
// (team owner/admin act as editors on projects they don't own).
//
// Every change to who can reach a project goes through here, so the access
// lists stay in step:
//   Firestore  projects/{id}.memberUids          everyone with access (rules, queries)
//   RTDB       projectMembers/{id}/{uid} = role   effective role (live-edit rules)
// Owners/admins create invites and links directly (Firestore rules check
// them); accepting, redeeming, approving, role changes and removals happen here.
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getDatabase } = require('firebase-admin/database');

initializeApp();
setGlobalOptions({ region: 'europe-west1', maxInstances: 5 });

const db = getFirestore('multeam');
const rtdb = getDatabase();
const RANK = { viewer: 1, editor: 2, admin: 3, owner: 4 };

const KINDS = {
  project: { col: 'projects', noun: 'project', grantable: ['editor', 'viewer'], managers: ['owner'] },
  team: { col: 'teams', noun: 'workspace', grantable: ['admin', 'editor', 'viewer'], managers: ['owner', 'admin'] }
};

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

// { teamId } or { projectId } in a request / invite / link
const targetOf = (data) => (data?.teamId ? { kind: 'team', id: str(data.teamId, 'workspace') } : { kind: 'project', id: str(data?.projectId, 'project') });

async function load({ kind, id }) {
  const snap = await db.doc(`${KINDS[kind].col}/${id}`).get();
  if (!snap.exists) throw new HttpsError('not-found', `This ${KINDS[kind].noun} no longer exists.`);
  return { kind, id, ref: snap.ref, data: snap.data() };
}

const roleIn = (t, uid) => t.data.members?.[uid]?.role || null;

function requireManager(t, uid) {
  if (!KINDS[t.kind].managers.includes(roleIn(t, uid))) {
    throw new HttpsError('permission-denied', t.kind === 'team' ? 'Only the workspace owner or an admin can do that.' : 'Only the project owner can do that.');
  }
}

// Admins manage editors/viewers; only the owner manages admins.
function requireCanManageRole(t, actorUid, ...roles) {
  requireManager(t, actorUid);
  if (roleIn(t, actorUid) !== 'owner' && roles.some((r) => r === 'admin' || r === 'owner')) {
    throw new HttpsError('permission-denied', 'Only the workspace owner can manage admins.');
  }
}

const projectRoleFromTeam = (teamRole) => (teamRole === 'viewer' ? 'viewer' : 'editor');

// Recompute who can reach a project and with what role (direct ∪ team).
async function syncAccess(projectId) {
  const snap = await db.doc(`projects/${projectId}`).get();
  if (!snap.exists) { await rtdb.ref(`projectMembers/${projectId}`).set(null); return; }
  const p = snap.data();
  const eff = {};
  for (const [uid, m] of Object.entries(p.members || {})) eff[uid] = m.role;
  if (p.teamId) {
    const team = await db.doc(`teams/${p.teamId}`).get();
    for (const [uid, m] of Object.entries(team.exists ? team.data().members || {} : {})) {
      const r = projectRoleFromTeam(m.role);
      if (!eff[uid] || RANK[r] > RANK[eff[uid]]) eff[uid] = r;
    }
  }
  const uids = Object.keys(eff).sort();
  if (JSON.stringify([...(p.memberUids || [])].sort()) !== JSON.stringify(uids)) {
    await snap.ref.update({ memberUids: uids, updatedAt: FieldValue.serverTimestamp() });
  }
  await rtdb.ref(`projectMembers/${projectId}`).set(uids.length ? eff : null);
}

async function syncTeamProjects(teamId) {
  const ps = await db.collection('projects').where('teamId', '==', teamId).get();
  await Promise.all(ps.docs.map((d) => syncAccess(d.id)));
}

async function afterMembershipChange(t) {
  if (t.kind === 'project') await syncAccess(t.id);
  else await syncTeamProjects(t.id);
}

// Adds (or upgrades) a member; never downgrades an existing role.
async function addMember(target, auth, role) {
  const { kind, id } = target;
  const ref = db.doc(`${KINDS[kind].col}/${id}`);
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', `This ${KINDS[kind].noun} no longer exists.`);
    const d = snap.data();
    const current = d.members?.[auth.uid];
    if (current && RANK[current.role] >= RANK[role]) return { name: d.name, role: current.role, already: true };
    tx.update(ref, {
      [`members.${auth.uid}`]: { role, ...profileOf(auth), joinedAt: current?.joinedAt || FieldValue.serverTimestamp() },
      memberUids: FieldValue.arrayUnion(auth.uid),
      updatedAt: FieldValue.serverTimestamp()
    });
    return { name: d.name, role, already: false };
  });
  await afterMembershipChange(target);
  return { kind, [kind === 'team' ? 'teamId' : 'projectId']: id, ...result };
}

// ---------- email / account invites ----------
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
  const target = targetOf(inv);
  const role = KINDS[target.kind].grantable.includes(inv.role) ? inv.role : 'viewer';
  const res = await addMember(target, auth, role);
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
    const byName = await db.collection('users').where('nameLower', '>=', q).where('nameLower', '<=', q + '').limit(10).get();
    byName.forEach((d) => { if (!found.has(d.id) && d.get('displayName')) found.set(d.id, toResult(d)); });
  }
  found.delete(auth.uid);
  let members = {};
  const scope = req.data?.teamId ? `teams/${req.data.teamId}` : req.data?.projectId ? `projects/${req.data.projectId}` : null;
  if (typeof scope === 'string' && !scope.includes('//')) {
    const t = await db.doc(scope).get();
    if (t.exists && t.data().members?.[auth.uid]) members = t.data().members || {};
  }
  return { users: [...found.values()].slice(0, 8).map((u) => ({ ...u, member: members[u.uid]?.role || null })) };
});

// Owner/admin invites a user picked from search, addressed to the account
// (inviteeUid), so the inviter never learns their email.
exports.inviteUser = onCall(async (req) => {
  const auth = signedIn(req);
  const t = await load(targetOf(req.data));
  const role = KINDS[t.kind].grantable.includes(req.data?.role) ? req.data.role : 'editor';
  requireCanManageRole(t, auth.uid, role);
  const uid = str(req.data?.uid, 'user');
  if (uid === auth.uid) throw new HttpsError('failed-precondition', "You're already a member.");
  if (t.data.members?.[uid]) throw new HttpsError('already-exists', 'They are already a member.');
  const user = await db.doc(`users/${uid}`).get();
  if (!user.exists) throw new HttpsError('not-found', 'That MulTeam user no longer exists.');
  const field = t.kind === 'team' ? 'teamId' : 'projectId';
  const dup = await db.collection('invites').where(field, '==', t.id).where('inviteeUid', '==', uid).where('status', '==', 'pending').limit(1).get();
  if (!dup.empty) throw new HttpsError('already-exists', `They already have a pending invite to this ${KINDS[t.kind].noun}.`);
  await db.collection('invites').add({
    [field]: t.id,
    ...(t.kind === 'team' ? { teamName: t.data.name } : { projectName: t.data.name }),
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

// { code, preview?: true } → preview: { kind, projectId|teamId, name, ownerName, role, requiresApproval, member? }
//                          → join:    { kind, projectId|teamId, name, role } | { pending: true, name }
exports.redeemCode = onCall(async (req) => {
  const auth = signedIn(req);
  const { code, link } = await linkFor(req.data?.code);
  const t = await load(targetOf(link));
  const idField = t.kind === 'team' ? 'teamId' : 'projectId';
  const owner = Object.values(t.data.members || {}).find((m) => m.role === 'owner');
  const member = roleIn(t, auth.uid);
  if (req.data?.preview) return { kind: t.kind, [idField]: t.id, name: t.data.name, ownerName: owner?.name || '', role: link.role, requiresApproval: !!link.requiresApproval, member };
  if (member) return { kind: t.kind, [idField]: t.id, name: t.data.name, role: member, already: true };
  if (link.requiresApproval) {
    await t.ref.collection('joinRequests').doc(auth.uid).set({
      ...profileOf(auth), uid: auth.uid, role: link.role, code, status: 'pending', createdAt: FieldValue.serverTimestamp()
    });
    return { pending: true, kind: t.kind, [idField]: t.id, name: t.data.name };
  }
  return addMember(t, auth, KINDS[t.kind].grantable.includes(link.role) ? link.role : 'viewer');
});

// ---------- owner / admin actions ----------
exports.respondJoinRequest = onCall(async (req) => {
  const auth = signedIn(req);
  const t = await load(targetOf(req.data));
  const uid = str(req.data?.uid, 'user');
  const reqRef = t.ref.collection('joinRequests').doc(uid);
  const snap = await reqRef.get();
  if (!snap.exists) throw new HttpsError('not-found', 'That request was already handled.');
  const r = snap.data();
  const grantable = KINDS[t.kind].grantable;
  const role = grantable.includes(req.data?.role) ? req.data.role : (grantable.includes(r.role) ? r.role : 'viewer');
  requireCanManageRole(t, auth.uid, role);
  await reqRef.delete();
  if (!req.data?.approve) return { ok: true, approved: false };
  // add them using the profile they joined with
  await addMember(t, { uid, token: { name: r.name, email: r.email, picture: r.photo } }, role);
  return { ok: true, approved: true };
});

exports.setMemberRole = onCall(async (req) => {
  const auth = signedIn(req);
  const t = await load(targetOf(req.data));
  const uid = str(req.data?.uid, 'user');
  const role = req.data?.role;
  if (!KINDS[t.kind].grantable.includes(role)) throw new HttpsError('invalid-argument', `Role must be ${KINDS[t.kind].grantable.join(', ')}.`);
  if (uid === auth.uid) throw new HttpsError('failed-precondition', "You can't change your own role.");
  const current = roleIn(t, uid);
  if (!current) throw new HttpsError('not-found', `They aren't a member of this ${KINDS[t.kind].noun}.`);
  if (current === 'owner') throw new HttpsError('failed-precondition', "The owner's role can't be changed.");
  requireCanManageRole(t, auth.uid, role, current);
  await t.ref.update({ [`members.${uid}.role`]: role, updatedAt: FieldValue.serverTimestamp() });
  await afterMembershipChange(t);
  return { ok: true };
});

// Owner/admin removes someone, or a member leaves (uid = themselves).
exports.removeMember = onCall(async (req) => {
  const auth = signedIn(req);
  const t = await load(targetOf(req.data));
  const uid = str(req.data?.uid || auth.uid, 'user');
  const current = roleIn(t, uid);
  if (current === 'owner') throw new HttpsError('failed-precondition', t.kind === 'team' ? "The owner can't leave their own workspace. Stop sharing it instead." : "The owner can't leave their own project. Delete it or turn off cloud instead.");
  if (uid !== auth.uid) requireCanManageRole(t, auth.uid, current || 'viewer');
  const update = { [`members.${uid}`]: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() };
  // a project's memberUids is the access list (recomputed below); a team's is its member list
  if (t.kind === 'team') update.memberUids = FieldValue.arrayRemove(uid);
  await t.ref.update(update);
  await afterMembershipChange(t);
  return { ok: true };
});

// Owner's project record moved/created: make sure access + mirror match.
exports.syncMembers = onCall(async (req) => {
  const auth = signedIn(req);
  const t = await load({ kind: 'project', id: str(req.data?.projectId, 'project') });
  requireManager(t, auth.uid);
  await syncAccess(t.id);
  return { ok: true };
});

// ---------- team workspaces ↔ projects ----------
// Put your own cloud project into a team workspace you manage.
exports.addProjectToTeam = onCall(async (req) => {
  const auth = signedIn(req);
  const p = await load({ kind: 'project', id: str(req.data?.projectId, 'project') });
  const t = await load({ kind: 'team', id: str(req.data?.teamId, 'workspace') });
  if (roleIn(p, auth.uid) !== 'owner') throw new HttpsError('permission-denied', 'Only the project owner can move it into a workspace.');
  requireManager(t, auth.uid);
  const previous = p.data.teamId || null;
  await p.ref.update({ teamId: t.id, updatedAt: FieldValue.serverTimestamp() });
  await syncAccess(p.id);
  return { ok: true, previousTeamId: previous };
});

// Take a project out of its team workspace: the team loses access (unless
// they're also direct members of the project).
exports.removeProjectFromTeam = onCall(async (req) => {
  const auth = signedIn(req);
  const p = await load({ kind: 'project', id: str(req.data?.projectId, 'project') });
  if (!p.data.teamId) return { ok: true };
  const isProjectOwner = roleIn(p, auth.uid) === 'owner';
  let isTeamManager = false;
  try { isTeamManager = KINDS.team.managers.includes(roleIn(await load({ kind: 'team', id: p.data.teamId }), auth.uid)); } catch { /* team gone */ }
  if (!isProjectOwner && !isTeamManager) throw new HttpsError('permission-denied', 'Only the project owner or a workspace admin can do that.');
  await p.ref.update({ teamId: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
  await syncAccess(p.id);
  return { ok: true };
});

// Stop sharing a workspace (owner): its projects stay with their owners and
// direct members; the team, its invites and links go.
exports.deleteTeam = onCall(async (req) => {
  const auth = signedIn(req);
  const t = await load({ kind: 'team', id: str(req.data?.teamId, 'workspace') });
  if (roleIn(t, auth.uid) !== 'owner') throw new HttpsError('permission-denied', 'Only the workspace owner can stop sharing it.');
  const ps = await db.collection('projects').where('teamId', '==', t.id).get();
  await Promise.all(ps.docs.map((d) => d.ref.update({ teamId: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() })));
  for (const col of ['invites', 'inviteLinks']) {
    const docs = await db.collection(col).where('teamId', '==', t.id).get();
    await Promise.all(docs.docs.map((d) => d.ref.delete()));
  }
  const reqs = await t.ref.collection('joinRequests').get();
  await Promise.all(reqs.docs.map((d) => d.ref.delete()));
  await t.ref.delete();
  await Promise.all(ps.docs.map((d) => syncAccess(d.id)));
  return { ok: true, projects: ps.size };
});
