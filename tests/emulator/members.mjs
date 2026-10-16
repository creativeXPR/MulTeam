// Emulator tests for collaboration stage 1 (members & invites): Firestore
// rules + the membership Cloud Functions + the RTDB mirror, driven by real
// client SDK sessions for several users.
//   npm run test:members   (needs the Firebase CLI + Java)
import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInWithCredential, GoogleAuthProvider, createUserWithEmailAndPassword } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator, doc, setDoc, getDoc, getDocs, updateDoc, addDoc, collection, query, where, serverTimestamp, Timestamp } from 'firebase/firestore';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
import { getDatabase, connectDatabaseEmulator, ref, set, get, push } from 'firebase/database';

const PROJECT = 'demo-multeam';
// Functions' admin SDK uses the emulator namespace "<projectId>"; load the
// real RTDB rules into it so the live-edit checks are enforced.
{
  const { readFileSync } = await import('node:fs');
  const rules = readFileSync(new URL('../../firebase/database.rules.json', import.meta.url), 'utf8');
  const res = await fetch(`http://127.0.0.1:9411/.settings/rules.json?ns=${PROJECT}`, { method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: rules });
  if (!res.ok) throw new Error(`could not load RTDB rules: ${res.status} ${await res.text()}`);
}
let n = 0;
async function session(user) {
  const app = initializeApp({ projectId: PROJECT, apiKey: 'fake-key', databaseURL: `http://127.0.0.1:9411?ns=${PROJECT}` }, `u${n++}`);
  const auth = getAuth(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9109', { disableWarnings: true });
  const fs = getFirestore(app, 'multeam');
  connectFirestoreEmulator(fs, '127.0.0.1', 8187);
  const fns = getFunctions(app, 'europe-west1');
  connectFunctionsEmulator(fns, '127.0.0.1', 5011);
  const db = getDatabase(app);
  connectDatabaseEmulator(db, '127.0.0.1', 9411);
  if (user.verified) {
    await signInWithCredential(auth, GoogleAuthProvider.credential(JSON.stringify({ sub: user.id, email: user.email, email_verified: true, name: user.name })));
  } else {
    await createUserWithEmailAndPassword(auth, user.email, 'password123');
  }
  const call = (name) => async (data) => (await httpsCallable(fns, name)(data)).data;
  return { uid: auth.currentUser.uid, fs, db, call };
}

const results = [];
async function check(name, fn) {
  try { await fn(); results.push(['PASS', name]); } catch (err) { results.push(['FAIL', name, err?.message || String(err)]); }
}
const fails = async (p, re) => {
  try { await p; } catch (err) { if (re && !re.test(err.message)) throw new Error(`failed for the wrong reason: ${err.message}`); return; }
  throw new Error('expected it to fail, but it succeeded');
};
const eq = (a, b, what) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };

const owner = await session({ id: 'owner1', email: 'owner@team.dev', name: 'Olu Owner', verified: true });
const bob = await session({ id: 'bob1', email: 'bob@team.dev', name: 'Bob', verified: true });
const carol = await session({ email: 'carol@team.dev', verified: false });
const eve = await session({ id: 'eve1', email: 'eve@evil.dev', name: 'Eve', verified: true });
const dan = await session({ id: 'dan1', email: 'dan@team.dev', name: 'Dan', verified: true });

const P = 'proj-' + Date.now();
const pdoc = (s) => doc(s.fs, 'projects', P);
const live = (s) => `projects/${P}/b/main/docs/main~2Ejs`;
const pushLive = (s) => push(ref(s.db, `${live(s)}/updates`), { state: 'AAA=', origin: 1 });
const project = () => ({
  name: 'Team App', ownerId: owner.uid, repoUrl: '',
  members: { [owner.uid]: { role: 'owner', name: 'Olu Owner', email: 'owner@team.dev', photo: '' } },
  memberUids: [owner.uid], createdAt: serverTimestamp(), updatedAt: serverTimestamp()
});

