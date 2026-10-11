// Language support: installs language servers on demand and runs them as
// child processes speaking the Language Server Protocol over stdio. The
// renderer's LSP client (renderer/js/lspClient.js) gets/sends raw JSON-RPC
// messages via IPC.
//
// Sources (every download is integrity-checked):
//   npm      — npm registry tarballs (SHA-512 from the registry)
//   github   — GitHub release assets (SHA-256 digest from the GitHub API)
//   openvsx  — the server bundled inside an Open VSX extension package
//              (SHA-256 file published by Open VSX); only server files kept
//   dotnet   — a .NET global tool installed into our own folder
// Node-based servers run on Electron's own Node (ELECTRON_RUN_AS_NODE), so
// users don't need Node installed. Installs live in <userData>/languages/<id>/.
const { app, net } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawn, execFile } = require('node:child_process');
const AdmZip = require('adm-zip');

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? '.exe' : '';
const PLATFORM = { win32: 'windows', darwin: 'mac', linux: 'linux' }[process.platform];
const VSIX_TARGET = `${{ win32: 'win32', darwin: 'darwin', linux: 'linux' }[process.platform]}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
const JDTLS_CONFIG = { win32: 'config_win', darwin: process.arch === 'arm64' ? 'config_mac_arm' : 'config_mac', linux: process.arch === 'arm64' ? 'config_linux_arm' : 'config_linux' }[process.platform];

const langRoot = () => path.join(app.getPath('userData'), 'languages');
const dirFor = (id) => path.join(langRoot(), id);
const nodeServer = (entry, args = ['--stdio']) => ({ command: process.execPath, args: [entry, ...args], env: { ELECTRON_RUN_AS_NODE: '1' } });

// ---------- runtime detection ----------
function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout || ''}${stderr || ''}` }));
  });
}

async function findJava(minMajor = 21) {
  const candidates = [];
  if (process.env.JAVA_HOME) candidates.push(path.join(process.env.JAVA_HOME, 'bin', `java${EXE}`));
  candidates.push('java');
  for (const c of candidates) {
    const r = await run(c, ['-version']);
    const m = /version "(\d+)(?:\.(\d+))?/.exec(r.out);
    if (!r.ok || !m) continue;
    const major = Number(m[1]) === 1 ? Number(m[2]) : Number(m[1]); // "1.8" style
    if (major >= minMajor) return { path: c, major };
  }
  return null;
}

async function findDotnetSdk(minMajor = 8) {
  const r = await run('dotnet', ['--list-sdks']);
  if (!r.ok) return null;
  const majors = [...r.out.matchAll(/^(\d+)\.\d+\.\d+/gm)].map((m) => Number(m[1]));
  const best = Math.max(0, ...majors);
  return best >= minMajor ? { major: best } : null;
}

