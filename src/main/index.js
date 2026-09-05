const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const { createMainWindow } = require('./window');
const { registerIpcHandlers } = require('./ipcHandlers');

app.whenReady().then(() => {
  // The default File/Edit/View/Window/Help menu is Electron boilerplate —
  // none of its actions (Reload, Toggle DevTools, native Zoom, ...) are
  // wired to anything this app does, and it visually clashes with the
  // custom header bar. Removing it entirely rather than rebuilding those
  // menus in-app until there's real menu-driven functionality to expose.
  Menu.setApplicationMenu(null);

  registerIpcHandlers(ipcMain);
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
