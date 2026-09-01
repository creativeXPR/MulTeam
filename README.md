## Installation

Install Electron as a dev dependency:

```bash
npm init -y
npm install electron -D
```

## Electron Guide: From Zero to Shipped App

Everything below assumes the install step above is done. Work through it top to bottom the first time; use it as a reference after that.

### 1. What Electron actually is

Electron packages a Chromium browser and a Node.js runtime together into one executable. That's the whole trick: your UI is a web page (HTML/CSS/JS), and because Node is available alongside it, that "web page" can read files, spawn processes, open native dialogs, and do anything a desktop app can do — things a page in a normal browser is sandboxed away from.

Every Electron app has two kinds of process:

| | Main process | Renderer process |
|---|---|---|
| What it is | A regular Node.js process | A Chromium browser window |
| How many | Exactly one | One per `BrowserWindow` you open |
| What it can do | Full Node/OS access — filesystem, native menus, windows, tray icons, app lifecycle | Runs your HTML/CSS/JS UI, like a browser tab |
| Entry point | `main.js` (whatever `"main"` in `package.json` points to) | The HTML file loaded into a `BrowserWindow` |

The renderer does **not** get Node access by default in modern Electron — that's a deliberate security boundary. When the UI needs something only Node/the OS can do (save a file, read a config, hit a native API), it asks the main process to do it via **IPC** (inter-process communication), through a **preload script** that exposes a narrow, safe API. That pattern is section 4 below — it's the one thing worth understanding well before writing real features.

### 2. Project structure

This project keeps `main.js` as the only hand-written file at the root — everything else you author lives under `src/`. `package.json` and `node_modules` stay at the root regardless, since npm and Electron require them there.

```
MulTeam/
├── main.js            # Main process entry point (app lifecycle, windows)
├── src/
│   ├── preload.js      # Bridges main <-> renderer safely
│   ├── index.html       # Renderer UI
│   └── renderer.js      # Renderer-side JS (runs inside the page)
└── package.json
```

As the app grows, this can split further into `src/main/` for main-process modules and `src/renderer/` for UI code, but for a single window app the layout above is fine.

### 3. Your first window

**`main.js`**

```js
const { app, BrowserWindow } = require('electron')
const path = require('node:path')

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'src', 'preload.js'),
      contextIsolation: true, // keep the renderer's JS world separate from Node's
      nodeIntegration: false  // never give the renderer direct Node access
    }
  })

  win.loadFile('src/index.html')
}

// Windows/Linux/most-OSes lifecycle: app is ready -> open a window
app.whenReady().then(() => {
  createWindow()

  // macOS convention: re-create a window when the dock icon is clicked
  // and there are no other windows open
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS where apps
// conventionally stay running until the user quits with Cmd+Q
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
```

**`index.html`**

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title>MulTeam</title>
  </head>
  <body>
    <h1>Hello from Electron</h1>
    <p id="version"></p>
    <script src="renderer.js"></script>
  </body>
</html>
```

**`src/preload.js`** (can start empty — filled in below)

```js
// Runs before the renderer loads, with access to a limited, safe set of APIs.
```

Run it:

```bash
npm start
```

### 4. Talking between processes: preload + IPC

Never turn on `nodeIntegration: true` to make things "easier" — it hands a webpage full Node access, which is a serious security hole the moment your app loads any remote content (or a dependency does). The correct pattern is `contextBridge` + IPC.

**`src/preload.js`** — expose only what the UI actually needs:

```js
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
  openFile: () => ipcRenderer.invoke('dialog:open-file')
})
```

**`main.js`** — handle those requests:

```js
const { app, ipcMain, dialog } = require('electron')

ipcMain.handle('app:get-version', () => app.getVersion())

ipcMain.handle('dialog:open-file', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({ properties: ['openFile'] })
  return canceled ? null : filePaths[0]
})
```

**`src/renderer.js`** — the UI calls the exposed API, never `require('electron')` directly:

```js
window.api.getAppVersion().then((version) => {
  document.getElementById('version').textContent = version
})
```

(A top-level `await` here would need the script tag to be `type="module"` — the `.then()` form works either way.)

`ipcRenderer.invoke` / `ipcMain.handle` gives you a promise-based request/response — use this for almost everything. Reach for the fire-and-forget `ipcRenderer.send` / `ipcMain.on` only for one-way notifications where you don't need a reply.

### 5. Common native features

```js
const { Menu, Tray, Notification, shell, dialog } = require('electron')

// Native menu bar
Menu.setApplicationMenu(Menu.buildFromTemplate([
  { label: 'File', submenu: [{ role: 'quit' }] }
]))

// System tray icon
const tray = new Tray('icon.png')
tray.setToolTip('MulTeam')

// OS notification
new Notification({ title: 'MulTeam', body: 'Task complete' }).show()

// Open a link in the user's default browser (not inside your app window)
shell.openExternal('https://example.com')

// Native save/open dialogs
dialog.showSaveDialog({ defaultPath: 'export.json' })
```

### 6. Dev workflow & debugging

- Open the renderer's DevTools programmatically: `win.webContents.openDevTools()`.
- Main-process code is just Node — debug it with `node --inspect` flags via `electron --inspect=5858 .`, or attach your editor's Node debugger.
- Auto-reload on file changes during development: `electron-reload` or run through `electron-forge`'s dev server (see packaging below) — plain `electron .` does not watch files for you.
- Log main-process output to the same terminal you launched `npm start` from; renderer `console.log` goes to the DevTools console, not your terminal.

### 7. Packaging & distribution

`electron .` only runs the app from source — it doesn't produce something you can hand to someone else. For that, use **electron-builder** (most common) or **Electron Forge** (official, more scaffolding-heavy).

```bash
npm install electron-builder -D
```

Add to `package.json`:

```json
{
  "scripts": {
    "dist": "electron-builder"
  },
  "build": {
    "appId": "com.example.multeam",
    "win": { "target": "nsis" },
    "mac": { "target": "dmg" },
    "linux": { "target": "AppImage" }
  }
}
```

```bash
npm run dist
```

This produces a platform-specific installer/binary in `dist/`. Note that electron-builder cross-compiles best when run on the target OS (or via CI matrix builds) — building a `.dmg` from Windows, for example, isn't supported.

### 8. Auto-updates

For apps distributed outside an app store, [`electron-updater`](https://www.electron.build/auto-update) (ships alongside electron-builder) checks a hosted release feed (e.g. GitHub Releases) and downloads/applies updates in the background. It needs a code-signed build to work reliably on Windows/macOS — unsigned auto-updates are unreliable and, on macOS, blocked outright.

### 9. Security checklist

Electron's own docs treat this as required reading, not optional — worth internalizing:

- `contextIsolation: true` and `nodeIntegration: false` on every `BrowserWindow` (Electron ≥ 20 defaults to this — don't override it).
- Never load remote/untrusted URLs into a window that has Node access.
- Validate and whitelist every IPC channel in `src/preload.js` — don't expose `ipcRenderer` wholesale via `contextBridge`.
- Set a `Content-Security-Policy` on your HTML if the renderer ever loads remote content.
- Keep Electron itself up to date — security fixes for the underlying Chromium ship with new Electron versions, not independently.

### 10. Where to go next

- Official docs: https://www.electronjs.org/docs/latest/
- API reference (the thing you'll actually search most often): https://www.electronjs.org/docs/latest/api/app
- electron-builder: https://www.electron.build/
- Electron Forge: https://www.electronforge.io/