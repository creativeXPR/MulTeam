// Emulator tests for whole-project live sync (collaboration stage 2.1):
// two "machines" (alice, bob — plus a viewer) each run the real
// liveProject.js engine on their own temp folder; disk changes are fed in
// the way the app's folder watcher would.
//   npm run test:live-project   (needs the Firebase CLI + Java)
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const outDir = path.join(here, '.build');
mkdirSync(outDir, { recursive: true });
await esbuild.build({
  entryPoints: [path.join(here, 'liveProjectEntry.js')],
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: path.join(outDir, 'liveProject.mjs'), logLevel: 'error',
  plugins: [{ name: 'stub-firebase', setup(b) { b.onResolve({ filter: /^\.\/firebase\.js$/ }, () => ({ path: path.join(here, 'firebaseStub.js') })); } }]
});
const { createLiveProject } = await import(pathToFileURL(path.join(outDir, 'liveProject.mjs')).href);

const env = await initializeTestEnvironment({
  projectId: 'demo-multeam',
  database: { rules: readFileSync(path.join(root, 'firebase/database.rules.json'), 'utf8'), host: '127.0.0.1', port: 9411 }
});
const P = 'lp' + Date.now();
await env.withSecurityRulesDisabled((ctx) => ctx.database().ref(`projectMembers/${P}`).set({ alice: 'owner', bob: 'editor', vic: 'viewer' }));

const results = [];
async function check(name, fn) { try { await fn(); results.push(['PASS', name]); } catch (err) { results.push(['FAIL', name, err?.message || String(err)]); } }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await wait(100); } return false; };
const eq = (a, b, what) => { if (a !== b) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };

// A machine: its own folder, fake trash, git HEAD contents, and an engine.
function machine(uid, { branch = 'main', canEdit = true, head = {} } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `mt-${uid}-`));
  const trash = mkdtempSync(path.join(os.tmpdir(), `mt-${uid}-trash-`));
  const backups = [];
  const toasts = [];
  const api = {
    readFile: (p) => fsp.readFile(p, 'utf8').then((t) => t, (e) => { throw e; }).then(async (t) => { if ((await fsp.stat(p)).isDirectory()) throw new Error('dir'); return t; }),
    writeFile: async (p, t) => { await fsp.mkdir(path.dirname(p), { recursive: true }); await fsp.writeFile(p, t); },
    readDir: (p) => fsp.readdir(p),
    createDirectory: (p) => fsp.mkdir(p, { recursive: true }),
    trashEntry: async (p) => { if (!existsSync(p)) return false; await fsp.rename(p, path.join(trash, path.basename(p) + '-' + Date.now())); return true; },
    backupFile: async (_pid, rel, content) => { backups.push({ rel, content }); return `backup/${rel}`; },
    headContent: async (_root, rel) => (rel in head ? head[rel] : null)
  };
  const db = env.authenticatedContext(uid).database()._delegate;
  const start = (b = branch) => createLiveProject({ projectId: P, root: dir, branch: b, isGit: true, uid, canEdit, api, toast: (m) => toasts.push(m), db });
  const m = { uid, dir, backups, toasts, head, engine: start(), start };
  m.file = (rel) => path.join(dir, ...rel.split('/'));
  m.read = (rel) => (existsSync(m.file(rel)) ? readFileSync(m.file(rel), 'utf8') : null);
  // write on "disk" and tell the engine, like the folder watcher would
  m.write = async (rel, text) => { mkdirSync(path.dirname(m.file(rel)), { recursive: true }); writeFileSync(m.file(rel), text); m.engine.onDiskEvent({ filename: rel.split('/').join(path.sep) }); };
  m.del = async (rel) => { rmSync(m.file(rel), { recursive: true, force: true }); m.engine.onDiskEvent({ filename: rel.split('/').join(path.sep) }); };
  m.gitSignal = () => m.engine.onDiskEvent({ filename: '.git/HEAD', git: true });
  return m;
}

const alice = machine('alice', { head: { 'README.md': '# app\n' } });
const bob = machine('bob');
await wait(500);

await check('alice edits a file on disk → it appears on bob’s disk', async () => {
  await alice.write('src/app.js', 'console.log(1);\n');
  eq(await until(() => bob.read('src/app.js') === 'console.log(1);\n'), true, 'synced');
});

await check('bob’s edit flows back to alice', async () => {
  await bob.write('src/app.js', 'console.log(1);\nconsole.log(2);\n');
  eq(await until(() => alice.read('src/app.js') === 'console.log(1);\nconsole.log(2);\n'), true, 'synced back');
});

await check('a new file in a new folder reaches the other machine', async () => {
  await bob.write('lib/util/math.js', 'export const add = (a, b) => a + b;\n');
  eq(await until(() => alice.read('lib/util/math.js') === 'export const add = (a, b) => a + b;\n'), true, 'created');
});