// ---------- catalog (versions pinned for reproducible installs) ----------
const CATALOG = [
  {
    id: 'typescript',
    name: 'JavaScript & TypeScript',
    description: 'Project-wide IntelliSense, go to definition across files, real type errors. typescript-language-server with TypeScript 5.9.',
    languages: ['javascript', 'typescript'],
    approxMB: 25,
    source: { type: 'npm', packages: [{ name: 'typescript-language-server', version: '6.0.2' }, { name: 'typescript', version: '5.9.3' }] },
    serverFile: ['node_modules', 'typescript-language-server', 'lib', 'cli.mjs'],
    launch: (dir) => nodeServer(path.join(dir, 'node_modules', 'typescript-language-server', 'lib', 'cli.mjs')),
    initializationOptions: (dir) => ({ tsserver: { fallbackPath: path.join(dir, 'node_modules', 'typescript', 'lib', 'tsserver.js') } })
  },
  {
    id: 'python',
    name: 'Python',
    description: 'Type-aware completions, hovers, go to definition and diagnostics. basedpyright (open-source, Pylance-class analysis).',
    languages: ['python'],
    approxMB: 27,
    source: { type: 'npm', packages: [{ name: 'basedpyright', version: '1.40.2' }] },
    serverFile: ['node_modules', 'basedpyright', 'langserver.index.js'],
    launch: (dir) => nodeServer(path.join(dir, 'node_modules', 'basedpyright', 'langserver.index.js')),
    initializationOptions: () => ({})
  },
  {
    id: 'cpp',
    name: 'C / C++',
    description: 'clangd from LLVM: completions, go to definition, errors and warnings. Best with a compile_commands.json in the project.',
    languages: ['c', 'cpp'],
    approxMB: 28,
    source: { type: 'github', repo: 'clangd/clangd', tag: '23.1.0', asset: `clangd-${PLATFORM}-23.1.0.zip` },
    serverFile: ['clangd_23.1.0', 'bin', `clangd${EXE}`],
    launch: (dir) => ({ command: path.join(dir, 'clangd_23.1.0', 'bin', `clangd${EXE}`), args: ['--background-index', '--header-insertion=never'] }),
    initializationOptions: () => ({})
  },
  {
    id: 'php',
    name: 'PHP',
    description: 'Intelephense: fast completions, go to definition, diagnostics. Core features are free; a licence key unlocks premium extras.',
    languages: ['php'],
    approxMB: 6,
    source: { type: 'openvsx', namespace: 'bmewburn', name: 'vscode-intelephense-client', version: '1.18.5', keep: ['extension/node_modules/'] },
    serverFile: ['node_modules', 'intelephense', 'lib', 'intelephense.js'],
    launch: (dir) => nodeServer(path.join(dir, 'node_modules', 'intelephense', 'lib', 'intelephense.js')),
    initializationOptions: (dir) => ({ storagePath: path.join(dir, 'cache'), globalStoragePath: path.join(dir, 'global'), clearCache: false })
  },
  {
    id: 'java',
    name: 'Java',
    description: 'Eclipse JDT Language Server (what VS Code’s Java extension uses). Uses your Java 21+ if installed, otherwise downloads one with the server.',
    languages: ['java'],
    approxMB: 54,
    source: { type: 'openvsx', namespace: 'redhat', name: 'java', version: '1.57.2026093008', keep: ['extension/server/', 'extension/jre/'], bundledRuntimeTarget: VSIX_TARGET, useSystemRuntime: () => findJava(21) },
    serverFile: ['server', 'plugins'],
    launch: (dir, meta, root) => {
      const plugins = path.join(dir, 'server', 'plugins');
      const launcher = fsSync.readdirSync(plugins).find((f) => /^org\.eclipse\.equinox\.launcher_.*\.jar$/.test(f));
      if (!launcher) throw new Error('Java language server is incomplete — reinstall it.');
      let java = meta.javaPath;
      if (!java) {
        const jreDir = path.join(dir, 'jre');
        const sub = fsSync.existsSync(jreDir) && fsSync.readdirSync(jreDir)[0];
        java = sub ? path.join(jreDir, sub, 'bin', `java${EXE}`) : 'java';
      }
      const dataDir = path.join(dir, 'workspaces', crypto.createHash('sha1').update(String(root || 'none')).digest('hex').slice(0, 12));
      return {
        command: java,
        args: [
          '-Declipse.application=org.eclipse.jdt.ls.core.id1', '-Dosgi.bundles.defaultStartLevel=4',
          '-Declipse.product=org.eclipse.jdt.ls.core.product', '-Dosgi.checkConfiguration=true',
          `-Dosgi.sharedConfiguration.area=${path.join(dir, 'server', JDTLS_CONFIG)}`, '-Dosgi.sharedConfiguration.area.readOnly=true',
          '-Dosgi.configuration.cascaded=true', '-Xms256m', '-Xmx1G', '--add-modules=ALL-SYSTEM',
          '--add-opens', 'java.base/java.util=ALL-UNNAMED', '--add-opens', 'java.base/java.lang=ALL-UNNAMED',
          '-jar', path.join(plugins, launcher), '-data', dataDir
        ]
      };
    },
    initializationOptions: () => ({ settings: { java: { autobuild: { enabled: true } } }, extendedClientCapabilities: { classFileContentsSupport: false } })
  },
  {
    id: 'csharp',
    name: 'C#',
    description: 'csharp-ls (Roslyn-based): completions, go to definition, diagnostics. Needs the .NET 8+ SDK and a .sln or .csproj in the project.',
    languages: ['csharp'],
    approxMB: 15,
    source: { type: 'dotnet', package: 'csharp-ls', version: '0.28.0' },
    requires: async () => (await findDotnetSdk(8)) ? null : 'C# support needs the .NET SDK 8 or newer. Install it from https://dotnet.microsoft.com/download, then try again.',
    serverFile: [`csharp-ls${EXE}`],
    launch: (dir) => ({ command: path.join(dir, `csharp-ls${EXE}`), args: [] }),
    initializationOptions: () => ({})
  }
];

