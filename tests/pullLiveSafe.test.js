// pullLiveSafe (main/git.js): pulling after a teammate committed the live
// edits you already have must work, without losing your other changes and
// without hiding real conflicts.   node --test tests/pullLiveSafe.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { pullLiveSafe } = require('../src/main/git.js');

const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'pipe' }).toString();
const id = '-c user.email=t@t -c user.name=t';
// git may check files out with CRLF on Windows (core.autocrlf)
const read = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-pull-'));
  const bare = path.join(dir, 'origin.git');
  sh(`git init -q --bare -b main "${bare}"`, dir);
  const a = path.join(dir, 'a');
  sh(`git clone -q "${bare}" a`, dir);
  fs.writeFileSync(path.join(a, 'x.txt'), 'one\n');
  fs.writeFileSync(path.join(a, 'y.txt'), 'why\n');
  sh(`git ${id} add . && git ${id} commit -qm init && git push -q origin main`, a);
  sh(`git clone -q "${bare}" b`, dir);
  return { dir, a, b: path.join(dir, 'b') };
}

test('pull succeeds when my uncommitted change is exactly what was pushed', async () => {
  const { a, b } = setup();
  // a teammate commits the live edit; I already have the same text on disk
  fs.writeFileSync(path.join(a, 'x.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(a, 'new.txt'), 'brand new\n');
  sh(`git ${id} commit -qam edit && git ${id} add new.txt && git ${id} commit -qm add && git push -q origin main`, a);
  fs.writeFileSync(path.join(b, 'x.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(b, 'new.txt'), 'brand new\n'); // untracked, identical
  fs.writeFileSync(path.join(b, 'y.txt'), 'why\nmine\n');   // unrelated local edit
  const r = await pullLiveSafe(b);
  assert.strictEqual(r.setAside, 2);
  assert.strictEqual(read(path.join(b, 'x.txt')), 'one\ntwo\n');
  assert.strictEqual(read(path.join(b, 'new.txt')), 'brand new\n');
  assert.strictEqual(read(path.join(b, 'y.txt')), 'why\nmine\n', 'my other edit is kept');
  const status = sh('git status --porcelain', b).trim();
  assert.strictEqual(status, 'M y.txt');
});

test('a real conflicting local change is not hidden', async () => {
  const { a, b } = setup();
  fs.writeFileSync(path.join(a, 'x.txt'), 'one\ntheirs\n');
  sh(`git ${id} commit -qam theirs && git push -q origin main`, a);
  fs.writeFileSync(path.join(b, 'x.txt'), 'one\nmine\n');
  await assert.rejects(() => pullLiveSafe(b), /overwritten|local changes/i);
  assert.strictEqual(read(path.join(b, 'x.txt')), 'one\nmine\n', 'my change is untouched');
});
