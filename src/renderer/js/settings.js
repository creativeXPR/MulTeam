// Editor settings — persisted as one JSON blob, applied as Monaco defaults
// on open and live via updateOptions() while a file is open. Only one Monaco
// instance is ever alive at a time in this app (see shell.js), so "live" is
// a single direct call, not a loop over multiple editors.
const SETTINGS_KEY = 'multeam:editorSettings';

const DEFAULTS = {
  fontSize: 14,
  fontFamily: '"JetBrains Mono",monospace',
  tabSize: 2,
  ligatures: true,
  minimap: true,
  autosave: true,
  formatOnSave: false,
  editorTheme: '', // '' = MulTeam default; else '<extensionId>::<theme label>'
  iconTheme: ''    // '' = built-in icons;  else '<extensionId>::<icon theme id>'
};

let current = null;

export function getSettings() {
  if (current) return current;
  try {
    current = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    current = { ...DEFAULTS };
  }
  return current;
}

export function updateSettings(patch) {
  current = { ...getSettings(), ...patch };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(current));
  document.dispatchEvent(new CustomEvent('multeam:settingschange', { detail: current }));
  return current;
}

// Options object for monaco.editor.create()/updateOptions() reflecting the
// current settings.
export function monacoOptionsFromSettings() {
  const s = getSettings();
  return {
    fontSize: s.fontSize,
    fontFamily: s.fontFamily,
    tabSize: s.tabSize,
    fontLigatures: s.ligatures,
    minimap: { enabled: s.minimap, scale: 1 }
  };
}
