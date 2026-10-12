// Emulator tests for live collaboration (stage 0): Realtime Database rules
// and the Yjs FirebaseProvider (src/renderer/js/sync.js) with real clients.
//   npm run test:emulator     (needs the Firebase CLI + Java)
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const PORT = 9411;

// ---------- bundle sync.js with the stub in place of firebase.js ----------
const outDir = path.join(here, '.build');
mkdirSync(outDir, { recursive: true });
await esbuild.build({
  entryPoints: [path.join(here, 'syncEntry.js')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  packages: 'external',
  outfile: path.join(outDir, 'sync.mjs'),
  logLevel: 'error',
  plugins: [{
    name: 'stub-firebase',
    setup(b) { b.onResolve({ filter: /^\.\/firebase\.js$/ }, () => ({ path: path.join(here, 'firebaseStub.js') })); }
  }]
});
const { FirebaseProvider, fileKeyFor, useDb, Y } = await import(pathToFileURL(path.join(outDir, 'sync.mjs')).href);

const env = await initializeTestEnvironment({
  projectId: 'demo-multeam',
  database: { rules: readFileSync(path.join(root, 'firebase/database.rules.json'), 'utf8'), host: '127.0.0.1', port: PORT }
});

const results = [];
async function check(name, fn) {
  try { await fn(); results.push(['PASS', name]); } catch (err) { results.push(['FAIL', name, err?.message || String(err)]); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await wait(50); } return false; };
const eq = (a, b, what) => { if (a !== b) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };

const db = (uid) => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).database();
const P = 'proj1';
const doc = `projects/${P}/docs/${fileKeyFor('src/app.js')}`;
const upd = { state: 'AAA=', origin: 1 };

// ================= rules =================
await check('owner can create the membership mirror for a new project', () => assertSucceeds(db('alice').ref(`projectMembers/${P}`).set({ alice: 'owner' })));
await check('stranger cannot claim an existing project', () => assertFails(db('eve').ref(`projectMembers/${P}`).set({ eve: 'owner' })));
await check('stranger cannot add themselves to it', () => assertFails(db('eve').ref(`projectMembers/${P}/eve`).set('editor')));
await check('owner can add an editor and a viewer', () => assertSucceeds(db('alice').ref(`projectMembers/${P}`).update({ bob: 'editor', carol: 'viewer' })));
await check('roles are validated', () => assertFails(db('alice').ref(`projectMembers/${P}/dave`).set('admin')));
await check('editor cannot change roles', () => assertFails(db('bob').ref(`projectMembers/${P}/bob`).set('owner')));
await check('members can read their membership', () => assertSucceeds(db('carol').ref(`projectMembers/${P}`).get()));
await check('strangers cannot read the member list', () => assertFails(db('eve').ref(`projectMembers/${P}`).get()));

await check('editor can append an update', () => assertSucceeds(db('bob').ref(`${doc}/updates`).push(upd)));
await check('owner can append an update', () => assertSucceeds(db('alice').ref(`${doc}/updates`).push(upd)));
await check('viewer cannot append updates', () => assertFails(db('carol').ref(`${doc}/updates`).push(upd)));
await check('stranger cannot append updates', () => assertFails(db('eve').ref(`${doc}/updates`).push(upd)));
await check('signed-out cannot append updates', () => assertFails(db(null).ref(`${doc}/updates`).push(upd)));
await check('updates are validated', () => assertFails(db('bob').ref(`${doc}/updates`).push({ state: 5 })));
await check('existing updates cannot be rewritten', async () => {
  const r = db('bob').ref(`${doc}/updates`).push(upd);
  await r;
  await assertFails(db('bob').ref(`${doc}/updates/${r.key}`).set({ state: 'BBB=', origin: 2 }));
});
await check('editor can delete updates (compaction)', async () => {
  const r = db('bob').ref(`${doc}/updates`).push(upd);
  await r;
  await assertSucceeds(db('bob').ref(`${doc}/updates`).update({ [r.key]: null }));
});
await check('viewer cannot delete updates', async () => {
  const r = db('bob').ref(`${doc}/updates`).push(upd);
  await r;
  await assertFails(db('carol').ref(`${doc}/updates/${r.key}`).remove());
});
await check('editor can write the snapshot', () => assertSucceeds(db('bob').ref(`${doc}/snapshot`).set({ state: 'AAA=', updatedAt: 1 })));
await check('viewer cannot write the snapshot', () => assertFails(db('carol').ref(`${doc}/snapshot`).set({ state: 'AAA=', updatedAt: 1 })));
await check('members (incl. viewers) can read docs', () => assertSucceeds(db('carol').ref(doc).get()));
await check('strangers cannot read docs', () => assertFails(db('eve').ref(doc).get()));
await check('viewer can share presence', () => assertSucceeds(db('carol').ref(`${doc}/awareness/123`).set('AAA=')));
await check('stranger cannot share presence', () => assertFails(db('eve').ref(`${doc}/awareness/124`).set('AAA=')));
await check('editor cannot wipe the project', () => assertFails(db('bob').ref(`projects/${P}`).remove()));
await check('owner can wipe the project live data', () => assertSucceeds(db('alice').ref(`projects/${P}`).remove()));
await check('old unscoped docs/ path is closed', () => assertFails(db('alice').ref('docs/x/updates').push(upd)));

