// Plugin "debug engine", static half: checks a plugin folder before it runs
// and reports problems VS Code-style ({ file, line, column, endColumn,
// severity, code, message }). Pure — no Electron — so tests can call it.
// The runtime half (console output, crashes) lives in renderer pluginHost.
const vm = require('node:vm');
const { CALLS, REGISTRATIONS, EVENTS, PERMISSIONS, REMOVED_GLOBALS, UNAVAILABLE_GLOBALS } = require('../shared/pluginApi');

const MANIFEST = 'multeam-plugin.json';
const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const NAMESPACES = new Set([...Object.keys(CALLS), ...REGISTRATIONS].map((k) => k.split('.')[0]));
const KNOWN_MEMBERS = new Set([...Object.keys(CALLS), ...REGISTRATIONS]);

// 1-based line/column of a character offset.
function position(text, offset) {
  const before = text.slice(0, Math.max(0, offset));
  const line = before.split('\n').length;
  const column = offset - before.lastIndexOf('\n');
  return { line, column };
}

// Line of the first `"key"` in a JSON text (for pointing at manifest fields).
function keyLine(text, key) {
  const i = text.indexOf(`"${key}"`);
  return i === -1 ? { line: 1, column: 1 } : position(text, i + 1);
}

// Blank out comments (keeping offsets/lines intact) so API scans don't
// trip on commented-out code. Strings are kept — event names live there.
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

function lintManifest(text, folderName, diags) {
  const d = (where, severity, code, message) => diags.push({ file: MANIFEST, ...where, severity, code, message });
  if (text == null) {
    d({ line: 1, column: 1 }, 'error', 'manifest-missing', `${MANIFEST} is missing — every plugin needs one.`);
    return null;
  }
  let m;
  try {
    m = JSON.parse(text);
  } catch (err) {
    const lc = /line (\d+) column (\d+)/.exec(err.message);
    const pos = /position (\d+)/.exec(err.message);
    const where = lc ? { line: +lc[1], column: +lc[2] } : pos ? position(text, +pos[1]) : { line: 1, column: 1 };
    d(where, 'error', 'manifest-json', `Invalid JSON: ${err.message.replace(/ in JSON at position \d+.*$/, '')}`);
    return null;
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) {
    d({ line: 1, column: 1 }, 'error', 'manifest-shape', `${MANIFEST} must be a JSON object.`);
    return null;
  }

  const id = m.id || folderName;
  if (!ID_RE.test(id || '')) d(keyLine(text, 'id'), 'error', 'manifest-id', `Plugin id "${id}" must be 2–64 lowercase letters, digits or dashes.`);
  else if (m.id && folderName && m.id !== folderName) {
    d(keyLine(text, 'id'), 'error', 'manifest-id-folder', `The id is "${m.id}" but the plugin folder is "${folderName}". MulTeam finds plugins by folder — keep them the same (change the id by creating a new plugin).`);
  }
  if (!m.name) d(keyLine(text, 'name'), 'error', 'manifest-name', 'Manifest needs a "name" — it’s what users see.');
  if (!m.version) d({ line: 1, column: 1 }, 'warning', 'manifest-version', 'Add a "version" (e.g. "0.1.0") — the gallery needs one to publish updates.');
  else if (!/^\d+\.\d+\.\d+([-.+][\w.-]+)?$/.test(String(m.version))) d(keyLine(text, 'version'), 'warning', 'manifest-version', `"${m.version}" isn’t a semantic version like 1.2.3.`);
  if (!m.description) d({ line: 1, column: 1 }, 'info', 'manifest-description', 'Add a short "description" — it shows on the plugin card and in the gallery.');

  const main = m.main || 'main.js';
  if (String(main).includes('..') || /^([a-zA-Z]:|[\\/])/.test(String(main))) {
    d(keyLine(text, 'main'), 'error', 'manifest-main', '"main" must be a file inside the plugin folder.');
  }
  if (m.permissions !== undefined && !Array.isArray(m.permissions)) {
    d(keyLine(text, 'permissions'), 'error', 'manifest-permissions', '"permissions" must be a list, e.g. ["editor"].');
  }
  const permissions = Array.isArray(m.permissions) ? m.permissions : [];
  for (const p of permissions) {
    if (!PERMISSIONS.includes(p)) d(keyLine(text, 'permissions'), 'error', 'manifest-permission-unknown', `Unknown permission "${p}". Allowed: ${PERMISSIONS.join(', ')}.`);
  }
  return { main, permissions };
}

