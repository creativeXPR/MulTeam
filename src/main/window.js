const { BrowserWindow } = require('electron');
const path = require('node:path');
const { startRendererServer } = require('./server');

async function createMainWindow() {
  const rendererRoot = path.join(__dirname, '..', 'renderer');
  const server = await startRendererServer(rendererRoot);
  const { port } = server.address();

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'dist', 'bridge.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  win.loadURL(`http://localhost:${port}/app.html`);
  win.on('closed', () => server.close());

  return win;
}

module.exports = { createMainWindow };
