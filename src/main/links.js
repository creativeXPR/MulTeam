// multeam:// links (e.g. multeam://join/AB12-CD34 from an invite): the one
// that launched the app waits here until the window asks for it; links
// clicked while the app runs are pushed to the window straight away.
const { BrowserWindow } = require('electron');
const { IPC } = require('../shared/constants');

const findLink = (argv) => (argv || []).find((a) => /^multeam:\/\//i.test(a)) || null;
let pendingLink = findLink(process.argv);

function deliverLink(url) {
  if (!url) return;
  const win = BrowserWindow.getAllWindows()[0];
  if (win && !win.webContents.isLoading()) win.webContents.send(IPC.APP_OPEN_LINK, url);
  else pendingLink = url;
}

function setupLinkHandlers(ipcMain) {
  ipcMain.handle(IPC.APP_TAKE_LINK, () => { const l = pendingLink; pendingLink = null; return l; });
}

module.exports = { findLink, deliverLink, setupLinkHandlers };
