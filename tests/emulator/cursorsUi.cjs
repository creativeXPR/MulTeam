// In-app test of collaborators' cursors: a teammate's cursor at line 1,
// col 1 (where labels used to be clipped), its colour, following, fading,
// and disappearing when they leave.   npm run test:cursors-ui
const { app, ipcMain, Menu } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createMainWindow } = require('../../src/main/window');
const { registerIpcHandlers } = require('../../src/main/ipcHandlers');
app.disableHardwareAcceleration();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await wait(250); } return false; };
const TMPF = process.env.TMPF || fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'multeam-cur-'));
const proj = path.join(TMPF, 'cur');
fs.mkdirSync(proj, { recursive: true });
fs.writeFileSync(path.join(proj, 'main.js'), 'const a = 1;\nconst b = 2;\nconst c = 3;\nfunction add(x, y) {\n  return x + y;\n}\n');

app.whenReady().then(async () => {
  const out = (...a) => console.log('RES', ...a);
  try {
    await fetch('http://127.0.0.1:9411/.settings/rules.json?ns=demo-multeam', { method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: fs.readFileSync(path.join(__dirname, '../../firebase/database.rules.json'), 'utf8') });
    const outDir = path.join(__dirname, '.build');
    await require('esbuild').build({
      entryPoints: [path.join(__dirname, 'syncEntry.js')], bundle: true, format: 'esm', platform: 'node', packages: 'external',
      outfile: path.join(outDir, 'sync.mjs'), logLevel: 'error',
      plugins: [{ name: 'stub-firebase', setup(b) { b.onResolve({ filter: /^\.\/firebase\.js$/ }, () => ({ path: path.join(__dirname, 'firebaseStub.js') })); } }]
    });
    const { FirebaseProvider, fileKeyFor, Y } = await import(pathToFileURL(path.join(outDir, 'sync.mjs')).href);
    const { initializeApp } = await import('firebase/app');
    const { getAuth, connectAuthEmulator, signInWithCredential, GoogleAuthProvider } = await import('firebase/auth');
    const { getFunctions, connectFunctionsEmulator, httpsCallable } = await import('firebase/functions');
    const { getDatabase, connectDatabaseEmulator } = await import('firebase/database');

    Menu.setApplicationMenu(null); registerIpcHandlers(ipcMain);
    const win = await createMainWindow();
    const errs = [];
    win.webContents.on('console-message', (e, level, msg) => { if (level >= 3 && !/Could not reach Cloud Firestore|PERMISSION_DENIED|permission_denied/.test(msg)) errs.push(String(msg).slice(0, 300)); });
    await wait(4000);
    const js = (s) => win.webContents.executeJavaScript('(async () => { ' + s + ' })()').catch((e) => 'TESTERR ' + e.message);
    const shot = async (n) => { for (let i = 0; i < 4; i++) { try { fs.writeFileSync(path.join(TMPF, n), (await win.capturePage()).toPNG()); return; } catch { await wait(600); } } };
    await js("for (const p of await window.electronAPI.listProjects()) if (p.name === 'Cursors') await window.electronAPI.deleteProjectLocal(p.id)");
    await js("localStorage.setItem('multeam:emulators', '1'); document.querySelector('[data-theme-set=dark]')?.click(); location.reload()"); await wait(4500);
    await js("await window.__multeamTest.signIn({ uid: 'olu', email: 'olu@team.dev', name: 'Olu Owner' })"); await wait(1000);
    const pid = await js('return (await window.electronAPI.createProject({ name: "Cursors", folderPath: ' + JSON.stringify(proj) + ', cloudEnabled: false })).id');
    await js('location.reload()'); await wait(4500);
    const menu = async (label) => {
      await js("document.querySelector('#projects [data-project=\"" + pid + "\"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 400, clientY: 330 }))"); await wait(300);
      await js("[...document.querySelectorAll('.context-menu-item')].find(b => b.offsetParent && b.textContent.startsWith(" + JSON.stringify(label) + ")).click()");
    };
    await menu('Edit…'); await wait(300);
    await js("document.getElementById('project-cloud-toggle').checked = true; document.getElementById('project-submit').click()");
    await until(() => js("return document.getElementById('project-modal').hidden"), 40000); await wait(500);
    await menu('Share…');
    await until(() => js("return document.getElementById('share-title').textContent.includes('Cursors')"));
    await js("document.getElementById('share-link-create').click()");
    await until(() => js("return !!document.querySelector('#share-links .share__item:not(.is-pending) .share__code')"));
    const code = await js("return document.querySelector('#share-links .share__item:not(.is-pending) .share__code').textContent");
    await js("document.getElementById('share-done').click()");

    const fa = initializeApp({ projectId: 'demo-multeam', apiKey: 'fake', databaseURL: 'http://127.0.0.1:9411?ns=demo-multeam' }, 'mate');
    const auth = getAuth(fa); connectAuthEmulator(auth, 'http://127.0.0.1:9109', { disableWarnings: true });
    const fns = getFunctions(fa, 'europe-west1'); connectFunctionsEmulator(fns, '127.0.0.1', 5011);
    const db = getDatabase(fa); connectDatabaseEmulator(db, '127.0.0.1', 9411);
    await signInWithCredential(auth, GoogleAuthProvider.credential(JSON.stringify({ sub: 'mate', email: 'mate@team.dev', email_verified: true, name: 'Ada Mate' })));
    await httpsCallable(fns, 'redeemCode')({ code });

    // app opens main.js (creates the live doc)
    await js("document.querySelector('[data-project-row=\"" + pid + "\"]').click()"); await wait(1500);
    await js("[...document.querySelectorAll('#file-tree .file-tree-node')].find(n => n.dataset.name === 'main.js').click()"); await wait(3500);

    // teammate joins the same live file and puts the cursor at line 1, col 1
    const ydoc = new Y.Doc();
    const prov = new FirebaseProvider({ projectId: pid, branchKey: fileKeyFor('_project'), fileKey: fileKeyFor('main.js') }, ydoc, { db });
    await prov.synced;
    await Promise.race([prov.firstState, wait(6000)]);
    const ytext = ydoc.getText('monaco');
    const putCursor = (index) => prov.awareness.setLocalState({ user: { name: 'Ada Mate', color: '#3E63DD' }, selection: { anchor: Y.createRelativePositionFromTypeIndex(ytext, index), head: Y.createRelativePositionFromTypeIndex(ytext, index) } });
    putCursor(0);
    const shown = await until(() => js("return !!document.querySelector('.rcursor.is-active')"), 10000);
    const box = await js("const el = document.querySelector('.rcursor'); const r = el.getBoundingClientRect(); const ed = document.querySelector('.egroup__editor').getBoundingClientRect(); return JSON.stringify({ text: el.textContent, top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom), edTop: Math.round(ed.top), edLeft: Math.round(ed.left), inOverflowLayer: !!el.closest('.overflowingContentWidgets'), bg: getComputedStyle(el).backgroundColor })");
    out('label at line 1 shown:', shown, box);
    const head = await js("const h = document.querySelector('.yRemoteSelectionHead'); return h ? getComputedStyle(h).borderLeftColor + ' w=' + getComputedStyle(h).borderLeftWidth : 'no caret'");
    out('caret:', head);
    await shot('cursor-top.png');
    // move to line 5 and type
    ytext.insert(ytext.toString().indexOf('return'), '// ');
    putCursor(ytext.toString().indexOf('return'));
    await wait(600);
    out('label follows to line 5:', await js("const el = document.querySelector('.rcursor'); return el.classList.contains('is-active') + ' top=' + Math.round(el.getBoundingClientRect().top)"));
    await wait(3600);
    out('label fades when idle:', await js("return !document.querySelector('.rcursor').classList.contains('is-active') && getComputedStyle(document.querySelector('.rcursor')).opacity"));
    prov.destroy();
    out('label removed when they leave:', await until(() => js("return !document.querySelector('.rcursor')"), 10000));
    out('errors:', errs.join('\n  ') || 'none');
    await js("for (const p of await window.electronAPI.listProjects()) if (p.name === 'Cursors') await window.electronAPI.deleteProjectLocal(p.id); localStorage.removeItem('multeam:emulators')");
  } catch (e) { out('HARNESS', e.stack); }
  app.quit();
});