// ---------- project record ----------
await check('stranger cannot create a project listing someone else as owner', () => fails(setDoc(pdoc(eve), { ...project(), ownerId: owner.uid })));
await check('owner creates the cloud project', () => setDoc(pdoc(owner), project()));
await check('cannot create a project with extra members', () => fails(setDoc(doc(eve.fs, 'projects', P + 'x'), { ...project(), ownerId: eve.uid, members: { [eve.uid]: { role: 'owner' }, [bob.uid]: { role: 'editor' } }, memberUids: [eve.uid, bob.uid] })));
await check('owner creates the live-edit mirror', () => set(ref(owner.db, `projectMembers/${P}`), { [owner.uid]: 'owner' }));
await check('non-members cannot read the project', () => fails(getDoc(pdoc(bob))));
await check('owner cannot add members by editing the record', () => fails(updateDoc(pdoc(owner), { [`members.${bob.uid}`]: { role: 'editor' }, memberUids: [owner.uid, bob.uid] })));
await check('owner can rename and set the repo', () => updateDoc(pdoc(owner), { name: 'Team App 2', repoUrl: 'https://github.com/x/y', updatedAt: serverTimestamp() }));

// ---------- email invites ----------
const invite = (s, email, role = 'editor', extra = {}) => addDoc(collection(s.fs, 'invites'), {
  projectId: P, projectName: 'Team App', ownerId: s.uid, email, role, status: 'pending',
  invitedBy: { uid: s.uid, name: 'x' }, createdAt: serverTimestamp(), ...extra
});
let bobInvite, carolInvite;
await check('owner invites bob by email', async () => { bobInvite = (await invite(owner, 'bob@team.dev')).id; });
await check('owner invites carol (unverified email)', async () => { carolInvite = (await invite(owner, 'carol@team.dev', 'viewer')).id; });
await check('cannot invite yourself', () => fails(invite(owner, 'owner@team.dev')));
await check('invite role must be editor/viewer', () => fails(invite(owner, 'x@team.dev', 'owner')));
await check('non-owners cannot send invites', () => fails(invite(eve, 'eve2@evil.dev')));
await check('bob sees his invite', async () => {
  const s = await getDocs(query(collection(bob.fs, 'invites'), where('email', '==', 'bob@team.dev'), where('status', '==', 'pending')));
  eq(s.size, 1, 'invites');
});
await check("eve cannot list bob's invites", () => fails(getDocs(query(collection(eve.fs, 'invites'), where('email', '==', 'bob@team.dev')))));
await check('unverified carol cannot list invites', () => fails(getDocs(query(collection(carol.fs, 'invites'), where('email', '==', 'carol@team.dev')))));
await check("eve cannot accept bob's invite", () => fails(eve.call('acceptInvite')({ inviteId: bobInvite }), /different email/));
await check('unverified carol cannot accept', () => fails(carol.call('acceptInvite')({ inviteId: carolInvite }), /Verify your email/));
await check('bob accepts → editor', async () => {
  const r = await bob.call('acceptInvite')({ inviteId: bobInvite });
  eq([r.role, r.name], ['editor', 'Team App 2'], 'result');
});
await check('invite cannot be reused', () => fails(bob.call('acceptInvite')({ inviteId: bobInvite }), /already used/));
await check('bob can now read the project', async () => eq((await getDoc(pdoc(bob))).data().members[bob.uid].role, 'editor', 'role'));
await check('mirror gives bob live editing', async () => { eq((await get(ref(bob.db, `projectMembers/${P}/${bob.uid}`))).val(), 'editor', 'mirror'); await pushLive(bob); });
await check('bob (editor) cannot change roles', () => fails(bob.call('setMemberRole')({ projectId: P, uid: owner.uid, role: 'viewer' }), /owner/));

