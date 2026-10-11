// Extensions view (sidebar) + the contributions MulTeam understands today:
// VS Code color themes (applied to the Monaco editor) and snippets
// (offered as completions). Packages come from Open VSX via the main
// process (main/extensions.js).
import * as monaco from 'monaco-editor';
import { setCustomEditorTheme, setMonacoTheme } from './editor.js';
import { getTheme } from './theme.js';
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
const SCOPE_ALIASES = [
  ['comment', ['comment']],
  ['string.regexp', ['regexp']],
  ['string', ['string']],
  ['constant.numeric', ['number']],
  ['constant.language', ['keyword']],
  ['constant.character.escape', ['string.escape']],
  ['keyword.operator', ['operator', 'delimiter']],
  ['keyword', ['keyword']],
  ['storage', ['keyword']],
  ['entity.name.type', ['type', 'type.identifier']],
  ['entity.name.class', ['type', 'type.identifier']],
  ['support.type.property-name', ['string.key.json', 'attribute.name']],
  ['support.type', ['type', 'type.identifier']],
  ['support.class', ['type', 'type.identifier']],
  ['entity.name.tag', ['tag']],
  ['entity.other.attribute-name', ['attribute.name']],
  ['variable', ['identifier', 'variable']],
  ['punctuation', ['delimiter']],
  ['markup.heading', ['keyword.md']],
  ['meta.tag', ['tag']],
  ['invalid', ['invalid']]
];

function normalizeHex(c) {
  if (typeof c !== 'string') return null;
  let h = c.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3,4}$/i.test(h)) h = [...h].map((x) => x + x).join('');
  return /^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h) ? h : null;
}

export function toMonacoTheme(vs, uiTheme) {
  const type = vs.type || (uiTheme === 'vs' ? 'light' : uiTheme === 'hc-black' ? 'hc' : 'dark');
  const base = type === 'light' ? 'vs' : type === 'hc' ? 'hc-black' : 'vs-dark';
  const rules = [];
  const tokenColors = Array.isArray(vs.tokenColors) ? vs.tokenColors : [];
  for (const tc of tokenColors) {
    const st = tc.settings || {};
    const fg = normalizeHex(st.foreground);
    if (!fg && !st.fontStyle) continue;
    const scopes = Array.isArray(tc.scope) ? tc.scope : String(tc.scope || '').split(',');
    for (const raw of scopes) {
      const scope = raw.trim();
      if (!scope) {
        // a scope-less entry sets the default foreground
        if (fg) rules.push({ token: '', foreground: fg });
        continue;
      }
      const tokens = new Set([scope]);
      const hit = SCOPE_ALIASES.find(([prefix]) => scope === prefix || scope.startsWith(`${prefix}.`) || scope.startsWith(`${prefix} `));
      if (hit) hit[1].forEach((t) => tokens.add(t));
      for (const token of tokens) rules.push({ token, ...(fg ? { foreground: fg } : {}), ...(st.fontStyle ? { fontStyle: st.fontStyle } : {}) });
    }
  }
  const colors = {};
  for (const [k, v] of Object.entries(vs.colors || {})) {
    const hex = normalizeHex(v);
    if (hex) colors[k] = `#${hex}`;
  }
  if (!colors['editor.foreground'] && rules.find((r) => r.token === '' && r.foreground)) colors['editor.foreground'] = `#${rules.find((r) => r.token === '').foreground}`;
  return { base, inherit: true, rules, colors };
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function compact(n) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n);
}

