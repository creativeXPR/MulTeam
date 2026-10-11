// Small inline SVG icon set — avoids pulling in an icon font/library for a
// handful of glyphs. Callers set these via .innerHTML (trusted, hardcoded
// strings only — never interpolate user data into them) and put untrusted
// text like filenames into a sibling node via .textContent instead.

const EXTENSION_COLORS = {
  js: '#e0b23a', jsx: '#e0b23a',
  ts: '#3b82c4', tsx: '#3b82c4',
  json: '#c77dd8',
  html: '#e8748f',
  css: '#6b4ef0',
  md: '#8b8b9b',
  py: '#3b82c4'
};

export function colorForExtension(ext) {
  return EXTENSION_COLORS[ext] || '#a29dc9';
}

export function fileIconSvg(color = '#a29dc9') {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M6 2h8l6 6v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z" fill="${color}" opacity="0.18"/>
    <path d="M6 2h8l6 6v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M14 2v6h6" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>
  </svg>`;
}

export function folderIconSvg(open = false) {
  const color = '#6b4ef0';
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z" fill="${color}" opacity="${open ? 0.28 : 0.16}"/>
    <path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>
  </svg>`;
}

export function chevronSvg() {
  return `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

export function plusIconSvg() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
  </svg>`;
}

export function newFileIconSvg() {
  return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M6 2h8l6 6v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
    <path d="M14 2v6h6" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
    <path d="M12 12v6M9 15h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
  </svg>`;
}

export function newFolderIconSvg() {
  return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
    <path d="M12 11v5M9.5 13.5h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
  </svg>`;
}

export function saveIconSvg() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
    <path d="M8 3v6h7V3M7 21v-7h10v7" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
  </svg>`;
}

export function trashIconSvg() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M4 7h16M9 7V4h6v3M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M10 11v6M14 11v6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`;
}

export function duplicateIconSvg() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="8" y="8" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.6"/>
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" stroke="currentColor" stroke-width="1.6"/>
  </svg>`;
}

export function renameIconSvg() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
    <path d="M13.5 7.5l3 3" stroke="currentColor" stroke-width="1.6"/>
  </svg>`;
}

export function copyIconSvg() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.6"/>
    <path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" stroke="currentColor" stroke-width="1.6"/>
  </svg>`;
}

export function editIconSvg() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 20h9" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19 3 20l1-4Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
  </svg>`;
}

export function searchIconSvg() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.8"/>
    <path d="M21 21l-4.3-4.3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
  </svg>`;
}

export function chevronDownIconSvg() {
  return `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

// ------------------------------------------------------------------
// File icon themes (VS Code iconTheme format, installed from Open VSX).
// extensions.js builds a resolved theme and passes it to setIconTheme();
// fileIcon()/folderIcon() fall back to the built-in glyphs when no theme
// is active or the theme has no icon for that entry.
// ------------------------------------------------------------------
let iconTheme = null; // { url(id) -> string|null, file, folder, folderExpanded, fileNames, fileExtensions, folderNames, folderNamesExpanded, languageIds, extToLang }

export function setIconTheme(theme) { iconTheme = theme; }
export function hasIconTheme() { return !!iconTheme; }

function img(id) {
  const url = id && iconTheme.url(id);
  return url ? `<img class="ti" src="${url}" alt="" draggable="false" />` : null;
}

export function fileIcon(name) {
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (!iconTheme) return fileIconSvg(colorForExtension(ext));
  const t = iconTheme;
  const lower = name.toLowerCase();
  let id = t.fileNames[lower] || t.fileNames[name];
  if (!id) {
    // longest compound extension first: "a.test.ts" -> "test.ts" -> "ts"
    const parts = lower.split('.');
    for (let i = 1; i < parts.length && !id; i++) id = t.fileExtensions[parts.slice(i).join('.')];
  }
  if (!id && ext && t.extToLang[ext]) id = t.languageIds[t.extToLang[ext]];
  return img(id) || img(t.file) || fileIconSvg(colorForExtension(ext));
}

export function folderIcon(name, open = false) {
  if (!iconTheme) return folderIconSvg(open);
  const t = iconTheme;
  const lower = String(name).toLowerCase();
  const id = open ? (t.folderNamesExpanded[lower] || t.folderExpanded || t.folder) : (t.folderNames[lower] || t.folder);
  return img(id) || folderIconSvg(open);
}
