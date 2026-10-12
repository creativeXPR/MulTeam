// Extensions view (sidebar) + the contributions MulTeam understands today:
// VS Code color themes (applied to the Monaco editor) and snippets
// (offered as completions). Packages come from Open VSX via the main
// process (main/extensions.js).
import * as monaco from 'monaco-editor';
import { setCustomEditorTheme, setMonacoTheme } from './editor.js';
import { getTheme, getEffectiveTheme, setAppPalette, clearAppPalette, hasAppPalette } from './theme.js';
import { getSettings, updateSettings } from './settings.js';
import { setIconTheme } from './icons.js';

// tiny posix path helpers (icon paths inside an extension are relative)
function posixNormalize(p) {
  const out = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop(); else out.push(seg);
  }
  return out.join('/');
}
const posixDir = (p) => posixNormalize(p).split('/').slice(0, -1).join('/');

const ICON_FALLBACK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><path d="M17 13.5v7M13.5 17h7"/></svg>';

// VS Code language ids → Monaco language ids
const LANG_ALIAS = { javascriptreact: 'javascript', typescriptreact: 'typescript', jsonc: 'json', shellscript: 'shell', 'objective-c': 'objective-c' };

// TextMate scopes (what VS Code themes use) → Monaco's Monarch token names.
// Monaco rules match by token prefix, so a few aliases cover most languages.
// Monaco's tokenizers emit generic tokens ("keyword.js", "string.js",
// "identifier.ts"…); VS Code themes color TextMate scopes. For each Monaco
// token we name the TextMate scopes VS Code would give that text (most
// representative first) and pick the theme rule that matches best, using
// TextMate rules: a rule scope matches when it equals the scope or is a
// dot-prefix of it; the longest match wins, then the later rule.
const TOKEN_SCOPES = [
  ['comment', ['comment.line.double-slash', 'comment']],
  ['comment.doc', ['comment.block.documentation', 'comment.block', 'comment']],
  ['string', ['string.quoted.double', 'string']],
  ['string.escape', ['constant.character.escape', 'string']],
  ['string.key.json', ['support.type.property-name.json', 'support.type.property-name', 'string']],
  ['string.value.json', ['string.quoted.double.json', 'string']],
  ['regexp', ['string.regexp']],
  ['number', ['constant.numeric.decimal', 'constant.numeric']],
  ['keyword', ['storage.type', 'keyword.control', 'keyword']],
  ['keyword.flow', ['keyword.control.flow', 'keyword.control', 'keyword']],
  ['operator', ['keyword.operator']],
  ['delimiter', ['punctuation.separator', 'punctuation']],
  ['type', ['entity.name.type', 'support.type', 'entity.name.class']],
  ['type.identifier', ['entity.name.type', 'support.type', 'entity.name.class']],
  ['identifier', ['variable.other.readwrite', 'variable.other', 'variable']],
  ['variable', ['variable.other.readwrite', 'variable']],
  ['variable.predefined', ['variable.language', 'support.variable', 'variable']],
  ['variable.parameter', ['variable.parameter']],
  ['constant', ['constant.language', 'constant']],
  ['predefined', ['support.function', 'entity.name.function']],
  ['annotation', ['meta.decorator', 'entity.name.function.decorator']],
  ['metatag', ['meta.preprocessor', 'entity.name.tag']],
  ['namespace', ['entity.name.namespace', 'entity.name.type.module']],
  ['tag', ['entity.name.tag']],
  ['attribute.name', ['entity.other.attribute-name']],
  ['attribute.value', ['string.quoted.double.html', 'string']],
  ['keyword.md', ['markup.heading', 'entity.name.section']],
  ['strong', ['markup.bold']],
  ['emphasis', ['markup.italic']],
  ['invalid', ['invalid.illegal', 'invalid']]
];

