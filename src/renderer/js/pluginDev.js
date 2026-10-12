// Plugin debug engine — the bottom panel's "Plugin" tab.
//   Check  → static checks from main/pluginLint.js (manifest, syntax, API
//            names, permissions, sandbox), shown here, as editor squiggles
//            and in Problems.
//   Output → the plugin's console.*, crashes, failed commands and reloads,
//            streamed live from the sandbox (pluginHost.js onLog).
// While a plugin's own project is open (Plugins workspace), saving any of
// its files re-checks it and — if "Reload on save" is on — restarts it.
import * as monaco from 'monaco-editor';

const OWNER = 'multeam-plugin';
const MAX_LOGS = 500;
const AUTO_KEY = 'multeam:pluginAutoReload';

const SEVERITY = {
  error: monaco.MarkerSeverity.Error,
  warning: monaco.MarkerSeverity.Warning,
  info: monaco.MarkerSeverity.Info
};

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();

export function initPluginDev({ getHost, openFileAt, openPanel, toast, getProject, joinPath }) {
  const api = window.electronAPI.plugins;
  const pane = document.getElementById('pluginDevPane');
  const tabCount = document.getElementById('pluginTabCount');

  let target = null;                 // plugin id the tab is showing
  const results = new Map();         // id -> { dir, diagnostics, at }
  const logs = new Map();            // id -> [{ level, text, at }]
  const markersByPath = new Map();   // norm(path) -> monaco markers
  let autoReload = true;
  try { autoReload = localStorage.getItem(AUTO_KEY) !== 'off'; } catch { /* default on */ }

  // ---------- editor markers ----------
  function applyMarkers(model) {
    const list = markersByPath.get(norm(model.uri.fsPath));
    monaco.editor.setModelMarkers(model, OWNER, list || []);
  }
  monaco.editor.onDidCreateModel((model) => applyMarkers(model));

  function setMarkers(dir, diagnostics) {
    // clear this plugin's old markers first
    for (const key of [...markersByPath.keys()]) if (key.startsWith(norm(dir) + '/')) markersByPath.delete(key);
    for (const d of diagnostics) {
      const key = norm(d.path);
      if (!markersByPath.has(key)) markersByPath.set(key, []);
      markersByPath.get(key).push({
        severity: SEVERITY[d.severity],
        message: d.message,
        code: d.code,
        source: 'plugin check',
        startLineNumber: d.line,
        startColumn: d.column || 1,
        endLineNumber: d.line,
        endColumn: d.endColumn || (d.column || 1) + 1
      });
    }
    for (const model of monaco.editor.getModels()) {
      if (norm(model.uri.fsPath).startsWith(norm(dir) + '/')) applyMarkers(model);
    }
  }

  // ---------- actions ----------
  async function check(id = target, { quiet = false } = {}) {
    if (!id) return null;
    try {
      const res = await api.check(id);
      results.set(id, { ...res, at: Date.now() });
      setMarkers(res.dir, res.diagnostics);
      if (!quiet) {
        const errors = res.diagnostics.filter((d) => d.severity === 'error').length;
        toast(errors ? `Plugin check: ${errors} error${errors === 1 ? '' : 's'}` : 'Plugin check passed ✓', errors ? 'error' : undefined);
      }
      render();
      return res;
    } catch (err) {
      toast(String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error');
      return null;
    }
  }

  async function reload(id = target) {
    if (!id) return;
    const res = await check(id, { quiet: true });
    const errors = res?.diagnostics.filter((d) => d.severity === 'error') || [];
    if (errors.length) {
      addLog(id, { level: 'error', text: `Not reloaded — fix ${errors.length} error${errors.length === 1 ? '' : 's'} from Check first.`, at: Date.now() });
      return;
    }
    await getHost()?.reload(id);
  }

  function addLog(id, entry) {
    if (!logs.has(id)) logs.set(id, []);
    const list = logs.get(id);
    list.push(entry);
    if (list.length > MAX_LOGS) list.splice(0, list.length - MAX_LOGS);
    if (id === target) render();
  }

  // Called after any file save: a save inside the open plugin project
  // re-checks it and (optionally) hot-reloads it.
  async function onSaved(filePath) {
    const p = getProject();
    if (!p?.pluginId || !norm(filePath).startsWith(norm(p.folderPath) + '/')) return;
    setTarget(p.pluginId);
    if (autoReload) await reload(p.pluginId);
    else await check(p.pluginId, { quiet: true });
  }

  function setTarget(id) {
    if (id && id !== target) { target = id; render(); }
  }

  // ---------- UI ----------
  function where(d) {
    return `${d.file}:${d.line}${d.column ? `:${d.column}` : ''}`;
  }

  // main.js:12:5 in log text → clickable
  function linkify(text, dir) {
    return escapeHtml(text).replace(/([\w./-]+\.(?:js|json)):(\d+)(?::(\d+))?/g, (m, file, line, col) =>
      dir ? `<button type="button" class="linkbtn" data-open="${escapeHtml(joinPath(dir, file))}" data-line="${line}" data-col="${col || 1}">${m}</button>` : m);
  }

  function render() {
    const host = getHost();
    const installed = host?.installed() || [];
    if (!target && installed.length) target = getProject()?.pluginId || installed[0].id;
    const res = results.get(target);
    const diags = res?.diagnostics || [];
    const errors = diags.filter((d) => d.severity === 'error').length;
    const warnings = diags.filter((d) => d.severity === 'warning').length;

    const allErrors = [...results.values()].reduce((n, r) => n + r.diagnostics.filter((d) => d.severity === 'error').length, 0);
    tabCount.textContent = allErrors;
    tabCount.hidden = allErrors === 0;

    if (!installed.length) {
      pane.innerHTML = '<div class="problems__empty">No plugins installed. Create one from Plugins → Templates, then press “Edit in MulTeam”.</div>';
      return;
    }

    const plugin = installed.find((p) => p.id === target);
    const running = host?.isRunning(target);
    const runtimeError = host?.runtimeError(target);
    const dir = res?.dir || plugin?.dir;
    const list = logs.get(target) || [];

    pane.innerHTML = `
      <div class="pdev__bar">
        <select class="pill sm" data-pdev="pick" aria-label="Plugin">
          ${installed.map((p) => `<option value="${escapeHtml(p.id)}" ${p.id === target ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
        </select>
        <span class="pdev__state ${running ? 'is-on' : ''}">${running ? '● running' : plugin?.enabled === false ? 'disabled' : '○ stopped'}</span>
        <button type="button" class="chipbtn is-primary" data-pdev="check">Check</button>
        <button type="button" class="chipbtn" data-pdev="reload" ${plugin?.enabled === false ? 'disabled' : ''}>Reload</button>
        <button type="button" class="chipbtn" data-pdev="clear">Clear output</button>
        <label class="pdev__auto" title="While this plugin's project is open, saving a file re-checks and reloads it">
          <button type="button" class="switch sm ${autoReload ? 'is-on' : ''}" data-pdev="auto" aria-label="Reload on save"></button>
          Reload on save
        </label>
      </div>
      <div class="pdev__cols">
        <section class="pdev__col">
          <div class="pdev__head">Check ${res ? `<span class="pdev__sum">${errors} error${errors === 1 ? '' : 's'} · ${warnings} warning${warnings === 1 ? '' : 's'}</span>` : '<span class="pdev__sum">not run yet</span>'}</div>
          ${runtimeError ? `<div class="pdev__item is-error"><span class="pdev__sev">runtime</span><span>${linkify(runtimeError, dir)}</span></div>` : ''}
          ${res ? (diags.length ? diags.map((d) => `
            <button type="button" class="pdev__item is-${d.severity}" data-open="${escapeHtml(d.path)}" data-line="${d.line}" data-col="${d.column || 1}">
              <span class="pdev__sev">${d.severity}</span>
              <span class="pdev__msg">${escapeHtml(d.message)}</span>
              <span class="pdev__where">${escapeHtml(where(d))}</span>
            </button>`).join('') : '<div class="problems__empty">No problems found ✓</div>') : '<div class="problems__empty">Press Check to lint the manifest and code.</div>'}
        </section>
        <section class="pdev__col">
          <div class="pdev__head">Output <span class="pdev__sum">${list.length} line${list.length === 1 ? '' : 's'}</span></div>
          <div class="pdev__log">${list.length ? list.map((l) => `<div class="pdev__line is-${escapeHtml(l.level)}"><span class="pdev__time">${new Date(l.at).toLocaleTimeString()}</span><span class="pdev__lvl">${escapeHtml(l.level)}</span><span class="pdev__text">${linkify(l.text, dir)}</span></div>`).join('') : '<div class="problems__empty">console.log / warn / error from the plugin shows up here.</div>'}</div>
        </section>
      </div>`;
    const logEl = pane.querySelector('.pdev__log');
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
  }

  pane.addEventListener('click', async (e) => {
    const open = e.target.closest('[data-open]');
    if (open) return openFileAt(open.dataset.open, Number(open.dataset.line) || 1, Number(open.dataset.col) || 1);
    const b = e.target.closest('[data-pdev]');
    if (!b) return;
    const act = b.dataset.pdev;
    if (act === 'check') check();
    if (act === 'reload') reload();
    if (act === 'clear') { logs.set(target, []); render(); }
    if (act === 'auto') {
      autoReload = !autoReload;
      try { localStorage.setItem(AUTO_KEY, autoReload ? 'on' : 'off'); } catch { /* not persisted */ }
      render();
    }
  });
  pane.addEventListener('change', (e) => {
    if (e.target.matches('[data-pdev="pick"]')) { target = e.target.value; render(); }
  });

  return {
    addLog,
    check,
    reload,
    onSaved,
    render,
    select: setTarget,
    // "Edit in MulTeam": point the tab at this plugin, check it, show the panel.
    async focus(id) {
      setTarget(id);
      target = id;
      openPanel();
      await check(id, { quiet: true });
    }
  };
}
