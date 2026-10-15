// The last text of each live file that this computer and the live session
// agreed on (what was last synced to disk). Kept under userData so that,
// after MulTeam was closed or offline, a file changed here can be merged
// with what teammates did meanwhile instead of one side overwriting the other.
const fs = require('node:fs/promises');
const path = require('node:path');
const { app } = require('electron');

const safe = (s) => String(s).replace(/[^A-Za-z0-9~%._-]/g, '_').slice(0, 200);
const fileFor = (projectId, branchKey, fileKey) => path.join(app.getPath('userData'), 'live-base', safe(projectId), safe(branchKey), `${safe(fileKey)}.txt`);

async function get(projectId, branchKey, fileKey) {
  try { return await fs.readFile(fileFor(projectId, branchKey, fileKey), 'utf8'); } catch { return null; }
}
async function set(projectId, branchKey, fileKey, text) {
  const f = fileFor(projectId, branchKey, fileKey);
  await fs.mkdir(path.dirname(f), { recursive: true });
  await fs.writeFile(f, String(text), 'utf8');
  return true;
}
async function remove(projectId, branchKey, fileKey) {
  await fs.rm(fileFor(projectId, branchKey, fileKey), { force: true });
  return true;
}

function setupLiveBaseHandlers(ipcMain, IPC) {
  ipcMain.handle(IPC.LIVE_BASE_GET, (_e, p, b, f) => get(p, b, f));
  ipcMain.handle(IPC.LIVE_BASE_SET, (_e, p, b, f, t) => set(p, b, f, t));
  ipcMain.handle(IPC.LIVE_BASE_REMOVE, (_e, p, b, f) => remove(p, b, f));
}

module.exports = { setupLiveBaseHandlers };