await check('concurrent edits to the same file merge', async () => {
  await alice.write('notes.txt', 'middle\n');
  await until(() => bob.read('notes.txt') === 'middle\n');
  await Promise.all([alice.write('notes.txt', 'top\nmiddle\n'), bob.write('notes.txt', 'middle\nbottom\n')]);
  const ok = await until(() => alice.read('notes.txt') === bob.read('notes.txt') && /top/.test(alice.read('notes.txt') || '') && /bottom/.test(alice.read('notes.txt') || ''));
  eq(ok, true, `merged (alice=${JSON.stringify(alice.read('notes.txt'))}, bob=${JSON.stringify(bob.read('notes.txt'))})`);
});

await check('a delete moves the file to the other machine’s trash', async () => {
  await alice.del('lib/util/math.js');
  eq(await until(() => bob.read('lib/util/math.js') === null), true, 'deleted on bob');
  if (!bob.toasts.some((t) => /deleted by a teammate/.test(t))) throw new Error('no notice shown');
});

await check('re-creating a deleted file starts fresh (no old content)', async () => {
  await bob.write('lib/util/math.js', 'export const v2 = 2;\n');
  eq(await until(() => alice.read('lib/util/math.js') === 'export const v2 = 2;\n'), true, 'fresh content');
});

await check('changes right after a Git HEAD move are not shared', async () => {
  alice.gitSignal();
  await alice.write('src/app.js', 'GIT CHECKOUT CONTENT\n');
  await wait(2500);
  eq(bob.read('src/app.js') === 'GIT CHECKOUT CONTENT\n', false, 'leaked to bob');
});

await check('a file identical to the last commit isn’t shared', async () => {
  await wait(3200); // past the Git quiet window
  await alice.write('README.md', '# app\n'); // same as HEAD
  await wait(2000);
  eq(bob.read('README.md'), null, 'README leaked');
});

await check('ignored files (.env, node_modules) stay local', async () => {
  await alice.write('.env', 'SECRET=1\n');
  await alice.write('node_modules/x/index.js', 'x\n');
  await wait(2000);
  eq(bob.read('.env'), null, '.env leaked');
  eq(bob.read('node_modules/x/index.js'), null, 'node_modules leaked');
});

await check('MulTeam’s own writes are not re-broadcast (no echo loop)', async () => {
  const before = (await env.authenticatedContext('alice').database().ref(`projects/${P}/b/main/files`).get()).numChildren();
  alice.engine.noteWritten('src/app.js', alice.read('src/app.js'));
  alice.engine.onDiskEvent({ filename: 'src/app.js' });
  await wait(1500);
  const after = (await env.authenticatedContext('alice').database().ref(`projects/${P}/b/main/files`).get()).numChildren();
  eq(after, before, 'index entries');
});

const vic = machine('vic', { canEdit: false });
await check('a viewer joining receives every live file', async () => {
  eq(await until(() => vic.read('src/app.js') !== null && vic.read('notes.txt') !== null && vic.read('lib/util/math.js') === 'export const v2 = 2;\n'), true, 'viewer synced');
});
await check('a viewer’s own disk edits are not shared', async () => {
  await vic.write('notes.txt', 'viewer scribble\n');
  await wait(2000);
  eq(/viewer scribble/.test(alice.read('notes.txt') || ''), false, 'viewer edit leaked');
});

await check('joining with a different local copy backs it up first', async () => {
  const carolDir = machine('bob'); // a second machine of an editor, with an old local copy
  carolDir.engine.dispose();
  writeFileSync(path.join(carolDir.dir, 'notes.txt'), 'my old local notes\n');
  carolDir.engine = carolDir.start();
  eq(await until(() => carolDir.read('notes.txt') === alice.read('notes.txt')), true, 'took live version');
  eq(carolDir.backups.some((b) => b.rel === 'notes.txt' && b.content === 'my old local notes\n'), true, 'backup made');
  carolDir.engine.dispose();
});

await check('branches are separate live sessions', async () => {
  const feat = machine('alice', { branch: 'feature/login' });
  await feat.write('src/login.js', 'login()\n');
  await wait(2500);
  eq(bob.read('src/login.js'), null, 'feature-branch file leaked to main');
  const feat2 = machine('bob', { branch: 'feature/login' });
  eq(await until(() => feat2.read('src/login.js') === 'login()\n'), true, 'same-branch teammate got it');
  feat.engine.dispose(); feat2.engine.dispose();
});

for (const m of [alice, bob, vic]) m.engine.dispose();
await env.cleanup();
const failed = results.filter((r) => r[0] === 'FAIL');
for (const r of results) console.log(r[0].padEnd(5), r[1], r[2] ? `\n      → ${r[2]}` : '');
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
