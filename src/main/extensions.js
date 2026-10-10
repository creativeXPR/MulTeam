// Extensions from Open VSX (open-vsx.org — the open marketplace VS Code
// forks use; Microsoft's marketplace terms don't allow other editors).
// For now only declarative contributions are used: color themes and
// snippets. Installs live in <userData>/extensions/<publisher.name>/ with
// the original package.json, so richer contribution types can be enabled
// later without reinstalling.
const { app, net } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');

const API = 'https://open-vsx.org/api';
const extRoot = () => path.join(app.getPath('userData'), 'extensions');
const registryFile = () => path.join(extRoot(), 'extensions.json');
const SAFE_ID = /^[\w.-]+$/;

async function readRegistry() {
  try { return JSON.parse(await fs.readFile(registryFile(), 'utf8')); } catch { return []; }
}
async function writeRegistry(list) {
  await fs.mkdir(extRoot(), { recursive: true });
  await fs.writeFile(registryFile(), JSON.stringify(list, null, 2));
}

async function getJson(url) {
  const res = await net.fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Open VSX request failed (${res.status})`);
  return res.json();
}

// VS Code JSON files are JSONC: comments + trailing commas.
function parseJsonc(text) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') { out += n ?? ''; i++; } else if (c === '"') inStr = false;
    } else if (c === '"') { inStr = true; out += c; }
    else if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; }
    else if (c === '/' && n === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; }
    else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1').replace(/^﻿/, ''));
}

// ---------- marketplace ----------
async function search({ query = '', category = 'Themes', offset = 0 } = {}) {
  const params = new URLSearchParams({ query, size: '30', offset: String(offset), sortBy: query ? 'relevance' : 'downloadCount', sortOrder: 'desc' });
  if (category && category !== 'All') params.set('category', category);
  const data = await getJson(`${API}/-/search?${params}`);
  return (data.extensions || []).map((e) => ({
    id: `${e.namespace}.${e.name}`,
    namespace: e.namespace,
    name: e.name,
    displayName: e.displayName || e.name,
    description: e.description || '',
    version: e.version,
    downloads: e.downloadCount || 0,
    icon: e.files?.icon || null,
    download: e.files?.download || null
  }));
}

// ---------- install / uninstall ----------
async function install({ namespace, name }) {
  if (!SAFE_ID.test(namespace) || !SAFE_ID.test(name)) throw new Error('Invalid extension id.');
  const meta = await getJson(`${API}/${namespace}/${name}`);
  const url = meta.files?.download;
  if (!url) throw new Error('This extension has no downloadable package.');

  const res = await net.fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));

  const manifestEntry = zip.getEntry('extension/package.json');
  if (!manifestEntry) throw new Error('Not a valid VS Code extension package.');
  const pkg = parseJsonc(manifestEntry.getData().toString('utf8'));
  const contributes = pkg.contributes || {};
  const themes = (contributes.themes || []).filter((t) => t.path);
  const snippets = (contributes.snippets || []).filter((s) => s.path && s.language);
  if (!themes.length && !snippets.length) {
    throw new Error("This extension doesn't contribute color themes or snippets, which is all MulTeam supports for now.");
  }

  const id = `${namespace}.${name}`;
  const dir = path.join(extRoot(), id);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });

  // copy only what we use: manifest, the declared theme/snippet files (and
  // any files a theme `include`s, which sit next to it), plus the icon
  const wanted = new Set(['package.json']);
  for (const c of [...themes, ...snippets]) wanted.add(path.posix.normalize(c.path.replace(/^\.\//, '')));
  if (pkg.icon) wanted.add(path.posix.normalize(pkg.icon.replace(/^\.\//, '')));
  const themeDirs = themes.map((t) => path.posix.dirname(path.posix.normalize(t.path.replace(/^\.\//, ''))));

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory || !entry.entryName.startsWith('extension/')) continue;
    const rel = entry.entryName.slice('extension/'.length);
    const inThemeDir = rel.endsWith('.json') && themeDirs.includes(path.posix.dirname(rel));
    if (!wanted.has(rel) && !inThemeDir) continue;
    const out = path.join(dir, ...rel.split('/'));
    if (!out.startsWith(dir + path.sep)) continue; // zip-slip guard
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, entry.getData());
  }

  const record = {
    id,
    namespace,
    name,
    displayName: pkg.displayName || meta.displayName || name,
    description: pkg.description || meta.description || '',
    version: pkg.version || meta.version,
    icon: pkg.icon && fsSync.existsSync(path.join(dir, pkg.icon)) ? pkg.icon : null,
    themes: themes.map((t) => ({ label: t.label || t.id || path.basename(t.path, '.json'), uiTheme: t.uiTheme || 'vs-dark', path: t.path })),
    snippets: snippets.map((s) => ({ language: s.language, path: s.path })),
    installedAt: Date.now()
  };
  const list = (await readRegistry()).filter((e) => e.id !== id);
  list.push(record);
  await writeRegistry(list);
  return record;
}

async function uninstall(id) {
  if (!SAFE_ID.test(id)) throw new Error('Invalid extension id.');
  await fs.rm(path.join(extRoot(), id), { recursive: true, force: true });
  await writeRegistry((await readRegistry()).filter((e) => e.id !== id));
}

// ---------- reading contributions ----------
async function readContribution(id, relPath) {
  if (!SAFE_ID.test(id)) throw new Error('Invalid extension id.');
  const dir = path.join(extRoot(), id);
  const file = path.resolve(dir, relPath);
  if (!file.startsWith(dir + path.sep)) throw new Error('Invalid path.');
  return parseJsonc(await fs.readFile(file, 'utf8'));
}

// Themes may `include` a base theme file; merge base first, then overrides.
async function readTheme(id, relPath, depth = 0) {
  const theme = await readContribution(id, relPath);
  if (theme.include && depth < 4) {
    const base = await readTheme(id, path.posix.join(path.posix.dirname(relPath.replace(/\\/g, '/')), theme.include), depth + 1);
    return {
      ...base,
      ...theme,
      colors: { ...(base.colors || {}), ...(theme.colors || {}) },
      tokenColors: [...(Array.isArray(base.tokenColors) ? base.tokenColors : []), ...(Array.isArray(theme.tokenColors) ? theme.tokenColors : [])]
    };
  }
  return theme;
}

function setupExtensionHandlers(ipcMain, IPC) {
  ipcMain.handle(IPC.EXT_SEARCH, (_e, opts) => search(opts));
  ipcMain.handle(IPC.EXT_INSTALL, (_e, opts) => install(opts));
  ipcMain.handle(IPC.EXT_UNINSTALL, (_e, id) => uninstall(id));
  ipcMain.handle(IPC.EXT_LIST, () => readRegistry());
  ipcMain.handle(IPC.EXT_READ_THEME, (_e, id, relPath) => readTheme(id, relPath));
  ipcMain.handle(IPC.EXT_READ_SNIPPETS, (_e, id, relPath) => readContribution(id, relPath));
  ipcMain.handle(IPC.EXT_ICON, async (_e, id) => {
    const rec = (await readRegistry()).find((e) => e.id === id);
    if (!rec?.icon) return null;
    const buf = await fs.readFile(path.join(extRoot(), id, rec.icon));
    const ext = path.extname(rec.icon).slice(1).toLowerCase();
    return `data:image/${ext === 'svg' ? 'svg+xml' : ext};base64,${buf.toString('base64')}`;
  });
}

module.exports = { setupExtensionHandlers };
