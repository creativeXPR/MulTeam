// In-app test of follow mode (stage 5) against the emulators:
//   npm run test:follow-ui
// The app hosts a live session; a guest outside the app announces where
// they are (presence) the way MulTeam does. The app follows them, notes an
// unshared file, stops when the user scrolls or presses Esc, answers a
// "Follow me", and asks everyone to follow it.
const { app, ipcMain, Menu } = require('electron');
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
const until = async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await wait(200); } return false; };
const TMPF = fs.mkdtempSync(path.join(os.tmpdir(), 'multeam-follow-'));
const proj = path.join(TMPF, 'pair');
fs.mkdirSync(path.join(proj, 'lib'), { recursive: true });
fs.writeFileSync(path.join(proj, 'app.js'), Array.from({ length: 300 }, (_, i) => `const l${i + 1} = ${i + 1};`).join('\n') + '\n');
fs.writeFileSync(path.join(proj, 'lib', 'util.js'), 'export const util = true;\n');
fs.writeFileSync(path.join(proj, '.env'), 'SECRET=1\n');

let failed = 0;
const out = (label, ok, ...more) => { if (ok !== true) failed++; console.log(ok === true ? 'PASS ' : 'FAIL ', label, ...more); };

app.whenReady().then(async () => {
  try {
    await fetch('http://127.0.0.1:9411/.settings/rules.json?ns=demo-multeam', { method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: fs.readFileSync(path.join(__dirname, '../../firebase/database.rules.json'), 'utf8') });
    const { initializeApp } = await import('firebase/app');
    const { getAuth, connectAuthEmulator, signInWithCredential, GoogleAuthProvider } = await import('firebase/auth');
    const { getDatabase, connectDatabaseEmulator, ref, get, set, update, remove } = await import('firebase/database');

    Menu.setApplicationMenu(null); registerIpcHandlers(ipcMain);
    const win = await createMainWindow();
    win.webContents.setBackgroundThrottling(false);
    win.show(); win.focus();
    win.webContents.on('console-message', (e, level, msg) => { if (level >= 3 && !/Could not reach Cloud Firestore|permission_denied|WebChannel/i.test(msg)) console.log('  [renderer]', String(msg).slice(0, 300)); });
    await wait(4000);
    const js = (s) => win.webContents.executeJavaScript('(async () => { ' + s + ' })()').catch((e) => 'TESTERR ' + e.message);
    await js("for (const p of await window.electronAPI.listProjects()) if (p.name === 'Pair' || p.session) await window.electronAPI.deleteProjectLocal(p.id)");
    await js("localStorage.setItem('multeam:emulators', '1'); location.reload()"); await wait(4500);
    await js("await window.__multeamTest.signIn({ uid: 'hana', email: 'hana@pair.dev', name: 'Hana Host' })"); await wait(1000);
    const pid = await js('return (await window.electronAPI.createProject({ name: "Pair", folderPath: ' + JSON.stringify(proj) + ', cloudEnabled: false })).id');
    await js('location.reload()'); await wait(4500);

    // open app.js, start a session
    await js("document.querySelector('[data-project-row=\"" + pid + "\"]').click()"); await wait(2500);
    await js("[...document.querySelectorAll('#file-tree .file-tree-node')].find(n => n.dataset.name === 'app.js').click()"); await wait(2500);
    await js("document.querySelector('.menubar__title[data-menu=\"0\"]').click()"); await wait(300);
    await js("[...document.querySelectorAll('.menubar__item')].find(b => b.textContent.trim().startsWith('Start Live Session')).click()");
    await until(() => js("return /multeam:\\/\\/session\\//.test(document.querySelector('.session__link code')?.textContent || '')"));
    const sid = (/session\/([a-z0-9]+)/.exec(await js("return document.querySelector('.session__link code')?.textContent || ''")) || [])[1];
    out('session started', !!sid);
    await js("document.body.click()"); await wait(300);

    // the guest joins and is admitted
    const fa = initializeApp({ projectId: 'demo-multeam', apiKey: 'fake', databaseURL: 'http://127.0.0.1:9411?ns=demo-multeam' }, 'gus');
    const auth = getAuth(fa); connectAuthEmulator(auth, 'http://127.0.0.1:9109', { disableWarnings: true });
    const db = getDatabase(fa); connectDatabaseEmulator(db, '127.0.0.1', 9411);
    await signInWithCredential(auth, GoogleAuthProvider.credential(JSON.stringify({ sub: 'gus', email: 'gus@pair.dev', email_verified: true, name: 'Gus Guest' })));
    const gus = auth.currentUser.uid;
    await set(ref(db, `sessions/${sid}/members/${gus}`), { name: 'Gus Guest', status: 'pending', role: 'editor', at: Date.now() });
    await until(() => js("return !!document.querySelector('#sessionBtn.has-pending')"));
    await js("document.getElementById('sessionBtn').click()"); await wait(300);
    await until(() => js("return !!document.querySelector('#sessionBody [data-s=admit]')"), 5000);
    await js("document.querySelector('#sessionBody [data-s=admit]').click()");
    await until(async () => (await get(ref(db, `sessions/${sid}/members/${gus}/status`))).val() === 'admitted');
    await js("document.body.click()"); await wait(300);

    const presRef = ref(db, `sessions/${sid}/presence/gus1`);
    const at = (file, extra = {}) => set(presRef, { uid: gus, name: 'Gus Guest', color: '#0ea5e9', branch: null, file, shared: true, top: 1, line: 1, following: null, followMe: null, at: Date.now(), ...extra });
    const appEntry = async () => Object.values((await get(ref(db, `sessions/${sid}/presence`))).val() || {}).find((p) => p.uid !== gus) || null;

    // presence both ways
    await at('lib/util.js');
    out('footer shows the guest', await until(() => js("return !!document.querySelector('.follow-av[title^=\"Gus Guest\"]')")));
    out("the guest's file in the tooltip", await js("return document.querySelector('.follow-av').title.includes('lib/util.js')"));
    out('the app announces its file', await until(async () => (await appEntry())?.file === 'app.js'), JSON.stringify(await appEntry()));

    // follow
    await js("document.querySelector('.follow-av').click()");
    const activeName = "return document.querySelector('.egroup.is-focused .tab.active, .egroup .tab.active')?.dataset.path?.split(/[\\\\/]/).pop()";
    out('following: pill + frame', await until(() => js("return !!document.querySelector('.egroup.is-following .follow-pill') && document.querySelector('.follow-pill').textContent.includes('Gus Guest')")));
    out("following: opened the guest's file", await until(async () => (await js(activeName)) === 'util.js'), await js(activeName));
    out('the app says who it follows', await until(async () => (await appEntry())?.following === 'gus1'));

    await at('app.js', { top: 200, line: 205 });
    out('follows into another file', await until(async () => (await js(activeName)) === 'app.js'));
    out('and scrolls to where they are', await until(() => js("return document.querySelector('.egroup.is-following .view-lines').textContent.includes('l200 =')")), await js("return document.querySelector('.egroup .view-lines')?.textContent.slice(0, 60)"));

    await at('.env', { shared: false });
    out('unshared file: keeps following with a note', await until(() => js("return document.querySelector('.follow-pill__note')?.textContent.includes(\"isn't shared\")")), await js("return document.querySelector('.follow-pill')?.textContent"));
    out('unshared file: stays where it was', (await js(activeName)) === 'app.js');

    // scrolling yourself stops following
    await at('lib/util.js');
    await until(async () => (await js(activeName)) === 'util.js');
    const box = JSON.parse(await js("const r = document.querySelector('.egroup.is-following .egroup__editor').getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })"));
    win.webContents.sendInputEvent({ type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: -120 });
    out('scrolling stops following', await until(() => js("return !document.querySelector('.follow-pill') && !document.querySelector('.egroup.is-following')")));
    out('…and the app no longer says it follows', await until(async () => !(await appEntry())?.following));

    // Esc stops following
    await js("document.querySelector('.follow-av').click()");
    await until(() => js("return !!document.querySelector('.follow-pill')"));
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    out('Esc stops following', await until(() => js("return !document.querySelector('.follow-pill')")));

    // the guest asks everyone to follow them
    await at('app.js', { top: 100, followMe: Date.now() });
    out('"Follow me" prompt', await until(() => js("return !document.getElementById('confirm-modal').hidden && document.getElementById('confirm-title').textContent.includes('Gus Guest asks')")));
    await js("document.getElementById('confirm-ok').click()");
    out('accepting follows them', await until(async () => (await js("return !!document.querySelector('.follow-pill')")) && (await js(activeName)) === 'app.js'));

    // the guest leaves
    await remove(presRef);
    out('they leave: following stops', await until(() => js("return !document.querySelector('.follow-pill')")));
    out('they leave: avatar gone', await until(() => js("return !document.querySelector('.follow-av')")));

    // the app asks everyone to follow it
    await at('lib/util.js');
    await until(() => js("return !!document.querySelector('[data-follow-me]')"));
    await js("document.querySelector('[data-follow-me]').click()");
    out('Follow me: announced', await until(async () => typeof (await appEntry())?.followMe === 'number'));
    await at('lib/util.js', { following: Object.keys((await get(ref(db, `sessions/${sid}/presence`))).val()).find((k) => k !== 'gus1') });
    out('Follow me: shows who follows', await until(() => js("return (document.querySelector('.follow-count')?.textContent || '').includes('1 following you')")));
    await js("document.querySelector('[data-follow-me]').click()");
    out('Stop follow me', await until(async () => !(await appEntry())?.followMe));

    // ending the session clears presence
    await js("document.getElementById('sessionBtn').click()"); await wait(300);
    await until(() => js("return !!document.querySelector('#sessionBody [data-s=end]')"), 5000);
    await js("document.querySelector('#sessionBody [data-s=end]').click()");
    await until(() => js("return !document.getElementById('confirm-modal').hidden"), 5000);
    await js("document.getElementById('confirm-ok').click()");
    out('session ended: footer avatars cleared', await until(() => js("return !document.querySelector('.follow-av') && !document.querySelector('[data-follow-me]')")));
  } catch (err) {
    failed++;
    console.log('FAIL  crashed:', err?.stack || err);
  }
  try { fs.rmSync(TMPF, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  app.exit(failed ? 1 : 0);
});
