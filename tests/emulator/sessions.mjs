// Emulator tests for live sessions (collaboration stage 4): RTDB rules for
// sessions/{id} and the sync engine running against a session (host's
// folder → guest's empty folder, guest edits → host's disk).
//   npm run test:sessions   (needs the Firebase CLI + Java)
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const outDir = path.join(here, '.build');
mkdirSync(outDir, { recursive: true });
await esbuild.build({
  entryPoints: [path.join(here, 'liveProjectEntry.js')], bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: path.join(outDir, 'liveProject.mjs'), logLevel: 'error',
  plugins: [{ name: 'stub-firebase', setup(b) { b.onResolve({ filter: /^\.\/firebase\.js$/ }, () => ({ path: path.join(here, 'firebaseStub.js') })); } }]
});
const { createLiveProject } = await import(pathToFileURL(path.join(outDir, 'liveProject.mjs')).href);

const env = await initializeTestEnvironment({
  projectId: 'demo-multeam',
  database: { rules: readFileSync(path.join(root, 'firebase/database.rules.json'), 'utf8'), host: '127.0.0.1', port: 9411 }
});

const results = [];
async function check(name, fn) { try { await fn(); results.push(['PASS', name]); } catch (err) { results.push(['FAIL', name, err?.message || String(err)]); } }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await wait(100); } return false; };
const eq = (a, b, what) => { if (a !== b) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const db = (uid) => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).database();

const S = 'sess' + Date.now();
const at = Date.now();
const info = { projectName: 'Pair App', hostName: 'Host', createdAt: at };
const member = (status, role = 'editor', name = 'Guest') => ({ name, status, role, at });
const upd = { state: 'AAA=', origin: 1 };
const docPath = `sessions/${S}/docs/app~2Ejs`;

// ---------- rules ----------
await check('host starts a session (host + info in one write)', () => assertSucceeds(db('host').ref().update({ [`sessions/${S}/hostUid`]: 'host', [`sessions/${S}/info`]: info })));
await check('nobody else can claim an existing session', () => assertFails(db('eve').ref(`sessions/${S}/hostUid`).set('eve')));
await check('anyone signed in can see the session name', () => assertSucceeds(db('guest').ref(`sessions/${S}/info`).get()));
await check('signed-out people cannot', () => assertFails(db(null).ref(`sessions/${S}/info`).get()));
await check('a guest asks to join (pending)', () => assertSucceeds(db('guest').ref(`sessions/${S}/members/guest`).set(member('pending'))));
await check('a guest cannot admit themselves', () => assertFails(db('eve').ref(`sessions/${S}/members/eve`).set(member('admitted'))));
await check('a guest cannot change their request after sending it', () => assertFails(db('guest').ref(`sessions/${S}/members/guest`).set(member('admitted'))));
await check('a guest cannot add someone else', () => assertFails(db('guest').ref(`sessions/${S}/members/other`).set(member('pending'))));
await check('a guest can read their own status', () => assertSucceeds(db('guest').ref(`sessions/${S}/members/guest`).get()));
await check('a waiting guest cannot read the files or member list', async () => {
  await assertFails(db('guest').ref(`sessions/${S}/files`).get());
  await assertFails(db('guest').ref(`sessions/${S}/members`).get());
});
await check('a waiting guest cannot edit', () => assertFails(db('guest').ref(`${docPath}/updates`).push(upd)));
await check('the host admits the guest', () => assertSucceeds(db('host').ref(`sessions/${S}/members/guest`).update({ status: 'admitted' })));
await check('an admitted editor reads and edits', async () => {
  await assertSucceeds(db('guest').ref(`sessions/${S}`).get());
  await assertSucceeds(db('guest').ref(`${docPath}/updates`).push(upd));
});
await check('index entries must name the writer', () => assertFails(db('guest').ref(`sessions/${S}/files/x`).set({ path: 'x', kind: 'file', state: 'live', by: 'host', at: 1 })));
await check('the host switches the guest to read-only', async () => {
  await assertSucceeds(db('host').ref(`sessions/${S}/members/guest/role`).set('viewer'));
  await assertFails(db('guest').ref(`${docPath}/updates`).push(upd));
  await assertSucceeds(db('guest').ref(`${docPath}/awareness/5`).set('AAA='));
});
// presence (follow mode, stage 5)
const pres = (uid, extra = {}) => ({ uid, name: uid, at: Date.now(), file: 'app.js', shared: true, top: 1, line: 1, ...extra });
await check('presence: an admitted guest announces themselves', () => assertSucceeds(db('guest').ref(`sessions/${S}/presence/g1`).set(pres('guest'))));
await check('presence: nobody can write as someone else', async () => {
  await assertFails(db('guest').ref(`sessions/${S}/presence/g2`).set(pres('host')));
  await assertFails(db('guest').ref(`sessions/${S}/presence/h1`).set(pres('guest')).then(() => db('host').ref(`sessions/${S}/presence/h1`).set(pres('host'))));
});
await check('presence: a waiting/unknown person cannot', () => assertFails(db('eve').ref(`sessions/${S}/presence/e1`).set(pres('eve'))));
await check('presence: the host can clear a removed guest', () => assertSucceeds(db('host').ref(`sessions/${S}/presence/g1`).remove()));
await check('presence: project members only, own entry only', async () => {
  await env.withSecurityRulesDisabled((c) => c.database().ref('projectMembers/pp1').set({ olu: 'owner', mate: 'viewer', ed: 'editor' }));
  await assertSucceeds(db('mate').ref('projects/pp1/presence/m1').set(pres('mate', { branch: 'main' })));
  await assertSucceeds(db('olu').ref('projects/pp1/presence').get());
  await assertFails(db('olu').ref('projects/pp1/presence/m1').set(pres('olu')));
  await assertFails(db('ed').ref('projects/pp1/presence/m1').remove()); // (the owner may: deleting a project clears it all)
  await assertFails(db('eve').ref('projects/pp1/presence').get());
  await assertFails(db('eve').ref('projects/pp1/presence/e1').set(pres('eve')));
  await assertSucceeds(db('mate').ref('projects/pp1/presence/m1').remove());
});

