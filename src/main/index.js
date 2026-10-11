const { app, BrowserWindow, ipcMain, Menu, session } = require('electron');
const { createMainWindow } = require('./window');
const { registerIpcHandlers } = require('./ipcHandlers');
const { killAllTerminals } = require('./terminal');
const { stopAllLanguageServers } = require('./languages');

// One running copy only (like VS Code). A second copy couldn't get the
// renderer's fixed port, would land on a different origin, and so would see
// none of the saved settings or the Firebase sign-in. Launching again just
// brings the existing window forward.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.whenReady().then(() => {
    // The default File/Edit/View/Window/Help menu is Electron boilerplate —
    // the app draws its own menu bar in the title bar (renderer/menubar.js).
    Menu.setApplicationMenu(null);

    registerIpcHandlers(ipcMain);
    createMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on('before-quit', () => {
    killAllTerminals();
    stopAllLanguageServers();
    // Chromium commits localStorage lazily; without this, a setting changed
    // just before quitting (theme, editor theme, panel sizes…) can be lost.
    session.defaultSession.flushStorageData();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
