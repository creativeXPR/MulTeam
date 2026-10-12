// UI end-to-end test for collaboration stage 1, against the emulators:
//   npm run test:collab-ui
// The app (signed in as a test user) shares a project, other users join via
// the client SDK, and the app accepts an invite as a viewer. The folder
// picker is stubbed to test folders under TMPF (default: OS temp dir).
const { app, ipcMain, Menu, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createMainWindow } = require('../../src/main/window');
const { registerIpcHandlers } = require('../../src/main/ipcHandlers');
const { initializeApp } = require('firebase/app');
const { getAuth, connectAuthEmulator, signInWithCredential, GoogleAuthProvider } = require('firebase/auth');
const { getFirestore, connectFirestoreEmulator, doc, setDoc, getDoc, getDocs, addDoc, collection, query, where, serverTimestamp } = require('firebase/firestore');
const { getFunctions, connectFunctionsEmulator, httpsCallable } = require('firebase/functions');
const { getDatabase, connectDatabaseEmulator, ref, set } = require('firebase/database');

app.disableHardwareAcceleration();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await wait(300); } return false; };
const TMPF = process.env.TMPF || fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'multeam-collab-'));
fs.mkdirSync(path.join(TMPF, 'owned'), { recursive: true });
fs.writeFileSync(path.join(TMPF, 'owned', 'main.js'), 'const team = 1;\n');
let nextFolder = path.join(TMPF, 'owned');
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [nextFolder] }); // folder picker → test folders

let n = 0;
async function user(id, email, name) {
  const a = initializeApp({ projectId: 'demo-multeam', apiKey: 'fake', databaseURL: 'http://127.0.0.1:9411?ns=demo-multeam' }, `t${n++}`);
  const auth = getAuth(a); connectAuthEmulator(auth, 'http://127.0.0.1:9109', { disableWarnings: true });
  const fsx = getFirestore(a, 'multeam'); connectFirestoreEmulator(fsx, '127.0.0.1', 8187);
  const fns = getFunctions(a, 'europe-west1'); connectFunctionsEmulator(fns, '127.0.0.1', 5011);
  const db = getDatabase(a); connectDatabaseEmulator(db, '127.0.0.1', 9411);
  await signInWithCredential(auth, GoogleAuthProvider.credential(JSON.stringify({ sub: id, email, email_verified: true, name })));
  return { uid: auth.currentUser.uid, fs: fsx, db, call: (f) => async (d) => (await httpsCallable(fns, f)(d)).data };
}