await check('a denied guest sees nothing', async () => {
  await db('eve').ref(`sessions/${S}/members/eve`).set(member('pending', 'editor', 'Eve'));
  await assertSucceeds(db('host').ref(`sessions/${S}/members/eve/status`).set('denied'));
  await assertFails(db('eve').ref(`sessions/${S}/files`).get());
});
await check('a guest can leave', async () => {
  await assertSucceeds(db('guest').ref(`sessions/${S}/members/guest`).remove());
  await assertFails(db('guest').ref(`sessions/${S}/files`).get());
});
await check('only the host can end the session', async () => {
  await assertFails(db('eve').ref(`sessions/${S}`).remove());
  await assertSucceeds(db('host').ref(`sessions/${S}`).remove());
});

// ---------- the engine against a session ----------
function machine(uid, sid, { canEdit = true, seed = {} } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `mt-s-${uid}-`));
  for (const [rel, text] of Object.entries(seed)) { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), text); }
  const api = {
    readFile: async (p) => { if ((await fsp.stat(p)).isDirectory()) throw new Error('dir'); return fsp.readFile(p, 'utf8'); },
    writeFile: async (p, t) => { await fsp.mkdir(path.dirname(p), { recursive: true }); await fsp.writeFile(p, t); },
    readDir: (p) => fsp.readdir(p), createDirectory: (p) => fsp.mkdir(p, { recursive: true }),
    trashEntry: async (p) => { await fsp.rm(p, { recursive: true, force: true }); return true; },
    backupFile: async () => 'x', headContent: async () => null,
    listFiles: async (r) => { const files = []; const walk = async (d) => { for (const e of await fsp.readdir(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules') await walk(f); } else files.push(path.relative(r, f)); } }; await walk(r); return { files, truncated: false }; }
  };
  const engine = createLiveProject({ projectId: sid, root: dir, branch: null, isGit: false, uid, canEdit, api, db: db(uid)._delegate, basePath: `sessions/${sid}` });
  const read = (rel) => (existsSync(path.join(dir, rel)) ? readFileSync(path.join(dir, rel), 'utf8') : null);
  const write = (rel, t) => { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), t); engine.onDiskEvent({ filename: rel }); };
  return { dir, engine, read, write };
}

const S2 = 'sess2' + Date.now();
await check('session: the host’s whole folder reaches a guest’s empty folder', async () => {
  await db('host').ref().update({ [`sessions/${S2}/hostUid`]: 'host', [`sessions/${S2}/info`]: { ...info, createdAt: Date.now() } });
  const host = machine('host', S2, { seed: { 'index.js': 'start();\n', 'lib/util.js': 'export const u = 1;\n', '.env': 'SECRET=1\n' } });
  await host.engine.treeShared;
  await db('guest').ref(`sessions/${S2}/members/guest`).set(member('pending'));
  await db('host').ref(`sessions/${S2}/members/guest/status`).set('admitted');
  const guest = machine('guest', S2);
  eq(await until(() => guest.read('index.js') === 'start();\n' && guest.read('lib/util.js') === 'export const u = 1;\n'), true, 'received');
  eq(guest.read('.env'), null, '.env stays on the host');
  guest.write('index.js', 'start();\nguestEdit();\n');
  eq(await until(() => host.read('index.js') === 'start();\nguestEdit();\n'), true, "guest's edit on host disk");
  guest.write('new-by-guest.js', 'hello();\n');
  eq(await until(() => host.read('new-by-guest.js') === 'hello();\n'), true, "guest's new file on host disk");
  host.engine.dispose(); guest.engine.dispose();
});

await env.cleanup();
const failed = results.filter((r) => r[0] === 'FAIL');
for (const r of results) console.log(r[0].padEnd(5), r[1], r[2] ? `\n      → ${r[2]}` : '');
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
