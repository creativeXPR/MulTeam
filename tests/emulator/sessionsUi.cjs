// In-app test of live sessions (stage 4) against the emulators:
//   npm run test:sessions-ui
// A: the app hosts a local project; a guest (real sync engine, own empty
//    folder) asks to join, is admitted, edits, is made read-only, and the
//    session ends.
// B: a host outside the app runs a session; the app joins it from a link,
//    gets the project as a temporary one, edits, and it's removed at the end.
const { app, ipcMain, Menu } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createMainWindow } = require('../../src/main/window');
const { registerIpcHandlers } = require('../../src/main/ipcHandlers');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-background-timer-throttling');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await wait(250); } return false; };
const TMPF = fs.mkdtempSync(path.join(os.tmpdir(), 'multeam-sess-'));
const proj = path.join(TMPF, 'pair');
const guestDir = path.join(TMPF, 'guest');
const outsideHost = path.join(TMPF, 'outside');
for (const d of [proj, guestDir, outsideHost]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(proj, 'app.js'), 'const v = 1;\n');
fs.mkdirSync(path.join(proj, 'lib'));
fs.writeFileSync(path.join(proj, 'lib', 'util.js'), 'export const u = 1;\n');
fs.writeFileSync(path.join(outsideHost, 'main.py'), 'print("hi")\n');

let failed = 0;
const out = (label, ok, ...more) => { if (ok !== true) failed++; console.log(ok === true ? 'PASS ' : 'FAIL ', label, ...more); };

