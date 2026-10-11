// Language support manager: lists installable language servers, installs
// them on demand, starts one lazily when a file in its language is opened,
// and stops them when the project closes. UI: a "Language support" section
// in the Extensions view + a status item in the footer.
import * as monaco from 'monaco-editor';
import { LspClient } from './lspClient.js';
import { TS_LSP_FLAG, builtinTsEnabledAtBoot } from './editor.js';

// Built-in (single-file) TypeScript diagnostics can be switched live; its
// other features are fixed at startup (see editor.js), so a change of JS/TS
// server state mid-session asks for a reload.
const BASE_DIAGNOSTICS = { noSemanticValidation: false, noSyntaxValidation: false, diagnosticCodesToIgnore: [2307, 2792] };
function setBuiltinTsDiagnostics(enabled) {
  const ts = monaco.languages.typescript;
  if (enabled) {
    ts.typescriptDefaults.setDiagnosticsOptions(BASE_DIAGNOSTICS);
    ts.javascriptDefaults.setDiagnosticsOptions({ ...BASE_DIAGNOSTICS, noSemanticValidation: true });
  } else {
    ts.typescriptDefaults.setDiagnosticsOptions({ ...BASE_DIAGNOSTICS, noSemanticValidation: true, noSyntaxValidation: true });
    ts.javascriptDefaults.setDiagnosticsOptions({ ...BASE_DIAGNOSTICS, noSemanticValidation: true, noSyntaxValidation: true });
    for (const m of monaco.editor.getModels()) { monaco.editor.setModelMarkers(m, 'typescript', []); monaco.editor.setModelMarkers(m, 'javascript', []); }
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function initLanguageSupport({ toast, confirmDialog, getRoot, getActiveModel, openFileAt, showExtensions, onCatalogChange = () => {}, lspShouldFormat = () => true }) {
  const api = window.electronAPI?.languages;
  const listEl = document.getElementById('langList');
  const statusEl = document.getElementById('langStatus');

  let catalog = [];
  const clients = new Map();     // id -> LspClient
  const starting = new Map();    // id -> Promise
  const progress = new Map();    // id -> { pct, detail }
  const crashed = new Map();     // id -> log tail
  let clientRoot = null;

  // language servers only — formatter/linter tools share the catalog but never start as servers
  const entryForLang = (lang) => catalog.find((c) => c.kind === 'server' && c.languages.includes(lang));

  // ---------- servers ----------
  // Every start/stop request goes through one queue: two quick calls (e.g.
  // a file opening while the project switches) could otherwise both pass
  // the "already running?" check and start the same server twice, which
  // doubles every completion and turns go-to-definition into a peek list.
  let queue = Promise.resolve();
  function ensureFor(lang) {
    queue = queue.then(() => ensureForNow(lang)).catch(() => {});
    return queue;
  }

  async function ensureForNow(lang) {
    const entry = entryForLang(lang);
    if (!entry || !entry.installed) { paintStatus(); return; }
    const root = getRoot();
    if (clientRoot !== root) { await stopAll(); clientRoot = root; }
    if (clients.has(entry.id) || starting.has(entry.id)) { paintStatus(); return; }

    const p = (async () => {
      crashed.delete(entry.id);
      paintStatus();
      const info = await api.start(entry.id, root);
      const client = new LspClient({
        id: entry.id, name: entry.name, languages: info.languages, rootPath: root,
        initializationOptions: info.initializationOptions, api, shouldFormat: lspShouldFormat,
        onState: () => paintStatus()
      });
      clients.set(entry.id, client);
      if (entry.id === 'typescript') setBuiltinTsDiagnostics(false);
      try {
        await client.start();
      } catch (err) {
        clients.delete(entry.id);
        client.dispose();
        if (entry.id === 'typescript') setBuiltinTsDiagnostics(true);
        api.stop(entry.id).catch(() => {});
        throw err;
      }
    })();
    starting.set(entry.id, p);
    try { await p; }
    catch (err) { crashed.set(entry.id, String(err.message || err)); toast(`${entry.name} language server failed to start: ${err.message || err}`, 'error'); }
    finally { starting.delete(entry.id); paintStatus(); render(); }
  }

  async function stop(id) {
    const c = clients.get(id);
    clients.delete(id);
    if (c) await c.stop();
    await api.stop(id).catch(() => {});
    if (id === 'typescript') setBuiltinTsDiagnostics(true);
  }

  async function stopAll() {
    await Promise.all([...clients.keys()].map((id) => stop(id)));
    crashed.clear();
    paintStatus();
  }

  api?.onMessage((id, msg) => clients.get(id)?.handle(msg));
  api?.onExit((id, code, log) => {
    const c = clients.get(id);
    if (!c) return;
    clients.delete(id);
    c.dispose();
    if (id === 'typescript') setBuiltinTsDiagnostics(true);
    crashed.set(id, log || `exited with code ${code}`);
    toast(`${catalog.find((x) => x.id === id)?.name || id} language server stopped (code ${code})`, 'error');
    paintStatus();
    render();
  });
  api?.onProgress(({ id, pct, detail, phase }) => {
    // only while an install we started is in flight — the final "done"
    // event can arrive after the install call has already resolved
    if (!progress.has(id) || phase === 'done') return;
    progress.set(id, { pct, detail, phase });
    render();
    paintStatus();
  });

  // Go to definition into another file → open it through the app.
  monaco.editor.registerEditorOpener({
    openCodeEditor(source, resource, selectionOrPosition) {
      if (resource.scheme !== 'file') return false;
      const cur = source.getModel();
      if (cur && cur.uri.toString() === resource.toString()) return false; // same file: Monaco handles it
      const pos = selectionOrPosition && ('startLineNumber' in selectionOrPosition
        ? { line: selectionOrPosition.startLineNumber, column: selectionOrPosition.startColumn }
        : { line: selectionOrPosition.lineNumber, column: selectionOrPosition.column });
      openFileAt(resource.fsPath, pos?.line || 1, pos?.column || 1);
      return true;
    }
  });

  // ---------- install / uninstall ----------
  async function install(id) {
    const entry = catalog.find((c) => c.id === id);
    progress.set(id, { pct: 0, detail: 'starting…', phase: 'resolving' });
    render();
    try {
      await api.install(id);
      progress.delete(id);
      await reload();
      toast(entry.kind === 'tool' ? `${entry.name} installed` : `${entry.name} support installed`);
      if (id === 'typescript') offerReloadForTs();
      const model = getActiveModel();
      if (model && entry.languages.includes(model.getLanguageId())) ensureFor(model.getLanguageId());
    } catch (err) {
      progress.delete(id);
      render();
      toast(`Couldn't install ${entry.name} support: ${String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`, 'error');
    }
  }

  async function uninstall(id) {
    const entry = catalog.find((c) => c.id === id);
    const ok = await confirmDialog({
      title: entry.kind === 'tool' ? `Uninstall ${entry.name}?` : `Uninstall ${entry.name} support?`,
      message: entry.kind === 'tool' ? 'The formatter is removed from this computer. You can reinstall it any time.' : 'The language server is removed from this computer. You can reinstall it any time.',
      confirmLabel: 'Uninstall',
      danger: true
    });
    if (!ok) return;
    await stop(id);
    try { await api.uninstall(id); } catch (err) { toast(String(err.message || err), 'error'); }
    await reload();
    toast(`${entry.name} support uninstalled`);
    if (id === 'typescript') offerReloadForTs();
  }

  async function reload() {
    catalog = api ? await api.list() : [];
    const tsInstalled = !!catalog.find((c) => c.id === 'typescript')?.installed;
    try { localStorage.setItem(TS_LSP_FLAG, tsInstalled ? '1' : ''); } catch { /* non-fatal */ }
    onCatalogChange(catalog);
    render();
    paintStatus();
    return tsInstalled;
  }

  // JS/TS server installed/uninstalled after startup: the built-in features
  // still match the old state until the window reloads.
  async function offerReloadForTs() {
    const tsInstalled = !!catalog.find((c) => c.id === 'typescript')?.installed;
    if (tsInstalled === !builtinTsEnabledAtBoot()) return;
    const ok = await confirmDialog({
      title: 'Reload to finish switching JavaScript/TypeScript?',
      message: tsInstalled
        ? 'The new language server is running. Reload once so the built-in single-file IntelliSense steps aside — otherwise some suggestions appear twice.'
        : 'Reload once to bring back the built-in single-file IntelliSense.',
      confirmLabel: 'Reload now'
    });
    if (ok) location.reload();
  }

  // ---------- UI ----------
  function card(c) {
    const isTool = c.kind === 'tool';
    const prog = progress.get(c.id);
    const running = clients.has(c.id);
    const err = crashed.get(c.id);
    let actions;
    if (prog) actions = `<div class="lang__bar"><span style="width:${Math.max(4, prog.pct)}%"></span></div><span class="ext__busy">${escapeHtml(prog.detail || prog.phase)}</span>`;
    else if (!c.installed) actions = `<button type="button" class="chipbtn is-primary" data-lang-install="${c.id}">Install</button>`;
    else actions = `${!isTool && running ? '<span class="plugin__live">● running</span>' : ''}
      ${isTool ? '' : `<button type="button" class="chipbtn" data-lang-restart="${c.id}">${running ? 'Restart' : 'Start'}</button>`}
      <button type="button" class="chipbtn danger" data-lang-uninstall="${c.id}">Uninstall</button>`;
    const badge = c.installed ? (c.variant === 'bundled-runtime' ? 'installed · own Java' : c.variant === 'system-runtime' ? 'installed · your Java' : 'installed') : `~${c.approxMB} MB`;
    return `<div class="ext">
      <div class="ext__media"><span class="ext__ic lang__ic">${isTool ? '¶' : '{ }'}</span></div>
      <div class="ext__info">
        <div class="ext__top"><b>${escapeHtml(c.name)}</b><span class="ext__dl">${badge}</span></div>
        <div class="ext__desc">${escapeHtml(c.description)}</div>
        <div class="ext__meta">${c.source.map((p) => `<span class="perm">${escapeHtml(p)}</span>`).join('')}</div>
        ${err ? `<div class="plugin__err">${escapeHtml(err.slice(-400))}</div>` : ''}
        <div class="ext__acts">${actions}</div>
      </div>
    </div>`;
  }

  // view: which tab of the Extensions view is showing (set by extensions.js)
  let view = { mode: 'hidden', query: '' };
  function render() {
    if (!listEl) return;
    listEl.hidden = view.mode === 'hidden';
    if (view.mode === 'hidden') return;
    const q = view.query.toLowerCase();
    const match = (c) => !q || `${c.name} ${c.description} ${c.languages.join(' ')}`.toLowerCase().includes(q);
    const servers = catalog.filter((c) => c.kind !== 'tool' && match(c));
    const toolsList = catalog.filter((c) => c.kind === 'tool' && match(c));
    const section = (title, note, items, empty) => `<div class="ext__section">${title} <span class="ext__src">${note}</span></div>` +
      (items.length ? items.map(card).join('') : `<p class="scm__empty">${empty}</p>`);
    if (view.mode === 'servers') listEl.innerHTML = section('Language support', 'language servers', servers, 'Nothing matches.');
    else if (view.mode === 'tools') listEl.innerHTML = section('Formatters &amp; linters', 'ESLint uses each project’s own', toolsList, 'Nothing matches.');
    else if (view.mode === 'installed') {
      listEl.innerHTML =
        section('Language support', 'installed', servers.filter((c) => c.installed || progress.has(c.id)), 'No language support installed yet — see the Languages tab.') +
        section('Formatters &amp; linters', 'installed', toolsList.filter((c) => c.installed || progress.has(c.id)), 'No formatters installed yet — see the Formatters tab.');
    }
  }

  listEl?.addEventListener('click', (e) => {
    const i = e.target.closest('[data-lang-install]');
    const u = e.target.closest('[data-lang-uninstall]');
    const r = e.target.closest('[data-lang-restart]');
    if (i) install(i.dataset.langInstall);
    if (u) uninstall(u.dataset.langUninstall);
    if (r) {
      const id = r.dataset.langRestart;
      stop(id).then(() => {
        const model = getActiveModel();
        const lang = model && catalog.find((c) => c.id === id)?.languages.includes(model.getLanguageId()) ? model.getLanguageId() : catalog.find((c) => c.id === id).languages[0];
        crashed.delete(id);
        ensureFor(lang);
      });
    }
  });

  // footer: state of language support for the open file's language
  function paintStatus() {
    if (!statusEl) return;
    const model = getActiveModel();
    const entry = model && entryForLang(model.getLanguageId());
    if (!entry) { statusEl.hidden = true; return; }
    statusEl.hidden = false;
    let text;
    let cls = '';
    let title;
    if (progress.has(entry.id)) { text = `Installing ${entry.name}… ${progress.get(entry.id).pct}%`; title = 'Installing language support'; }
    else if (!entry.installed) { text = `Install ${entry.name} support`; cls = 'is-cta'; title = 'Get IntelliSense, go to definition and real errors'; }
    else if (crashed.has(entry.id)) { text = `⚠ ${entry.name}`; cls = 'is-error'; title = 'Language server stopped — click to restart'; }
    else if (clients.get(entry.id)?.state === 'running') { text = `● ${entry.name}`; cls = 'is-ok'; title = 'Language server running'; }
    else { text = `◌ ${entry.name}`; title = 'Starting language server…'; }
    statusEl.textContent = text;
    statusEl.className = `footbtn lang-status ${cls}`;
    statusEl.title = title;
    statusEl.dataset.id = entry.id;
  }

  statusEl?.addEventListener('click', () => {
    const entry = catalog.find((c) => c.id === statusEl.dataset.id);
    if (!entry) return;
    if (!entry.installed) { showExtensions(); install(entry.id); }
    else if (crashed.has(entry.id) || !clients.has(entry.id)) { crashed.delete(entry.id); const m = getActiveModel(); if (m) ensureFor(m.getLanguageId()); }
    else showExtensions();
  });

  reload();

  return {
    // called by the shell whenever a file becomes the active editor
    onFileOpened(model) { if (model) ensureFor(model.getLanguageId()); paintStatus(); },
    onFileSaved(model) { for (const c of clients.values()) c.didSave(model); },
    onProjectClosed() { clientRoot = null; queue = queue.then(() => stopAll()).catch(() => {}); },
    refreshStatus: paintStatus,
    // symbols for breadcrumbs from the running server for this file, if any
    async symbolsFor(model) {
      const entry = model && entryForLang(model.getLanguageId());
      const client = entry && clients.get(entry.id);
      return client && client.state === 'running' ? client.documentSymbols(model) : null;
    },
    setView(tabName, query = '') {
      view = { mode: { Languages: 'servers', Formatters: 'tools', Installed: 'installed' }[tabName] || 'hidden', query };
      render();
    }
  };
}
