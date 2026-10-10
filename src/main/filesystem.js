const { dialog, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { IPC } = require('../shared/constants');

// Keyed by watched path -> fs.FSWatcher, so a renderer can stop watching a
// file/directory it navigated away from without leaking watchers.
const watchers = new Map();

async function buildFileTree(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const nodes = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.git') || entry.name === 'node_modules') continue;

    const fullPath = path.join(dirPath, entry.name);
    nodes.push({
      name: entry.name,
      path: fullPath,
      type: entry.isDirectory() ? 'directory' : 'file'
    });
  }

  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return nodes;
}

// Appends " (2)", " (3)", ... before the extension until a free path is
// found, so a duplicate never silently clobbers an existing file/folder.
function uniqueSiblingPath(targetPath) {
  if (!fsSync.existsSync(targetPath)) return targetPath;

  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const base = path.basename(targetPath, ext);

  for (let n = 2; n < 1000; n++) {
    const candidate = path.join(dir, `${base} (${n})${ext}`);
    if (!fsSync.existsSync(candidate)) return candidate;
  }
  throw new Error('Could not find a free name for the duplicate');
}

function setupFileSystemHandlers(ipcMain) {
  ipcMain.handle(IPC.OPEN_DIRECTORY, async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openDirectory']
    });
    if (canceled) return null;
    return filePaths[0];
  });

  ipcMain.handle(IPC.SHOW_SAVE_DIALOG, async (_event, defaultPath) => {
    const { canceled, filePath } = await dialog.showSaveDialog({ defaultPath });
    return canceled ? null : filePath;
  });

  ipcMain.handle(IPC.READ_DIR, async (_event, dirPath) => {
    return buildFileTree(dirPath);
  });

  ipcMain.handle(IPC.READ_FILE, async (_event, filePath) => {
    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch (err) {
      throw new Error(`Failed to read file: ${err.message}`);
    }
  });

  ipcMain.handle(IPC.WRITE_FILE, async (_event, filePath, content) => {
    try {
      await fs.writeFile(filePath, content, 'utf-8');
      return true;
    } catch (err) {
      throw new Error(`Failed to write file: ${err.message}`);
    }
  });

  ipcMain.handle(IPC.CREATE_FILE, async (_event, filePath) => {
    try {
      await fs.writeFile(filePath, '', { flag: 'wx' });
      return true;
    } catch (err) {
      throw new Error(`Failed to create file: ${err.message}`);
    }
  });

  ipcMain.handle(IPC.CREATE_DIRECTORY, async (_event, dirPath) => {
    try {
      await fs.mkdir(dirPath);
      return true;
    } catch (err) {
      throw new Error(`Failed to create folder: ${err.message}`);
    }
  });

  ipcMain.handle(IPC.DELETE_ENTRY, async (_event, entryPath) => {
    try {
      await fs.rm(entryPath, { recursive: true });
      return true;
    } catch (err) {
      throw new Error(`Failed to delete: ${err.message}`);
    }
  });

  ipcMain.handle(IPC.RENAME_ENTRY, async (_event, oldPath, newPath) => {
    try {
      await fs.rename(oldPath, newPath);
      return newPath;
    } catch (err) {
      throw new Error(`Failed to rename: ${err.message}`);
    }
  });

  ipcMain.handle(IPC.DUPLICATE_ENTRY, async (_event, entryPath) => {
    try {
      const dest = uniqueSiblingPath(entryPath);
      await fs.cp(entryPath, dest, { recursive: true });
      return dest;
    } catch (err) {
      throw new Error(`Failed to duplicate: ${err.message}`);
    }
  });

  ipcMain.handle(IPC.WATCH_PATH, (event, watchPath) => {
    if (watchers.has(watchPath)) return true;

    const sender = event.sender;
    let watcher;
    try {
      // recursive: the Explorer needs to hear about changes in subfolders too
      // (supported on Windows/macOS, and Linux on recent Node/Electron)
      watcher = fsSync.watch(watchPath, { recursive: true }, (eventType, filename) => {
        if (filename && /(^|[\\/])(\.git|node_modules)([\\/]|$)/.test(filename)) return; // VCS/deps churn
        if (sender.isDestroyed()) return;
        sender.send(IPC.FILE_CHANGED, { path: watchPath, filename, eventType });
      });
    } catch (err) {
      throw new Error(`Can't watch ${watchPath}: ${err.message}`);
    }
    // e.g. the folder itself was deleted — stop quietly instead of crashing
    watcher.on('error', () => { watcher.close(); watchers.delete(watchPath); });
    sender.once('destroyed', () => { watcher.close(); watchers.delete(watchPath); });

    watchers.set(watchPath, watcher);
    return true;
  });

  ipcMain.handle(IPC.UNWATCH_PATH, (_event, watchPath) => {
    const watcher = watchers.get(watchPath);
    if (!watcher) return false;
    watcher.close();
    watchers.delete(watchPath);
    return true;
  });
}

module.exports = { setupFileSystemHandlers };
