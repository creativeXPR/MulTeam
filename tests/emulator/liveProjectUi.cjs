// In-app test of whole-project live sync (stage 2.1) against the emulators:
//   npm run test:live-ui
// The app owns a Git-tracked cloud project; a teammate runs the real sync
// engine on their own folder. Checks files, editor typing, outside edits and
// a branch switch.
const { app, ipcMain, Menu } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { createMainWindow } = require('../../src/main/window');
const { registerIpcHandlers } = require('../../src/main/ipcHandlers');
app.disableHardwareAcceleration();
// Test windows sit in the background; without these, Chromium may stop
// painting them (Monaco then shows no text even though the model is right).
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-background-timer-throttling');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await wait(250); } return false; };
const TMPF = process.env.TMPF || fs.mkdtempSync(path.join(os.tmpdir(), 'multeam-live-'));
const proj = path.join(TMPF, 'team');
const mate = path.join(TMPF, 'mate');
for (const d of [proj, mate]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(proj, 'app.js'), 'const v = 1;\n');
const sh = (cmd, cwd = proj) => execSync(cmd, { cwd, stdio: 'pipe' }).toString();
sh('git init -q -b main && git -c user.email=t@t -c user.name=t add . && git -c user.email=t@t -c user.name=t commit -qm init');
fs.cpSync(path.join(proj, 'app.js'), path.join(mate, 'app.js'));

