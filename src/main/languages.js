// Language support: installs language servers on demand (from the npm
// registry, integrity-checked) and runs them as child processes speaking the
// Language Server Protocol over stdio. The renderer's LSP client
// (renderer/js/lspClient.js) gets/sends raw JSON-RPC messages via IPC.
//
// Servers run on Electron's own Node (ELECTRON_RUN_AS_NODE), so users don't
// need Node installed. Installs live in <userData>/languages/<id>/.
const { app, net } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');

// Versions are pinned so every install is reproducible.
const CATALOG = [
  {
    id: 'typescript',
    name: 'JavaScript & TypeScript',
    description: 'Project-wide IntelliSense, go to definition across files, real type errors. Uses typescript-language-server with TypeScript 5.9.',
    languages: ['javascript', 'typescript'],
    packages: [
      { name: 'typescript-language-server', version: '6.0.2' },
      { name: 'typescript', version: '5.9.3' }
    ],
    entry: ['typescript-language-server', 'lib', 'cli.mjs'],
    args: ['--stdio'],
    initializationOptions: (dir) => ({
      // a project's own node_modules/typescript wins; ours is the fallback
      tsserver: { fallbackPath: path.join(dir, 'node_modules', 'typescript', 'lib', 'tsserver.js') }
    })
  },
  {
    id: 'python',
    name: 'Python',
    description: 'Type-aware completions, hovers, go to definition and diagnostics. Uses basedpyright (open-source, Pylance-class analysis).',
    languages: ['python'],
    packages: [{ name: 'basedpyright', version: '1.40.2' }],
    entry: ['basedpyright', 'langserver.index.js'],
    args: ['--stdio'],
    initializationOptions: () => ({})
  }
];

const langRoot = () => path.join(app.getPath('userData'), 'languages');
const dirFor = (id) => path.join(langRoot(), id);
const markerFile = (id) => path.join(dirFor(id), 'installed.json');
const entryFor = (spec) => path.join(dirFor(spec.id), 'node_modules', ...spec.entry);
const specFor = (id) => {
  const s = CATALOG.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown language support "${id}".`);
  return s;
};

async function installedInfo(id) {
  try { return JSON.parse(await fs.readFile(markerFile(id), 'utf8')); } catch { return null; }
}

async function list() {
  return Promise.all(CATALOG.map(async (s) => {
    const info = await installedInfo(s.id);
    return {
      id: s.id,
      name: s.name,
      description: s.description,
      languages: s.languages,
      packages: s.packages.map((p) => `${p.name}@${p.version}`),
      installed: !!info && fsSync.existsSync(entryFor(s)),
      installedAt: info?.installedAt || null,
      running: [...servers.values()].some((x) => x.id === s.id)
    };
  }));
}

// ---------- download + integrity + extract ----------
async function fetchBuffer(url, onProgress) {
  const res = await net.fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    received += value.length;
    onProgress?.(received, total);
  }
  return Buffer.concat(chunks);
}

function verifyIntegrity(buf, integrity) {
  // npm publishes SRI strings like "sha512-<base64>"
  const m = /^(sha512|sha384|sha256)-(.+)$/.exec(String(integrity || '').split(/\s+/)[0]);
  if (!m) throw new Error('The registry gave no integrity hash; refusing to install.');
  const actual = crypto.createHash(m[1]).update(buf).digest('base64');
  if (actual !== m[2]) throw new Error('Integrity check failed — the download doesn’t match what npm published.');
}

// Minimal .tgz extractor for npm packages (ustar + pax/GNU long names).
// Entries are rooted at "package/"; that prefix is stripped.
async function extractTgz(tgz, destDir) {
  const tar = zlib.gunzipSync(tgz);
  let off = 0;
  let longName = null;
  const readStr = (o, n) => tar.subarray(o, o + n).toString('utf8').replace(/\0.*$/s, '');
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    let name = readStr(off, 100);
    const size = parseInt(readStr(off + 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = readStr(off + 345, 155);
    if (prefix) name = `${prefix}/${name}`;
    const dataStart = off + 512;
    const data = tar.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / 512) * 512;

    if (type === 'x') { // pax header: may carry the real path
      const m = /\d+ path=([^\n]+)\n/.exec(data.toString('utf8'));
      if (m) longName = m[1];
      continue;
    }
    if (type === 'L') { longName = data.toString('utf8').replace(/\0.*$/s, ''); continue; }
    if (type === 'g') continue;
    if (longName) { name = longName; longName = null; }
    if (type !== '0' && type !== '\0' && type !== '5') continue; // skip links/devices

    const rel = name.replace(/^[^/]+\//, ''); // strip "package/"
    if (!rel) continue;
    const out = path.resolve(destDir, rel);
    if (!out.startsWith(path.resolve(destDir) + path.sep)) continue; // path-escape guard
    if (type === '5') { await fs.mkdir(out, { recursive: true }); continue; }
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, data);
  }
}

async function install(id, sender) {
  const spec = specFor(id);
  const dir = dirFor(id);
  const progress = (phase, pct, detail = '') => { if (!sender.isDestroyed()) sender.send(IPC_REF.LSP_PROGRESS, { id, phase, pct, detail }); };

  await stopById(id);
  const tmp = `${dir}.installing`;
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.mkdir(tmp, { recursive: true });
  try {
    for (let i = 0; i < spec.packages.length; i++) {
      const p = spec.packages[i];
      progress('resolving', Math.round((i / spec.packages.length) * 100), p.name);
      const metaRes = await net.fetch(`https://registry.npmjs.org/${p.name}/${p.version}`, { headers: { Accept: 'application/json' } });
      if (!metaRes.ok) throw new Error(`npm registry error (${metaRes.status}) for ${p.name}`);
      const meta = await metaRes.json();
      const tgz = await fetchBuffer(meta.dist.tarball, (rec, total) => {
        const within = total ? rec / total : 0;
        progress('downloading', Math.round(((i + within * 0.9) / spec.packages.length) * 100), `${p.name} ${(rec / 1048576).toFixed(1)} MB`);
      });
      verifyIntegrity(tgz, meta.dist.integrity);
      progress('extracting', Math.round(((i + 0.95) / spec.packages.length) * 100), p.name);
      await extractTgz(tgz, path.join(tmp, 'node_modules', p.name));
    }
    await fs.writeFile(path.join(tmp, 'installed.json'), JSON.stringify({ id, packages: spec.packages, installedAt: Date.now() }, null, 2));
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rename(tmp, dir);
  } catch (err) {
    await fs.rm(tmp, { recursive: true, force: true });
    throw err;
  }
  progress('done', 100);
  return (await list()).find((x) => x.id === id);
}