app.whenReady().then(async () => {
  const out = (...a) => console.log('RES', ...a);
  try {
    const rules = fs.readFileSync(path.join(__dirname, '../../firebase/database.rules.json'), 'utf8');
    await fetch('http://127.0.0.1:9411/.settings/rules.json?ns=demo-multeam', { method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: rules });
    Menu.setApplicationMenu(null); registerIpcHandlers(ipcMain);
    const win = await createMainWindow();
    const errs = [];
    win.webContents.on('console-message', (e, level, msg) => { if (level >= 3 && !/permission_denied|PERMISSION_DENIED|Permission denied/i.test(msg)) errs.push(String(msg).slice(0, 300)); });
    await wait(4000);
    const js = (s) => win.webContents.executeJavaScript('(async () => { ' + s + ' })()').catch((e) => 'TESTERR ' + e.message);
    const shot = async (name) => { for (let i = 0; i < 3; i++) { try { fs.writeFileSync(path.join(TMPF, name), (await win.capturePage()).toPNG()); return; } catch { await wait(500); } } };
    const clickMenu = (label) => js("const b = [...document.querySelectorAll('.context-menu-item')].find(b => b.offsetParent && b.querySelector('.context-menu-label').textContent.startsWith(" + JSON.stringify(label) + ")); if (!b) return 'NOITEM'; b.click(); return 'ok'");
    const confirmOk = () => js("document.getElementById('confirm-ok').click()");

    await js("for (const p of await window.electronAPI.listProjects()) if (/Team App|Dave/.test(p.name)) await window.electronAPI.deleteProjectLocal(p.id)");
    await js("localStorage.setItem('multeam:emulators', '1'); location.reload()"); await wait(4500);
    out('signed in:', await js("return (await window.__multeamTest.signIn({ uid: 'olu', email: 'olu@team.dev', name: 'Olu Owner' })).email"));
    await wait(1000);
    const pid = await js('return (await window.electronAPI.createProject({ name: "Team App", folderPath: ' + JSON.stringify(path.join(TMPF, 'owned')) + ', cloudEnabled: false })).id');
    await js('location.reload()'); await wait(4500);

    // owner: turn on cloud via Edit project
    await js("document.querySelector('#projects [data-project=\"" + pid + "\"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 400, clientY: 330 }))"); await wait(300);
    out('menu share item:', await js("return [...document.querySelectorAll('.context-menu-item')].filter(b => b.offsetParent).map(b => b.textContent).join(' | ')"));
    await clickMenu('Edit…'); await wait(400);
    await js("const t = document.getElementById('project-cloud-toggle'); t.checked = true; document.getElementById('project-submit').click()");
    await until(() => js("return document.getElementById('project-modal').hidden"), 40000); await wait(800);
    out('after cloud on:', await js("return JSON.stringify((await window.electronAPI.listProjects()).map(p => [p.name, p.cloudEnabled])) + ' err=' + document.getElementById('project-error').textContent + ' modalHidden=' + document.getElementById('project-modal').hidden + ' toasts=' + document.getElementById('toasts').textContent"));

    // open Share from the context menu
    await js("document.querySelector('#projects [data-project=\"" + pid + "\"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 400, clientY: 330 }))"); await wait(300);
    await clickMenu('Share…');
    await until(() => js("return document.getElementById('share-title').textContent.includes('Team App')"));
    out('share modal:', await js("return document.getElementById('share-title').textContent + ' / ' + document.getElementById('share-sub').textContent + ' / members=' + document.querySelectorAll('#share-members .share__item').length"));

    // invite bob by email; create a viewer link
    await js("document.getElementById('share-email').value = 'bob@team.dev'; document.getElementById('share-invite-role').value = 'editor'; document.getElementById('share-invite-form').requestSubmit()");
    await until(() => js("return document.querySelectorAll('#share-invites .share__item').length === 1"));
    out('pending invites:', await js("return [...document.querySelectorAll('#share-invites .share__who')].map(e => e.textContent.trim().replace(/\\s+/g, ' ')).join(' | ')"));
    await js("document.getElementById('share-link-role').value = 'viewer'; document.getElementById('share-link-create').click()");
    await until(() => js("return document.querySelectorAll('#share-links .share__item:not(.is-pending) .share__code').length === 1"));
    const code = await js("return document.querySelector('#share-links .share__item:not(.is-pending) .share__code').textContent");
    out('link code:', code, '/', await js("return document.querySelector('#share-links .share__item:not(.is-pending) .share__who').textContent.trim()"));

    // bob accepts; carol joins with the code
    const bob = await user('bob', 'bob@team.dev', 'Bob Builder');
    const inv = await getDocs(query(collection(bob.fs, 'invites'), where('email', '==', 'bob@team.dev'), where('status', '==', 'pending')));
    await bob.call('acceptInvite')({ inviteId: inv.docs[0].id });
    const carol = await user('carol', 'carol@team.dev', 'Carol');
    await carol.call('redeemCode')({ code });
    await until(() => js("return document.querySelectorAll('#share-members .share__item').length === 3"));
    out('members live:', await js("return [...document.querySelectorAll('#share-members .share__item')].map(e => e.querySelector('b').textContent + ':' + (e.querySelector('select')?.value || e.querySelector('.share__role')?.textContent)).join(' | ')"), ' invites left=' + await js("return document.querySelectorAll('#share-invites .share__item').length"));
    await shot('share.png');

    // owner: carol → editor, then remove bob
    await js("const s = document.querySelector('#share-members [data-role-for=\"" + carol.uid + "\"]'); s.value = 'editor'; s.dispatchEvent(new Event('change', { bubbles: true }))");
    await until(async () => (await getDoc(doc(carol.fs, 'projects', pid))).data().members[carol.uid].role === 'editor');
    out('carol role now:', (await getDoc(doc(carol.fs, 'projects', pid))).data().members[carol.uid].role);
    await js("document.querySelector('#share-members [data-remove=\"" + bob.uid + "\"]').click()"); await wait(300);
    out('remove confirm:', await js("return document.getElementById('confirm-title').textContent"));
    await confirmOk();
    await until(() => js("return document.querySelectorAll('#share-members .share__item').length === 2"));
    out('after remove:', await js("return document.querySelectorAll('#share-members .share__item').length"), 'bob can read:', await getDoc(doc(bob.fs, 'projects', pid)).then(() => 'yes', () => 'no'));
    await js("document.getElementById('share-done').click()");

    // reverse: dave invites olu as a VIEWER to dave's project
    const dave = await user('dave', 'dave@team.dev', 'Dave');
    const dpid = 'daveproj01';
    await setDoc(doc(dave.fs, 'projects', dpid), { name: "Dave's API", ownerId: dave.uid, repoUrl: '', members: { [dave.uid]: { role: 'owner', name: 'Dave', email: 'dave@team.dev', photo: '' } }, memberUids: [dave.uid], createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    await set(ref(dave.db, `projectMembers/${dpid}`), { [dave.uid]: 'owner' });
    await addDoc(collection(dave.fs, 'invites'), { projectId: dpid, projectName: "Dave's API", ownerId: dave.uid, email: 'olu@team.dev', role: 'viewer', status: 'pending', invitedBy: { uid: dave.uid, name: 'Dave' }, createdAt: serverTimestamp() });
    await until(() => js("return !!document.querySelector('#inviteBox [data-accept]')"));
    await js("document.getElementById('notifBtn').click()"); await wait(400);
    out('bell invite:', await js("return document.querySelector('#inviteBox .invite span').textContent"));
    await shot('bell.png');
    await js("document.querySelector('#inviteBox [data-accept]').click()");
    await until(() => js("return !document.getElementById('confirm-modal').hidden"));
    out('setup prompt:', await js("return document.getElementById('confirm-title').textContent"));
    fs.mkdirSync(path.join(TMPF, 'daves'), { recursive: true });
    fs.writeFileSync(path.join(TMPF, 'daves', 'api.js'), 'export const api = 1;\n');
    nextFolder = path.join(TMPF, 'daves');
    await confirmOk();
    await until(() => js("return !!document.querySelector('#file-tree .file-tree-node[data-name=\"api.js\"]')"));
    out('joined + opened:', await js("return document.querySelector('#panel-project-list .subitem.is-sel .node-label')?.textContent"));
    await js("[...document.querySelectorAll('#file-tree .file-tree-node')].find(n => n.dataset.name === 'api.js').click()"); await wait(3000);
    await js("document.querySelector('.monaco-editor textarea').focus()");
    win.webContents.insertText('HACK '); await wait(800);
    out('viewer editor text:', await js("return document.querySelector('.view-lines').textContent"), '/ disk:', JSON.stringify(fs.readFileSync(path.join(TMPF, 'daves', 'api.js'), 'utf8')));
    await shot('viewer.png');

    // join modal with a code (dave makes an editor link to a second project)
    const d2 = 'daveproj02';
    await setDoc(doc(dave.fs, 'projects', d2), { name: 'Dave Web', ownerId: dave.uid, repoUrl: '', members: { [dave.uid]: { role: 'owner', name: 'Dave', email: 'dave@team.dev', photo: '' } }, memberUids: [dave.uid], createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    await setDoc(doc(dave.fs, 'inviteLinks', 'WEBX2345'), { projectId: d2, ownerId: dave.uid, role: 'editor', requiresApproval: false, revoked: false, expiresAt: null, createdAt: serverTimestamp() });
    await js("go && go('dashboard')").catch(() => {});
    await js("document.getElementById('joinProjectBtn').click()"); await wait(400);
    await js("document.getElementById('join-code').value = 'multeam://join/WEBX-2345'; document.getElementById('join-form').requestSubmit()");
    await until(() => js("return !document.getElementById('join-preview').hidden"));
    out('join preview:', await js("return document.getElementById('join-preview').textContent.replace(/\\s+/g, ' ').trim() + ' [' + document.getElementById('join-submit').textContent + ']'"));
    await shot('join.png');
    await js("document.getElementById('join-form').requestSubmit()");
    await until(() => js("return !document.getElementById('confirm-modal').hidden"));
    await js("document.getElementById('confirm-cancel').click()"); await wait(800);
    out('shared with you:', await js("return [...document.querySelectorAll('#sharedWithMe .shared__item b')].map(b => b.textContent).join(', ') + ' hidden=' + document.getElementById('sharedWithMe').hidden"));

    out('errors:', errs.filter((e) => !/Could not reach Cloud Firestore backend/.test(e)).join('\n  ') || 'none');
    // leave the test profile as it was
    await js("for (const p of await window.electronAPI.listProjects()) if (/Team App|Dave/.test(p.name)) await window.electronAPI.deleteProjectLocal(p.id); localStorage.removeItem('multeam:emulators')");
  } catch (err) {
    out('HARNESS ERROR', err.stack || err.message);
  }
  app.quit();
});
