const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { startRendererServer } = require('./server');

// The app's navbar doubles as the window title bar (VS Code style): the
// native frame is hidden and the OS draws only the min/max/close controls
// on top of it. Colors mirror --bg / --text-2 in renderer/css/style.css.
const TITLEBAR_HEIGHT = 35; // same as VS Code; matches --nav-h in style.css
const TITLEBAR_COLORS = {
  light: { color: '#fbfcff', symbolColor: '#000000a6' },
  dark: { color: '#0e0f13', symbolColor: '#ffffffb3' }
};

// Ctrl +/-/0 zoom. The app menu (which normally provides these
// accelerators) is removed in index.js, so they're handled here instead —
// in before-input-event, so they still work while Monaco has focus.
const ZOOM_MIN = -3;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.5;
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');

let currentTheme = 'light';
let customOverlay = null; // { color, symbolColor } from an active color theme

function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return {}; }
}

function writeState(patch) {
  try { fs.writeFileSync(stateFile(), JSON.stringify({ ...readState(), ...patch })); } catch { /* non-fatal */ }
}

// The overlay height is in device-independent px and doesn't follow page
// zoom, so it's rescaled to stay level with the (zoomed) CSS navbar.
function titleBarOverlayFor(theme, zoomFactor = 1) {
  if (theme && theme !== currentTheme) {
    currentTheme = theme;
    writeState({ theme }); // so the next launch opens in the right colors
  }
  return {
    ...(customOverlay || TITLEBAR_COLORS[currentTheme] || TITLEBAR_COLORS.light),
    height: Math.round(TITLEBAR_HEIGHT * zoomFactor)
  };
}

// A color theme's own title-bar colors (null = MulTeam's light/dark pair).
const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;
function setCustomOverlay(custom) {
  customOverlay = custom && HEX.test(custom.color) && HEX.test(custom.symbolColor)
    ? { color: custom.color.slice(0, 7), symbolColor: custom.symbolColor.slice(0, 7) }
    : null;
  writeState({ customOverlay });
}

function applyZoom(win, level) {
  const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, level));
  win.webContents.setZoomLevel(clamped);
  if (process.platform !== 'darwin') {
    win.setTitleBarOverlay(titleBarOverlayFor(null, win.webContents.getZoomFactor()));
  }
  writeState({ zoomLevel: clamped });
}

// 'in' | 'out' | 'reset' — shared by the keyboard shortcuts and View menu.
function zoom(win, action) {
  const current = win.webContents.getZoomLevel();
  if (action === 'in') applyZoom(win, current + ZOOM_STEP);
  else if (action === 'out') applyZoom(win, current - ZOOM_STEP);
  else applyZoom(win, 0);
}

function wireZoomShortcuts(win) {
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return;
    // '=' / '+' cover both the main row (with or without Shift) and numpad.
    if (input.key === '=' || input.key === '+') zoom(win, 'in');
    else if (input.key === '-' || input.key === '_') zoom(win, 'out');
    else if (input.key === '0') zoom(win, 'reset');
    else return;
    event.preventDefault();
  });
}

async function createMainWindow() {
  const rendererRoot = path.join(__dirname, '..', 'renderer');
  const server = await startRendererServer(rendererRoot, {
    'ext-assets': path.join(app.getPath('userData'), 'extensions')
  });
  const { port } = server.address();

  // Start in the last-used theme so the frame/background don't flash light
  // before the renderer applies its stored theme.
  currentTheme = TITLEBAR_COLORS[readState().theme] ? readState().theme : 'light';
  customOverlay = readState().customOverlay || null;

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: (customOverlay || TITLEBAR_COLORS[currentTheme]).color,
    // Generated from public/logo-1024.png by `npm run icons`.
    icon: path.join(__dirname, '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    titleBarStyle: 'hidden',
    // macOS keeps its traffic lights; Windows/Linux get overlay controls.
    titleBarOverlay: process.platform === 'darwin' ? true : titleBarOverlayFor(currentTheme),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'dist', 'bridge.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Read by the preload as a fallback when localStorage has no theme yet.
      additionalArguments: [`--multeam-theme=${currentTheme}`]
    }
  });

  wireZoomShortcuts(win);
  // Zoom is per-origin in Chromium and the renderer's localhost port changes
  // every launch, so the saved level is re-applied on each load.
  win.webContents.on('did-finish-load', () => applyZoom(win, readState().zoomLevel || 0));

  win.loadURL(`http://localhost:${port}/app.html`);
  win.on('closed', () => server.close());

  return win;
}

module.exports = { createMainWindow, titleBarOverlayFor, setCustomOverlay, zoom };
