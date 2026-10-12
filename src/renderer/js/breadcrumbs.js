// Breadcrumbs above the editor: project › folders › file › symbol path at the
// cursor (like VS Code). Symbols come from the running language server, or
// from Monaco's built-in TypeScript engine for JS/TS.
import * as monaco from 'monaco-editor';

const CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>';

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// TypeScript navigation tree → normalized symbols
function fromNavTree(model, item) {
  const span = item.spans?.[0];
  if (!span) return null;
  const s = model.getPositionAt(span.start);
  const e = model.getPositionAt(span.start + span.length);
  return {
    name: item.text,
    start: { line: s.lineNumber, col: s.column }, end: { line: e.lineNumber, col: e.column },
    children: (item.childItems || []).map((c) => fromNavTree(model, c)).filter(Boolean)
  };
}

async function tsSymbols(model) {
  const lang = model.getLanguageId();
  if (lang !== 'typescript' && lang !== 'javascript') return null;
  try {
    const ts = monaco.languages.typescript;
    const getWorker = lang === 'typescript' ? ts.getTypeScriptWorker : ts.getJavaScriptWorker;
    const worker = await (await getWorker())(model.uri);
    const tree = await worker.getNavigationTree(model.uri.toString());
    return (tree?.childItems || []).map((c) => fromNavTree(model, c)).filter(Boolean);
  } catch { return null; }
}

const contains = (sym, pos) => {
  const afterStart = pos.lineNumber > sym.start.line || (pos.lineNumber === sym.start.line && pos.column >= sym.start.col);
  const beforeEnd = pos.lineNumber < sym.end.line || (pos.lineNumber === sym.end.line && pos.column <= sym.end.col);
  return afterStart && beforeEnd;
};

function pathAt(symbols, pos) {
  const out = [];
  let level = symbols || [];
  for (;;) {
    const hit = level.find((s) => contains(s, pos));
    if (!hit) return out;
    out.push(hit);
    level = hit.children || [];
  }
}

export function initBreadcrumbs({ el, getRoot, getProjectName, lspSymbols, onReveal }) {
  let editor = null;
  let filePath = null;
  let symbols = null;
  let symbolsVersion = -1;
  let subs = [];
  let cursorTimer = null;
  let symTimer = null;
  let trail = []; // symbol path currently shown

  function segments() {
    const root = getRoot();
    if (!filePath) return [];
    const rel = root ? filePath.slice(root.length).replace(/^[\\/]/, '') : filePath;
    const parts = rel.split(/[\\/]/).filter(Boolean);
    const sep = filePath.includes('\\') ? '\\' : '/';
    const segs = [];
    if (root) segs.push({ kind: 'root', label: getProjectName() || root.split(/[\\/]/).pop(), path: root });
    let cur = root ? root.replace(/[\\/]+$/, '') : '';
    parts.forEach((p, i) => {
      cur = cur ? cur + sep + p : p;
      segs.push({ kind: i === parts.length - 1 ? 'file' : 'dir', label: p, path: cur });
    });
    return segs;
  }

  function render() {
    if (!filePath) { el.innerHTML = ''; return; }
    const segs = segments();
    const pos = editor?.getPosition();
    trail = symbols && pos ? pathAt(symbols, pos) : [];
    el.innerHTML = [
      ...segs.map((s, i) => `<button type="button" class="crumb ${s.kind === 'file' ? 'is-file' : ''}" data-crumb="path" data-i="${i}" title="${escapeHtml(s.path)}">${escapeHtml(s.label)}</button>`),
      ...trail.map((s, i) => `<button type="button" class="crumb is-symbol" data-crumb="sym" data-i="${i}">${escapeHtml(s.name)}</button>`)
    ].join(`<span class="crumb__sep">${CHEVRON}</span>`);
    el._segs = segs;
    // keep the end (current symbol) visible when the trail is long
    el.scrollLeft = el.scrollWidth;
  }

  async function refreshSymbols() {
    const model = editor?.getModel();
    if (!model) return;
    const version = model.getVersionId();
    if (version === symbolsVersion && symbols) return render();
    const fromServer = await lspSymbols(model);
    const next = fromServer || (await tsSymbols(model));
    if (editor?.getModel() !== model) return;
    symbols = next;
    symbolsVersion = version;
    render();
  }

  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-crumb]');
    if (!b) return;
    const i = Number(b.dataset.i);
    if (b.dataset.crumb === 'path') onReveal(el._segs[i].path);
    else {
      const s = trail[i];
      if (s && editor) {
        editor.revealLineInCenterIfOutsideViewport(s.start.line);
        editor.setPosition({ lineNumber: s.start.line, column: s.start.col });
        editor.focus();
      }
    }
  });

  return {
    // called whenever the active editor changes (null = no file open)
    setEditor(nextEditor, nextPath) {
      subs.forEach((d) => d.dispose());
      subs = [];
      editor = nextEditor;
      filePath = nextEditor ? nextPath : null;
      symbols = null;
      symbolsVersion = -1;
      render();
      if (!nextEditor) return;
      subs.push(nextEditor.onDidChangeCursorPosition(() => { clearTimeout(cursorTimer); cursorTimer = setTimeout(render, 80); }));
      subs.push(nextEditor.onDidChangeModelContent(() => { clearTimeout(symTimer); symTimer = setTimeout(refreshSymbols, 600); }));
      setTimeout(refreshSymbols, 300);
    },
    refresh: () => refreshSymbols()
  };
}
