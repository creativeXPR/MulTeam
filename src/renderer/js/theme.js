// Theme + accent color. Light is the default (:root in style.css needs no
// attribute), dark is opt-in via [data-theme="dark"]. The accent rewrites
// the --violet-* vars, which the minimalist design uses only for actions,
// selection and active states.
//
// An installed VS Code color theme recolors the WHOLE app through an "app
// palette": its UI colors are mapped onto MulTeam's design tokens (see
// extensions.js#toAppPalette) and set on :root, overriding light/dark.
const THEME_KEY = 'multeam:theme';
const ACCENT_KEY = 'multeam:accent';
const PALETTE_KEY = 'multeam:palette';
const PALETTE_VARS = ['--bg', '--surface', '--line', '--line-soft', '--fill', '--fill-2', '--text', '--text-2', '--muted',
  '--danger', '--warn', '--success', '--scrim', '--shadow', '--shadow-float'];

let palette = null; // { mode: 'light'|'dark', vars: {…}, accent, titleBar: { color, symbolColor } }

export function getTheme() {
  return localStorage.getItem(THEME_KEY) || window.electronAPI?.savedTheme || 'light';
}

// The mode actually on screen: the color theme's when one is active.
export function getEffectiveTheme() {
  return palette ? palette.mode : getTheme();
}

// The navbar is the window title bar; the OS-drawn min/max/close controls
// over it are re-tinted by the main process to match.
function syncTitleBar(theme, custom = null) {
  window.electronAPI?.setTitleBarTheme?.(theme, custom);
}

function emitChange() {
  document.dispatchEvent(new CustomEvent('multeam:themechange', { detail: { theme: getEffectiveTheme() } }));
}

// MulTeam's own light/dark preference. While a color theme is active the
// preference is stored but the theme keeps control of what's on screen.
export function setTheme(theme) {
  localStorage.setItem(THEME_KEY, theme);
  if (!palette) {
    document.documentElement.dataset.theme = theme;
    syncTitleBar(theme);
  }
  emitChange();
}

export function toggleTheme() {
  setTheme(getTheme() === 'dark' ? 'light' : 'dark');
}

function shade(hex, pct) {
  const n = parseInt(hex.slice(1, 7), 16);
  const f = (v) => Math.max(0, Math.min(255, Math.round(v + (pct / 100) * 255)));
  return '#' + [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => f(v).toString(16).padStart(2, '0')).join('');
}

export function getAccent() {
  return localStorage.getItem(ACCENT_KEY) || '#6D4AFF';
}

function applyAccentVars(hex) {
  const root = document.documentElement.style;
  root.setProperty('--violet-500', hex);
  root.setProperty('--violet-600', shade(hex, -22));
  root.setProperty('--violet-400', shade(hex, 16));
  root.setProperty('--violet-300', shade(hex, 38));
}

export function setAccent(hex) {
  localStorage.setItem(ACCENT_KEY, hex);
  if (!palette) applyAccentVars(hex); // a color theme brings its own accent
}

// ---------- app palette (whole-app color themes) ----------
function applyPaletteNow(p) {
  const st = document.documentElement.style;
  for (const v of PALETTE_VARS) st.removeProperty(v);
  for (const [k, v] of Object.entries(p.vars || {})) if (PALETTE_VARS.includes(k) && v) st.setProperty(k, v);
  document.documentElement.dataset.theme = p.mode;
  if (p.accent) applyAccentVars(p.accent);
  syncTitleBar(p.mode, p.titleBar || null);
}

export function hasAppPalette() { return !!palette; }

export function setAppPalette(p, { persist = true } = {}) {
  palette = p;
  applyPaletteNow(p);
  if (persist) { try { localStorage.setItem(PALETTE_KEY, JSON.stringify(p)); } catch { /* non-fatal */ } }
  emitChange();
}

export function clearAppPalette({ persist = true } = {}) {
  const st = document.documentElement.style;
  for (const v of PALETTE_VARS) st.removeProperty(v);
  palette = null;
  document.documentElement.dataset.theme = getTheme();
  applyAccentVars(getAccent());
  syncTitleBar(getTheme());
  if (persist) { try { localStorage.removeItem(PALETTE_KEY); } catch { /* non-fatal */ } }
  emitChange();
}

// Call once at the very top of each page's entry script, before any DOM
// that depends on theme colors is meaningfully visible.
export function applyStoredTheme() {
  document.documentElement.dataset.theme = getTheme();
  applyAccentVars(getAccent());
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(PALETTE_KEY) || 'null'); } catch { /* ignore */ }
  if (saved && saved.vars) { palette = saved; applyPaletteNow(saved); }
  else syncTitleBar(getTheme());
}
