// MulTeam plugin host. Each enabled plugin runs in its own Web Worker built
// from a small bootstrap (the `multeam` API) + the plugin's code. Workers
// have no DOM, no Node and no app internals; every capability is a message
// to this host, which checks the plugin's declared permissions first.
//
// Network APIs inside the worker are removed before plugin code runs. That
// is best-effort hardening, not a security boundary — only install plugins
// you trust.
import * as monaco from 'monaco-editor';

const PERMISSION_FOR = {
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

// Runs inside the worker before the plugin's own code.
const BOOTSTRAP = `
'use strict';
(() => {
  // remove network/script-loading APIs (best effort — see pluginHost.js)
  for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'WebTransport']) {
    let o = self;
    while (o) { try { delete o[name]; } catch {} o = Object.getPrototypeOf(o); }
    try { Object.defineProperty(self, name, { value: undefined, writable: false, configurable: false }); } catch {}
  }
})();
const __pending = new Map();
let __seq = 0;
const __commands = new Map();
const __completions = new Map();
const __listeners = new Map();
function __call(m, ...a) {
  return new Promise((resolve, reject) => {
    const id = ++__seq;
    __pending.set(id, { resolve, reject });
    postMessage({ t: 'call', id, m, a });
  });
}
self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.t === 'res') {
    const p = __pending.get(msg.id); if (!p) return;
    __pending.delete(msg.id);
    msg.ok ? p.resolve(msg.value) : p.reject(new Error(msg.error));
  } else if (msg.t === 'run') {
    try { await __commands.get(msg.cmd)?.(); postMessage({ t: 'done', rid: msg.rid, ok: true }); }
    catch (err) { postMessage({ t: 'done', rid: msg.rid, ok: false, error: String(err && err.message || err) }); }
  } else if (msg.t === 'complete') {
    try { const items = await (__completions.get(msg.lang)?.(msg.ctx) || []); postMessage({ t: 'done', rid: msg.rid, ok: true, value: Array.isArray(items) ? items.slice(0, 200) : [] }); }
    catch (err) { postMessage({ t: 'done', rid: msg.rid, ok: false, error: String(err && err.message || err) }); }
  } else if (msg.t === 'event') {
    for (const fn of __listeners.get(msg.ev) || []) { try { fn(msg.data); } catch (err) { console.error(err); } }
  }
};
const multeam = Object.freeze({
  commands: Object.freeze({
    register(id, title, handler) {
      if (typeof handler !== 'function') throw new Error('commands.register(id, title, handler) needs a function');
      __commands.set(String(id), handler);
      postMessage({ t: 'cmd', id: String(id), title: String(title || id) });
    }
  }),
  window: Object.freeze({
    showMessage: (text) => __call('window.showMessage', String(text)),
    showError: (text) => __call('window.showError', String(text)),
    showInput: (opts = {}) => __call('window.showInput', opts),
    setStatus: (text) => __call('window.setStatus', String(text ?? ''))
  }),
  editor: Object.freeze({
    getText: () => __call('editor.getText'),
    getSelectedText: () => __call('editor.getSelectedText'),
    replaceSelection: (text) => __call('editor.replaceSelection', String(text)),
    insertText: (text) => __call('editor.insertText', String(text)),
    getFile: () => __call('editor.getFile')
  }),
  workspace: Object.freeze({
    getRoot: () => __call('workspace.getRoot'),
    listFiles: () => __call('workspace.listFiles'),
    readFile: (rel) => __call('workspace.readFile', String(rel)),
    writeFile: (rel, text) => __call('workspace.writeFile', String(rel), String(text))
  }),
  languages: Object.freeze({
    registerCompletions(language, provider) {
      if (typeof provider !== 'function') throw new Error('registerCompletions(language, provider) needs a function');
      __completions.set(String(language), provider);
      postMessage({ t: 'completions', lang: String(language) });
    }
  }),
  on(event, fn) {
    if (!__listeners.has(event)) __listeners.set(event, []);
    __listeners.get(event).push(fn);
  }
});
self.multeam = multeam;
`;

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function safeRelative(rel) {
  const norm = String(rel).replace(/\\/g, '/').replace(/^\/+/, '');
  if (!norm || norm.split('/').some((seg) => seg === '..') || /^[a-zA-Z]:/.test(norm)) throw new Error('Paths must be relative to the project folder.');
  return norm;
}

// `space` (pluginSpace.js) owns the plugin pane: it handles creating from a
// template and gallery publish/unpublish, and may add buttons to each card.
export function initPluginHost({ app, toast, confirmDialog, promptDialog, commands, space = {} }) {
  const api = window.electronAPI?.plugins;
  const listEl = document.getElementById('pluginList');
  const statusHost = document.getElementById('pluginStatus');

  let plugins = [];                     // manifests from main
  const running = new Map();            // id -> { worker, manifest, pending, rid }
  const runtimeErrors = new Map();      // id -> message
  const completionLangs = new Map();    // lang -> Set(pluginId)
  const providers = new Map();          // lang -> monaco disposable

  // ---------- host-side API ----------
  async function handleCall(rt, m, a) {
    const need = PERMISSION_FOR[m];
    if (need === undefined) throw new Error(`Unknown API: ${m}`);
    if (need && !rt.manifest.permissions.includes(need)) throw new Error(`"${m}" needs the "${need}" permission in multeam-plugin.json.`);

    switch (m) {
      case 'window.showMessage': toast(`${rt.manifest.name}: ${a[0]}`); return null;
      case 'window.showError': toast(`${rt.manifest.name}: ${a[0]}`, 'error'); return null;
      case 'window.showInput': {
        const o = a[0] || {};
        return promptDialog({ title: String(o.title || rt.manifest.name), label: String(o.label || 'Value'), placeholder: String(o.placeholder || ''), value: String(o.value || ''), confirmLabel: 'OK' });
      }
      case 'window.setStatus': setStatus(rt.manifest, a[0]); return null;
      case 'editor.getText': return app.editorText();
      case 'editor.getSelectedText': return app.selectedText();
      case 'editor.replaceSelection': return app.replaceSelection(a[0]);
      case 'editor.insertText': return app.insertText(a[0]);
      case 'editor.getFile': return app.currentFile();
      case 'workspace.getRoot': return app.root();
      case 'workspace.listFiles': {
        const root = app.root();
        if (!root) return [];
        return (await window.electronAPI.listFiles(root)).files.map((f) => f.replace(/\\/g, '/'));
      }
      case 'workspace.readFile': {
        const root = app.root();
        if (!root) throw new Error('No project is open.');
        return window.electronAPI.readFile(app.join(root, safeRelative(a[0])));
      }
      case 'workspace.writeFile': {
        const root = app.root();
        if (!root) throw new Error('No project is open.');
        await window.electronAPI.writeFile(app.join(root, safeRelative(a[0])), a[1]);
        return null;
      }
      default: throw new Error(`Unknown API: ${m}`);
    }
  }

  function request(rt, payload, timeoutMs = 0) {
    return new Promise((resolve, reject) => {
      const rid = ++rt.rid;
      rt.pending.set(rid, { resolve, reject });
      rt.worker.postMessage({ ...payload, rid });
      if (timeoutMs) setTimeout(() => { if (rt.pending.delete(rid)) reject(new Error('timeout')); }, timeoutMs);
    });
  }

  // ---------- status items ----------
  function setStatus(manifest, text) {
    let el = statusHost.querySelector(`[data-plugin="${manifest.id}"]`);
    if (!text) { el?.remove(); return; }
    if (!el) {
      el = document.createElement('span');
      el.className = 'plugin-status';
      el.dataset.plugin = manifest.id;
      el.title = manifest.name;
      statusHost.appendChild(el);
    }
    el.textContent = String(text).slice(0, 80);
  }

  // ---------- completions ----------
  function ensureProvider(lang) {
    if (providers.has(lang)) return;
    providers.set(lang, monaco.languages.registerCompletionItemProvider(lang, {
      async provideCompletionItems(model, position) {
        const ids = [...(completionLangs.get(lang) || [])].filter((id) => running.has(id));
        if (!ids.length) return { suggestions: [] };
        const word = model.getWordUntilPosition(position);
        const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
        const ctx = { word: word.word, line: model.getLineContent(position.lineNumber), lineNumber: position.lineNumber, column: position.column, language: lang };
        const batches = await Promise.all(ids.map(async (id) => {
          const rt = running.get(id);
          try {
            const items = await request(rt, { t: 'complete', lang, ctx }, 500);
            return (items || []).filter((it) => it && it.label).map((it) => ({
              label: { label: String(it.label), description: rt.manifest.name },
              kind: monaco.languages.CompletionItemKind.Snippet,
              detail: it.detail ? String(it.detail) : undefined,
              documentation: it.documentation ? String(it.documentation) : undefined,
              insertText: String(it.insertText ?? it.label),
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              range
            }));
          } catch { return []; }
        }));
        return { suggestions: batches.flat() };
      }
    }));
  }

  // ---------- lifecycle ----------
  function stop(id) {
    const rt = running.get(id);
    if (!rt) return;
    rt.worker.terminate();
    for (const p of rt.pending.values()) p.reject(new Error('Plugin stopped'));
    running.delete(id);
    for (let i = commands.length - 1; i >= 0; i--) if (commands[i].pluginId === id) commands.splice(i, 1);
    statusHost.querySelector(`[data-plugin="${id}"]`)?.remove();
    for (const set of completionLangs.values()) set.delete(id);
  }

  async function start(manifest) {
    stop(manifest.id);
    runtimeErrors.delete(manifest.id);
    let code;
    try { code = await api.code(manifest.id); } catch (err) { runtimeErrors.set(manifest.id, cleanErr(err)); return; }

    const source = `${BOOTSTRAP}\n;(() => {\n${code}\n})();\n//# sourceURL=multeam-plugin:${manifest.id}/${manifest.main}`;
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    const worker = new Worker(url, { name: `plugin:${manifest.id}` });
    URL.revokeObjectURL(url);
    const rt = { worker, manifest, pending: new Map(), rid: 0 };
    running.set(manifest.id, rt);

    worker.onmessage = async (e) => {
      const msg = e.data || {};
      if (msg.t === 'call') {
        try { worker.postMessage({ t: 'res', id: msg.id, ok: true, value: await handleCall(rt, msg.m, msg.a || []) }); }
        catch (err) { worker.postMessage({ t: 'res', id: msg.id, ok: false, error: cleanErr(err) }); }
      } else if (msg.t === 'cmd') {
        const label = `${manifest.name}: ${msg.title}`;
        for (let i = commands.length - 1; i >= 0; i--) if (commands[i].pluginId === manifest.id && commands[i].cmdId === msg.id) commands.splice(i, 1);
        commands.push({ label, hint: 'plugin', pluginId: manifest.id, cmdId: msg.id, action: () => runCommand(manifest.id, msg.id) });
      } else if (msg.t === 'completions') {
        if (!completionLangs.has(msg.lang)) completionLangs.set(msg.lang, new Set());
        completionLangs.get(msg.lang).add(manifest.id);
        ensureProvider(msg.lang);
      } else if (msg.t === 'done') {
        const p = rt.pending.get(msg.rid);
        if (!p) return;
        rt.pending.delete(msg.rid);
        msg.ok ? p.resolve(msg.value) : p.reject(new Error(msg.error));
      }
    };
    worker.onerror = (e) => {
      e.preventDefault();
      // map the worker's line number back to the plugin's own main.js
      const where = e.lineno ? ` (line ${Math.max(1, e.lineno - BOOTSTRAP.split('\n').length - 1)})` : '';
      runtimeErrors.set(manifest.id, `${e.message || 'Plugin crashed'}${where}`);
      toast(`${manifest.name} failed: ${e.message || 'error'}`, 'error');
      stop(manifest.id);
      render();
    };
  }

  async function runCommand(id, cmdId) {
    const rt = running.get(id);
    if (!rt) return;
    try { await request(rt, { t: 'run', cmd: cmdId }); }
    catch (err) { toast(`${rt.manifest.name}: ${cleanErr(err)}`, 'error'); }
  }

  function cleanErr(err) {
    return String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }

  async function loadAll() {
    if (!api) return;
    plugins = await api.list();
    for (const id of [...running.keys()]) if (!plugins.some((p) => p.id === id && p.enabled && !p.error)) stop(id);
    for (const p of plugins) if (p.enabled && !p.error) await start(p);
    render();
  }

  // ---------- UI (Plugins pane → Installed) ----------
  let filter = '';
  function render() {
    if (!listEl) return;
    const head = `<div class="ext__section">Installed <span class="scm__count">${plugins.length}</span></div>
      <div class="plugin__bar">
        <button type="button" class="chipbtn" data-plugin-act="create">New from template</button>
        <button type="button" class="chipbtn" data-plugin-act="install-package" title="Install a .mtplugin file">Install .mtplugin</button>
        <button type="button" class="chipbtn" data-plugin-act="install" title="Install from a plugin folder">From folder</button>
      </div>`;
    const q = filter.toLowerCase();
    const shown = plugins.filter((p) => !q || `${p.name} ${p.description} ${p.id}`.toLowerCase().includes(q));
    if (!plugins.length) {
      listEl.innerHTML = `${head}<p class="scm__empty">No plugins yet. Start from a template (Templates tab), get one from the Gallery, or install a .mtplugin file.</p>`;
      return;
    }
    listEl.innerHTML = head + (shown.length ? '' : '<p class="scm__empty">Nothing matches.</p>') + shown.map((p) => {
      const err = p.error || runtimeErrors.get(p.id);
      const live = running.has(p.id);
      return `<div class="ext plugin ${p.enabled ? '' : 'is-off'}">
        <div class="ext__media"><span class="ext__ic plugin__ic">${escapeHtml((p.name[0] || '?').toUpperCase())}</span></div>
        <div class="ext__info">
          <div class="ext__top"><b>${escapeHtml(p.name)}</b><span class="ext__dl">${escapeHtml(p.version)}</span>
            <button type="button" class="switch sm ${p.enabled ? 'is-on' : ''}" data-plugin-toggle="${escapeHtml(p.id)}" title="${p.enabled ? 'Disable' : 'Enable'}" aria-label="${p.enabled ? 'Disable' : 'Enable'} ${escapeHtml(p.name)}"></button>
          </div>
          ${p.description ? `<div class="ext__desc">${escapeHtml(p.description)}</div>` : ''}
          <div class="ext__meta">${p.permissions.length ? p.permissions.map((x) => `<span class="perm">${escapeHtml(x)}</span>`).join('') : '<span>no permissions</span>'}${live ? '<span class="plugin__live">● running</span>' : ''}</div>
          ${err ? `<div class="plugin__err">${escapeHtml(err)}</div>` : ''}
          <div class="ext__acts">
            <button type="button" class="chipbtn" data-plugin-act="reload" data-id="${escapeHtml(p.id)}" ${p.enabled ? '' : 'disabled'}>Reload</button>
            <button type="button" class="chipbtn" data-plugin-act="folder" data-id="${escapeHtml(p.id)}">Open folder</button>
            <button type="button" class="chipbtn" data-plugin-act="export" data-id="${escapeHtml(p.id)}" ${p.error ? 'disabled' : ''}>Export</button>
            ${p.error ? '' : `<button type="button" class="chipbtn" data-plugin-act="publish" data-id="${escapeHtml(p.id)}">Publish…</button>`}
            ${space.isPublishedByMe?.(p.id) ? `<button type="button" class="chipbtn danger" data-plugin-act="unpublish" data-id="${escapeHtml(p.id)}">Unpublish</button>` : ''}
            <button type="button" class="chipbtn danger" data-plugin-act="uninstall" data-id="${escapeHtml(p.id)}">Uninstall</button>
          </div>
        </div>
      </div>`;
    }).join('');
  }

  listEl?.addEventListener('click', async (e) => {
    const tog = e.target.closest('[data-plugin-toggle]');
    const btn = e.target.closest('[data-plugin-act]');
    try {
      if (tog) {
        const p = plugins.find((x) => x.id === tog.dataset.pluginToggle);
        await api.setEnabled(p.id, !p.enabled);
        await loadAll();
        toast(`${p.name} ${p.enabled ? 'disabled' : 'enabled'}`);
        return;
      }
      if (!btn) return;
      const act = btn.dataset.pluginAct;
      const p = plugins.find((x) => x.id === btn.dataset.id);
      if (act === 'create') return space.onCreate?.();
      if (act === 'install') {
        const installed = await api.installFromFolder();
        if (installed) { await loadAll(); toast(`Installed ${installed.name}`); }
      }
      if (act === 'install-package') {
        const installed = await api.installPackage();
        if (installed) { await loadAll(); toast(`Installed ${installed.name} ${installed.version}`); }
      }
      if (act === 'reload' && p) { await api.list().then((l) => { plugins = l; }); const fresh = plugins.find((x) => x.id === p.id); if (fresh && !fresh.error) await start(fresh); render(); toast(`${p.name} reloaded`); }
      if (act === 'folder' && p) await api.openFolder(p.id);
      if (act === 'export' && p) {
        const file = await api.exportPackage(p.id);
        if (file) toast(`Exported ${file.split(/[\\/]/).pop()}`);
      }
      if (act === 'publish' && p) await space.onPublish?.(p);
      if (act === 'unpublish' && p) await space.onUnpublish?.(p);
      if (act === 'uninstall' && p) {
        const ok = await confirmDialog({ title: `Uninstall ${p.name}?`, message: 'The plugin and its folder are deleted from this computer. This can’t be undone.', confirmLabel: 'Uninstall', danger: true });
        if (!ok) return;
        stop(p.id);
        await api.uninstall(p.id);
        await loadAll();
        toast(`Uninstalled ${p.name}`);
      }
    } catch (err) {
      toast(cleanErr(err), 'error');
    }
  });

  loadAll();

  return {
    emit(event, data) { for (const rt of running.values()) rt.worker.postMessage({ t: 'event', ev: event, data }); },
    reloadAll: loadAll,
    runningCount: () => running.size,
    installed: () => plugins,
    setFilter(q) { filter = q || ''; render(); },
    rerender: () => render()
  };
}
