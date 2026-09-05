// Local-first project registry — one JSON file per project under the app's
// userData directory, functioning like a local mirror of a Firestore
// collection. This is the source of truth for the dashboard; Firestore is
// only ever written to when a project has cloud sync explicitly enabled.
const { app } = require('electron');
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

async function createProject({ name, folderPath, cloudEnabled }) {
  const now = Date.now();
  return writeRecord({
    id: crypto.randomUUID(),
    name,
    folderPath,
    cloudEnabled: !!cloudEnabled,
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

async function deleteProjectLocal(id) {
  const dir = await ensureRegistryDir();
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
    createdAt: now,
    lastOpenedAt: now
  });
}

function setupProjectHandlers(ipcMain, IPC) {
  ipcMain.handle(IPC.LIST_PROJECTS, () => listProjects());
  ipcMain.handle(IPC.GET_PROJECT, (_e, id) => getProject(id));
  ipcMain.handle(IPC.CREATE_PROJECT, (_e, params) => createProject(params));
  ipcMain.handle(IPC.UPDATE_PROJECT, (_e, id, patch) => updateProject(id, patch));
  ipcMain.handle(IPC.DELETE_PROJECT_LOCAL, (_e, id) => deleteProjectLocal(id));
  ipcMain.handle(IPC.DUPLICATE_PROJECT, (_e, id) => duplicateProject(id));
}

module.exports = { setupProjectHandlers };
