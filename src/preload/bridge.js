const { contextBridge, ipcRenderer } = require('electron');
const { IPC } = require('../shared/constants');

contextBridge.exposeInMainWorld('electronAPI', {
  getAppVersion: () => ipcRenderer.invoke(IPC.GET_APP_VERSION),

  // Filesystem
  openDirectory: () => ipcRenderer.invoke(IPC.OPEN_DIRECTORY),
  showSaveDialog: (defaultPath) => ipcRenderer.invoke(IPC.SHOW_SAVE_DIALOG, defaultPath),
  readDir: (dirPath) => ipcRenderer.invoke(IPC.READ_DIR, dirPath),
  readFile: (filePath) => ipcRenderer.invoke(IPC.READ_FILE, filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke(IPC.WRITE_FILE, filePath, content),
  createFile: (filePath) => ipcRenderer.invoke(IPC.CREATE_FILE, filePath),
  createDirectory: (dirPath) => ipcRenderer.invoke(IPC.CREATE_DIRECTORY, dirPath),
  deleteEntry: (entryPath) => ipcRenderer.invoke(IPC.DELETE_ENTRY, entryPath),
  renameEntry: (oldPath, newPath) => ipcRenderer.invoke(IPC.RENAME_ENTRY, oldPath, newPath),
  duplicateEntry: (entryPath) => ipcRenderer.invoke(IPC.DUPLICATE_ENTRY, entryPath),
  watchPath: (watchPath) => ipcRenderer.invoke(IPC.WATCH_PATH, watchPath),
  unwatchPath: (watchPath) => ipcRenderer.invoke(IPC.UNWATCH_PATH, watchPath),

  onFileExternalChange: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on(IPC.FILE_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC.FILE_CHANGED, handler);
  },

  // Local project registry
  listProjects: () => ipcRenderer.invoke(IPC.LIST_PROJECTS),
  getProject: (id) => ipcRenderer.invoke(IPC.GET_PROJECT, id),
  createProject: (params) => ipcRenderer.invoke(IPC.CREATE_PROJECT, params),
  updateProject: (id, patch) => ipcRenderer.invoke(IPC.UPDATE_PROJECT, id, patch),
  deleteProjectLocal: (id) => ipcRenderer.invoke(IPC.DELETE_PROJECT_LOCAL, id),
  duplicateProject: (id) => ipcRenderer.invoke(IPC.DUPLICATE_PROJECT, id)
});