// Formatters/linters: installed exactly like servers, but run per request
// by main/tools.js instead of as long-lived LSP processes.
const RUFF_ASSET = {
  'win32-x64': 'ruff-x86_64-pc-windows-msvc.zip', 'win32-arm64': 'ruff-aarch64-pc-windows-msvc.zip',
  'darwin-x64': 'ruff-x86_64-apple-darwin.tar.gz', 'darwin-arm64': 'ruff-aarch64-apple-darwin.tar.gz',
  'linux-x64': 'ruff-x86_64-unknown-linux-gnu.tar.gz', 'linux-arm64': 'ruff-aarch64-unknown-linux-gnu.tar.gz'
}[`${process.platform}-${process.arch}`];

CATALOG.push(
  {
    id: 'prettier',
    kind: 'tool',
    name: 'Prettier',
    description: 'Formatter for JavaScript, TypeScript, JSON, CSS/SCSS/Less, HTML, Markdown and YAML. Follows the project\u2019s .prettierrc when there is one.',
    languages: ['javascript', 'typescript', 'json', 'css', 'scss', 'less', 'html', 'markdown', 'yaml', 'graphql'],
    approxMB: 10,
    source: { type: 'npm', packages: [{ name: 'prettier', version: '3.9.10' }] },
    serverFile: ['node_modules', 'prettier', 'bin', 'prettier.cjs']
  },
  {
    id: 'ruff',
    kind: 'tool',
    name: 'Ruff (Python)',
    description: 'Extremely fast Python formatter and linter (replaces Black + flake8). Follows pyproject.toml / ruff.toml when present.',
    languages: ['python'],
    approxMB: 10,
    source: { type: 'github', repo: 'astral-sh/ruff', tag: '0.17.0', asset: RUFF_ASSET },
    serverFile: [`ruff${EXE}`]
  }
);