// 'light' | 'dark' | 'hcLight' | 'hcDark' — from the theme file's "type", else the
// package's uiTheme (vs, vs-dark, hc-light, hc-black).
function themeKind(vs, uiTheme) {
  const t = String(vs?.type || '').toLowerCase();
  if (t === 'light' || t === 'dark') return t;
  if (t === 'hclight' || t === 'hc-light') return 'hcLight';
  if (t === 'hc' || t === 'hcdark' || t === 'hc-black') return 'hcDark';
  return { vs: 'light', 'hc-light': 'hcLight', 'hc-black': 'hcDark' }[uiTheme] || 'dark';
}
const isLightKind = (k) => k === 'light' || k === 'hcLight';

function normalizeHex(c) {
  if (typeof c !== 'string') return null;
  let h = c.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3,4}$/i.test(h)) h = [...h].map((x) => x + x).join('');
  return /^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h) ? h : null;
}

export function toMonacoTheme(vs, uiTheme) {
  const type = themeKind(vs, uiTheme);
  const base = { light: 'vs', hcLight: 'hc-light', hcDark: 'hc-black' }[type] || 'vs-dark';
  const rules = [];
  const entries = []; // { scope, fg, fontStyle, order }
  const tokenColors = Array.isArray(vs.tokenColors) ? vs.tokenColors : [];
  tokenColors.forEach((tc, order) => {
    const st = tc.settings || {};
    const fg = normalizeHex(st.foreground);
    const fontStyle = typeof st.fontStyle === 'string' ? st.fontStyle : undefined;
    if (!fg && fontStyle === undefined) return;
    const scopes = Array.isArray(tc.scope) ? tc.scope : String(tc.scope || '').split(',');
    if (!tc.scope) { if (fg) rules.push({ token: '', foreground: fg }); return; } // default foreground
    for (const raw of scopes) {
      const scope = raw.trim();
      // descendant selectors ("string variable", "source.js keyword") need a
      // scope stack Monaco doesn't have — skip them
      if (scope && !/\s/.test(scope)) entries.push({ scope, fg, fontStyle, order });
    }
  });
  const best = (target, prop) => {
    let hit = null;
    for (const e of entries) {
      if (e[prop] === undefined || e[prop] === null) continue;
      if (target !== e.scope && !target.startsWith(`${e.scope}.`)) continue;
      if (!hit || e.scope.length > hit.scope.length || (e.scope.length === hit.scope.length && e.order > hit.order)) hit = e;
    }
    return hit;
  };
  const defaultFg = rules.find((r) => r.token === '' && r.foreground)?.foreground || normalizeHex(vs.colors?.['editor.foreground']);
  for (const [token, targets] of TOKEN_SCOPES) {
    let fg = null;
    let fontStyle;
    for (const t of targets) { const h = best(t, 'fg'); if (h) { fg = h.fg; break; } }
    for (const t of targets) { const h = best(t, 'fontStyle'); if (h) { fontStyle = h.fontStyle; break; } }
    // like VS Code, text the theme doesn't color uses its default foreground
    // (never Monaco's built-in vs/vs-dark token colors)
    fg = fg || defaultFg;
    if (fg || fontStyle !== undefined) rules.push({ token, ...(fg ? { foreground: fg } : {}), ...(fontStyle !== undefined ? { fontStyle } : {}) });
  }
  const colors = {};
  for (const [k, v] of Object.entries(vs.colors || {})) {
    const hex = normalizeHex(v);
    if (hex) colors[k] = `#${hex}`;
  }
  if (!colors['editor.foreground'] && rules.find((r) => r.token === '' && r.foreground)) colors['editor.foreground'] = `#${rules.find((r) => r.token === '').foreground}`;
  return { base, inherit: true, rules, colors };
}

