// MulTeam's own plugin system — storage side. A plugin is a folder with a
// `multeam-plugin.json` manifest and a JS entry file. Plugins live in
// <userData>/plugins/<id>/ and RUN in the renderer inside a sandboxed Web
// Worker (renderer/js/pluginHost.js); this module only lists, installs,
// scaffolds and removes them, and hands their code over.
const { app, dialog, shell, BrowserWindow } = require('electron');
const crypto = require('node:crypto');
const AdmZip = require('adm-zip');
const { TEMPLATES } = require('./pluginTemplates');
const { lintPlugin } = require('./pluginLint');
const { openPluginProject, forgetPluginProject } = require('./projects');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');

const MANIFEST = 'multeam-plugin.json';
const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const KNOWN_PERMISSIONS = new Set(['editor', 'workspace.read', 'workspace.write']);

const pluginsRoot = () => path.join(app.getPath('userData'), 'plugins');
const stateFile = () => path.join(pluginsRoot(), 'state.json');

async function readState() {
  try { return JSON.parse(await fs.readFile(stateFile(), 'utf8')); } catch { return { disabled: [] }; }
}
async function writeState(state) {
  await fs.mkdir(pluginsRoot(), { recursive: true });
  await fs.writeFile(stateFile(), JSON.stringify(state, null, 2));
}

// Validates a manifest; returns a normalized copy or throws a readable error.
function validateManifest(m, folderName) {
  if (!m || typeof m !== 'object') throw new Error(`${MANIFEST} is not a JSON object.`);
  const id = m.id || folderName || '';
  if (!ID_RE.test(id || '')) throw new Error(`Plugin id "${id}" must be 2–64 lowercase letters, digits or dashes.`);
  if (!m.name) throw new Error('Manifest needs a "name".');
  const main = m.main || 'main.js';
  if (main.includes('..') || path.isAbsolute(main)) throw new Error('"main" must be a file inside the plugin folder.');
  const permissions = Array.isArray(m.permissions) ? m.permissions : [];
  const unknown = permissions.filter((p) => !KNOWN_PERMISSIONS.has(p));
  if (unknown.length) throw new Error(`Unknown permission(s): ${unknown.join(', ')}. Allowed: ${[...KNOWN_PERMISSIONS].join(', ')}.`);
  return {
    id,
    name: String(m.name),
    version: String(m.version || '0.0.0'),
    description: String(m.description || ''),
    author: String(m.author || ''),
    main,
    permissions
  };
}

async function readPlugin(dir) {
  const manifest = JSON.parse(await fs.readFile(path.join(dir, MANIFEST), 'utf8'));
  return validateManifest(manifest, path.basename(dir));
}

