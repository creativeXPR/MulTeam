// Formatters + linters in the editor.
//   Formatting: Prettier / Ruff become Monaco document formatters, so Edit →
//   Format Document, Shift+Alt+F and format-on-save use them. Languages
//   without one fall back to their language server's formatter (clangd,
//   Java, PHP, C#), registered in lspClient.js.
//   Linting: Ruff (Python) and the project's own ESLint (JS/TS) report into
//   the Problems panel; ESLint runs only after the user allows it per project.
import * as monaco from 'monaco-editor';

const ESLINT_KEY = 'multeam:eslintAllowed'; // { "<project root>": true|false }
const LINT_DELAY = 800;
const SEVERITY = { error: monaco.MarkerSeverity.Error, warning: monaco.MarkerSeverity.Warning, info: monaco.MarkerSeverity.Info };

const clean = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export function initFormatting({ toast, confirmDialog, getRoot }) {
  const api = window.electronAPI?.tools;
  let tools = [];
  const providers = [];
  const timers = new Map();      // model uri -> timeout
  const warned = new Set();      // tool ids we already reported a failure for

  const installedTool = (id) => tools.find((t) => t.id === id && t.installed);
  const formatterFor = (lang) => tools.find((t) => t.installed && t.languages.includes(lang));

  // ---------- formatting ----------
  async function formatWith(tool, model) {
    const text = model.getValue();
    try {
      const out = await api.format(tool.id, model.uri.fsPath, text, getRoot());
      if (model.isDisposed() || model.getValue() !== text || out === text) return []; // edited meanwhile, or nothing to do
      return [{ range: model.getFullModelRange(), text: out }];
    } catch (err) {
      toast(`${tool.name}: ${clean(err)}`, 'error');
      return [];
    }
  }

  function setCatalog(catalog) {
    tools = catalog.filter((c) => c.kind === 'tool');
    providers.splice(0).forEach((d) => d.dispose());
    for (const t of tools.filter((x) => x.installed)) {
      for (const lang of t.languages) {
        providers.push(monaco.languages.registerDocumentFormattingEditProvider(lang, {
          displayName: t.name,
          provideDocumentFormattingEdits: (model) => formatWith(t, model)
        }));
      }
    }
    for (const m of monaco.editor.getModels()) scheduleLint(m, 0);
  }

  // ---------- ESLint permission (runs project code) ----------
  function readAllowed() { try { return JSON.parse(localStorage.getItem(ESLINT_KEY) || '{}'); } catch { return {}; } }
  const asking = new Map();
  async function eslintAllowed(root) {
    const key = root || '(no project)';
    const saved = readAllowed();
    if (key in saved) return saved[key];
    if (!asking.has(key)) {
      asking.set(key, (async () => {
        const ok = await confirmDialog({
          title: 'Run this project’s ESLint?',
          message: 'This project has ESLint installed. Allowing it shows lint problems in the Problems panel, and runs the project’s own ESLint configuration (JavaScript code) on this computer. Only allow it for projects you trust.',
          confirmLabel: 'Allow ESLint'
        });
        const next = readAllowed();
        next[key] = ok;
        try { localStorage.setItem(ESLINT_KEY, JSON.stringify(next)); } catch { /* non-fatal */ }
        asking.delete(key);
        return ok;
      })());
    }
    return asking.get(key);
  }

  // ---------- linting ----------
  function toMarkers(diags) {
    return diags.map((d) => ({
      severity: SEVERITY[d.severity] ?? monaco.MarkerSeverity.Warning,
      message: d.message,
      code: d.code || undefined,
      startLineNumber: d.startLine, startColumn: d.startColumn,
      endLineNumber: Math.max(d.endLine, d.startLine), endColumn: d.endLine === d.startLine ? Math.max(d.endColumn, d.startColumn + 1) : d.endColumn
    }));
  }

  async function runLinter(id, model) {
    const text = model.getValue();
    try {
      const res = await api.lint(id, model.uri.fsPath, text, getRoot());
      if (model.isDisposed() || model.getValue() !== text) return; // stale
      monaco.editor.setModelMarkers(model, id, toMarkers(res.diagnostics || []));
    } catch (err) {
      if (!model.isDisposed()) monaco.editor.setModelMarkers(model, id, []);
      if (!warned.has(id)) { warned.add(id); toast(`${id === 'eslint' ? 'ESLint' : 'Ruff'}: ${clean(err)}`, 'error'); }
    }
  }

  async function lintModel(model) {
    if (!api || !model || model.isDisposed() || model.uri.scheme !== 'file') return;
    const lang = model.getLanguageId();
    const root = getRoot();

    if (lang === 'python' && installedTool('ruff')) await runLinter('ruff', model);
    else monaco.editor.setModelMarkers(model, 'ruff', []);

    if (lang === 'javascript' || lang === 'typescript') {
      const has = await api.hasEslint(model.uri.fsPath, root).catch(() => false);
      if (has && await eslintAllowed(root)) await runLinter('eslint', model);
      else monaco.editor.setModelMarkers(model, 'eslint', []);
    }
  }

  function scheduleLint(model, delay = LINT_DELAY) {
    const key = model.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => { timers.delete(key); lintModel(model); }, delay));
  }

  monaco.editor.onDidCreateModel((model) => {
    if (model.uri.scheme !== 'file') return;
    const sub = model.onDidChangeContent(() => scheduleLint(model));
    model.onWillDispose(() => { sub.dispose(); clearTimeout(timers.get(model.uri.toString())); timers.delete(model.uri.toString()); });
    scheduleLint(model, 300);
  });

  return {
    setCatalog,
    hasFormatter: (lang) => !!formatterFor(lang),
    lintNow: (model) => lintModel(model),
    resetEslintPermission() { try { localStorage.removeItem(ESLINT_KEY); } catch { /* ignore */ } toast('ESLint will ask again for each project'); }
  };
}
