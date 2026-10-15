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
const { createLiveProject, fileKeyFor: fileKey } = await import(pathToFileURL(path.join(outDir, 'liveProject.mjs')).href);

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
function machine(uid, { branch = 'main', canEdit = true, head = {}, isGit = true, project = P, seedFiles = {}, v24 = false } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `mt-${uid}-`));
  for (const [rel, text] of Object.entries(seedFiles)) { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), text); }
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
    headContent: async (_root, rel) => (rel in head ? head[rel] : null),
    listFiles: async (r) => {
      const files = [];
      const walk = async (d) => { for (const e of await fsp.readdir(d, { withFileTypes: true })) { const full = path.join(d, e.name); if (e.isDirectory()) { if (!['node_modules', '.git'].includes(e.name)) await walk(full); } else files.push(path.relative(r, full)); } };
      await walk(r);
      return { files, truncated: false };
    }
  };
  const bases = new Map(); // the agreed-text store (survives engine restarts, like userData)
  if (v24) {
    api.liveBase = {
      get: async (p, b, f) => (bases.has(`${p}/${b}/${f}`) ? bases.get(`${p}/${b}/${f}`) : null),
      set: async (p, b, f, t) => { bases.set(`${p}/${b}/${f}`, t); return true; },
      remove: async (p, b, f) => { bases.delete(`${p}/${b}/${f}`); return true; }
    };
    api.currentBranch = async () => m.branch;
    // "git status": files whose text differs from HEAD (untracked included)
    api.changedFiles = async () => (await api.listFiles(dir)).files.map((f) => f.split(path.sep).join('/')).filter((rel) => readFileSync(path.join(dir, rel), 'utf8') !== head[rel]);
  }
  const db = env.authenticatedContext(uid).database()._delegate;
  const start = (b = branch) => createLiveProject({ projectId: project, root: dir, branch: b, isGit, uid, canEdit, api, toast: (m) => toasts.push(m), db });
  const m = { uid, dir, backups, toasts, head, branch, start };
  m.engine = start();
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

// ================= projects without Git (stage 2.2) =================
const NP = P + '-nogit';
await env.withSecurityRulesDisabled((ctx) => ctx.database().ref(`projectMembers/${NP}`).set({ alice: 'owner', bob: 'editor', vic: 'viewer' }));
const ng = { isGit: false, project: NP };
const owner = machine('alice', { ...ng, seedFiles: { 'index.html': '<h1>hi</h1>\n', 'css/site.css': 'body{}\n', 'js/app.js': 'go();\n', '.env': 'KEY=1\n', 'node_modules/x.js': 'x\n' } });

