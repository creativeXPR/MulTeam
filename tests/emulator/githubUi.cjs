// In-app test of joining a cloud project that has a GitHub repository
// (stage 2.3): accept the invite, choose "Clone into a folder…", watch the
// progress, and the project opens. Needs internet (clones the public
// octocat/Hello-World repo).   npm run test:github-ui
const { app, ipcMain, Menu, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createMainWindow } = require('../../src/main/window');
const { registerIpcHandlers } = require('../../src/main/ipcHandlers');
app.disableHardwareAcceleration();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await wait(300); } return false; };
const TMPF = process.env.TMPF || fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'multeam-gh-'));
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [TMPF] }); // "choose folder" → test dir

app.whenReady().then(async () => {
  const out = (...a) => console.log('RES', ...a);
  try {
    await fetch('http://127.0.0.1:9411/.settings/rules.json?ns=demo-multeam', { method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: fs.readFileSync(path.join(__dirname, '../../firebase/database.rules.json'), 'utf8') });
    const { initializeApp } = await import('firebase/app');
    const { getAuth, connectAuthEmulator, signInWithCredential, GoogleAuthProvider } = await import('firebase/auth');
    const { getFirestore, connectFirestoreEmulator, doc, setDoc, addDoc, collection, serverTimestamp } = await import('firebase/firestore');
    const { getFunctions, connectFunctionsEmulator, httpsCallable } = await import('firebase/functions');

    Menu.setApplicationMenu(null); registerIpcHandlers(ipcMain);
    const win = await createMainWindow();
    const errs = [];
    win.webContents.on('console-message', (e, level, msg) => { if (level >= 3 && !/Could not reach Cloud Firestore|PERMISSION_DENIED|permission_denied/.test(msg)) errs.push(String(msg).slice(0, 300)); });
    await wait(4000);
    const js = (s) => win.webContents.executeJavaScript('(async () => { ' + s + ' })()').catch((e) => 'TESTERR ' + e.message);
    const shot = async (n) => { for (let i = 0; i < 4; i++) { try { fs.writeFileSync(path.join(TMPF, n), (await win.capturePage()).toPNG()); return; } catch { await wait(600); } } };

    await js("localStorage.setItem('multeam:emulators', '1'); location.reload()"); await wait(4500);
    await js("await window.__multeamTest.signIn({ uid: 'joiner', email: 'joiner@team.dev', name: 'Joiner' })"); await wait(800);
    const fa = initializeApp({ projectId: 'demo-multeam', apiKey: 'fake' }, 'owner');
    const auth = getAuth(fa); connectAuthEmulator(auth, 'http://127.0.0.1:9109', { disableWarnings: true });
    const fsx = getFirestore(fa, 'multeam'); connectFirestoreEmulator(fsx, '127.0.0.1', 8187);
    const fns = getFunctions(fa, 'europe-west1'); connectFunctionsEmulator(fns, '127.0.0.1', 5011);
    await signInWithCredential(auth, GoogleAuthProvider.credential(JSON.stringify({ sub: 'own', email: 'own@team.dev', email_verified: true, name: 'Owner' })));
    // warm up the emulated functions runtime (first call is slow to start)
    await httpsCallable(fns, 'acceptInvite')({ inviteId: 'warmup' }).catch(() => {});
    const ou = auth.currentUser.uid;
    await setDoc(doc(fsx, 'projects', 'hwproj1'), { name: 'Hello World', ownerId: ou, repoUrl: 'https://github.com/octocat/Hello-World', members: { [ou]: { role: 'owner', name: 'Owner', email: 'own@team.dev', photo: '' } }, memberUids: [ou], createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    await addDoc(collection(fsx, 'invites'), { projectId: 'hwproj1', projectName: 'Hello World', ownerId: ou, email: 'joiner@team.dev', role: 'editor', status: 'pending', invitedBy: { uid: ou, name: 'Owner' }, createdAt: serverTimestamp() });
    await until(() => js("return !!document.querySelector('#inviteBox [data-accept]')"));
    await js("document.querySelector('#inviteBox [data-accept]').click()");
    const prompted = await until(() => js("return !document.getElementById('confirm-modal').hidden"));
    out('setup prompt:', prompted, await js("return document.getElementById('confirm-title').textContent + ' | ' + document.getElementById('confirm-message').textContent + ' | [' + document.getElementById('confirm-ok').textContent + '] [' + document.getElementById('confirm-alt').textContent + ']'"));
    await shot('gh-setup.png');
    await js("document.getElementById('confirm-ok').click()");
    const sawProgress = await until(() => js("return !document.getElementById('clone-modal').hidden"), 10000);
    out('clone progress shown:', sawProgress);
    let lines = new Set();
    for (let i = 0; i < 40 && !fs.existsSync(path.join(TMPF, 'Hello-World', 'README')); i++) { lines.add(await js("return document.getElementById('clone-line').textContent")); await wait(250); }
    out('progress lines seen:', [...lines].slice(0, 4).join(' | '));
    out('cloned:', await until(() => fs.existsSync(path.join(TMPF, 'Hello-World', 'README')), 60000));
    out('project opened:', await until(() => js("return document.querySelector('#panel-project-list .subitem.is-sel .node-label')?.textContent === 'Hello World'"), 15000));
    out('record:', await js("return JSON.stringify((await window.electronAPI.listProjects()).filter(p => p.name === 'Hello World').map(p => [p.id, p.joined, p.cloudEnabled, p.folderPath.split(/[\\\\/]/).pop()]))"));
    out('cloned repo has no token in .git/config:', !/extraheader|x-access-token/i.test(fs.readFileSync(path.join(TMPF, 'Hello-World', '.git', 'config'), 'utf8')));
    out('errors:', errs.join('\n  ') || 'none');
    await js("for (const p of await window.electronAPI.listProjects()) if (p.name === 'Hello World') await window.electronAPI.deleteProjectLocal(p.id); localStorage.removeItem('multeam:emulators')");
  } catch (e) { out('HARNESS', e.stack); }
  app.quit();
});