// ---------- links / codes ----------
const link = (s, code, data) => setDoc(doc(s.fs, 'inviteLinks', code), { projectId: P, ownerId: s.uid, role: 'viewer', requiresApproval: false, revoked: false, expiresAt: null, createdAt: serverTimestamp(), ...data });
await check('owner creates a viewer link', () => link(owner, 'VIEW2345', {}));
await check('owner creates an approval link', () => link(owner, 'APPR2345', { role: 'editor', requiresApproval: true }));
await check('owner creates an expired link', () => link(owner, 'OLDX2345', { expiresAt: Timestamp.fromMillis(Date.now() - 1000) }));
await check('non-owners cannot create links', () => fails(link(eve, 'EVIL2345', {})));
await check('links are not readable by others', () => fails(getDoc(doc(eve.fs, 'inviteLinks', 'VIEW2345'))));
await check('preview shows the project without joining', async () => {
  const r = await eve.call('redeemCode')({ code: 'view-2345', preview: true });
  eq([r.name, r.role, r.requiresApproval, r.member, r.ownerName], ['Team App 2', 'viewer', false, null, 'Olu Owner'], 'preview');
  await fails(getDoc(pdoc(eve)));
});
await check('eve joins by code → viewer', async () => eq((await eve.call('redeemCode')({ code: 'VIEW-2345' })).role, 'viewer', 'role'));
await check('viewer cannot push live edits', () => fails(pushLive(eve)));
await check('viewer can share presence', () => set(ref(eve.db, `${live(eve)}/awareness/77`), 'AAA='));
await check('expired link is refused', () => fails(dan.call('redeemCode')({ code: 'OLDX2345' }), /expired/));
await check('unknown code is refused', () => fails(dan.call('redeemCode')({ code: 'NOPE2345' }), /doesn't exist/));
await check('approval link creates a request, not membership', async () => {
  const r = await dan.call('redeemCode')({ code: 'APPR2345' });
  eq(r.pending, true, 'pending');
  await fails(getDoc(pdoc(dan)));
});
await check('owner sees the request', async () => eq((await getDocs(collection(owner.fs, 'projects', P, 'joinRequests'))).size, 1, 'requests'));
await check('members cannot approve requests', () => fails(bob.call('respondJoinRequest')({ projectId: P, uid: dan.uid, approve: true }), /owner/));
await check('owner approves dan as viewer', async () => {
  await owner.call('respondJoinRequest')({ projectId: P, uid: dan.uid, approve: true, role: 'viewer' });
  eq((await getDoc(pdoc(dan))).data().members[dan.uid].role, 'viewer', 'role');
});
await check('revoked link is refused', async () => {
  await updateDoc(doc(owner.fs, 'inviteLinks', 'VIEW2345'), { revoked: true });
  await fails(carol.call('redeemCode')({ code: 'VIEW2345' }), /turned off/);
});

// ---------- roles & removal ----------
await check('owner demotes bob to viewer → live edits stop', async () => {
  await owner.call('setMemberRole')({ projectId: P, uid: bob.uid, role: 'viewer' });
  eq((await get(ref(bob.db, `projectMembers/${P}/${bob.uid}`))).val(), 'viewer', 'mirror');
  await fails(pushLive(bob));
});
await check('owner cannot change own role', () => fails(owner.call('setMemberRole')({ projectId: P, uid: owner.uid, role: 'viewer' })));
await check('owner removes eve → no access', async () => {
  await owner.call('removeMember')({ projectId: P, uid: eve.uid });
  await fails(getDoc(pdoc(eve)));
  await fails(get(ref(eve.db, live(eve))));
});
await check('dan leaves on his own', async () => { await dan.call('removeMember')({ projectId: P }); await fails(getDoc(pdoc(dan))); });
await check('owner cannot leave', () => fails(owner.call('removeMember')({ projectId: P }), /owner can't leave/));
await check('members list is consistent', async () => {
  const d = (await getDoc(pdoc(owner))).data();
  eq(Object.keys(d.members).sort(), [owner.uid, bob.uid].sort(), 'members');
  eq([...d.memberUids].sort(), [owner.uid, bob.uid].sort(), 'memberUids');
  const mirror = (await get(ref(owner.db, `projectMembers/${P}`))).val();
  const sortObj = (o) => Object.fromEntries(Object.entries(o || {}).sort());
  eq(sortObj(mirror), sortObj({ [owner.uid]: 'owner', [bob.uid]: 'viewer' }), 'mirror');
});
await check('other users profiles are private', () => fails(getDoc(doc(eve.fs, 'users', owner.uid))));

// ---------- user search + invite by account (GitHub-style) ----------
const profile = (u, name, email) => setDoc(doc(u.fs, 'users', u.uid), { uid: u.uid, displayName: name, nameLower: name.toLowerCase(), email, emailLower: email, photoURL: '' }, { merge: true });
await check('users write their own searchable profile', async () => {
  await profile(owner, 'Olu Owner', 'owner@team.dev');
  await profile(bob, 'Bob Builder', 'bob@team.dev');
  await profile(carol, '', 'carol@team.dev');
  await profile(eve, 'Eve', 'eve@evil.dev');
  await profile(dan, 'Dan', 'dan@team.dev');
});
await check("cannot write someone else's profile", () => fails(setDoc(doc(eve.fs, 'users', bob.uid), { displayName: 'hacked' }, { merge: true })));
await check('cannot claim another email in your profile', () => fails(setDoc(doc(eve.fs, 'users', eve.uid), { emailLower: 'bob@team.dev' }, { merge: true })));
await check('search by name finds users, without emails', async () => {
  const r = await eve.call('searchUsers')({ q: 'bo' });
  eq(r.users.map((u) => u.name), ['Bob Builder'], 'names');
  if (JSON.stringify(r).includes('@')) throw new Error('an email leaked into results');
});
await check('search marks existing members', async () => eq((await owner.call('searchUsers')({ q: 'bob', projectId: P })).users[0].member, 'viewer', 'member'));
await check('exact email finds a user with no display name', async () => {
  const r = await owner.call('searchUsers')({ q: 'carol@team.dev' });
  eq([r.users.length, r.users[0]?.exactEmail], [1, true], 'exact');
});
await check('partial emails find nothing', async () => eq((await owner.call('searchUsers')({ q: 'carol@team' })).users.length, 0, 'partial'));
await check('you are not in your own results', async () => eq((await owner.call('searchUsers')({ q: 'olu' })).users.length, 0, 'self'));
let carolUid;
await check('owner invites carol by account (no email stored)', async () => {
  carolUid = (await owner.call('searchUsers')({ q: 'carol@team.dev' })).users[0].uid;
  await owner.call('inviteUser')({ projectId: P, uid: carolUid, role: 'editor' });
  const inv = await getDocs(query(collection(owner.fs, 'invites'), where('ownerId', '==', owner.uid), where('projectId', '==', P), where('status', '==', 'pending')));
  const d = inv.docs.find((x) => x.data().inviteeUid === carolUid).data();
  eq([d.email, d.inviteeName], [null, 'MulTeam user'], 'invite');
});
await check('duplicate account invites are refused', () => fails(owner.call('inviteUser')({ projectId: P, uid: carolUid, role: 'editor' }), /already have a pending/));
await check('non-owners cannot invite by account', () => fails(bob.call('inviteUser')({ projectId: P, uid: carolUid, role: 'editor' }), /owner/));
await check('cannot invite an existing member', () => fails(owner.call('inviteUser')({ projectId: P, uid: bob.uid, role: 'editor' }), /already a member/));
let carolInv;
await check('unverified carol sees her account invite', async () => {
  const s2 = await getDocs(query(collection(carol.fs, 'invites'), where('inviteeUid', '==', carol.uid), where('status', '==', 'pending')));
  eq(s2.size, 1, 'invites'); carolInv = s2.docs[0].id;
});
await check("eve cannot see carol's account invite", () => fails(getDocs(query(collection(eve.fs, 'invites'), where('inviteeUid', '==', carol.uid)))));
await check("eve cannot accept carol's account invite", () => fails(eve.call('acceptInvite')({ inviteId: carolInv }), /different account/));
await check('carol accepts (account invites need no verified email)', async () => eq((await carol.call('acceptInvite')({ inviteId: carolInv })).role, 'editor', 'role'));

// ================= team workspaces (stage 3) =================
const T = 'team-' + Date.now();
const P2 = 'tproj-' + Date.now();
const P3 = 'bproj-' + Date.now();
const tdoc = (s) => doc(s.fs, 'teams', T);
const p2doc = (s) => doc(s.fs, 'projects', P2);
const live2 = (s) => push(ref(s.db, `projects/${P2}/b/main/docs/main~2Ejs/updates`), { state: 'AAA=', origin: 1 });
const team = () => ({ name: 'Acme Team', ownerId: owner.uid, members: { [owner.uid]: { role: 'owner', name: 'Olu Owner', email: 'owner@team.dev', photo: '' } }, memberUids: [owner.uid], createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
const proj = (s, name) => ({ name, ownerId: s.uid, repoUrl: '', members: { [s.uid]: { role: 'owner', name: 'x', email: 'x@x.dev', photo: '' } }, memberUids: [s.uid], createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
const tinvite = (s, email, role, extra = {}) => addDoc(collection(s.fs, 'invites'), { teamId: T, teamName: 'Acme Team', ownerId: s.uid, email, role, status: 'pending', invitedBy: { uid: s.uid, name: 'x' }, createdAt: serverTimestamp(), ...extra });

await check('team: owner shares a workspace (creates the team)', () => setDoc(tdoc(owner), team()));
await check('team: cannot create a team that lists other members', () => fails(setDoc(doc(eve.fs, 'teams', T + 'x'), { ...team(), ownerId: eve.uid, members: { [eve.uid]: { role: 'owner' }, [bob.uid]: { role: 'admin' } }, memberUids: [eve.uid, bob.uid] })));
await check('team: non-members cannot read it', () => fails(getDoc(tdoc(bob))));
await check('team: owner moves their cloud project into it', async () => {
  await setDoc(p2doc(owner), proj(owner, 'Team Project'));
  await set(ref(owner.db, `projectMembers/${P2}`), { [owner.uid]: 'owner' });
  await owner.call('addProjectToTeam')({ projectId: P2, teamId: T });
  eq((await getDoc(p2doc(owner))).data().teamId, T, 'teamId');
});
await check('team: the project owner cannot change teamId directly', () => fails(updateDoc(p2doc(owner), { teamId: 'other' })));

let bobTeamInvite;
await check('team: owner invites bob to the workspace as editor', async () => { bobTeamInvite = (await tinvite(owner, 'bob@team.dev', 'editor')).id; });
await check('team: bob accepts → editor on the workspace', async () => eq((await bob.call('acceptInvite')({ inviteId: bobTeamInvite })).role, 'editor', 'role'));
await check("team: bob now reaches the workspace's project (read + live edit)", async () => {
  eq((await getDoc(p2doc(bob))).data().name, 'Team Project', 'read');
  eq((await get(ref(bob.db, `projectMembers/${P2}/${bob.uid}`))).val(), 'editor', 'mirror');
  await live2(bob);
});
await check('team: a viewer link gives viewer access to its projects', async () => {
  await setDoc(doc(owner.fs, 'inviteLinks', 'TEAM2345'), { teamId: T, ownerId: owner.uid, role: 'viewer', requiresApproval: false, revoked: false, expiresAt: null, createdAt: serverTimestamp() });
  const r = await dan.call('redeemCode')({ code: 'TEAM2345' });
  eq([r.kind, r.role], ['team', 'viewer'], 'joined');
  eq((await get(ref(dan.db, `projectMembers/${P2}/${dan.uid}`))).val(), 'viewer', 'mirror');
  await fails(live2(dan));
});
await check('team: highest role wins (team viewer + project editor = editor)', async () => {
  const inv = (await addDoc(collection(owner.fs, 'invites'), { projectId: P2, projectName: 'Team Project', ownerId: owner.uid, email: 'dan@team.dev', role: 'editor', status: 'pending', invitedBy: { uid: owner.uid, name: 'x' }, createdAt: serverTimestamp() })).id;
  await dan.call('acceptInvite')({ inviteId: inv });
  eq((await get(ref(dan.db, `projectMembers/${P2}/${dan.uid}`))).val(), 'editor', 'effective');
  await live2(dan);
});

await check('team: owner makes bob an admin', async () => {
  await owner.call('setMemberRole')({ teamId: T, uid: bob.uid, role: 'admin' });
  eq((await getDoc(tdoc(bob))).data().members[bob.uid].role, 'admin', 'role');
  eq((await get(ref(bob.db, `projectMembers/${P2}/${bob.uid}`))).val(), 'editor', 'admins edit projects');
});
await check('team: admins see every pending team invite (not just their own)', async () => {
  await tinvite(owner, 'someone@team.dev', 'viewer');
  const s2 = await getDocs(query(collection(bob.fs, 'invites'), where('teamId', '==', T), where('status', '==', 'pending')));
  if (!s2.docs.some((d) => d.data().email === 'someone@team.dev')) throw new Error("admin can't see the owner's invite");
});
await check('team: an admin can invite editors', () => tinvite(bob, 'new@team.dev', 'editor'));
await check('team: an admin cannot invite admins', () => fails(tinvite(bob, 'boss@team.dev', 'admin')));
await check('team: an admin cannot promote someone to admin', () => fails(bob.call('setMemberRole')({ teamId: T, uid: dan.uid, role: 'admin' }), /owner can manage admins/));
await check('team: an admin can add their own project', async () => {
  await setDoc(doc(bob.fs, 'projects', P3), proj(bob, "Bob's Project"));
  await bob.call('addProjectToTeam')({ projectId: P3, teamId: T });
  eq((await getDoc(doc(owner.fs, 'projects', P3))).data().teamId, T, 'owner reaches it via the team');
});
await check("team: nobody can move someone else's project into a team", () => fails(bob.call('addProjectToTeam')({ projectId: P2, teamId: T }), /project owner/));
await check('team: editors cannot manage the workspace', () => fails(dan.call('setMemberRole')({ teamId: T, uid: bob.uid, role: 'viewer' }), /owner or an admin/));

await check('team: moving a project out removes the team’s access', async () => {
  await bob.call('removeProjectFromTeam')({ projectId: P2 }); // admin moves it out
  await fails(getDoc(p2doc(bob))); // bob only had it through the team
  eq((await get(ref(owner.db, `projectMembers/${P2}/${bob.uid}`))).val(), null, 'mirror');
  eq((await get(ref(owner.db, `projectMembers/${P2}/${dan.uid}`))).val(), 'editor', 'direct member keeps access');
});
await check('team: removing a member removes their project access', async () => {
  await owner.call('addProjectToTeam')({ projectId: P2, teamId: T });
  eq((await getDoc(p2doc(bob))).exists(), true, 'bob back via team');
  await owner.call('removeMember')({ teamId: T, uid: bob.uid });
  await fails(getDoc(p2doc(bob)));
  await fails(getDoc(tdoc(bob)));
});
await check('team: the owner cannot leave', () => fails(owner.call('removeMember')({ teamId: T }), /Stop sharing/));
await check('team: only the owner can stop sharing', () => fails(dan.call('deleteTeam')({ teamId: T }), /Only the workspace owner/));
await check('team: stopping sharing keeps projects with their owners', async () => {
  const r = await owner.call('deleteTeam')({ teamId: T });
  eq(r.projects, 2, 'projects released');
  eq((await getDoc(p2doc(owner))).data().teamId, undefined, 'teamId cleared');
  eq((await get(ref(owner.db, `projectMembers/${P2}/${dan.uid}`))).val(), 'editor', 'direct members stay');
  eq((await getDoc(doc(bob.fs, 'projects', P3))).data().ownerId, bob.uid, "bob's project is still bob's");
  await fails(getDoc(doc(owner.fs, 'projects', P3))); // owner only reached it via the team
});

const failed = results.filter((r) => r[0] === 'FAIL');
for (const r of results) console.log(r[0].padEnd(5), r[1], r[2] ? `\n      → ${r[2]}` : '');
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