await check('no Git: the owner shares the whole project when it opens', async () => {
  await owner.engine.treeShared;
  if (!owner.toasts.some((t) => /Shared 3 files/.test(t))) throw new Error('toasts: ' + JSON.stringify(owner.toasts));
});
const joiner = machine('bob', { ...ng });
await check('no Git: a joiner with an empty folder receives every file', async () => {
  eq(await until(() => joiner.read('index.html') === '<h1>hi</h1>\n' && joiner.read('css/site.css') === 'body{}\n' && joiner.read('js/app.js') === 'go();\n'), true, 'received');
  eq(joiner.read('.env'), null, '.env leaked');
  eq(joiner.read('node_modules/x.js'), null, 'node_modules leaked');
});
await check('no Git: a later edit and a new file keep syncing', async () => {
  await joiner.write('js/app.js', 'go(); stop();\n');
  await joiner.write('README.txt', 'read me\n');
  eq(await until(() => owner.read('js/app.js') === 'go(); stop();\n' && owner.read('README.txt') === 'read me\n'), true, 'synced');
});
await check('no Git: a deleted file is not brought back by someone who still has it', async () => {
  const late = machine('bob', { ...ng, seedFiles: { 'README.txt': 'read me\n' } }); // offline copy
  late.engine.dispose();
  await owner.del('README.txt');
  await until(() => joiner.read('README.txt') === null);
  late.engine = late.start();
  await late.engine.treeShared;
  await wait(1500);
  eq(owner.read('README.txt'), null, 'resurrected on owner');
  eq(late.read('README.txt'), null, 'still on the late machine');
  late.engine.dispose();
});
await check('no Git: a stale copy is backed up and replaced; extra local files are shared', async () => {
  const stale = machine('bob', { ...ng, seedFiles: { 'index.html': '<h1>OLD</h1>\n', 'notes/mine.md': '# mine\n' } });
  await stale.engine.treeShared;
  eq(await until(() => stale.read('index.html') === '<h1>hi</h1>\n'), true, 'replaced with live');
  eq(stale.backups.some((b) => b.rel === 'index.html' && b.content === '<h1>OLD</h1>\n'), true, 'backup made');
  eq(await until(() => owner.read('notes/mine.md') === '# mine\n'), true, 'extra file shared');
  stale.engine.dispose();
});
await check('no Git: a viewer receives but never uploads its files', async () => {
  const v = machine('vic', { ...ng, seedFiles: { 'viewer-only.txt': 'nope\n' } });
  eq(await until(() => v.read('index.html') === '<h1>hi</h1>\n'), true, 'viewer received');
  await wait(1500);
  eq(owner.read('viewer-only.txt'), null, 'viewer file uploaded');
  v.engine.dispose();
});
await check('no Git: a project over the file limit asks for Git instead', async () => {
  const BP = P + '-big';
  await env.withSecurityRulesDisabled((ctx) => ctx.database().ref(`projectMembers/${BP}`).set({ alice: 'owner' }));
  const seed = Object.fromEntries(Array.from({ length: 405 }, (_, i) => [`f/${i}.txt`, `${i}\n`]));
  const big = machine('alice', { isGit: false, project: BP, seedFiles: seed });
  await big.engine.treeShared;
  eq(big.toasts.some((t) => /too many to sync without Git/.test(t)), true, 'limit message');
  const idx = (await env.authenticatedContext('alice').database().ref(`projects/${BP}/b/_project/files`).get()).exists();
  eq(idx, false, 'nothing shared');
  big.engine.dispose();
});
await check('stress: 5 rounds of simultaneous disk edits keep every edit', async () => {
  await owner.write('race.txt', 'base\n');
  await until(() => joiner.read('race.txt') === 'base\n');
  for (let i = 0; i < 5; i++) {
    const a = owner.read('race.txt');
    const b = joiner.read('race.txt');
    await Promise.all([owner.write('race.txt', `A${i}\n` + a), joiner.write('race.txt', b + `B${i}\n`)]);
    await wait(300);
  }
  const ok = await until(() => owner.read('race.txt') === joiner.read('race.txt') && [0, 1, 2, 3, 4].every((i) => (owner.read('race.txt') || '').includes(`A${i}\n`) && (owner.read('race.txt') || '').includes(`B${i}\n`)), 15000);
  eq(ok, true, `converged with all edits (owner=${JSON.stringify(owner.read('race.txt'))}, joiner=${JSON.stringify(joiner.read('race.txt'))})`);
});
for (const m of [owner, joiner]) m.engine.dispose();

// ================= offline + Git reconciliation (stage 2.4) =================
const GP = P + '-git24';
await env.withSecurityRulesDisabled((ctx) => ctx.database().ref(`projectMembers/${GP}`).set({ alice: 'owner', bob: 'editor' }));
const g = { project: GP, v24: true };
const al = machine('alice', g);
const bo = machine('bob', g);
await wait(500);
const idxEntry = async (rel) => (await env.authenticatedContext('alice').database().ref(`projects/${GP}/b/main/files/${fileKey(rel)}`).get()).val();

await check('2.4: edits made while MulTeam was closed are merged on restart', async () => {
  await al.write('f.txt', 'top\nmiddle\nbottom\n');
  eq(await until(() => bo.read('f.txt') === 'top\nmiddle\nbottom\n'), true, 'shared');
  await wait(800); // let the agreed text be stored
  bo.engine.dispose();
  writeFileSync(bo.file('f.txt'), 'top\nmiddle\nbottom\nbob offline\n'); // bob edits while closed
  await al.write('f.txt', 'alice live\ntop\nmiddle\nbottom\n');         // alice edits meanwhile
  await wait(800);
  bo.engine = bo.start();
  const want = 'alice live\ntop\nmiddle\nbottom\nbob offline\n';
  eq(await until(() => bo.read('f.txt') === want && al.read('f.txt') === want, 12000), true, `merged (bob=${JSON.stringify(bo.read('f.txt'))}, alice=${JSON.stringify(al.read('f.txt'))})`);
  eq(bo.toasts.some((t) => /Merged the changes you made to f\.txt/.test(t)), true, 'merge notice');
});