export function initExtensions({ toast, confirmDialog, pick, onIconThemeChange = () => {} }) {
  const api = window.electronAPI?.extensions;
  const input = document.getElementById('extSearch');
  const listEl = document.getElementById('extList');
  const filterEl = document.getElementById('extFilter');
  const themeSelect = document.getElementById('editorTheme');
  const iconThemeSelect = document.getElementById('iconTheme');
  let activeIcon = null; // { t, def } of the applied icon theme

  let installed = [];
  let category = 'Themes';
  let results = [];
  let seq = 0;
  let timer = null;
  const busy = new Set();               // ids being installed/removed
  const definedThemes = new Set();      // monaco theme names already defined
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
    } catch (err) {
      toast(`Couldn't load that theme: ${String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`, 'error');
      setCustomEditorTheme(null);
      key = '';
    }
    setMonacoTheme(getTheme());
    if (persist) {
      updateSettings({ editorTheme: key });
      if (themeSelect) themeSelect.value = key;
    }
  }

  function paintThemeOptions() {
    if (!themeSelect) return;
    const current = getSettings().editorTheme || '';
    themeSelect.innerHTML = '<option value="">MulTeam (follows app theme)</option>' +
      allThemes().map((t) => `<option value="${escapeHtml(t.key)}">${escapeHtml(t.label)}</option>`).join('');
    themeSelect.value = allThemes().some((t) => t.key === current) ? current : '';
  }
  themeSelect?.addEventListener('change', () => applyEditorTheme(themeSelect.value));

  function openThemePicker(onlyExtId) {
    const themes = allThemes().filter((t) => !onlyExtId || t.extId === onlyExtId);
    const before = getSettings().editorTheme || '';
    const items = [
      ...(onlyExtId ? [] : [{ label: 'MulTeam (follows app theme)', detail: 'built-in', value: '' }]),
      ...themes.map((t) => ({ label: t.label, detail: `${t.extName} · ${t.uiTheme === 'vs' ? 'light' : 'dark'}`, value: t.key }))
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
    const light = getTheme() === 'light' && def.light ? def.light : null;
    const merged = (k) => ({ ...(def[k] || {}), ...((light && light[k]) || {}) });
    const lower = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));
    const extToLang = {};
    for (const lang of monaco.languages.getLanguages()) {
      for (const e of lang.extensions || []) {
        const key = e.replace(/^\./, '').toLowerCase();
        if (!(key in extToLang)) extToLang[key] = lang.id;
      }
    }
    return {
      url(id) {
        const d = def.iconDefinitions?.[id];
        if (!d || typeof d.iconPath !== 'string') return null; // font-based icons aren't supported
        const rel = posixNormalize(`${dir}/${d.iconPath}`);
        return `/ext-assets/${encodeURIComponent(t.extId)}/${rel.split('/').map(encodeURIComponent).join('/')}`;
      },
      file: (light && light.file) || def.file,
      folder: (light && light.folder) || def.folder,
      folderExpanded: (light && light.folderExpanded) || def.folderExpanded,
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
      const r = await api.search({ query: input.value.trim(), category });
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
    if (!q && installed.length) {
      html += `<div class="ext__section">Installed <span class="scm__count">${installed.length}</span></div>`;
      html += installed.map((e) => card(e, true)).join('');
    }
    html += `<div class="ext__section">${q ? 'Results' : `Popular ${category === 'All' ? 'extensions' : category.toLowerCase()}`} <span class="ext__src">Open VSX</span></div>`;
    if (listEl.dataset.loading) html += '<div class="bounce-loader"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>';
    else if (listEl.dataset.error) html += `<p class="scm__empty error">${escapeHtml(listEl.dataset.error)}</p>`;
    else if (!results.length) html += '<p class="scm__empty">No extensions found.</p>';
    else html += results.map((e) => card(e, false)).join('');
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

  input?.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(runSearch, 350); });
  filterEl?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]');
    if (!b) return;
    category = b.dataset.cat;
    filterEl.querySelectorAll('[data-cat]').forEach((x) => x.classList.toggle('is-on', x === b));
    runSearch();
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
    onShow() { if (!searchedOnce) { searchedOnce = true; runSearch(); } setTimeout(() => input?.focus(), 120); },
    openThemePicker: () => openThemePicker(),
    openIconThemePicker: () => openIconThemePicker(),
    reload: reloadInstalled
  };
}