// Maps a VS Code theme's workbench colors onto MulTeam's design tokens so a
// color theme restyles the whole app, not just the editor.
export function toAppPalette(vs, uiTheme) {
  const type = themeKind(vs, uiTheme);
  const mode = isLightKind(type) ? 'light' : 'dark';
  const c = vs.colors || {};
  const pick = (...keys) => { for (const k of keys) { const h = normalizeHex(c[k]); if (h) return `#${h}`; } return null; };
  const solid = (hex) => hex.slice(0, 7);
  const alpha = (hex, a) => `${solid(hex)}${Math.round(a * 255).toString(16).padStart(2, '0')}`;
  const bg = solid(pick('editor.background', 'sideBar.background') || (mode === 'dark' ? '#1e1e1e' : '#ffffff'));
  const fg = solid(pick('foreground', 'editor.foreground', 'sideBar.foreground') || (mode === 'dark' ? '#cccccc' : '#333333'));
  // Accent = the theme's most vivid "brand" color. Many themes use a grey
  // button.background, which would make selection/active states vanish.
  const saturation = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    return max === 0 ? 0 : (max - min) / max;
  };
  const accentCandidates = ['activityBarBadge.background', 'progressBar.background', 'textLink.foreground', 'focusBorder',
    'tab.activeBorderTop', 'tab.activeBorder', 'button.background', 'statusBarItem.remoteBackground', 'editorCursor.foreground']
    .map((k) => pick(k)).filter(Boolean).map(solid);
  const accent = accentCandidates.find((h) => saturation(h) >= 0.35) || accentCandidates[0] || '#6d4aff';
  return {
    mode,
    accent,
    vars: {
      '--bg': bg,
      '--surface': pick('editorWidget.background', 'dropdown.background', 'menu.background', 'quickInput.background', 'sideBar.background') || bg,
      '--line': pick('panel.border', 'editorGroup.border', 'sideBar.border', 'widget.border', 'contrastBorder') || alpha(fg, 0.14),
      '--line-soft': alpha(fg, 0.07),
      '--fill': pick('list.hoverBackground') || alpha(fg, 0.07),
      '--fill-2': pick('list.inactiveSelectionBackground', 'list.activeSelectionBackground') || alpha(fg, 0.12),
      '--text': fg,
      '--text-2': alpha(fg, 0.8),
      '--muted': pick('descriptionForeground') || alpha(fg, 0.55),
      '--danger': pick('errorForeground', 'editorError.foreground') || '#e14b63',
      '--warn': pick('editorWarning.foreground', 'list.warningForeground') || '#e08a2b',
      '--success': pick('gitDecoration.addedResourceForeground', 'terminal.ansiGreen') || '#12b76a',
      '--scrim': mode === 'dark' ? '#00000080' : '#00000033',
      '--shadow': mode === 'dark' ? '0 0 10px #00000040' : '0 0 10px #00000008',
      '--shadow-float': mode === 'dark' ? '0 16px 40px -12px #000000b3' : '0 12px 32px -12px #00000026'
    },
    titleBar: { color: bg, symbolColor: fg }
  };
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function compact(n) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n);
}

