const { app, BrowserWindow } = require('electron');
const { IPC } = require('../shared/constants');
const { setupFileSystemHandlers } = require('./filesystem');
const { setupProjectHandlers } = require('./projects');
const { setupTerminalHandlers } = require('./terminal');
const { setupSearchHandlers } = require('./search');
const { setupGitHandlers } = require('./git');
const { setupExtensionHandlers } = require('./extensions');
const { setupPluginHandlers } = require('./plugins');
const { setupLanguageHandlers } = require('./languages');
const { setupToolHandlers } = require('./tools');
const { setupRunHandlers } = require('./runner');
const { setupLinkHandlers } = require('./links');
const { setupGitHubHandlers } = require('./github');
const { setupLiveBaseHandlers } = require('./liveBase');
const { titleBarOverlayFor, setCustomOverlay, zoom } = require('./window');

function registerIpcHandlers(ipcMain) {
  ipcMain.handle(IPC.GET_APP_VERSION, () => app.getVersion());

  // Re-tints the native window controls (min/max/close) drawn over the
  // custom title bar so they follow the app's light/dark theme.
  ipcMain.handle(IPC.SET_TITLEBAR_THEME, (event, theme, custom) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    setCustomOverlay(custom || null);
    if (!win || process.platform === 'darwin') return;
    win.setTitleBarOverlay(titleBarOverlayFor(theme, win.webContents.getZoomFactor()));
  });

  ipcMain.handle(IPC.WINDOW_ZOOM, (event, action) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && ['in', 'out', 'reset'].includes(action)) zoom(win, action);
  });

  setupFileSystemHandlers(ipcMain);
  setupProjectHandlers(ipcMain, IPC);
  setupTerminalHandlers(ipcMain, IPC);
  setupSearchHandlers(ipcMain, IPC);
  setupGitHandlers(ipcMain, IPC);
  setupExtensionHandlers(ipcMain, IPC);
  setupPluginHandlers(ipcMain, IPC);
  setupLanguageHandlers(ipcMain, IPC);
  setupToolHandlers(ipcMain, IPC);
  setupRunHandlers(ipcMain, IPC);
  setupLinkHandlers(ipcMain);
  setupGitHubHandlers(ipcMain, IPC);
  setupLiveBaseHandlers(ipcMain, IPC);
}

module.exports = { registerIpcHandlers };
