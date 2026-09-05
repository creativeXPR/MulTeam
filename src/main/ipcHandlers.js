const { app } = require('electron');
const { IPC } = require('../shared/constants');
const { setupFileSystemHandlers } = require('./filesystem');
const { setupProjectHandlers } = require('./projects');

function registerIpcHandlers(ipcMain) {
  ipcMain.handle(IPC.GET_APP_VERSION, () => app.getVersion());

  setupFileSystemHandlers(ipcMain);
  setupProjectHandlers(ipcMain, IPC);
}

module.exports = { registerIpcHandlers };