export function initExtensions({ toast, confirmDialog, pick, onIconThemeChange = () => {}, onTabChange = () => {} }) {
  const api = window.electronAPI?.extensions;
  const input = document.getElementById('extSearch');
  const listEl = document.getElementById('extList');
  const filterEl = document.getElementById('extFilter');
  const themeSelect = document.getElementById('editorTheme');
  const iconThemeSelect = document.getElementById('iconTheme');
  let activeIcon = null; // { t, def } of the applied icon theme

  let installed = [];
  // Tabs: Themes/Snippets/All browse Open VSX; Languages/Formatters show the
  // language-support catalog (languageSupport.js); Installed shows everything
  // installed. The search box searches Open VSX or filters the local lists.
  const MARKET_TABS = ['Themes', 'Snippets', 'All'];
  let tab = 'Themes';
  const isMarket = () => MARKET_TABS.includes(tab);
  const category = () => (isMarket() ? tab : 'All');
  let results = [];
  let seq = 0;
  let timer = null;
  const busy = new Set();               // ids being installed/removed
  const definedThemes = new Set();      // monaco theme names already defined
  const themeData = new Map();          // theme key -> VS Code theme JSON
  const snippetsByLang = new Map();     // monaco lang -> [{prefix, body, name, description, source}]
  const providers = new Map();          // monaco lang -> disposable

  const themeKey = (extId, label) => `${extId}::${label}`;
  const monacoName = (key) => `ext-${key.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`.slice(0, 80);

  function allThemes() {
    return installed.flatMap((e) => e.themes.map((t) => ({ ...t, extId: e.id, extName: e.displayName, key: themeKey(e.id, t.label) })));
  }

  // ---------- themes ----------
  async function ensureThemeDefined(t) {
    const name = monacoName(t.key);
    if (definedThemes.has(name)) return name;
    const vs = await api.readTheme(t.extId, t.path);
    themeData.set(t.key, vs);
    monaco.editor.defineTheme(name, toMonacoTheme(vs, t.uiTheme));
    definedThemes.add(name);
    return name;
  }

  // key '' = MulTeam's default (follows the app's light/dark)
  async function applyEditorTheme(key, { persist = true } = {}) {
    const t = key && allThemes().find((x) => x.key === key);
    if (key && !t) key = ''; // theme's extension was uninstalled
    try {
      setCustomEditorTheme(t ? await ensureThemeDefined(t) : null);
      // the whole app follows the color theme, not just the editor
      if (t) setAppPalette(toAppPalette(themeData.get(t.key) || {}, t.uiTheme), { persist });
      else if (hasAppPalette()) clearAppPalette({ persist });
    } catch (err) {
      toast(`Couldn't load that theme: ${String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`, 'error');
      setCustomEditorTheme(null);
      if (hasAppPalette()) clearAppPalette({ persist });
      key = '';
    }
    setMonacoTheme(getEffectiveTheme());
    if (persist) {
      updateSettings({ editorTheme: key });
      if (themeSelect) themeSelect.value = key;
    }
  }

  function paintThemeOptions() {
    if (!themeSelect) return;
    const current = getSettings().editorTheme || '';
    themeSelect.innerHTML = '<option value="">MulTeam (light / dark)</option>' +
      allThemes().map((t) => `<option value="${escapeHtml(t.key)}">${escapeHtml(t.label)}</option>`).join('');
    themeSelect.value = allThemes().some((t) => t.key === current) ? current : '';
  }
  themeSelect?.addEventListener('change', () => applyEditorTheme(themeSelect.value));

  function openThemePicker(onlyExtId) {
    const themes = allThemes().filter((t) => !onlyExtId || t.extId === onlyExtId);
    const before = getSettings().editorTheme || '';
    const items = [
      ...(onlyExtId ? [] : [{ label: 'MulTeam (light / dark)', detail: 'built-in', value: '' }]),
      ...themes.map((t) => ({ label: t.label, detail: `${t.extName} · ${t.uiTheme === 'vs' || t.uiTheme === 'hc-light' ? 'light' : 'dark'}`, value: t.key }))
    ];
    if (!items.length) { toast('Install a theme from the Extensions view first', 'error'); return; }
    pick({
      title: 'Select Color Theme (↑↓ to preview)',
      items,
      current: before,
      onPreview: (it) => applyEditorTheme(it.value, { persist: false }),
      onPick: (it) => applyEditorTheme(it.value),
      onCancel: () => applyEditorTheme(before, { persist: false })
    });
  }

  // ---------- file icon themes ----------
  function allIconThemes() {
    return installed.flatMap((e) => (e.iconThemes || []).map((t) => ({ ...t, extId: e.id, extName: e.displayName, key: `${e.id}::${t.id}` })));
  }

  // Turns a VS Code icon theme definition into lookup tables for icons.js.
  // The theme's `light` section overrides entries while the app is light.
  function resolveIconTheme(t, def) {
    const dir = posixDir(t.path.replace(/^\.\//, ''));
    const url = (id) => {
      const d = def.iconDefinitions?.[id];
      if (!d || typeof d.iconPath !== 'string' || !d.iconPath) return null; // font-based / placeholder icons aren't supported
      const rel = posixNormalize(`${dir}/${d.iconPath}`);
      return `/ext-assets/${encodeURIComponent(t.extId)}/${rel.split('/').map(encodeURIComponent).join('/')}`;
    };
    // Light overrides only win when they point at a real image — some themes
    // (e.g. VSCode Icons) ship empty light placeholders, which would leave
    // folders with no icon at all.
    const light = getEffectiveTheme() === 'light' && def.light ? def.light : null;
    const pick = (k) => (light && url(light[k]) ? light[k] : def[k]);
    const merged = (k) => ({ ...(def[k] || {}), ...Object.fromEntries(Object.entries((light && light[k]) || {}).filter(([, id]) => url(id))) });
    const lower = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));
    const extToLang = {};
    for (const lang of monaco.languages.getLanguages()) {
      for (const e of lang.extensions || []) {
        const key = e.replace(/^\./, '').toLowerCase();
        if (!(key in extToLang)) extToLang[key] = lang.id;
      }
    }
    return {
      url,
      file: pick('file'),
      folder: pick('folder'),
      folderExpanded: pick('folderExpanded'),
      fileNames: lower(merged('fileNames')),
      fileExtensions: lower(merged('fileExtensions')),
      folderNames: lower(merged('folderNames')),
      folderNamesExpanded: lower(merged('folderNamesExpanded')),
      languageIds: merged('languageIds'),
      extToLang
    };
  }

  // key '' = MulTeam's built-in icons
  async function applyIconTheme(key, { persist = true } = {}) {
    const t = key && allIconThemes().find((x) => x.key === key);
    if (!t) {
      activeIcon = null;
      setIconTheme(null);
      key = '';
    } else {
      try {
        const def = activeIcon?.t.key === t.key ? activeIcon.def : await api.readJson(t.extId, t.path);
        const usable = Object.values(def.iconDefinitions || {}).some((d) => d && typeof d.iconPath === 'string');
        if (!usable) throw new Error('this icon theme uses an icon font, which MulTeam doesn\u2019t support yet');
        activeIcon = { t, def };
        setIconTheme(resolveIconTheme(t, def));
      } catch (err) {
        toast(`Couldn't load that icon theme: ${String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`, 'error');
        activeIcon = null;
        setIconTheme(null);
        key = '';
      }
    }
    if (persist) {
      updateSettings({ iconTheme: key });
      if (iconThemeSelect) iconThemeSelect.value = key;
    }
    onIconThemeChange();
  }

  function paintIconThemeOptions() {
    if (!iconThemeSelect) return;
    const current = getSettings().iconTheme || '';
    iconThemeSelect.innerHTML = '<option value="">MulTeam (built-in)</option>' +
      allIconThemes().map((t) => `<option value="${escapeHtml(t.key)}">${escapeHtml(t.label)}</option>`).join('');
    iconThemeSelect.value = allIconThemes().some((t) => t.key === current) ? current : '';
  }
  iconThemeSelect?.addEventListener('change', () => applyIconTheme(iconThemeSelect.value));

  function openIconThemePicker(onlyExtId) {
    const themes = allIconThemes().filter((t) => !onlyExtId || t.extId === onlyExtId);
    const before = getSettings().iconTheme || '';
    const items = [
      ...(onlyExtId ? [] : [{ label: 'MulTeam (built-in)', detail: 'built-in', value: '' }]),
      ...themes.map((t) => ({ label: t.label, detail: t.extName, value: t.key }))
    ];
    if (items.length <= (onlyExtId ? 0 : 1)) { toast('Install a file icon theme from the Extensions view first (e.g. Material Icon Theme)', 'error'); return; }
    pick({
      title: 'Select File Icon Theme (↑↓ to preview)',
      items,
      current: before,
      onPreview: (it) => applyIconTheme(it.value, { persist: false }),
      onPick: (it) => applyIconTheme(it.value),
      onCancel: () => applyIconTheme(before, { persist: false })
    });
  }

  // light/dark switch: icon themes may ship light variants
  document.addEventListener('multeam:themechange', () => {
    if (activeIcon) { setIconTheme(resolveIconTheme(activeIcon.t, activeIcon.def)); onIconThemeChange(); }
  });

  // ---------- snippets ----------
  function ensureProvider(lang) {
    if (providers.has(lang)) return;
    providers.set(lang, monaco.languages.registerCompletionItemProvider(lang, {
      provideCompletionItems(model, position) {
        const word = model.getWordUntilPosition(position);
        const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
        return {
          suggestions: (snippetsByLang.get(lang) || []).map((s) => ({
            label: { label: s.prefix, description: s.source },
            kind: monaco.languages.CompletionItemKind.Snippet,
            detail: s.name,
            documentation: s.description ? `${s.description}\n\n${s.body}` : s.body,
            insertText: s.body,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range
          }))
        };
      }
    }));
  }

  async function loadSnippets() {
    snippetsByLang.clear();
    for (const ext of installed) {
      for (const c of ext.snippets) {
        let data;
        try { data = await api.readSnippets(ext.id, c.path); } catch { continue; }
        const lang = LANG_ALIAS[c.language] || c.language;
        const list = snippetsByLang.get(lang) || [];
        for (const [name, s] of Object.entries(data || {})) {
          if (!s || s.body == null || s.prefix == null) continue;
          const body = Array.isArray(s.body) ? s.body.join('\n') : String(s.body);
          for (const prefix of Array.isArray(s.prefix) ? s.prefix : [s.prefix]) {
            list.push({ prefix: String(prefix), body, name, description: s.description || '', source: ext.displayName });
          }
        }
        snippetsByLang.set(lang, list);
        ensureProvider(lang);
      }
    }
  }

  // ---------- data ----------
  async function reloadInstalled() {
    installed = api ? await api.list() : [];
    paintThemeOptions();
    paintIconThemeOptions();
    await loadSnippets();
    render();
  }

  async function runSearch() {
    if (!api) return;
    const mySeq = ++seq;
    listEl.dataset.loading = '1';
    render();
    try {
      const r = await api.search({ query: input.value.trim(), category: category() });
      if (mySeq !== seq) return;
      results = r;
    } catch (err) {
      if (mySeq !== seq) return;
      results = [];
      listEl.dataset.error = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    } finally {
      if (mySeq === seq) delete listEl.dataset.loading;
    }
    render();
    delete listEl.dataset.error;
  }

  // ---------- rendering ----------
  function card(e, isInstalled) {
    const rec = installed.find((x) => x.id === e.id);
    const state = busy.has(e.id) ? 'busy' : rec ? 'installed' : 'available';
    const iconCount = rec?.iconThemes?.length || 0;
    const kinds = rec ? [rec.themes.length ? `${rec.themes.length} color theme${rec.themes.length === 1 ? '' : 's'}` : '', iconCount ? `${iconCount} icon theme${iconCount === 1 ? '' : 's'}` : '', rec.snippets.length ? `snippets: ${[...new Set(rec.snippets.map((s) => s.language))].join(', ')}` : ''].filter(Boolean).join(' · ') : '';
    const icon = e.icon && !isInstalled ? `<img src="${escapeHtml(e.icon)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : `<span class="ext__ic" data-icon-for="${escapeHtml(e.id)}">${ICON_FALLBACK}</span>`;
    let actions = '';
    if (state === 'busy') actions = '<span class="ext__busy">Working…</span>';
    else if (state === 'installed') {
      actions = `${rec.themes.length ? `<button type="button" class="chipbtn" data-ext-theme="${escapeHtml(e.id)}">Set color theme</button>` : ''}
        ${iconCount ? `<button type="button" class="chipbtn" data-ext-icons="${escapeHtml(e.id)}">Set icon theme</button>` : ''}
        <button type="button" class="chipbtn danger" data-ext-uninstall="${escapeHtml(e.id)}">Uninstall</button>`;
    } else actions = `<button type="button" class="chipbtn is-primary" data-ext-install="${escapeHtml(e.id)}">Install</button>`;
    return `<div class="ext" title="${escapeHtml(e.description)}">
      <div class="ext__media">${icon}</div>
      <div class="ext__info">
        <div class="ext__top"><b>${escapeHtml(e.displayName)}</b>${e.downloads ? `<span class="ext__dl">↓ ${compact(e.downloads)}</span>` : ''}</div>
        <div class="ext__desc">${escapeHtml(e.description || '')}</div>
        <div class="ext__meta"><span>${escapeHtml(e.namespace || e.id.split('.')[0])}</span>${kinds ? `<span>${escapeHtml(kinds)}</span>` : ''}</div>
        <div class="ext__acts">${actions}</div>
      </div>
    </div>`;
  }

  function render() {
    if (!listEl) return;
    const q = input.value.trim();
    let html = '';
    if (tab === 'Installed') {
      const ql = q.toLowerCase();
      const mine = installed.filter((e) => !ql || `${e.displayName} ${e.description} ${e.id}`.toLowerCase().includes(ql));
      html += `<div class="ext__section">VS Code extensions <span class="scm__count">${mine.length}</span><span class="ext__src">Open VSX</span></div>`;
      html += mine.length ? mine.map((e) => card(e, true)).join('') : `<p class="scm__empty">${installed.length ? 'Nothing matches.' : 'No themes, icon themes or snippets installed yet — browse the Themes tab.'}</p>`;
    } else if (isMarket()) {
      html += `<div class="ext__section">${q ? 'Results' : `Popular ${tab === 'All' ? 'extensions' : tab.toLowerCase()}`} <span class="ext__src">Open VSX</span></div>`;
      if (listEl.dataset.loading) html += '<div class="bounce-loader"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>';
      else if (listEl.dataset.error) html += `<p class="scm__empty error">${escapeHtml(listEl.dataset.error)}</p>`;
      else if (!results.length) html += '<p class="scm__empty">No extensions found.</p>';
      else html += results.map((e) => card(e, false)).join('');
    }
    listEl.innerHTML = html;

    // local icons for installed extensions (stored on disk, served as data URLs)
    listEl.querySelectorAll('[data-icon-for]').forEach(async (el) => {
      const url = await api.icon(el.dataset.iconFor).catch(() => null);
      if (url) el.outerHTML = `<img src="${url}" alt="" />`;
    });
  }

  // ---------- actions ----------
  listEl?.addEventListener('click', async (e) => {
    const ins = e.target.closest('[data-ext-install]');
    const un = e.target.closest('[data-ext-uninstall]');
    const th = e.target.closest('[data-ext-theme]');
    const ic = e.target.closest('[data-ext-icons]');
    if (ic) openIconThemePicker(ic.dataset.extIcons);
    if (ins) {
      const id = ins.dataset.extInstall;
      const item = results.find((r) => r.id === id);
      if (!item) return;
      busy.add(id); render();
      try {
        const rec = await api.install({ namespace: item.namespace, name: item.name });
        await reloadInstalled();
        toast(`Installed ${rec.displayName}`);
        if (rec.themes.length) openThemePicker(rec.id);
        else if (rec.iconThemes?.length) openIconThemePicker(rec.id);
      } catch (err) {
        toast(String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error');
      } finally { busy.delete(id); render(); }
    }
    if (un) {
      const id = un.dataset.extUninstall;
      const rec = installed.find((r) => r.id === id);
      const ok = await confirmDialog({
        title: `Uninstall ${rec?.displayName || id}?`,
        message: 'Its themes, icons and snippets will be removed. Anything of it in use goes back to MulTeam\u2019s built-in look.',
        confirmLabel: 'Uninstall',
        danger: true
      });
      if (!ok) return;
      busy.add(id); render();
      try {
        const usingIt = (getSettings().editorTheme || '').startsWith(`${id}::`);
        const usingIcons = (getSettings().iconTheme || '').startsWith(`${id}::`);
        if (usingIcons) await applyIconTheme(''); // before the files disappear
        await api.uninstall(id);
        await reloadInstalled();
        if (usingIt) await applyEditorTheme('');
        toast(`Uninstalled ${rec?.displayName || id}`);
      } catch (err) {
        toast(String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error');
      } finally { busy.delete(id); render(); }
    }
    if (th) openThemePicker(th.dataset.extTheme);
  });

  const PLACEHOLDER = { Languages: 'Filter languages', Formatters: 'Filter formatters & linters', Installed: 'Filter installed' };
  function setTab(next) {
    tab = next;
    filterEl.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('is-on', x.dataset.tab === tab));
    input.placeholder = PLACEHOLDER[tab] || `Search Open VSX ${tab === 'All' ? 'extensions' : tab.toLowerCase()}`;
    listEl.hidden = !(isMarket() || tab === 'Installed');
    onTabChange(tab, input.value.trim());
    if (isMarket()) runSearch(); else render();
  }

  input?.addEventListener('input', () => {
    clearTimeout(timer);
    if (isMarket()) timer = setTimeout(runSearch, 350);
    else { render(); onTabChange(tab, input.value.trim()); }
  });
  filterEl?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b && b.dataset.tab !== tab) setTab(b.dataset.tab);
  });

  // ---------- boot ----------
  let searchedOnce = false;
  reloadInstalled().then(() => {
    const key = getSettings().editorTheme;
    if (key) applyEditorTheme(key, { persist: false });
    const iconKey = getSettings().iconTheme;
    if (iconKey) applyIconTheme(iconKey, { persist: false });
  });

  return {
    onShow() { if (!searchedOnce) { searchedOnce = true; setTab(tab); } setTimeout(() => input?.focus(), 120); },
    showTab: (name) => setTab(name),
    openThemePicker: () => openThemePicker(),
    async resetColorTheme() { if (hasAppPalette() || getSettings().editorTheme) { await applyEditorTheme(''); return true; } return false; },
    // Light/dark switch while a color theme is active: move to the same
    // extension's light or dark variant. Returns { switched } | { missing } | { same } | null (no theme).
    async switchColorThemeMode(mode) {
      const cur = allThemes().find((t) => t.key === getSettings().editorTheme);
      if (!cur) return null;
      const isLight = (t) => t.uiTheme === 'vs' || t.uiTheme === 'hc-light';
      if (isLight(cur) === (mode === 'light')) return { same: cur.label };
      const siblings = allThemes().filter((t) => t.extId === cur.extId && isLight(t) === (mode === 'light'));
      if (!siblings.length) return { missing: cur.label };
      // "GitHub Light Default" ↔ "GitHub Dark Default"; else the longest shared name prefix
      const swapped = cur.label.replace(/\b(dark|light)\b/i, (w) => (w.toLowerCase() === 'dark' ? 'Light' : 'Dark')).toLowerCase();
      const common = (a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return i; };
      const best = siblings.find((t) => t.label.toLowerCase() === swapped)
        || [...siblings].sort((a, b) => common(b.label.toLowerCase(), cur.label.toLowerCase()) - common(a.label.toLowerCase(), cur.label.toLowerCase()))[0];
      await applyEditorTheme(best.key);
      return { switched: best.label };
    },
    openIconThemePicker: () => openIconThemePicker(),
    reload: reloadInstalled
  };
}
