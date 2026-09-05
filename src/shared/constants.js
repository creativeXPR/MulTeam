// Shared between main, preload and renderer — keep this file dependency-free
// (no `require('electron')`, no DOM/browser APIs) so all three can import it.

const IPC = Object.freeze({
  GET_APP_VERSION: 'app:get-version',
  OPEN_DIRECTORY: 'fs:openDirectory',
  SHOW_SAVE_DIALOG: 'fs:showSaveDialog',
  READ_DIR: 'fs:readDir',
  READ_FILE: 'fs:readFile',
  WRITE_FILE: 'fs:writeFile',
  WATCH_PATH: 'fs:watchPath',
  UNWATCH_PATH: 'fs:unwatchPath',
  FILE_CHANGED: 'fs:changed',
  CREATE_FILE: 'fs:createFile',
  CREATE_DIRECTORY: 'fs:createDirectory',
  DELETE_ENTRY: 'fs:deleteEntry',
  RENAME_ENTRY: 'fs:renameEntry',
  DUPLICATE_ENTRY: 'fs:duplicateEntry',
  LIST_PROJECTS: 'projects:list',
  GET_PROJECT: 'projects:get',
  CREATE_PROJECT: 'projects:create',
  UPDATE_PROJECT: 'projects:update',
  DELETE_PROJECT_LOCAL: 'projects:deleteLocal',
  DUPLICATE_PROJECT: 'projects:duplicate'
});

const ROLES = Object.freeze({
  OWNER: 'owner',
  EDITOR: 'editor',
  VIEWER: 'viewer'
});

const COLLECTIONS = Object.freeze({
  USERS: 'users',
  PROJECTS: 'projects',
  DOCUMENTS: 'documents'
});

module.exports = { IPC, ROLES, COLLECTIONS };
