// MulTeam's own plugin system — storage side. A plugin is a folder with a
// `multeam-plugin.json` manifest and a JS entry file. Plugins live in
// <userData>/plugins/<id>/ and RUN in the renderer inside a sandboxed Web
// Worker (renderer/js/pluginHost.js); this module only lists, installs,
// scaffolds and removes them, and hands their code over.
const { app, dialog, shell, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');

const MANIFEST = 'multeam-plugin.json';
const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const KNOWN_PERMISSIONS = new Set(['editor', 'workspace.read', 'workspace.write']);

const pluginsRoot = () => path.join(app.getPath('userData'), 'plugins');
const stateFile = () => path.join(pluginsRoot(), 'state.json');

async function readState() {
  try { return JSON.parse(await fs.readFile(stateFile(), 'utf8')); } catch { return { disabled: [] }; }
}
async function writeState(state) {
  await fs.mkdir(pluginsRoot(), { recursive: true });
  await fs.writeFile(stateFile(), JSON.stringify(state, null, 2));
}

// Validates a manifest; returns a normalized copy or throws a readable error.
function validateManifest(m, folderName) {
  if (!m || typeof m !== 'object') throw new Error(`${MANIFEST} is not a JSON object.`);
  const id = m.id || folderName;
  if (!ID_RE.test(id || '')) throw new Error(`Plugin id "${id}" must be 2–64 lowercase letters, digits or dashes.`);
  if (!m.name) throw new Error('Manifest needs a "name".');
  const main = m.main || 'main.js';
  if (main.includes('..') || path.isAbsolute(main)) throw new Error('"main" must be a file inside the plugin folder.');
  const permissions = Array.isArray(m.permissions) ? m.permissions : [];
  const unknown = permissions.filter((p) => !KNOWN_PERMISSIONS.has(p));
  if (unknown.length) throw new Error(`Unknown permission(s): ${unknown.join(', ')}. Allowed: ${[...KNOWN_PERMISSIONS].join(', ')}.`);
  return {
    id,
    name: String(m.name),
    version: String(m.version || '0.0.0'),
    description: String(m.description || ''),
    author: String(m.author || ''),
    main,
    permissions
  };
}

async function readPlugin(dir) {
  const manifest = JSON.parse(await fs.readFile(path.join(dir, MANIFEST), 'utf8'));
  return validateManifest(manifest, path.basename(dir));
}

async function list() {
  await fs.mkdir(pluginsRoot(), { recursive: true });
  const state = await readState();
  const out = [];
  for (const e of await fs.readdir(pluginsRoot(), { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const dir = path.join(pluginsRoot(), e.name);
    try {
      const p = await readPlugin(dir);
      out.push({ ...p, dir, enabled: !state.disabled.includes(p.id), error: null });
    } catch (err) {
      out.push({ id: e.name, name: e.name, version: '', description: '', permissions: [], dir, enabled: false, error: err.message });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function readCode(id) {
  if (!ID_RE.test(id)) throw new Error('Invalid plugin id.');
  const dir = path.join(pluginsRoot(), id);
  const p = await readPlugin(dir);
  const file = path.resolve(dir, p.main);
  if (!file.startsWith(dir + path.sep)) throw new Error('Invalid entry file.');
  return fs.readFile(file, 'utf8');
}

async function installFromFolder(event) {
  const win = BrowserWindow.fromWebContents(event.sender);
  const pick = await dialog.showOpenDialog(win, { title: 'Choose a MulTeam plugin folder', properties: ['openDirectory'] });
  if (pick.canceled || !pick.filePaths[0]) return null;
  const src = pick.filePaths[0];
  if (!fsSync.existsSync(path.join(src, MANIFEST))) throw new Error(`That folder has no ${MANIFEST}.`);
  const p = await readPlugin(src);
  const dest = path.join(pluginsRoot(), p.id);
  if (path.resolve(src) === path.resolve(dest)) return p;
  await fs.rm(dest, { recursive: true, force: true });
  await fs.cp(src, dest, { recursive: true, filter: (f) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(f) });
  return p;
}

async function uninstall(id) {
  if (!ID_RE.test(id)) throw new Error('Invalid plugin id.');
  await fs.rm(path.join(pluginsRoot(), id), { recursive: true, force: true });
  const state = await readState();
  state.disabled = state.disabled.filter((x) => x !== id);
  await writeState(state);
}

async function setEnabled(id, enabled) {
  const state = await readState();
  state.disabled = state.disabled.filter((x) => x !== id);
  if (!enabled) state.disabled.push(id);
  await writeState(state);
}

// Writes a small, working example plugin the user can edit.
async function scaffold(name) {
  const id = String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'my-plugin';
  if (!ID_RE.test(id)) throw new Error('Pick a name with letters or digits.');
  const dir = path.join(pluginsRoot(), id);
  if (fsSync.existsSync(dir)) throw new Error(`A plugin called "${id}" already exists.`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, MANIFEST), JSON.stringify({
    id,
    name: String(name).trim(),
    version: '0.1.0',
    description: 'My first MulTeam plugin.',
    main: 'main.js',
    permissions: ['editor']
  }, null, 2) + '\n');
  await fs.writeFile(path.join(dir, 'main.js'), SAMPLE_MAIN);
  await fs.writeFile(path.join(dir, 'README.md'), SAMPLE_README.replace(/\{name\}/g, String(name).trim()));
  return { id, dir };
}

const SAMPLE_MAIN = `// A MulTeam plugin runs in a sandboxed worker. Everything goes through the
// global \`multeam\` API (see README.md). Edit this file, then press Reload
// on the plugin in the Extensions view.

// 1) A command — shows up in the command palette (Ctrl+K).
multeam.commands.register('sayHello', 'Say hello', async () => {
  const name = await multeam.window.showInput({ title: 'Say hello', label: 'Your name' });
  if (name) multeam.window.showMessage(\`Hello, \${name}! 👋\`);
});

// 2) A command that edits the code (needs the "editor" permission).
multeam.commands.register('upperCase', 'Make selection UPPERCASE', async () => {
  const text = await multeam.editor.getSelectedText();
  if (!text) return multeam.window.showError('Select some text first.');
  await multeam.editor.replaceSelection(text.toUpperCase());
});

// 3) A live status item in the footer — word count of the open file.
async function updateWordCount() {
  const text = await multeam.editor.getText();
  const words = text ? (text.match(/\\S+/g) || []).length : 0;
  multeam.window.setStatus(text === null ? '' : \`\${words} words\`);
}
multeam.on('open', updateWordCount);
multeam.on('save', updateWordCount);
updateWordCount();

// 4) Completions — type "todo" in a JavaScript file.
multeam.languages.registerCompletions('javascript', () => [
  { label: 'todo', insertText: '// TODO(\${1:me}): \${2:describe}', detail: 'TODO comment' }
]);
`;

const SAMPLE_README = `# {name}

A MulTeam plugin. Files:

- \`multeam-plugin.json\` — manifest: \`id\`, \`name\`, \`version\`, \`description\`, \`main\`, \`permissions\`
- \`main.js\` — runs in a sandboxed Web Worker with a global \`multeam\` object

## Permissions

| permission        | unlocks |
|-------------------|---------|
| \`editor\`          | \`multeam.editor.*\` — read/insert/replace text in the open file |
| \`workspace.read\`  | \`multeam.workspace.getRoot / listFiles / readFile\` |
| \`workspace.write\` | \`multeam.workspace.writeFile\` |

Commands, messages, input prompts, the status item, completions and events need no permission.

## API

\`\`\`js
multeam.commands.register(id, title, handler)        // appears in Ctrl+K as "{name}: title"
multeam.window.showMessage(text) / showError(text)
await multeam.window.showInput({ title, label, placeholder, value })  // string | null
multeam.window.setStatus(text)                        // footer text ('' hides it)

await multeam.editor.getText()          // string, or null when no file is open
await multeam.editor.getSelectedText()
await multeam.editor.replaceSelection(text)
await multeam.editor.insertText(text)   // at the cursor
await multeam.editor.getFile()          // { path, language } | null

await multeam.workspace.getRoot()       // project folder | null
await multeam.workspace.listFiles()     // relative paths
await multeam.workspace.readFile(relativePath)
await multeam.workspace.writeFile(relativePath, text)

multeam.languages.registerCompletions(languageId, (ctx) => [
  { label, insertText, detail }        // insertText may use $1 / \${1:placeholder}
])

multeam.on('open', ({ path, language }) => {})
multeam.on('save', ({ path }) => {})
\`\`\`
`;

function setupPluginHandlers(ipcMain, IPC) {
  ipcMain.handle(IPC.PLUGIN_LIST, () => list());
  ipcMain.handle(IPC.PLUGIN_CODE, (_e, id) => readCode(id));
  ipcMain.handle(IPC.PLUGIN_INSTALL_FOLDER, (e) => installFromFolder(e));
  ipcMain.handle(IPC.PLUGIN_UNINSTALL, (_e, id) => uninstall(id));
  ipcMain.handle(IPC.PLUGIN_SET_ENABLED, (_e, id, enabled) => setEnabled(id, enabled));
  ipcMain.handle(IPC.PLUGIN_SCAFFOLD, (_e, name) => scaffold(name));
  ipcMain.handle(IPC.PLUGIN_OPEN_FOLDER, async (_e, id) => {
    if (!ID_RE.test(id)) throw new Error('Invalid plugin id.');
    const err = await shell.openPath(path.join(pluginsRoot(), id));
    if (err) throw new Error(err);
  });
}

module.exports = { setupPluginHandlers };