app.whenReady().then(async () => {
  try {
    await fetch('http://127.0.0.1:9411/.settings/rules.json?ns=demo-multeam', { method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: fs.readFileSync(path.join(__dirname, '../../firebase/database.rules.json'), 'utf8') });
    const outDir = path.join(__dirname, '.build');
    await require('esbuild').build({
      entryPoints: [path.join(__dirname, 'liveProjectEntry.js')], bundle: true, format: 'esm', platform: 'node', packages: 'external',
      outfile: path.join(outDir, 'liveProject.mjs'), logLevel: 'error',
      plugins: [{ name: 'stub-firebase', setup(b) { b.onResolve({ filter: /^\.\/firebase\.js$/ }, () => ({ path: path.join(__dirname, 'firebaseStub.js') })); } }]
    });
    const { initializeApp } = await import('firebase/app');
    const { getAuth, connectAuthEmulator, signInWithCredential, GoogleAuthProvider } = await import('firebase/auth');
    const { getDatabase, connectDatabaseEmulator, ref, get, set, update, remove } = await import('firebase/database');
    const { createLiveProject } = await import(pathToFileURL(path.join(outDir, 'liveProject.mjs')).href);

    Menu.setApplicationMenu(null); registerIpcHandlers(ipcMain);
    const win = await createMainWindow();
    win.webContents.setBackgroundThrottling(false);
    win.show(); win.focus();
    win.webContents.on('console-message', (e, level, msg) => { if (level >= 2 && !/Could not reach Cloud Firestore/.test(msg)) console.log('  [renderer]', String(msg).slice(0, 300)); });
    await wait(4000);
    const js = (s) => win.webContents.executeJavaScript('(async () => { ' + s + ' })()').catch((e) => 'TESTERR ' + e.message);
    await js("for (const p of await window.electronAPI.listProjects()) if (p.name === 'Pair' || p.session) await window.electronAPI.deleteProjectLocal(p.id)");
    await js("localStorage.setItem('multeam:emulators', '1'); location.reload()"); await wait(4500);
    await js("await window.__multeamTest.signIn({ uid: 'hana', email: 'hana@pair.dev', name: 'Hana Host' })"); await wait(1000);
    const pid = await js('return (await window.electronAPI.createProject({ name: "Pair", folderPath: ' + JSON.stringify(proj) + ', cloudEnabled: false })).id');
    await js('location.reload()'); await wait(4500);
    // toasts vanish after a few seconds; log them as they appear
    await js("new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.classList?.contains('toast')) console.warn('TOAST ' + n.textContent); }).observe(document.body, { childList: true, subtree: true })");

    // a second signed-in person outside the app, on the same emulators
    const person = async (name, uid) => {
      const fa = initializeApp({ projectId: 'demo-multeam', apiKey: 'fake', databaseURL: 'http://127.0.0.1:9411?ns=demo-multeam' }, name);
      const auth = getAuth(fa); connectAuthEmulator(auth, 'http://127.0.0.1:9109', { disableWarnings: true });
      const db = getDatabase(fa); connectDatabaseEmulator(db, '127.0.0.1', 9411);
      await signInWithCredential(auth, GoogleAuthProvider.credential(JSON.stringify({ sub: uid, email: `${uid}@pair.dev`, email_verified: true, name })));
      return { db, uid: auth.currentUser.uid };
    };
    const fsp = fs.promises;
    const nodeApi = {
      readFile: async (p) => { if ((await fsp.stat(p)).isDirectory()) throw new Error('dir'); return fsp.readFile(p, 'utf8'); },
      writeFile: async (p, t) => { await fsp.mkdir(path.dirname(p), { recursive: true }); await fsp.writeFile(p, t); },
      readDir: (p) => fsp.readdir(p), createDirectory: (p) => fsp.mkdir(p, { recursive: true }),
      trashEntry: async (p) => { await fsp.rm(p, { recursive: true, force: true }); return true; },
      backupFile: async () => 'x', headContent: async () => null,
      listFiles: async (r) => { const files = []; const walk = async (d) => { for (const e of await fsp.readdir(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) await walk(f); else files.push(path.relative(r, f)); } }; await walk(r); return { files, truncated: false }; }
    };
    const readIn = (dir, rel) => (fs.existsSync(path.join(dir, rel)) ? fs.readFileSync(path.join(dir, rel), 'utf8') : null);
    const confirmOk = async () => { await until(() => js("return !document.getElementById('confirm-modal').hidden"), 5000); await js("document.getElementById('confirm-ok').click()"); };

    // ================= A: the app hosts =================
    await js("document.querySelector('[data-project-row=\"" + pid + "\"]').click()"); await wait(2500);
    await js("[...document.querySelectorAll('#file-tree .file-tree-node')].find(n => n.dataset.name === 'app.js').click()"); await wait(2500);
    await js("document.querySelector('.menubar__title[data-menu=\"0\"]').click()"); await wait(300);
    await js("[...document.querySelectorAll('.menubar__item')].find(b => b.textContent.trim().startsWith('Start Live Session')).click()");
    const started = await until(() => js("return !document.getElementById('sessionBtn').hidden && /multeam:\\/\\/session\\//.test(document.querySelector('.session__link code')?.textContent || '')"));
    out('host: session started, footer + link shown', started);
    const link = await js("return document.querySelector('.session__link code')?.textContent || ''");
    const sid = (/session\/([a-z0-9]+)/.exec(link) || [])[1];

    const guest = await person('Gus Guest', 'gus');
    await set(ref(guest.db, `sessions/${sid}/members/${guest.uid}`), { name: 'Gus Guest', status: 'pending', role: 'editor', at: Date.now() });
    out('host: sees the request', await until(() => js("return document.getElementById('sessionBtn').classList.contains('has-pending')")));
    await js("document.getElementById('sessionBtn').classList.contains('is-on') || document.getElementById('sessionBtn').click()"); await wait(300);
    await until(() => js("return !!document.querySelector('#sessionBody [data-s=admit]')"), 5000);
    await js("document.querySelector('#sessionBody [data-s=admit]').click()");
    out('guest: admitted', await until(async () => (await get(ref(guest.db, `sessions/${sid}/members/${guest.uid}/status`))).val() === 'admitted'));

    const gEngine = createLiveProject({ projectId: sid, root: guestDir, branch: null, isGit: false, uid: guest.uid, canEdit: true, api: nodeApi, db: guest.db, basePath: `sessions/${sid}` });
    out("guest: gets the host's whole folder", await until(() => readIn(guestDir, 'app.js') === 'const v = 1;\n' && readIn(guestDir, 'lib/util.js') === 'export const u = 1;\n'));

    // host typing in the open editor → guest's disk
    await wait(2500); // editors rebind to the session after the folder is shared
    await js("document.querySelector('.monaco-editor textarea').focus()");
    win.webContents.insertText('// host typed\n'); await wait(300);
    out('host editor → guest disk', await until(() => /host typed/.test(readIn(guestDir, 'app.js') || '')), JSON.stringify(readIn(guestDir, 'app.js')));

    // guest edit → host's editor and disk
    fs.writeFileSync(path.join(guestDir, 'app.js'), (readIn(guestDir, 'app.js') || '') + 'const fromGuest = 1;\n'); gEngine.onDiskEvent({ filename: 'app.js' });
    out('guest edit → host editor', await until(() => js("return document.querySelector('.view-lines').textContent.includes('fromGuest')")));
    out('guest edit → host disk', await until(() => /fromGuest/.test(readIn(proj, 'app.js') || '')));

    // read-only
    await js("document.getElementById('sessionBtn').classList.contains('is-on') || document.getElementById('sessionBtn').click()"); await wait(300);
    await until(() => js("return !!document.querySelector('#sessionBody [data-s=role]')"), 5000);
    await js("document.querySelector('#sessionBody [data-s=role]').click()");
    out('host: guest made read-only', await until(async () => (await get(ref(guest.db, `sessions/${sid}/members/${guest.uid}/role`))).val() === 'viewer'));
    let blocked = false;
    try { await update(ref(guest.db, `sessions/${sid}/files/x`), { path: 'x', kind: 'file', state: 'live', by: guest.uid, at: 1 }); } catch { blocked = true; }
    out('read-only guest cannot write', blocked);
    gEngine.dispose();

    // end
    await until(() => js("return !!document.querySelector('#sessionBody [data-s=end]')"), 5000);
    await js("document.querySelector('#sessionBody [data-s=end]').click()");
    await confirmOk();
    out('host: session ended and deleted', await until(async () => { try { return !(await get(ref(guest.db, `sessions/${sid}/info`))).exists(); } catch { return false; } }));
    out('host: footer pill hidden', await until(() => js("return document.getElementById('sessionBtn').hidden")));
    out('host: file still has the edits', /fromGuest/.test(readIn(proj, 'app.js') || ''));

    // ================= B: the app joins =================
    const host = await person('Omar Outside', 'omar');
    const sid2 = 'outside' + Date.now().toString(36);
    await update(ref(host.db), { [`sessions/${sid2}/hostUid`]: host.uid, [`sessions/${sid2}/info`]: { projectName: 'Py Thing', hostName: 'Omar Outside', createdAt: Date.now() } });
    const hEngine = createLiveProject({ projectId: sid2, root: outsideHost, branch: null, isGit: false, uid: host.uid, canEdit: true, api: nodeApi, db: host.db, basePath: `sessions/${sid2}` });
    await hEngine.treeShared;

    await js("document.getElementById('join-modal').hidden = false; document.getElementById('join-code').value = 'multeam://session/" + sid2 + "'; document.getElementById('join-form').requestSubmit()");
    out('app: waiting for the host', await until(() => js("return !document.getElementById('session-wait').hidden")));
    const pending = await until(async () => { try { const v = (await get(ref(host.db, `sessions/${sid2}/members`))).val() || {}; return Object.values(v).some((m) => m.status === 'pending'); } catch { return false; } });
    out('host (outside): sees the request', pending);
    const members = (await get(ref(host.db, `sessions/${sid2}/members`))).val() || {};
    const appUid = Object.keys(members)[0];
    await update(ref(host.db, `sessions/${sid2}/members/${appUid}`), { status: 'admitted' });
    out('app: opened the session project', await until(() => js("return !!document.querySelector('#file-tree .file-tree-node[data-name=\"main.py\"]')")));
    const folder = await js("return (await window.electronAPI.listProjects()).find(p => p.session)?.folderPath || ''");
    out('app: files in a temporary folder', readIn(folder, 'main.py') === 'print("hi")\n', folder);
    out('app: footer says live with the host', await js("return document.getElementById('sessionBtnText').textContent.includes('Omar')"));

    await js("[...document.querySelectorAll('#file-tree .file-tree-node')].find(n => n.dataset.name === 'main.py').click()"); await wait(2500);
    await js("document.querySelector('.monaco-editor textarea').focus()");
    win.webContents.insertText('# guest typed\n'); await wait(300);
    out('app (guest) editor → host disk', await until(() => /guest typed/.test(readIn(outsideHost, 'main.py') || '')), JSON.stringify(readIn(outsideHost, 'main.py')));

    await set(ref(host.db, `sessions/${sid2}/members/${appUid}/role`), 'viewer');
    out('app: told it is read-only', await until(() => js("return document.getElementById('sessionBtnText').textContent.includes('read-only')")));

    hEngine.dispose();
    await remove(ref(host.db, `sessions/${sid2}`));
    out('app: session project removed when it ends', await until(async () => !(await js("return (await window.electronAPI.listProjects()).some(p => p.session)"))));
    out('app: temporary folder deleted', await until(() => !fs.existsSync(folder)));
    out('app: footer pill hidden', await js("return document.getElementById('sessionBtn').hidden"));
  } catch (err) {
    failed++;
    console.log('FAIL  crashed:', err?.stack || err);
  }
  await js_cleanup();
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  app.exit(failed ? 1 : 0);
  async function js_cleanup() { try { fs.rmSync(TMPF, { recursive: true, force: true }); } catch { /* ignore */ } }
});
