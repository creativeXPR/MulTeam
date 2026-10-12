// Local-first project registry — one JSON file per project under the app's
// userData directory, functioning like a local mirror of a Firestore
// collection. This is the source of truth for the dashboard; Firestore is
// only ever written to when a project has cloud sync explicitly enabled.
const { app, shell } = require('electron');
const os = require('node:os');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function registryDir() {
  return path.join(app.getPath('userData'), 'workspace-index');
}

async function ensureRegistryDir() {
  const dir = registryDir();
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function readRecord(dir, file) {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, file), 'utf-8'));
  } catch {
    return null;
  }
}

async function listProjects() {
  const dir = await ensureRegistryDir();
  const files = await fs.readdir(dir);
  const records = await Promise.all(
    files.filter((f) => f.endsWith('.json')).map((f) => readRecord(dir, f))
  );
  return records
    .filter(Boolean)
    .sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0));
}

async function writeRecord(record) {
  const dir = await ensureRegistryDir();
  await fs.writeFile(path.join(dir, `${record.id}.json`), JSON.stringify(record, null, 2), 'utf-8');
  return record;
}

// `id` is passed when linking a cloud project you joined to a local folder
// (local and cloud records share the id); `joined` marks it as not yours.
async function createProject({ id, name, folderPath, cloudEnabled, workspaceId, joined }) {
  const now = Date.now();
  if (id !== undefined) {
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(String(id))) throw new Error('Invalid project id.');
    if (await getProject(id)) throw new Error('This project is already set up on this computer.');
  }
  return writeRecord({
    id: id || crypto.randomUUID(),
    name,
    folderPath,
    cloudEnabled: !!cloudEnabled,
    ...(joined ? { joined: true } : {}),
    workspaceId: workspaceId || (await readWorkspaces()).currentId,
    createdAt: now,
    lastOpenedAt: now
  });
}

async function getProject(id) {
  const dir = await ensureRegistryDir();
  return readRecord(dir, `${id}.json`);
}

async function updateProject(id, patch) {
  const dir = await ensureRegistryDir();
  const existing = await readRecord(dir, `${id}.json`);
  if (!existing) throw new Error(`No project found with id ${id}`);
  return writeRecord({ ...existing, ...patch, id });
}

// Removes the project from the registry. With { deleteFolder: true } it also
// sends the project's folder to the OS Recycle Bin/Trash (recoverable, never
// a permanent rm) — refusing drive roots, the home directory, and folders
// another registered project still points at.
async function deleteProjectLocal(id, { deleteFolder = false } = {}) {
  const dir = await ensureRegistryDir();

  if (deleteFolder) {
    const existing = await readRecord(dir, `${id}.json`);
    if (!existing) throw new Error(`No project found with id ${id}`);
    const folder = path.resolve(existing.folderPath);

    if (folder === path.parse(folder).root || folder === path.resolve(os.homedir())) {
      throw new Error(`Refusing to delete ${folder} — it's a drive root or your home folder.`);
    }
    const others = (await listProjects()).filter((p) => p.id !== id && path.resolve(p.folderPath) === folder);
    if (others.length) {
      throw new Error(`"${others[0].name}" also uses this folder, so it wasn't deleted.`);
    }
    try {
      await fs.access(folder);
      await shell.trashItem(folder);
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`Couldn't move the folder to the Recycle Bin: ${err.message}`);
      // Folder already gone — nothing to delete, just drop the record.
    }
  }

  await fs.rm(path.join(dir, `${id}.json`), { force: true });
}

// Copies the project's folder to a sibling directory and registers it as a
// new project. Never touches the original — this only ever adds files.
async function duplicateProject(id) {
  const dir = await ensureRegistryDir();
  const existing = await readRecord(dir, `${id}.json`);
  if (!existing) throw new Error(`No project found with id ${id}`);

  const parent = path.dirname(existing.folderPath);
  const base = path.basename(existing.folderPath);
  const suffix = crypto.randomBytes(3).toString('hex');
  const newFolderPath = path.join(parent, `${base}-${suffix}`);

  await fs.cp(existing.folderPath, newFolderPath, { recursive: true });

  const now = Date.now();
  return writeRecord({
    id: crypto.randomUUID(),
    name: `${existing.name} (copy)`,
    folderPath: newFolderPath,
    cloudEnabled: existing.cloudEnabled,
    workspaceId: existing.workspaceId,
    createdAt: now,
    lastOpenedAt: now
  });
}

// ---------- workspaces ----------
// A workspace groups projects; the Explorer and Dashboard show the current
// one. Stored next to the registry: { workspaces: [{ id, name, createdAt }], currentId }.
// Projects saved before workspaces existed (no workspaceId) belong to the
// first workspace ("default").
const DEFAULT_WS = 'default';
const workspacesFile = () => path.join(app.getPath('userData'), 'workspaces.json');

async function readWorkspaces() {
  let data = null;
  try { data = JSON.parse(await fs.readFile(workspacesFile(), 'utf-8')); } catch { /* first run */ }
  const workspaces = Array.isArray(data?.workspaces) && data.workspaces.length
    ? data.workspaces
    : [{ id: DEFAULT_WS, name: 'My Workspace', createdAt: Date.now() }];
  const currentId = workspaces.some((w) => w.id === data?.currentId) ? data.currentId : workspaces[0].id;
  return { workspaces, currentId };
}