// ================= provider =================
await env.withSecurityRulesDisabled((ctx) => ctx.database().ref(`projectMembers/p2`).set({ alice: 'owner', bob: 'editor', carol: 'viewer' }));
const client = (uid, fileKey, seedText) => {
  useDb(db(uid)._delegate);
  const ydoc = new Y.Doc();
  let denied = null;
  const provider = new FirebaseProvider({ projectId: 'p2', fileKey, seedText }, ydoc, { onDenied: (e) => { denied = e; } });
  return { ydoc, provider, text: () => ydoc.getText('monaco').toString(), denied: () => denied };
};

await check('fileKey is reversible-unique (a/b.js vs a_b.js vs a/b_js)', () => {
  const keys = new Set(['a/b.js', 'a_b.js', 'a/b_js', 'a~b.js', 'a%2Fb.js'].map(fileKeyFor));
  eq(keys.size, 5, 'distinct keys');
  for (const k of keys) if (/[.#$[\]/]/.test(k)) throw new Error(`illegal char in ${k}`);
});

await check('two people opening a new file at once: text appears ONCE', async () => {
  const a = client('alice', 'race', 'hello\n');
  const b = client('bob', 'race', 'hello\n');
  await Promise.all([a.provider.synced, b.provider.synced]);
  await until(() => a.text() === 'hello\n' && b.text() === 'hello\n');
  eq(a.text(), 'hello\n', 'alice');
  eq(b.text(), 'hello\n', 'bob');
  a.provider.destroy(); b.provider.destroy();
});

await check('edits flow both ways', async () => {
  const a = client('alice', 'flow', 'x');
  await a.provider.synced;
  const b = client('bob', 'flow', 'x');
  await b.provider.synced;
  await until(() => b.text() === 'x');
  a.ydoc.getText('monaco').insert(1, 'A');
  b.ydoc.getText('monaco').insert(0, 'B');
  await until(() => a.text() === b.text() && a.text().length === 3);
  eq(a.text(), b.text(), 'converged');
  eq(a.text().length, 3, 'length');
  a.provider.destroy(); b.provider.destroy();
});

await check('concurrent compaction by two clients loses no edits', async () => {
  const a = client('alice', 'compact', '');
  const b = client('bob', 'compact', '');
  await Promise.all([a.provider.synced, b.provider.synced]);
  // 260 edits each, interleaved → both clients cross the compaction threshold
  for (let i = 0; i < 260; i++) {
    a.ydoc.getText('monaco').insert(a.ydoc.getText('monaco').length, 'a');
    b.ydoc.getText('monaco').insert(0, 'b');
    if (i % 20 === 0) await wait(20);
  }
  await until(() => a.text().length === 520 && b.text().length === 520, 20000);
  await wait(4500); // let jittered compactions finish
  const late = client('carol', 'compact', 'SHOULD-NOT-APPEAR');
  await late.provider.synced;
  await until(() => late.text().length === 520, 10000);
  const updatesLeft = (await db('alice').ref('projects/p2/docs/compact/updates').get()).numChildren();
  eq(late.text().length, 520, 'late joiner sees every edit');
  eq((late.text().match(/a/g) || []).length, 260, "alice's edits");
  eq((late.text().match(/b/g) || []).length, 260, "bob's edits");
  if (updatesLeft >= 520) throw new Error(`log was never compacted (${updatesLeft} entries)`);
  results.push(['INFO', `update log after compaction: ${updatesLeft} entries (of 520 pushed)`]);
  a.provider.destroy(); b.provider.destroy(); late.provider.destroy();
});

await check('a viewer receives live text but cannot change the shared doc', async () => {
  const a = client('alice', 'view', 'seen');
  await a.provider.synced;
  const v = client('carol', 'view', '');
  await v.provider.synced;
  await until(() => v.text() === 'seen');
  eq(v.text(), 'seen', 'viewer sees text');
  v.ydoc.getText('monaco').insert(0, 'X'); // local only — the push is rejected
  await until(() => !!v.denied(), 3000);
  await wait(500);
  eq(a.text(), 'seen', "owner's doc unchanged");
  a.provider.destroy(); v.provider.destroy();
});

await check('a stranger cannot open the live doc', async () => {
  const e = client('eve', 'view', 'mine');
  await e.provider.synced;
  await until(() => !!e.denied(), 3000);
  if (!e.denied()) throw new Error('stranger was not denied');
  eq(e.text(), '', 'stranger received nothing');
  e.provider.destroy();
});

await env.cleanup();
const failed = results.filter((r) => r[0] === 'FAIL');
for (const r of results) console.log(r[0].padEnd(5), r[1], r[2] ? `\n      → ${r[2]}` : '');
console.log(`\n${results.filter((r) => r[0] === 'PASS').length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