// Compiles (never runs) the plugin exactly as the host wraps it, so syntax
// errors land on the plugin's own line numbers.
function lintSyntax(code, file, diags) {
  try {
    new vm.Script(`(() => {\n${code}\n})();`, { filename: file });
    return true;
  } catch (err) {
    const lines = String(err.stack || '').split('\n');
    const at = new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+)`).exec(lines[0] || '');
    const caret = lines.findIndex((l) => /^\s*\^+\s*$/.test(l));
    const line = at ? Math.max(1, +at[1] - 1) : 1; // -1: the wrapper's first line
    const column = caret > 0 ? lines[caret].indexOf('^') + 1 : 1;
    diags.push({ file, line, column, severity: 'error', code: 'syntax', message: `Syntax error: ${err.message}` });
    return false;
  }
}

function lintApi(code, file, permissions, diags) {
  const src = stripComments(code);
  const usedPermissions = new Set();
  let registersSomething = false;

  // multeam.<ns>.<member>  /  multeam.<name>
  const re = /\bmulteam\s*\.\s*([A-Za-z_$][\w$]*)(?:\s*\.\s*([A-Za-z_$][\w$]*))?/g;
  for (let m; (m = re.exec(src)); ) {
    const [, ns, member] = m;
    const where = position(src, m.index);
    if (ns === 'on') { registersSomething = true; continue; }
    if (!NAMESPACES.has(ns)) {
      diags.push({ file, ...where, endColumn: where.column + m[0].length, severity: 'error', code: 'api-unknown', message: `multeam.${ns} doesn’t exist. Available: ${[...NAMESPACES, 'on'].map((n) => `multeam.${n}`).join(', ')}.` });
      continue;
    }
    if (!member) continue; // e.g. `const { editor } = multeam` — fine
    const key = `${ns}.${member}`;
    if (!KNOWN_MEMBERS.has(key)) {
      const options = [...KNOWN_MEMBERS].filter((k) => k.startsWith(`${ns}.`)).map((k) => k.split('.')[1]);
      diags.push({ file, ...where, endColumn: where.column + m[0].length, severity: 'error', code: 'api-unknown', message: `multeam.${key} doesn’t exist. multeam.${ns} has: ${options.join(', ')}.` });
      continue;
    }
    if (REGISTRATIONS.includes(key) || key === 'window.setStatus') registersSomething = true;
    const need = CALLS[key];
    if (need) {
      usedPermissions.add(need);
      if (!permissions.includes(need)) {
        diags.push({ file, ...where, endColumn: where.column + m[0].length, severity: 'error', code: 'permission-missing', message: `multeam.${key} needs the "${need}" permission — add it to "permissions" in ${MANIFEST}.` });
      }
    }
  }

  // multeam.on('event', …) with an event the host never sends
  const onRe = /\bmulteam\s*\.\s*on\s*\(\s*(['"`])([^'"`]*)\1/g;
  for (let m; (m = onRe.exec(src)); ) {
    if (!EVENTS.includes(m[2])) {
      diags.push({ file, ...position(src, m.index), severity: 'warning', code: 'event-unknown', message: `MulTeam never sends a "${m[2]}" event, so this listener won’t run. Events: ${EVENTS.join(', ')}.` });
    }
  }

  // globals the sandbox removes / never had
  for (const name of REMOVED_GLOBALS) {
    const g = new RegExp(`(?<![\\w$.])${name}\\b`, 'g');
    for (let m; (m = g.exec(src)); ) {
      diags.push({ file, ...position(src, m.index), endColumn: position(src, m.index).column + name.length, severity: 'warning', code: 'sandbox', message: `${name} is removed inside the plugin sandbox — plugins can’t reach the network.` });
    }
  }
  for (const name of UNAVAILABLE_GLOBALS) {
    const g = new RegExp(`(?<![\\w$.])${name}\\b(?!\\s*:)`, 'g');
    for (let m; (m = g.exec(src)); ) {
      // allow declaring your own variable with that name
      const before = src.slice(Math.max(0, m.index - 12), m.index);
      if (/\b(const|let|var|function)\s+$/.test(before)) continue;
      diags.push({ file, ...position(src, m.index), endColumn: position(src, m.index).column + name.length, severity: 'warning', code: 'sandbox', message: `${name} isn’t available — plugins run in a Web Worker (no Node, no DOM). Use the multeam API instead.` });
    }
  }

  return { usedPermissions, registersSomething };
}

// files: { [relativeName]: text | null }. Returns diagnostics, most severe first.
function lintPlugin({ manifestText, folderName, readFile }) {
  const diags = [];
  const manifest = lintManifest(manifestText, folderName, diags);
  if (!manifest) return sort(diags);

  const code = readFile(manifest.main);
  if (code == null) {
    diags.push({ file: MANIFEST, ...keyLine(manifestText, 'main'), severity: 'error', code: 'main-missing', message: `The entry file "${manifest.main}" doesn’t exist.` });
    return sort(diags);
  }
  if (!lintSyntax(code, manifest.main, diags)) return sort(diags);

  const { usedPermissions, registersSomething } = lintApi(code, manifest.main, manifest.permissions, diags);
  for (const p of manifest.permissions) {
    if (PERMISSIONS.includes(p) && !usedPermissions.has(p)) {
      diags.push({ file: MANIFEST, ...keyLine(manifestText, 'permissions'), severity: 'warning', code: 'permission-unused', message: `"${p}" is declared but never used — remove it so people aren’t asked for access you don’t need.` });
    }
  }
  if (!registersSomething && code.trim()) {
    diags.push({ file: manifest.main, line: 1, column: 1, severity: 'info', code: 'nothing-registered', message: 'This plugin doesn’t register a command, listener, status item or completions, so nothing will trigger it.' });
  }
  return sort(diags);
}

const RANK = { error: 0, warning: 1, info: 2 };
function sort(diags) {
  return diags.sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
}

module.exports = { lintPlugin, MANIFEST };