app.whenReady().then(async () => {
  const out = (...a) => console.log('RES', ...a);
  try {
    await fetch('http://127.0.0.1:9411/.settings/rules.json?ns=demo-multeam', { method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: fs.readFileSync(path.join(__dirname, '../../firebase/database.rules.json'), 'utf8') });
    // the real engine, bundled with firebase.js stubbed (same as test:live-project)
    const outDir = path.join(__dirname, '.build');
    await require('esbuild').build({
      entryPoints: [path.join(__dirname, 'liveProjectEntry.js')], bundle: true, format: 'esm', platform: 'node', packages: 'external',
      outfile: path.join(outDir, 'liveProject.mjs'), logLevel: 'error',
      plugins: [{ name: 'stub-firebase', setup(b) { b.onResolve({ filter: /^\.\/firebase\.js$/ }, () => ({ path: path.join(__dirname, 'firebaseStub.js') })); } }]
    });
    // ESM firebase + the engine bundle share module instances
    const { initializeApp } = await import('firebase/app');
    const { getAuth, connectAuthEmulator, signInWithCredential, GoogleAuthProvider } = await import('firebase/auth');
    const { getFunctions, connectFunctionsEmulator, httpsCallable } = await import('firebase/functions');
    const { getDatabase, connectDatabaseEmulator } = await import('firebase/database');
    const { createLiveProject } = await import(pathToFileURL(path.join(outDir, 'liveProject.mjs')).href);

    Menu.setApplicationMenu(null); registerIpcHandlers(ipcMain);
    const win = await createMainWindow();
    // keep the test window painting and receiving keystrokes while in the background
    win.webContents.setBackgroundThrottling(false);
    win.show();
    win.focus();
    const errs = [];
    win.webContents.on('console-message', (e, level, msg) => { if (level >= 3 && !/Could not reach Cloud Firestore|PERMISSION_DENIED|permission_denied/.test(msg)) errs.push(String(msg).slice(0, 300)); });
    await wait(4000);
    const js = (s) => win.webContents.executeJavaScript('(async () => { ' + s + ' })()').catch((e) => 'TESTERR ' + e.message);
    // leftovers from an earlier interrupted run would confuse the test
    await js("for (const p of await window.electronAPI.listProjects()) if (p.name === 'Team' || p.name === 'Plain') await window.electronAPI.deleteProjectLocal(p.id)");
    await js("localStorage.setItem('multeam:emulators', '1'); location.reload()"); await wait(4500);
    await js("await window.__multeamTest.signIn({ uid: 'olu', email: 'olu@team.dev', name: 'Olu Owner' })"); await wait(1000);
    const pid = await js('return (await window.electronAPI.createProject({ name: "Team", folderPath: ' + JSON.stringify(proj) + ', cloudEnabled: false })).id');
    await js('location.reload()'); await wait(4500);
    const menu = async (label) => {
      await js("document.querySelector('#projects [data-project=\"" + pid + "\"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 400, clientY: 330 }))"); await wait(300);
      await js("[...document.querySelectorAll('.context-menu-item')].find(b => b.offsetParent && b.textContent.startsWith(" + JSON.stringify(label) + ")).click()");
    };
    await menu('Edit…'); await wait(300);
    await js("document.getElementById('project-cloud-toggle').checked = true; document.getElementById('project-submit').click()");
    await until(() => js("return document.getElementById('project-modal').hidden"), 40000); await wait(500);
    await menu('Share…');
    await until(() => js("return document.getElementById('share-title').textContent.includes('Team')"));
    await js("document.getElementById('share-link-create').click()");
    await until(() => js("return !!document.querySelector('#share-links .share__item:not(.is-pending) .share__code')"));
    const code = await js("return document.querySelector('#share-links .share__item:not(.is-pending) .share__code').textContent");
    await js("document.getElementById('share-done').click()");

    // teammate joins (editor link) and runs the engine on their own folder
    const fa = initializeApp({ projectId: 'demo-multeam', apiKey: 'fake', databaseURL: 'http://127.0.0.1:9411?ns=demo-multeam' }, 'mate');
    const auth = getAuth(fa); connectAuthEmulator(auth, 'http://127.0.0.1:9109', { disableWarnings: true });
    const fns = getFunctions(fa, 'europe-west1'); connectFunctionsEmulator(fns, '127.0.0.1', 5011);
    const db = getDatabase(fa); connectDatabaseEmulator(db, '127.0.0.1', 9411);
    await signInWithCredential(auth, GoogleAuthProvider.credential(JSON.stringify({ sub: 'mate', email: 'mate@team.dev', email_verified: true, name: 'Mate' })));
    await httpsCallable(fns, 'redeemCode')({ code });
    const fsp = fs.promises;
    const mateApi = {
      readFile: async (p) => { if ((await fsp.stat(p)).isDirectory()) throw new Error('dir'); return fsp.readFile(p, 'utf8'); },
      writeFile: async (p, t) => { await fsp.mkdir(path.dirname(p), { recursive: true }); await fsp.writeFile(p, t); },
      readDir: (p) => fsp.readdir(p), createDirectory: (p) => fsp.mkdir(p, { recursive: true }),
      trashEntry: async (p) => { await fsp.rm(p, { recursive: true, force: true }); return true; },
      backupFile: async () => 'x', headContent: async () => null
    };
    const mateEngine = createLiveProject({ projectId: pid, root: mate, branch: 'main', isGit: true, uid: auth.currentUser.uid, canEdit: true, api: mateApi, db });
    const mateWrite = (rel, t) => { fs.mkdirSync(path.dirname(path.join(mate, rel)), { recursive: true }); fs.writeFileSync(path.join(mate, rel), t); mateEngine.onDiskEvent({ filename: rel }); };
    const mateRead = (rel) => (fs.existsSync(path.join(mate, rel)) ? fs.readFileSync(path.join(mate, rel), 'utf8') : null);

    // open the project in the app
    await js("document.querySelector('[data-project-row=\"" + pid + "\"]').click()"); await wait(2500);

    mateWrite('src/hello.js', 'export const hi = "from mate";\n');
    out('mate file → app disk:', await until(() => fs.existsSync(path.join(proj, 'src', 'hello.js'))), JSON.stringify(fs.existsSync(path.join(proj, 'src', 'hello.js')) ? fs.readFileSync(path.join(proj, 'src', 'hello.js'), 'utf8') : null));
    await wait(800);
    out('explorer shows src/:', await js("return !!document.querySelector('#file-tree .file-tree-node[data-name=\"src\"]')"));

    // app edits app.js in the editor → mate's disk
    await js("[...document.querySelectorAll('#file-tree .file-tree-node')].find(n => n.dataset.name === 'app.js').click()"); await wait(3000);
    await js("document.querySelector('.monaco-editor textarea').focus()");
    win.webContents.insertText('// typed live\n'); await wait(300);
    out('app editor → mate disk:', await until(() => /typed live/.test(mateRead('app.js') || '')), JSON.stringify(mateRead('app.js')));
    out('app disk too (autosave/live):', await until(() => /typed live/.test(fs.readFileSync(path.join(proj, 'app.js'), 'utf8'))));

    // mate edits app.js → app editor updates live
    mateWrite('app.js', (mateRead('app.js') || '') + 'const fromMate = true;\n');
    const seen = await until(() => js("return document.querySelector('.view-lines').textContent.includes('fromMate')"));
    out('mate edit → app editor:', seen);
    if (!seen) out('  debug: mate disk=', JSON.stringify(mateRead('app.js')), ' mate state=', JSON.stringify(mateEngine._state().docs), ' app editor=', JSON.stringify(await js("return document.querySelector('.view-lines').textContent")), ' tabs=', await js("return [...document.querySelectorAll('.egroup .tab')].map(t => t.dataset.path.split(/[\\\\/]/).pop() + (t.classList.contains('active') ? '*' : '')).join(',') + ' editors=' + document.querySelectorAll('.monaco-editor').length + ' viewlines=' + document.querySelectorAll('.view-lines').length + ' emptyHint=' + (document.querySelector('.egroup__editor')?.dataset.empty || '') + ' editorChildren=' + document.querySelector('.egroup__editor')?.children.length"), ' toasts=', await js("return [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | ')"), ' app disk=', JSON.stringify(fs.readFileSync(path.join(proj, 'app.js'), 'utf8')));

    // a file created outside the editor (like the terminal) → mate
    fs.writeFileSync(path.join(proj, 'terminal.txt'), 'made in terminal\n');
    out('app terminal file → mate:', await until(() => mateRead('terminal.txt') === 'made in terminal\n'));

    // git checkout -b feature → app switches live session
    sh('git checkout -q -b feature');
    out('branch switch toast:', await until(() => js("return [...document.querySelectorAll('.toast')].some(t => /Switched to branch feature/.test(t.textContent))"), 15000));
    fs.writeFileSync(path.join(proj, 'feature-only.txt'), 'feature work\n');
    await wait(3500);
    out('feature-branch file stays off main (mate):', mateRead('feature-only.txt') === null);
    out('editor reopened:', await js("return document.querySelectorAll('.egroup .tab').length"));

    mateEngine.dispose();

    // ---- phase 2: a cloud project WITHOUT Git (stage 2.2) ----
    const plain = path.join(TMPF, 'plain');
    const plainMate = path.join(TMPF, 'plain-mate');
    fs.mkdirSync(path.join(plain, 'pages'), { recursive: true });
    fs.mkdirSync(plainMate, { recursive: true });
    fs.writeFileSync(path.join(plain, 'index.html'), '<h1>home</h1>\n');
    fs.writeFileSync(path.join(plain, 'pages', 'about.html'), '<p>about</p>\n');
    fs.writeFileSync(path.join(plain, '.env'), 'SECRET=1\n');
    const pid2 = await js('return (await window.electronAPI.createProject({ name: "Plain", folderPath: ' + JSON.stringify(plain) + ', cloudEnabled: false })).id');
    await js("go('dashboard'); await refreshProjects?.()").catch(() => {});
    await js('location.reload()'); await wait(4500);
    const menu2 = async (label) => {
      await js("document.querySelector('#projects [data-project=\"" + pid2 + "\"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 400, clientY: 330 }))"); await wait(300);
      await js("[...document.querySelectorAll('.context-menu-item')].find(b => b.offsetParent && b.textContent.startsWith(" + JSON.stringify(label) + ")).click()");
    };
    await menu2('Edit…'); await wait(300);
    await js("document.getElementById('project-cloud-toggle').checked = true; document.getElementById('project-submit').click()");
    const editClosed = await until(() => js("return document.getElementById('project-modal').hidden"), 40000); await wait(500);
    await menu2('Share…');
    await until(() => js("return document.getElementById('share-title').textContent.includes('Plain')"));
    await js("document.getElementById('share-link-create').click()");
    const linkShown = await until(() => js("return !!document.querySelector('#share-links .share__item:not(.is-pending) .share__code')"));
    if (!linkShown) out('  debug: no link; share sub=', await js("return document.getElementById('share-sub').textContent"), ' toasts=', await js("return [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | ')"), ' projects=', await js("return JSON.stringify((await window.electronAPI.listProjects()).map(p => [p.name, p.cloudEnabled]))"));
    await httpsCallable(fns, 'redeemCode')({ code: await js("return document.querySelector('#share-links .share__item:not(.is-pending) .share__code').textContent") });
    await js("document.getElementById('share-done').click()");
    // opening it shares the whole folder (no Git)
    await js("document.querySelector('[data-project-row=\"" + pid2 + "\"]').click()"); await wait(500);
    out('no-git: share toast:', await until(() => js("return [...document.querySelectorAll('.toast')].some(t => /Shared 2 files/.test(t.textContent))"), 20000));
    const plainApi = { ...mateApi, listFiles: async (r) => ({ files: [], truncated: false }) };
    const plainEngine = createLiveProject({ projectId: pid2, root: plainMate, branch: null, isGit: false, uid: auth.currentUser.uid, canEdit: true, api: plainApi, db });
    const pRead = (rel) => (fs.existsSync(path.join(plainMate, rel)) ? fs.readFileSync(path.join(plainMate, rel), 'utf8') : null);
    out('no-git: empty folder received everything:', await until(() => pRead('index.html') === '<h1>home</h1>\n' && pRead('pages/about.html') === '<p>about</p>\n'));
    out('no-git: .env stayed local:', pRead('.env') === null);
    fs.writeFileSync(path.join(plainMate, 'contact.html'), '<p>contact</p>\n');
    plainEngine.onDiskEvent({ filename: 'contact.html' });
    out('no-git: teammate file → app disk:', await until(() => fs.existsSync(path.join(plain, 'contact.html'))));
    await wait(800);
    out('no-git: explorer shows it:', await js("return !!document.querySelector('#file-tree .file-tree-node[data-name=\"contact.html\"]')"));
    plainEngine.dispose();

    out('errors:', errs.join('\n  ') || 'none');
    await js("for (const p of await window.electronAPI.listProjects()) if (p.name === 'Team' || p.name === 'Plain') await window.electronAPI.deleteProjectLocal(p.id); localStorage.removeItem('multeam:emulators')");
  } catch (e) { out('HARNESS', e.stack); }
  app.quit();
});
