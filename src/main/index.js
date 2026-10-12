const path = require('node:path');
const { app, BrowserWindow, ipcMain, Menu, session } = require('electron');
const { createMainWindow } = require('./window');
const { registerIpcHandlers } = require('./ipcHandlers');
const { killAllTerminals } = require('./terminal');
const { stopAllLanguageServers } = require('./languages');
const { findLink, deliverLink } = require('./links');

// multeam:// links (e.g. multeam://join/AB12-CD34 from an invite) open the
// app. In development Electron is started with the app path as an argument,
// so the OS must re-launch it that way.
if (process.defaultApp) {
  if (process.argv.length >= 2) app.setAsDefaultProtocolClient('multeam', process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient('multeam');
}
app.on('open-url', (e, url) => { e.preventDefault(); deliverLink(url); }); // macOS

// One running copy only (like VS Code). A second copy couldn't get the
// renderer's fixed port, would land on a different origin, and so would see
// none of the saved settings or the Firebase sign-in. Launching again just
// brings the existing window forward.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    deliverLink(findLink(argv)); // a multeam:// link clicked while running
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