async function uninstall(id) {
  specFor(id);
  await stopById(id);
  await fs.rm(dirFor(id), { recursive: true, force: true });
}

// ---------- running servers ----------
const servers = new Map(); // key -> { id, proc, owner, buffer, stderr: [] }

function frame(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

function start(id, rootPath, sender) {
  const spec = specFor(id);
  const entry = entryFor(spec);
  if (!fsSync.existsSync(entry)) throw new Error(`${spec.name} support isn't installed.`);
  const key = `${sender.id}:${id}`;
  stopKey(key);

  const proc = spawn(process.execPath, [entry, ...spec.args], {
    cwd: rootPath && fsSync.existsSync(rootPath) ? rootPath : dirFor(id),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  const srv = { id, proc, owner: sender, buffer: Buffer.alloc(0), stderr: [] };
  servers.set(key, srv);

  proc.stdout.on('data', (chunk) => {
    srv.buffer = Buffer.concat([srv.buffer, chunk]);
    // parse "Content-Length: N\r\n\r\n<json>" frames
    for (;;) {
      const headerEnd = srv.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const m = /Content-Length:\s*(\d+)/i.exec(srv.buffer.subarray(0, headerEnd).toString('ascii'));
      if (!m) { srv.buffer = srv.buffer.subarray(headerEnd + 4); continue; }
      const len = Number(m[1]);
      if (srv.buffer.length < headerEnd + 4 + len) return;
      const body = srv.buffer.subarray(headerEnd + 4, headerEnd + 4 + len).toString('utf8');
      srv.buffer = srv.buffer.subarray(headerEnd + 4 + len);
      let msg;
      try { msg = JSON.parse(body); } catch { continue; }
      if (!sender.isDestroyed()) sender.send(IPC_REF.LSP_MESSAGE, id, msg);
    }
  });
  proc.stderr.on('data', (d) => {
    srv.stderr.push(d.toString());
    if (srv.stderr.length > 40) srv.stderr.shift();
  });
  proc.on('exit', (code) => {
    if (servers.get(key) === srv) servers.delete(key);
    if (!sender.isDestroyed()) sender.send(IPC_REF.LSP_EXIT, id, code, srv.stderr.join('').slice(-1500));
  });
  proc.on('error', (err) => {
    if (!sender.isDestroyed()) sender.send(IPC_REF.LSP_EXIT, id, -1, String(err.message));
  });
  sender.once('destroyed', () => stopKey(key));

  return { initializationOptions: spec.initializationOptions(dirFor(id)), languages: spec.languages };
}

function stopKey(key) {
  const srv = servers.get(key);
  if (!srv) return;
  servers.delete(key);
  try { srv.proc.kill(); } catch { /* already gone */ }
}

async function stopById(id) {
  for (const [key, srv] of servers) if (srv.id === id) stopKey(key);
}

function stopAll() {
  for (const key of [...servers.keys()]) stopKey(key);
}

let IPC_REF = null;

function setupLanguageHandlers(ipcMain, IPC) {
  IPC_REF = IPC;
  ipcMain.handle(IPC.LSP_LIST, () => list());
  ipcMain.handle(IPC.LSP_INSTALL, (e, id) => install(id, e.sender));
  ipcMain.handle(IPC.LSP_UNINSTALL, (_e, id) => uninstall(id));
  ipcMain.handle(IPC.LSP_START, (e, id, rootPath) => start(id, rootPath, e.sender));
  ipcMain.handle(IPC.LSP_STOP, (e, id) => stopKey(`${e.sender.id}:${id}`));
  ipcMain.on(IPC.LSP_SEND, (e, id, msg) => {
    const srv = servers.get(`${e.sender.id}:${id}`);
    if (srv && srv.proc.stdin.writable) srv.proc.stdin.write(frame(msg));
  });
}

module.exports = { setupLanguageHandlers, stopAllLanguageServers: stopAll };
