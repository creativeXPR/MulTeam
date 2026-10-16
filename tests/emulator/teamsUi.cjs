// In-app test of team workspaces (stage 3) against the emulators:
//   npm run test:teams-ui
// The app shares a workspace, a teammate joins by link, projects follow the
// workspace in and out, the app joins someone else's workspace, and sharing
// stops.
const { app, ipcMain, Menu, dialog } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMainWindow } = require('../../src/main/window');
const { registerIpcHandlers } = require('../../src/main/ipcHandlers');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-background-timer-throttling');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await wait(300); } return false; };
const TMPF = process.env.TMPF || fs.mkdtempSync(path.join(os.tmpdir(), 'multeam-teams-'));
for (const d of ['alpha', 'beta', 'gamma', 'zed-local']) fs.mkdirSync(path.join(TMPF, d), { recursive: true });
let nextFolder = path.join(TMPF, 'zed-local');
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [nextFolder] });

app.whenReady().then(async () => {
  const out = (...a) => console.log('RES', ...a);
  try {
    await fetch('http://127.0.0.1:9411/.settings/rules.json?ns=demo-multeam', { method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: fs.readFileSync(path.join(__dirname, '../../firebase/database.rules.json'), 'utf8') });
    const { initializeApp } = await import('firebase/app');
    const { getAuth, connectAuthEmulator, signInWithCredential, GoogleAuthProvider } = await import('firebase/auth');
    const { getFirestore, connectFirestoreEmulator, doc, setDoc, getDoc, serverTimestamp } = await import('firebase/firestore');
    const { getFunctions, connectFunctionsEmulator, httpsCallable } = await import('firebase/functions');
    const { getDatabase, connectDatabaseEmulator, ref, get, set } = await import('firebase/database');
    const user = async (id, email, name) => {
      const a = initializeApp({ projectId: 'demo-multeam', apiKey: 'fake', databaseURL: 'http://127.0.0.1:9411?ns=demo-multeam' }, id);
      const auth = getAuth(a); connectAuthEmulator(auth, 'http://127.0.0.1:9109', { disableWarnings: true });
      const fsx = getFirestore(a, 'multeam'); connectFirestoreEmulator(fsx, '127.0.0.1', 8187);
      const fns = getFunctions(a, 'europe-west1'); connectFunctionsEmulator(fns, '127.0.0.1', 5011);
      const db = getDatabase(a); connectDatabaseEmulator(db, '127.0.0.1', 9411);
      await signInWithCredential(auth, GoogleAuthProvider.credential(JSON.stringify({ sub: id, email, email_verified: true, name })));
      const uid = auth.currentUser.uid;
      await setDoc(doc(fsx, 'users', uid), { uid, displayName: name, nameLower: name.toLowerCase(), email, emailLower: email, photoURL: '' });
      return { uid, fs: fsx, db, call: (f) => async (d) => (await httpsCallable(fns, f)(d)).data };
    };
    const canRead = async (u, pid) => getDoc(doc(u.fs, 'projects', pid)).then((s) => s.exists(), () => false);

    Menu.setApplicationMenu(null); registerIpcHandlers(ipcMain);
    const win = await createMainWindow();
    win.webContents.setBackgroundThrottling(false); win.show(); win.focus();
    const errs = [];
    win.webContents.on('console-message', (e, level, msg) => { if (level >= 3 && !/Could not reach Cloud Firestore|PERMISSION_DENIED|permission_denied|Missing or insufficient permissions/.test(msg)) errs.push(String(msg).slice(0, 300)); });
    await wait(4000);
    const js = (s) => win.webContents.executeJavaScript('(async () => { ' + s + ' })()').catch((e) => 'TESTERR ' + e.message);
    const shot = async (n) => { for (let i = 0; i < 4; i++) { try { fs.writeFileSync(path.join(TMPF, n), (await win.capturePage()).toPNG()); return; } catch { await wait(600); } } };
    const menuItems = () => js("return [...document.querySelectorAll('.context-menu-item')].filter(b => b.offsetParent).map(b => b.textContent).join(' | ')");
    const clickMenu = (label) => js("const b = [...document.querySelectorAll('.context-menu-item')].find(b => b.offsetParent && b.querySelector('.context-menu-label').textContent.startsWith(" + JSON.stringify(label) + ")); if (!b) return 'NOITEM'; b.click(); return 'ok'");
    const wsMenu = async () => { await js("document.getElementById('wsExplorerBtn').click()"); await wait(300); };
    const projRecs = () => js("return JSON.stringify((await window.electronAPI.listProjects()).map(p => [p.name, p.cloudEnabled, p.joined || false]))");

    // clean leftovers, emulator mode, sign in
    await js("for (const p of await window.electronAPI.listProjects()) if (/^(Alpha|Beta|Gamma|Zed App)$/.test(p.name)) await window.electronAPI.deleteProjectLocal(p.id); const ws = await window.electronAPI.workspaces.list(); for (const w of ws.workspaces) if (/^(Acme|Solo|Zed Team)$/.test(w.name) && ws.workspaces.length > 1) await window.electronAPI.workspaces.remove(w.id)");
    await js("localStorage.setItem('multeam:emulators', '1'); location.reload()"); await wait(4500);
    await js("await window.__multeamTest.signIn({ uid: 'olu', email: 'olu@team.dev', name: 'Olu Owner' })"); await wait(1200);

    // a fresh workspace "Acme" with two local projects
    await js("await window.electronAPI.workspaces.create('Acme')");
    const ids = {};
    for (const n of ['Alpha', 'Beta']) ids[n] = await js('return (await window.electronAPI.createProject({ name: "' + n + '", folderPath: ' + JSON.stringify(path.join(TMPF, n.toLowerCase())) + ', cloudEnabled: false })).id');
    await js('location.reload()'); await wait(4500);
    out('workspace + projects:', await js("return document.getElementById('wsExplorerName').textContent"), await projRecs());

    // 1) share the workspace
    await wsMenu();
    out('menu:', await menuItems());
    await clickMenu('Share Workspace…');
    await until(() => js("return !document.getElementById('confirm-modal').hidden"));
    out('share confirm:', await js("return document.getElementById('confirm-message').textContent"));
    await js("document.getElementById('confirm-ok').click()");
    const opened = await until(() => js("return !document.getElementById('share-modal').hidden && document.getElementById('share-title').textContent.includes('Acme')"), 40000);
    out('share dialog:', opened, await js("return document.getElementById('share-title').textContent + ' / ' + document.getElementById('share-sub').textContent"));
    out('invite roles:', await js("return [...document.getElementById('share-invite-role').options].map(o => o.textContent).join(',')"));
    out('projects now:', await projRecs());
    await shot('team-share.png');
    await js("document.getElementById('share-link-role').value = 'editor'; document.getElementById('share-link-create').click()");
    await until(() => js("return !!document.querySelector('#share-links .share__item:not(.is-pending) .share__code')"));
    const code = await js("return document.querySelector('#share-links .share__item:not(.is-pending) .share__code').textContent");
    const teamId = await js("return (await window.electronAPI.workspaces.list()).currentId");

    // 2) teammate joins by link → reaches both projects as editor
    const kim = await user('kim', 'kim@team.dev', 'Kim Mate');
    const joined = await kim.call('redeemCode')({ code });
    out('kim joined:', joined.kind, joined.role);
    out('kim reaches Alpha/Beta:', await canRead(kim, ids.Alpha), await canRead(kim, ids.Beta), (await get(ref(kim.db, `projectMembers/${ids.Alpha}/${kim.uid}`))).val());
    await until(() => js("return document.querySelectorAll('#share-members .share__item').length === 2"));
    out('members in dialog:', await js("return [...document.querySelectorAll('#share-members .share__item b')].map(b => b.textContent).join(', ')"));
    await js("document.getElementById('share-done').click()");

    // 3) a new project created in the shared workspace joins the team
    await js("document.querySelector('[data-action=newproject]').click()"); await wait(400);
    nextFolder = path.join(TMPF, 'gamma');
    await js("document.getElementById('project-name').value = 'Gamma'; document.getElementById('project-folder-btn').click()"); await wait(400);
    await js("document.getElementById('project-submit').click()");
    await until(() => js("return document.getElementById('project-modal').hidden"), 30000); await wait(1500);
    ids.Gamma = await js("return (await window.electronAPI.listProjects()).find(p => p.name === 'Gamma')?.id");
    out('new project reaches kim:', await until(() => canRead(kim, ids.Gamma), 15000));

    //    moving a project OUT asks first, then the team loses it
    await js("await window.electronAPI.workspaces.create('Solo'); await window.electronAPI.workspaces.setCurrent(" + JSON.stringify(teamId) + ")");
    await js('location.reload()'); await wait(4500);
    await js("document.querySelector('[data-project-row=\"" + ids.Beta + "\"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 120 }))"); await wait(300);
    await clickMenu('Move to Solo');
    await until(() => js("return !document.getElementById('confirm-modal').hidden"));
    out('move-out confirm:', await js("return document.getElementById('confirm-title').textContent"));
    await js("document.getElementById('confirm-ok').click()");
    out('kim lost Beta:', await until(async () => !(await canRead(kim, ids.Beta)), 15000), 'still has Alpha:', await canRead(kim, ids.Alpha));

    // 4) the app joins someone else's workspace
    const zed = await user('zed', 'zed@team.dev', 'Zed Boss');
    const ZT = 'zedteam' + Date.now();
    await setDoc(doc(zed.fs, 'teams', ZT), { name: 'Zed Team', ownerId: zed.uid, members: { [zed.uid]: { role: 'owner', name: 'Zed Boss', email: 'zed@team.dev', photo: '' } }, memberUids: [zed.uid], createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    const ZP = 'zedproj' + Date.now();
    await setDoc(doc(zed.fs, 'projects', ZP), { name: 'Zed App', ownerId: zed.uid, repoUrl: '', members: { [zed.uid]: { role: 'owner', name: 'Zed Boss', email: 'zed@team.dev', photo: '' } }, memberUids: [zed.uid], createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    await set(ref(zed.db, `projectMembers/${ZP}`), { [zed.uid]: 'owner' });
    await zed.call('addProjectToTeam')({ projectId: ZP, teamId: ZT });
    const oluUid = (await zed.call('searchUsers')({ q: 'olu' })).users[0].uid;
    await zed.call('inviteUser')({ teamId: ZT, uid: oluUid, role: 'editor' });
    await until(() => js("return !!document.querySelector('#inviteBox [data-accept]')"));
    await js("document.getElementById('notifBtn').click()"); await wait(300);
    out('bell:', await js("return document.querySelector('#inviteBox .invite span').textContent"));
    await js("document.querySelector('#inviteBox [data-accept]').click()");
    out('switched to Zed Team:', await until(() => js("return document.getElementById('wsExplorerName').textContent === 'Zed Team'"), 15000));
    out('shared with you:', await until(() => js("return !document.getElementById('sharedWithMe').hidden"), 15000), await js("return [...document.querySelectorAll('#sharedWithMe .shared__item')].map(i => i.textContent.replace(/\\s+/g, ' ').trim()).join(' | ')"));
    await shot('team-joined.png');
    await js("document.querySelector('#sharedWithMe [data-setup=\"" + ZP + "\"]').click()");
    await until(() => js("return !document.getElementById('confirm-modal').hidden"));
    nextFolder = path.join(TMPF, 'zed-local');
    await js("document.getElementById('confirm-ok').click()");
    out('Zed App set up in Zed Team:', await until(() => js("return (async () => { const p = (await window.electronAPI.listProjects()).find(p => p.name === 'Zed App'); const ws = await window.electronAPI.workspaces.list(); return !!p && ws.workspaces.find(w => w.id === p.workspaceId)?.name === 'Zed Team'; })()"), 15000));

    // 5) stop sharing Acme → kim loses everything
    await js("await window.electronAPI.workspaces.setCurrent(" + JSON.stringify(teamId) + ")"); await js('location.reload()'); await wait(4500);
    await wsMenu();
    await clickMenu('Stop Sharing…');
    await until(() => js("return !document.getElementById('confirm-modal').hidden"));
    await js("document.getElementById('confirm-ok').click()");
    out('kim lost Alpha after stop sharing:', await until(async () => !(await canRead(kim, ids.Alpha)), 15000));
    await wait(1500);
    await wsMenu();
    out('menu after stop:', await menuItems());
    await js("document.body.click()");

    out('errors:', errs.join('\n  ') || 'none');
    await js("for (const p of await window.electronAPI.listProjects()) if (/^(Alpha|Beta|Gamma|Zed App)$/.test(p.name)) await window.electronAPI.deleteProjectLocal(p.id); localStorage.removeItem('multeam:emulators')");
  } catch (e) { out('HARNESS', e.stack); }
  app.quit();
});