const specFor = (id) => {
  const s = CATALOG.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown language support "${id}".`);
  return s;
};
const readMeta = async (id) => { try { return JSON.parse(await fs.readFile(path.join(dirFor(id), 'installed.json'), 'utf8')); } catch { return null; } };
const isInstalled = (spec) => fsSync.existsSync(path.join(dirFor(spec.id), ...spec.serverFile)) && fsSync.existsSync(path.join(dirFor(spec.id), 'installed.json'));

async function list() {
  return Promise.all(CATALOG.map(async (s) => {
    const meta = await readMeta(s.id);
    return {
      id: s.id, kind: s.kind || 'server', name: s.name, description: s.description, languages: s.languages, approxMB: s.approxMB,
      source: describeSource(s.source),
      installed: isInstalled(s),
      variant: meta?.variant || null,
      running: [...servers.values()].some((x) => x.id === s.id)
    };
  }));
}

function describeSource(src) {
  if (src.type === 'npm') return src.packages.map((p) => `${p.name}@${p.version}`);
  if (src.type === 'github') return [`${src.repo}@${src.tag}`];
  if (src.type === 'openvsx') return [`open-vsx ${src.namespace}.${src.name}@${src.version}`];
  if (src.type === 'dotnet') return [`dotnet tool ${src.package}@${src.version}`];
  return [];
}

// ---------- download helpers ----------
async function fetchBuffer(url, onProgress) {
  const res = await net.fetch(url, { headers: { 'User-Agent': 'MulTeam' } });
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

async function fetchJson(url) {
  const res = await net.fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'MulTeam' } });
  if (!res.ok) throw new Error(`Request failed (${res.status}) for ${url}`);
  return res.json();
}

function verifySri(buf, integrity) {
  const m = /^(sha512|sha384|sha256)-(.+)$/.exec(String(integrity || '').split(/\s+/)[0]);
  if (!m) throw new Error('No integrity hash was published; refusing to install.');
  if (crypto.createHash(m[1]).update(buf).digest('base64') !== m[2]) throw new Error('Integrity check failed — the download doesn’t match what was published.');
}

function verifySha256Hex(buf, hex) {
  const want = String(hex || '').trim().split(/\s+/)[0].replace(/^sha256:/, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(want)) throw new Error('No checksum was published; refusing to install.');
  if (crypto.createHash('sha256').update(buf).digest('hex') !== want) throw new Error('Checksum mismatch — the download doesn’t match what was published.');
}

const insideDir = (dest, rel) => {
  const out = path.resolve(dest, rel);
  return out.startsWith(path.resolve(dest) + path.sep) ? out : null; // path-escape guard
};

// Minimal .tgz extractor for npm packages (ustar + pax/GNU long names);
// strips the leading "package/" folder.
async function extractTgz(tgz, destDir) {
  const tar = zlib.gunzipSync(tgz);
  let off = 0;
  let longName = null;
  const str = (o, n) => tar.subarray(o, o + n).toString('utf8').replace(/\0.*$/s, '');
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    let name = str(off, 100);
    const size = parseInt(str(off + 124, 12).trim() || '0', 8);
    const mode = parseInt(str(off + 100, 8).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = str(off + 345, 155);
    if (prefix) name = `${prefix}/${name}`;
    const data = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') { const m = /\d+ path=([^\n]+)\n/.exec(data.toString('utf8')); if (m) longName = m[1]; continue; }
    if (type === 'L') { longName = data.toString('utf8').replace(/\0.*$/s, ''); continue; }
    if (type === 'g') continue;
    if (longName) { name = longName; longName = null; }
    if (type !== '0' && type !== '\0' && type !== '5') continue;
    const rel = name.replace(/^[^/]+\//, '');
    const out = rel && insideDir(destDir, rel);
    if (!out) continue;
    if (type === '5') { await fs.mkdir(out, { recursive: true }); continue; }
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, data);
    if (!IS_WIN && mode & 0o111) await fs.chmod(out, 0o755);
  }
}

async function extractZip(buf, destDir, { keep = null, strip = '' } = {}) {
  const zip = new AdmZip(buf);
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    if (keep && !keep.some((k) => e.entryName.startsWith(k))) continue;
    const rel = strip && e.entryName.startsWith(strip) ? e.entryName.slice(strip.length) : e.entryName;
    const out = insideDir(destDir, rel);
    if (!out) continue;
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, e.getData());
    if (!IS_WIN && (e.header.attr >>> 16) & 0o111) await fs.chmod(out, 0o755); // keep executables runnable
  }
}

// ---------- installers per source ----------
async function installNpm(src, tmp, progress) {
  for (let i = 0; i < src.packages.length; i++) {
    const p = src.packages[i];
    const meta = await fetchJson(`https://registry.npmjs.org/${p.name}/${p.version}`);
    const tgz = await fetchBuffer(meta.dist.tarball, (rec, total) => progress((i + (total ? rec / total : 0) * 0.9) / src.packages.length, `${p.name} ${(rec / 1048576).toFixed(1)} MB`));
    verifySri(tgz, meta.dist.integrity);
    await extractTgz(tgz, path.join(tmp, 'node_modules', p.name));
  }
  return {};
}

async function installGithub(src, tmp, progress) {
  const rel = await fetchJson(`https://api.github.com/repos/${src.repo}/releases/tags/${src.tag}`);
  const asset = (rel.assets || []).find((a) => a.name === src.asset);
  if (!asset) throw new Error(`No ${src.asset} in ${src.repo} ${src.tag} for this platform.`);
  const buf = await fetchBuffer(asset.browser_download_url, (rec, total) => progress((total ? rec / total : 0) * 0.9, `${(rec / 1048576).toFixed(1)} / ${(asset.size / 1048576).toFixed(1)} MB`));
  verifySha256Hex(buf, asset.digest);
  progress(0.93, 'unpacking');
  if (/\.tar\.gz$|\.tgz$/.test(asset.name)) await extractTgz(buf, tmp); // strips the top folder
  else await extractZip(buf, tmp);
  return {};
}

