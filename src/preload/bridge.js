const { contextBridge, ipcRenderer } = require('electron');
const { IPC } = require('../shared/constants');

const themeArg = process.argv.find((a) => a.startsWith('--multeam-theme='));

contextBridge.exposeInMainWorld('electronAPI', {
  // Theme last saved by the main process (window-state.json).
  savedTheme: themeArg ? themeArg.split('=')[1] : null,
  getAppVersion: () => ipcRenderer.invoke(IPC.GET_APP_VERSION),
  setTitleBarTheme: (theme) => ipcRenderer.invoke(IPC.SET_TITLEBAR_THEME, theme),
  zoom: (action) => ipcRenderer.invoke(IPC.WINDOW_ZOOM, action),

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
  deleteProjectLocal: (id, options) => ipcRenderer.invoke(IPC.DELETE_PROJECT_LOCAL, id, options),
  duplicateProject: (id) => ipcRenderer.invoke(IPC.DUPLICATE_PROJECT, id),

  // Project-wide search
  listFiles: (root) => ipcRenderer.invoke(IPC.LIST_FILES, root),
  searchText: (root, query, options) => ipcRenderer.invoke(IPC.SEARCH_TEXT, root, query, options),

  // Source control (simple-git in the main process)
  git: {
    status: (root) => ipcRenderer.invoke(IPC.GIT_STATUS, root),
    init: (root) => ipcRenderer.invoke(IPC.GIT_INIT, root),
    stage: (root, paths) => ipcRenderer.invoke(IPC.GIT_STAGE, root, paths),
    unstage: (root, paths) => ipcRenderer.invoke(IPC.GIT_UNSTAGE, root, paths),
    discard: (root, files) => ipcRenderer.invoke(IPC.GIT_DISCARD, root, files),
    commit: (root, message) => ipcRenderer.invoke(IPC.GIT_COMMIT, root, message),
    pull: (root) => ipcRenderer.invoke(IPC.GIT_PULL, root),
    push: (root) => ipcRenderer.invoke(IPC.GIT_PUSH, root),
    fetch: (root) => ipcRenderer.invoke(IPC.GIT_FETCH, root),
    branches: (root) => ipcRenderer.invoke(IPC.GIT_BRANCHES, root),
    checkout: (root, branch) => ipcRenderer.invoke(IPC.GIT_CHECKOUT, root, branch),
    createBranch: (root, name) => ipcRenderer.invoke(IPC.GIT_CREATE_BRANCH, root, name)
  },

  // Extensions (Open VSX) — themes + snippets for now
  extensions: {
    search: (opts) => ipcRenderer.invoke(IPC.EXT_SEARCH, opts),
    install: (opts) => ipcRenderer.invoke(IPC.EXT_INSTALL, opts),
    uninstall: (id) => ipcRenderer.invoke(IPC.EXT_UNINSTALL, id),
    list: () => ipcRenderer.invoke(IPC.EXT_LIST),
    readTheme: (id, relPath) => ipcRenderer.invoke(IPC.EXT_READ_THEME, id, relPath),
    readSnippets: (id, relPath) => ipcRenderer.invoke(IPC.EXT_READ_SNIPPETS, id, relPath),
    readJson: (id, relPath) => ipcRenderer.invoke(IPC.EXT_READ_SNIPPETS, id, relPath), // any JSON(C) contribution
    icon: (id) => ipcRenderer.invoke(IPC.EXT_ICON, id)
  },

  // MulTeam plugins (storage side — code runs in a sandboxed worker)
  plugins: {
    list: () => ipcRenderer.invoke(IPC.PLUGIN_LIST),
    code: (id) => ipcRenderer.invoke(IPC.PLUGIN_CODE, id),
    installFromFolder: () => ipcRenderer.invoke(IPC.PLUGIN_INSTALL_FOLDER),
    uninstall: (id) => ipcRenderer.invoke(IPC.PLUGIN_UNINSTALL, id),
    setEnabled: (id, enabled) => ipcRenderer.invoke(IPC.PLUGIN_SET_ENABLED, id, enabled),
    scaffold: (name) => ipcRenderer.invoke(IPC.PLUGIN_SCAFFOLD, name),
    openFolder: (id) => ipcRenderer.invoke(IPC.PLUGIN_OPEN_FOLDER, id)
  },

  // Language support: language servers installed on demand, LSP over IPC
  languages: {
    list: () => ipcRenderer.invoke(IPC.LSP_LIST),
    install: (id) => ipcRenderer.invoke(IPC.LSP_INSTALL, id),
    uninstall: (id) => ipcRenderer.invoke(IPC.LSP_UNINSTALL, id),
    start: (id, rootPath) => ipcRenderer.invoke(IPC.LSP_START, id, rootPath),
    stop: (id) => ipcRenderer.invoke(IPC.LSP_STOP, id),
    send: (id, msg) => ipcRenderer.send(IPC.LSP_SEND, id, msg),
    onMessage: (cb) => { const h = (_e, id, msg) => cb(id, msg); ipcRenderer.on(IPC.LSP_MESSAGE, h); return () => ipcRenderer.removeListener(IPC.LSP_MESSAGE, h); },
    onExit: (cb) => { const h = (_e, id, code, log) => cb(id, code, log); ipcRenderer.on(IPC.LSP_EXIT, h); return () => ipcRenderer.removeListener(IPC.LSP_EXIT, h); },
    onProgress: (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on(IPC.LSP_PROGRESS, h); return () => ipcRenderer.removeListener(IPC.LSP_PROGRESS, h); }
  },

  // Integrated terminal (node-pty in the main process)
  terminal: {
    listShells: () => ipcRenderer.invoke(IPC.TERM_SHELLS),
    create: (opts) => ipcRenderer.invoke(IPC.TERM_CREATE, opts),
    write: (id, data) => ipcRenderer.send(IPC.TERM_WRITE, id, data),
    resize: (id, cols, rows) => ipcRenderer.send(IPC.TERM_RESIZE, id, cols, rows),
    kill: (id) => ipcRenderer.invoke(IPC.TERM_KILL, id),
    onData: (callback) => {
      const handler = (_e, id, data) => callback(id, data);
      ipcRenderer.on(IPC.TERM_DATA, handler);
      return () => ipcRenderer.removeListener(IPC.TERM_DATA, handler);
    },
    onExit: (callback) => {
      const handler = (_e, id, code) => callback(id, code);
      ipcRenderer.on(IPC.TERM_EXIT, handler);
      return () => ipcRenderer.removeListener(IPC.TERM_EXIT, handler);
    }
  }
});
