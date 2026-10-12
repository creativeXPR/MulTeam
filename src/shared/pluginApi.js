// The MulTeam plugin API surface, shared by the sandbox host
// (renderer/js/pluginHost.js — enforces permissions at call time) and the
// plugin linter (main/pluginLint.js — flags problems before you run).
// Keep this the single source of truth.

// Host calls a plugin can make → the permission each needs (null = none).
const CALLS = {
  'editor.getText': 'editor',
  'editor.getSelectedText': 'editor',
  'editor.replaceSelection': 'editor',
  'editor.insertText': 'editor',
  'editor.getFile': 'editor',
  'workspace.getRoot': 'workspace.read',
  'workspace.listFiles': 'workspace.read',
  'workspace.readFile': 'workspace.read',
  'workspace.writeFile': 'workspace.write',
  'window.showMessage': null,
  'window.showError': null,
  'window.showInput': null,
  'window.setStatus': null
};

// Registration APIs that live inside the worker (no host call, no permission).
const REGISTRATIONS = ['commands.register', 'languages.registerCompletions'];

// multeam.on(event, fn) events the host emits.
const EVENTS = ['open', 'save'];

const PERMISSIONS = ['editor', 'workspace.read', 'workspace.write'];

// Removed from the worker before plugin code runs (pluginHost BOOTSTRAP).
const REMOVED_GLOBALS = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'WebTransport'];

// Never existed in a Web Worker (Node / DOM-only) — common mistakes.
const UNAVAILABLE_GLOBALS = ['require', 'process', 'document', 'window', 'localStorage', 'sessionStorage', 'module', '__dirname'];

module.exports = { CALLS, REGISTRATIONS, EVENTS, PERMISSIONS, REMOVED_GLOBALS, UNAVAILABLE_GLOBALS };