async function installOpenVsx(src, tmp, progress) {
  // Prefer the user's own runtime (smaller download) when the server needs one.
  let target = null;
  let javaPath = null;
  if (src.bundledRuntimeTarget) {
    const sys = src.useSystemRuntime ? await src.useSystemRuntime() : null;
    if (sys) javaPath = sys.path; else target = src.bundledRuntimeTarget;
  }
  const base = `https://open-vsx.org/api/${src.namespace}/${src.name}`;
  const meta = await fetchJson(target ? `${base}/${target}/${src.version}` : `${base}/${src.version}`);
  if (!meta.files?.download || !meta.files?.sha256) throw new Error('Open VSX has no verifiable package for this version.');
  const sha = await (await net.fetch(meta.files.sha256)).text();
  const buf = await fetchBuffer(meta.files.download, (rec, total) => progress((total ? rec / total : 0) * 0.85, `${(rec / 1048576).toFixed(1)} MB`));
  verifySha256Hex(buf, sha);
  progress(0.9, 'unpacking');
  await extractZip(buf, tmp, { keep: src.keep, strip: 'extension/' });
  return { variant: target ? 'bundled-runtime' : (javaPath ? 'system-runtime' : 'universal'), javaPath };
}

async function installDotnet(src, tmp, progress) {
  progress(0.2, 'dotnet tool install (this can take a minute)');
  const r = await new Promise((resolve) => {
    execFile('dotnet', ['tool', 'install', src.package, '--version', src.version, '--tool-path', tmp], { timeout: 300000, windowsHide: true }, (err, stdout, stderr) => resolve({ err, out: `${stdout}${stderr}` }));
  });
  if (r.err) throw new Error(`dotnet tool install failed: ${r.out.trim().split('\n').slice(-3).join(' ')}`);
  return {};
}

const INSTALLERS = { npm: installNpm, github: installGithub, openvsx: installOpenVsx, dotnet: installDotnet };

async function install(id, sender) {
  const spec = specFor(id);
  const send = (phase, pct, detail = '') => { if (!sender.isDestroyed()) sender.send(IPC_REF.LSP_PROGRESS, { id, phase, pct, detail }); };
  const problem = spec.requires ? await spec.requires() : null;
  if (problem) throw new Error(problem);

  await stopById(id);
  const dir = dirFor(id);
  const tmp = `${dir}.installing`;
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.mkdir(tmp, { recursive: true });
  try {
    send('downloading', 0, 'starting…');
    const extra = await INSTALLERS[spec.source.type](spec.source, tmp, (frac, detail) => send('downloading', Math.min(99, Math.round(frac * 100)), detail));
    if (!fsSync.existsSync(path.join(tmp, ...spec.serverFile))) throw new Error('The download didn’t contain the expected language server files.');
    await fs.writeFile(path.join(tmp, 'installed.json'), JSON.stringify({ id, source: describeSource(spec.source), installedAt: Date.now(), ...extra }, null, 2));
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rename(tmp, dir);
  } catch (err) {
    await fs.rm(tmp, { recursive: true, force: true });
    throw err;
  }
  send('done', 100);
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

async function start(id, rootPath, sender) {
  const spec = specFor(id);
  if (!spec.launch) throw new Error(`${spec.name} isn't a language server.`);
  if (!isInstalled(spec)) throw new Error(`${spec.name} support isn't installed.`);
  const meta = (await readMeta(id)) || {};
  const key = `${sender.id}:${id}`;
  stopKey(key);

  const { command, args, env = {} } = spec.launch(dirFor(id), meta, rootPath);
  const proc = spawn(command, args, {
    cwd: rootPath && fsSync.existsSync(rootPath) ? rootPath : dirFor(id),
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  const srv = { id, proc, owner: sender, buffer: Buffer.alloc(0), stderr: [] };
  servers.set(key, srv);

  proc.stdout.on('data', (chunk) => {
    srv.buffer = Buffer.concat([srv.buffer, chunk]);
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
    if (servers.get(key) === srv) servers.delete(key);
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

module.exports = { setupLanguageHandlers, stopAllLanguageServers: stopAll, toolPath: (id) => { const s = specFor(id); return isInstalled(s) ? path.join(dirFor(id), ...s.serverFile) : null; } };