async function list() {
  await fs.mkdir(pluginsRoot(), { recursive: true });
  const state = await readState();
  const out = [];
  for (const e of await fs.readdir(pluginsRoot(), { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const dir = path.join(pluginsRoot(), e.name);
    try {
      const p = await readPlugin(dir);
      out.push({ ...p, dir, enabled: !state.disabled.includes(p.id), error: null });
    } catch (err) {
      out.push({ id: e.name, name: e.name, version: '', description: '', permissions: [], dir, enabled: false, error: err.message });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function readCode(id) {
  if (!ID_RE.test(id)) throw new Error('Invalid plugin id.');
  const dir = path.join(pluginsRoot(), id);
  const p = await readPlugin(dir);
  const file = path.resolve(dir, p.main);
  if (!file.startsWith(dir + path.sep)) throw new Error('Invalid entry file.');
  return fs.readFile(file, 'utf8');
}

async function installFromFolder(event) {
  const win = BrowserWindow.fromWebContents(event.sender);
  const pick = await dialog.showOpenDialog(win, { title: 'Choose a MulTeam plugin folder', properties: ['openDirectory'] });
  if (pick.canceled || !pick.filePaths[0]) return null;
  const src = pick.filePaths[0];
  if (!fsSync.existsSync(path.join(src, MANIFEST))) throw new Error(`That folder has no ${MANIFEST}.`);
  const p = await readPlugin(src);
  const dest = path.join(pluginsRoot(), p.id);
  if (path.resolve(src) === path.resolve(dest)) return p;
  await fs.rm(dest, { recursive: true, force: true });
  await fs.cp(src, dest, { recursive: true, filter: (f) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(f) });
  return p;
}

async function uninstall(id) {
  if (!ID_RE.test(id)) throw new Error('Invalid plugin id.');
  await fs.rm(path.join(pluginsRoot(), id), { recursive: true, force: true });
  await forgetPluginProject(id);
  const state = await readState();
  state.disabled = state.disabled.filter((x) => x !== id);
  await writeState(state);
}

async function setEnabled(id, enabled) {
  const state = await readState();
  state.disabled = state.disabled.filter((x) => x !== id);
  if (!enabled) state.disabled.push(id);
  await writeState(state);
}

// ---------- editing inside MulTeam ----------
// Opens the plugin's own folder as a project in the "Plugins" workspace.
async function openForEditing(id) {
  if (!ID_RE.test(id)) throw new Error('Invalid plugin id.');
  const dir = path.join(pluginsRoot(), id);
  if (!fsSync.existsSync(dir)) throw new Error('That plugin is no longer installed.');
  let name = id;
  let main = 'main.js';
  try {
    const m = JSON.parse(await fs.readFile(path.join(dir, MANIFEST), 'utf8'));
    name = String(m.name || id);
    main = String(m.main || 'main.js');
  } catch { /* a broken manifest is exactly what you'd open it to fix */ }
  const project = await openPluginProject({ pluginId: id, name, folderPath: dir });
  return { project, mainPath: path.join(dir, main), manifestPath: path.join(dir, MANIFEST) };
}

// The static half of the plugin debug engine (see pluginLint.js). Paths in
// the result are absolute so the renderer can mark the right editor model.
async function check(id) {
  if (!ID_RE.test(id)) throw new Error('Invalid plugin id.');
  const dir = path.join(pluginsRoot(), id);
  const read = (rel) => {
    const file = path.resolve(dir, rel);
    if (!file.startsWith(dir + path.sep)) return null;
    try { return fsSync.readFileSync(file, 'utf8'); } catch { return null; }
  };
  const diagnostics = lintPlugin({ manifestText: read(MANIFEST), folderName: id, readFile: read });
  return { dir, diagnostics: diagnostics.map((d) => ({ ...d, path: path.join(dir, d.file) })) };
}

// ---------- templates ----------
function slug(name) {
  return String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'my-plugin';
}

// Creates a new plugin from one of the starter templates.
async function scaffold(name, templateId = 'hello-command') {
  const tpl = TEMPLATES.find((t) => t.id === templateId) || TEMPLATES[0];
  const id = slug(name);
  if (!ID_RE.test(id)) throw new Error('Pick a name with letters or digits.');
  const dir = path.join(pluginsRoot(), id);
  if (fsSync.existsSync(dir)) throw new Error(`A plugin called "${id}" already exists.`);
  const fill = (txt) => txt.replace(/\{name\}/g, String(name).trim()).replace(/\{id\}/g, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, MANIFEST), JSON.stringify({
    id,
    name: String(name).trim(),
    version: '0.1.0',
    description: tpl.summary,
    main: 'main.js',
    permissions: tpl.permissions
  }, null, 2) + '\n');
  await fs.writeFile(path.join(dir, 'main.js'), fill(tpl.main));
  await fs.writeFile(path.join(dir, 'README.md'), fill(tpl.readme));
  return { id, dir };
}

// ---------- .mtplugin packages (a zip of the plugin folder) ----------
const MAX_PACKAGE_BYTES = 700 * 1024; // fits a Firestore document with room to spare
const SKIP = /(^|[\\/])(node_modules|\.git|\.DS_Store)([\\/]|$)/;

async function packFolder(dir) {
  const zip = new AdmZip();
  const walk = async (d, rel = '') => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (SKIP.test(r)) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full, r);
      else if (e.isFile()) zip.addFile(r, await fs.readFile(full));
    }
  };
  await walk(dir);
  const buf = zip.toBuffer();
  if (buf.length > MAX_PACKAGE_BYTES) throw new Error(`The package is ${(buf.length / 1024).toFixed(0)} KB — plugins can be at most ${MAX_PACKAGE_BYTES / 1024} KB.`);
  return buf;
}

// Reads + validates a package without installing it.
function inspectPackage(buf) {
  if (buf.length > MAX_PACKAGE_BYTES) throw new Error('That package is too large to be a MulTeam plugin.');
  let zip;
  try { zip = new AdmZip(buf); } catch { throw new Error('That file isn’t a valid .mtplugin package.'); }
  const entry = zip.getEntry(MANIFEST);
  if (!entry) throw new Error(`The package has no ${MANIFEST}.`);
  const manifest = validateManifest(JSON.parse(entry.getData().toString('utf8')), null);
  if (!zip.getEntry(manifest.main)) throw new Error(`The package is missing its entry file (${manifest.main}).`);
  return { zip, manifest };
}

async function installBuffer(buf) {
  const { zip, manifest } = inspectPackage(buf);
  const dest = path.join(pluginsRoot(), manifest.id);
  const tmp = `${dest}.installing`;
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.mkdir(tmp, { recursive: true });
  try {
    for (const e of zip.getEntries()) {
      if (e.isDirectory || SKIP.test(e.entryName)) continue;
      const out = path.resolve(tmp, e.entryName);
      if (!out.startsWith(path.resolve(tmp) + path.sep)) continue; // zip-slip guard
      await fs.mkdir(path.dirname(out), { recursive: true });
      await fs.writeFile(out, e.getData());
    }
    await fs.rm(dest, { recursive: true, force: true });
    await fs.rename(tmp, dest);
  } catch (err) {
    await fs.rm(tmp, { recursive: true, force: true });
    throw err;
  }
  return manifest;
}

async function exportPackage(event, id) {
  if (!ID_RE.test(id)) throw new Error('Invalid plugin id.');
  const dir = path.join(pluginsRoot(), id);
  const manifest = await readPlugin(dir);
  const buf = await packFolder(dir);
  const win = BrowserWindow.fromWebContents(event.sender);
  const res = await dialog.showSaveDialog(win, {
    title: 'Export plugin package',
    defaultPath: path.join(app.getPath('documents'), `${manifest.id}-${manifest.version}.mtplugin`),
    filters: [{ name: 'MulTeam plugin', extensions: ['mtplugin'] }]
  });
  if (res.canceled || !res.filePath) return null;
  await fs.writeFile(res.filePath, buf);
  return res.filePath;
}

async function installPackageFile(event) {
  const win = BrowserWindow.fromWebContents(event.sender);
  const pick = await dialog.showOpenDialog(win, { title: 'Install a .mtplugin package', properties: ['openFile'], filters: [{ name: 'MulTeam plugin', extensions: ['mtplugin', 'zip'] }] });
  if (pick.canceled || !pick.filePaths[0]) return null;
  return installBuffer(await fs.readFile(pick.filePaths[0]));
}

// For the gallery: pack an installed plugin as base64 + its SHA-256.
async function packForPublish(id) {
  if (!ID_RE.test(id)) throw new Error('Invalid plugin id.');
  const dir = path.join(pluginsRoot(), id);
  const manifest = await readPlugin(dir);
  const buf = await packFolder(dir);
  return { manifest, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'), base64: buf.toString('base64') };
}

// From the gallery: verify the hash the publisher recorded, then install.
async function installFromGallery(base64, sha256) {
  const buf = Buffer.from(String(base64 || ''), 'base64');
  if (crypto.createHash('sha256').update(buf).digest('hex') !== String(sha256 || '').toLowerCase()) {
    throw new Error('Checksum mismatch — the package doesn’t match what was published.');
  }
  return installBuffer(buf);
}

function setupPluginHandlers(ipcMain, IPC) {
  ipcMain.handle(IPC.PLUGIN_LIST, () => list());
  ipcMain.handle(IPC.PLUGIN_CODE, (_e, id) => readCode(id));
  ipcMain.handle(IPC.PLUGIN_INSTALL_FOLDER, (e) => installFromFolder(e));
  ipcMain.handle(IPC.PLUGIN_UNINSTALL, (_e, id) => uninstall(id));
  ipcMain.handle(IPC.PLUGIN_SET_ENABLED, (_e, id, enabled) => setEnabled(id, enabled));
  ipcMain.handle(IPC.PLUGIN_SCAFFOLD, (_e, name, templateId) => scaffold(name, templateId));
  ipcMain.handle(IPC.PLUGIN_TEMPLATES, () => TEMPLATES.map(({ id, title, summary, permissions }) => ({ id, title, summary, permissions })));
  ipcMain.handle(IPC.PLUGIN_EXPORT, (e, id) => exportPackage(e, id));
  ipcMain.handle(IPC.PLUGIN_INSTALL_PACKAGE, (e) => installPackageFile(e));
  ipcMain.handle(IPC.PLUGIN_PACK, (_e, id) => packForPublish(id));
  ipcMain.handle(IPC.PLUGIN_INSTALL_GALLERY, (_e, base64, sha256) => installFromGallery(base64, sha256));
  ipcMain.handle(IPC.PLUGIN_EDIT, (_e, id) => openForEditing(id));
  ipcMain.handle(IPC.PLUGIN_CHECK, (_e, id) => check(id));
  ipcMain.handle(IPC.PLUGIN_OPEN_FOLDER, async (_e, id) => {
    if (!ID_RE.test(id)) throw new Error('Invalid plugin id.');
    const err = await shell.openPath(path.join(pluginsRoot(), id));
    if (err) throw new Error(err);
  });
}

module.exports = { setupPluginHandlers };