async function writeWorkspaces(data) {
  await fs.mkdir(path.dirname(workspacesFile()), { recursive: true });
  await fs.writeFile(workspacesFile(), JSON.stringify(data, null, 2), 'utf-8');
  return data;
}

const cleanName = (name) => {
  const n = String(name || '').trim().slice(0, 60);
  if (!n) throw new Error('Give the workspace a name.');
  return n;
};

async function createWorkspace(name) {
  const data = await readWorkspaces();
  const ws = { id: crypto.randomUUID(), name: cleanName(name), createdAt: Date.now() };
  data.workspaces.push(ws);
  data.currentId = ws.id;
  await writeWorkspaces(data);
  return ws;
}

async function renameWorkspace(id, name) {
  const data = await readWorkspaces();
  const ws = data.workspaces.find((w) => w.id === id);
  if (!ws) throw new Error('That workspace no longer exists.');
  ws.name = cleanName(name);
  return writeWorkspaces(data);
}

async function setCurrentWorkspace(id) {
  const data = await readWorkspaces();
  if (!data.workspaces.some((w) => w.id === id)) throw new Error('That workspace no longer exists.');
  data.currentId = id;
  return writeWorkspaces(data);
}

// Deleting a workspace never deletes projects or folders: its projects move
// to `moveTo` (another workspace).
async function deleteWorkspace(id, moveTo) {
  const data = await readWorkspaces();
  if (data.workspaces.length < 2) throw new Error('You need at least one workspace.');
  const target = data.workspaces.find((w) => w.id === moveTo && w.id !== id) || data.workspaces.find((w) => w.id !== id);
  const firstId = data.workspaces[0].id;
  for (const p of await listProjects()) {
    if ((p.workspaceId || firstId) === id) await writeRecord({ ...p, workspaceId: target.id });
  }
  // projects without a workspaceId follow the FIRST workspace; pin them before it changes
  if (id === firstId) {
    for (const p of await listProjects()) if (!p.workspaceId) await writeRecord({ ...p, workspaceId: target.id });
  }
  data.workspaces = data.workspaces.filter((w) => w.id !== id);
  if (data.currentId === id) data.currentId = target.id;
  await writeWorkspaces(data);
  return { ...data, movedTo: target.id };
}

// ---------- the Plugins workspace ----------
// "Edit in MulTeam" on a plugin card opens that plugin's folder as its own
// project inside a reserved workspace (fixed id, so renaming it is fine and
// deleting it just means it's recreated on the next edit). One project per
// plugin, tagged with `pluginId`.
const PLUGINS_WS = 'plugins';

async function ensurePluginsWorkspace() {
  const data = await readWorkspaces();
  if (!data.workspaces.some((w) => w.id === PLUGINS_WS)) {
    data.workspaces.push({ id: PLUGINS_WS, name: 'Plugins', createdAt: Date.now() });
    await writeWorkspaces(data);
  }
  return data;
}

async function openPluginProject({ pluginId, name, folderPath }) {
  await ensurePluginsWorkspace();
  const existing = (await listProjects()).find((p) => p.pluginId === pluginId);
  const record = existing
    ? await writeRecord({ ...existing, name, folderPath, workspaceId: PLUGINS_WS, lastOpenedAt: Date.now() })
    : await writeRecord({
      id: crypto.randomUUID(),
      name,
      folderPath,
      cloudEnabled: false,
      workspaceId: PLUGINS_WS,
      pluginId,
      createdAt: Date.now(),
      lastOpenedAt: Date.now()
    });
  await setCurrentWorkspace(PLUGINS_WS);
  return record;
}

// Uninstalling a plugin drops its project record (its folder is already gone).
async function forgetPluginProject(pluginId) {
  const dir = await ensureRegistryDir();
  for (const p of await listProjects()) {
    if (p.pluginId === pluginId) await fs.rm(path.join(dir, `${p.id}.json`), { force: true });
  }
}

function setupProjectHandlers(ipcMain, IPC) {
  ipcMain.handle(IPC.WS_LIST, () => readWorkspaces());
  ipcMain.handle(IPC.WS_CREATE, (_e, name) => createWorkspace(name));
  ipcMain.handle(IPC.WS_RENAME, (_e, id, name) => renameWorkspace(String(id), name));
  ipcMain.handle(IPC.WS_SET_CURRENT, (_e, id) => setCurrentWorkspace(String(id)));
  ipcMain.handle(IPC.WS_DELETE, (_e, id, moveTo) => deleteWorkspace(String(id), moveTo ? String(moveTo) : null));
  ipcMain.handle(IPC.LIST_PROJECTS, () => listProjects());
  ipcMain.handle(IPC.GET_PROJECT, (_e, id) => getProject(id));
  ipcMain.handle(IPC.CREATE_PROJECT, (_e, params) => createProject(params));
  ipcMain.handle(IPC.UPDATE_PROJECT, (_e, id, patch) => updateProject(id, patch));
  ipcMain.handle(IPC.DELETE_PROJECT_LOCAL, (_e, id, options) => deleteProjectLocal(id, options));
  ipcMain.handle(IPC.DUPLICATE_PROJECT, (_e, id) => duplicateProject(id));
}

module.exports = { setupProjectHandlers, openPluginProject, forgetPluginProject };
