// Theme + accent color. Light is the default (:root in style.css needs no
// attribute), dark is opt-in via [data-theme="dark"]. The accent rewrites
// the --violet-* vars, which the minimalist design uses only for actions,
// selection and active states.
const THEME_KEY = 'multeam:theme';
const ACCENT_KEY = 'multeam:accent';

export function getTheme() {
  return localStorage.getItem(THEME_KEY) || window.electronAPI?.savedTheme || 'light';
}

// The navbar is the window title bar; the OS-drawn min/max/close controls
// over it are re-tinted by the main process to match.
function syncTitleBar(theme) {
  window.electronAPI?.setTitleBarTheme?.(theme);
}

export function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  syncTitleBar(theme);
  localStorage.setItem(THEME_KEY, theme);
  document.dispatchEvent(new CustomEvent('multeam:themechange', { detail: { theme } }));
}

export function toggleTheme() {
  setTheme(getTheme() === 'dark' ? 'light' : 'dark');
}

function shade(hex, pct) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => Math.max(0, Math.min(255, Math.round(v + (pct / 100) * 255)));
  return '#' + [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => f(v).toString(16).padStart(2, '0')).join('');
}

export function getAccent() {
  return localStorage.getItem(ACCENT_KEY) || '#6D4AFF';
}

export function setAccent(hex) {
  const root = document.documentElement.style;
  root.setProperty('--violet-500', hex);
  root.setProperty('--violet-600', shade(hex, -22));
  root.setProperty('--violet-400', shade(hex, 16));
  root.setProperty('--violet-300', shade(hex, 38));
  localStorage.setItem(ACCENT_KEY, hex);
}

// Call once at the very top of each page's entry script, before any DOM
// that depends on theme colors is meaningfully visible.
export function applyStoredTheme() {
  document.documentElement.dataset.theme = getTheme();
  syncTitleBar(getTheme());
  const accent = localStorage.getItem(ACCENT_KEY);
  if (accent) setAccent(accent);
}