await check('2.4: an unchanged copy just takes the newer live version (no backup)', async () => {
  await wait(800);
  bo.engine.dispose();
  const before = bo.backups.length;
  await al.write('f.txt', 'v3\n');
  await wait(800);
  bo.engine = bo.start();
  eq(await until(() => bo.read('f.txt') === 'v3\n'), true, 'updated');
  eq(bo.backups.length, before, 'no backup for an unchanged copy');
});

await check('2.4: a commit takes the file out of the live session (for both)', async () => {
  await wait(800);
  al.head['f.txt'] = 'v3\n'; // alice commits it
  al.gitSignal();
  eq(await until(async () => (await idxEntry('f.txt')) === null, 8000), true, 'index entry removed');
  eq(await until(() => !bo.engine._state().backgrounds.includes('f.txt')), true, 'bob stopped syncing it');
  eq(bo.read('f.txt'), 'v3\n', "bob's file kept");
});

await check('2.4: the next edit after a commit makes it live again', async () => {
  await al.write('f.txt', 'v3\nmore\n');
  const ok = await until(() => bo.read('f.txt') === 'v3\nmore\n');
  if (!ok) console.log('DEBUG entry=', JSON.stringify(await idxEntry('f.txt')), ' alice=', JSON.stringify(al.engine._state().docs), JSON.stringify(al.engine._state().backgrounds), ' bob=', JSON.stringify(bo.engine._state().docs), JSON.stringify(bo.engine._state().backgrounds), ' bobdisk=', JSON.stringify(bo.read('f.txt')), ' alicedisk=', JSON.stringify(al.read('f.txt')));
  eq(ok, true, 'live again');
});

await check('2.4: a pull updates a teammate’s open file that has no live edits', async () => {
  writeFileSync(al.file('g.txt'), 'old\n'); writeFileSync(bo.file('g.txt'), 'old\n');
  al.head['g.txt'] = 'old\n'; bo.head['g.txt'] = 'old\n';
  const da = al.engine.acquire('g.txt', 'old\n'); // both have it open in an editor
  const db2 = bo.engine.acquire('g.txt', 'old\n');
  await Promise.all([da.provider.synced, db2.provider.synced]);
  await wait(800);
  // bob pulls a commit that changed g.txt
  bo.gitSignal(); writeFileSync(bo.file('g.txt'), 'new from pull\n'); bo.head['g.txt'] = 'new from pull\n';
  eq(await until(() => al.read('g.txt') === 'new from pull\n', 10000), true, "alice's open copy followed");
  eq(await idxEntry('g.txt'), null, 'not made live');
  al.engine.release('g.txt'); bo.engine.release('g.txt');
});

await check('2.4: git stash/reset does not wipe the team’s live edits', async () => {
  await al.write('h.txt', 'team work\n');
  await until(() => bo.read('h.txt') === 'team work\n');
  await wait(800);
  bo.gitSignal(); rmSync(bo.file('h.txt')); writeFileSync(bo.file('h.txt'), ''); // stash-like: back to "HEAD"
  eq(await until(() => bo.read('h.txt') === 'team work\n', 10000), true, 'live version restored');
  eq(bo.toasts.some((t) => /has live edits from the team/.test(t)), true, 'notice');
  eq(al.read('h.txt'), 'team work\n', "alice's work untouched");
});

await check('2.4: discarding changes is shared, then the file leaves the live session', async () => {
  al.head['d.txt'] = 'committed\n'; bo.head['d.txt'] = 'committed\n';
  writeFileSync(al.file('d.txt'), 'committed\n'); writeFileSync(bo.file('d.txt'), 'committed\n');
  await al.write('d.txt', 'committed\nexperiment\n');
  await until(() => bo.read('d.txt') === 'committed\nexperiment\n');
  await wait(800);
  await al.write('d.txt', 'committed\n'); // Source Control → Discard
  eq(await until(() => bo.read('d.txt') === 'committed\n'), true, 'revert shared');
  eq(await until(async () => (await idxEntry('d.txt')) === null, 8000), true, 'retired');
});

await check('2.4: a file created while MulTeam was closed is shared at startup', async () => {
  bo.engine.dispose();
  writeFileSync(bo.file('offline-new.txt'), 'made offline\n');
  bo.engine = bo.start();
  eq(await until(() => al.read('offline-new.txt') === 'made offline\n', 10000), true, 'shared');
});
for (const m of [al, bo]) m.engine.dispose();

await env.cleanup();
const failed = results.filter((r) => r[0] === 'FAIL');
for (const r of results) console.log(r[0].padEnd(5), r[1], r[2] ? `\n      → ${r[2]}` : '');
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
