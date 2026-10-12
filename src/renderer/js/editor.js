// y-monaco imports monaco-editor's ESM build directly (for its own Range/
// Selection classes), so esbuild pulls the full editor into the bundle
// regardless of how we load it here — there's no bundle-size win left in
// keeping our own import separate, so `monaco` is just imported normally.
//
// Language services (type checking, IntelliSense, hovers, diagnostics) run
// in real Web Workers — monacoEnv.js points Monaco at them and must load
// before monaco-editor, hence the import order.
import './monacoEnv.js';
import { builtinSemanticRules } from './semanticTokens.js';
import * as monaco from 'monaco-editor';
import * as Y from 'yjs';
import { MonacoBinding } from 'y-monaco';
import { FirebaseProvider } from './sync.js';
import { monacoOptionsFromSettings } from './settings.js';

let themesDefined = false;
let languagesConfigured = false;

// Monaco's TypeScript mode reads its feature switches only once, when it
// first loads. When the JS/TS language server is installed (flag cached by
// languageSupport.js), the built-in completions/hovers/definitions are
// turned off up front so nothing is offered twice.
export const TS_LSP_FLAG = 'multeam:tsLanguageServer';
const TS_SERVER_FEATURES = ['completionItems', 'hovers', 'definitions', 'references', 'rename', 'diagnostics', 'signatureHelp', 'codeActions', 'inlayHints'];
let builtinTsAtBoot = true;
export function builtinTsEnabledAtBoot() { return builtinTsAtBoot; }

// One-time TS/JS language-service setup. Each open file is checked on its
// own (only one model is alive at a time), so "Cannot find module" for
// relative imports would be pure noise and is suppressed.
function configureLanguages() {
  if (languagesConfigured) return;
  languagesConfigured = true;

  const ts = monaco.languages.typescript;
  let useServer = false;
  try { useServer = localStorage.getItem(TS_LSP_FLAG) === '1'; } catch { /* default: built-in */ }
  if (useServer) {
    builtinTsAtBoot = false;
    const cfg = {
      documentSymbols: true, documentHighlights: true, documentRangeFormattingEdits: true, onTypeFormattingEdits: true,
      ...Object.fromEntries(TS_SERVER_FEATURES.map((f) => [f, false]))
    };
    ts.typescriptDefaults.setModeConfiguration(cfg);
    ts.javascriptDefaults.setModeConfiguration(cfg);
  }
  const compilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    jsx: ts.JsxEmit.ReactJSX,
    allowJs: true,
    allowNonTsExtensions: true,
    esModuleInterop: true,
    strict: true,
    skipLibCheck: true
  };
  const diagnosticsOptions = {
    noSemanticValidation: false,
    noSyntaxValidation: false,
    diagnosticCodesToIgnore: [2307, 2792] // can't resolve module (no project-wide graph yet)
  };
  ts.typescriptDefaults.setCompilerOptions(compilerOptions);
  ts.typescriptDefaults.setDiagnosticsOptions(diagnosticsOptions);
  // JS gets type-aware suggestions but only syntax errors by default —
  // semantic checks on plain JS (checkJs) are opt-in in real projects too.
  ts.javascriptDefaults.setCompilerOptions({ ...compilerOptions, checkJs: false });
  ts.javascriptDefaults.setDiagnosticsOptions({ ...diagnosticsOptions, noSemanticValidation: true });
  ts.typescriptDefaults.setEagerModelSync(true);
  ts.javascriptDefaults.setEagerModelSync(true);
}

// Matches the app shell's light/dark tokens (see style.css / theme.js)
// instead of shipping Monaco's stock vs/vs-dark look.
function defineMulteamThemes() {
  if (themesDefined) return;
  themesDefined = true;

  monaco.editor.defineTheme('multeam-light', {
    base: 'vs',
    inherit: true,
    rules: builtinSemanticRules(false),
    colors: {
      'editor.background': '#fbfcff',
      'editor.lineHighlightBackground': '#00000005',
      'editor.lineHighlightBorder': '#00000000',
      'editorGutter.background': '#fbfcff',
      'editorLineNumber.foreground': '#00000040',
      'editorLineNumber.activeForeground': '#000000a6',
      'editorCursor.foreground': '#6d4aff',
      'editor.selectionBackground': '#a78bfa33',
      'minimap.background': '#fbfcff'
    }
  });

  monaco.editor.defineTheme('multeam-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: builtinSemanticRules(true),
    colors: {
      'editor.background': '#0e0f13',
      'editor.lineHighlightBackground': '#ffffff07',
      'editor.lineHighlightBorder': '#00000000',
      'editorGutter.background': '#0e0f13',
      'editorLineNumber.foreground': '#ffffff40',
      'editorLineNumber.activeForeground': '#ffffffb3',
      'editorCursor.foreground': '#8b6bff',
      'editor.selectionBackground': '#8b6bff33',
      'minimap.background': '#0e0f13'
    }
  });
}

// An installed color theme (extensions.js) overrides the built-in pair;
// null = MulTeam's own light/dark, following the app theme.
let customThemeName = null;
export function setCustomEditorTheme(name) { customThemeName = name; }
function monacoThemeFor(appTheme) {
  return customThemeName || (appTheme === 'dark' ? 'multeam-dark' : 'multeam-light');
}

// Called by shell.js whenever the app theme toggles, so the currently open
// editor (if any) re-themes along with everything else.
export function setMonacoTheme(theme) {
  defineMulteamThemes();
  monaco.editor.setTheme(monacoThemeFor(theme));
}

// Diagnostics for every file-backed model (the language services publish
// them as "markers"). Calls back immediately and on every change.
export function watchMarkers(callback) {
  const emit = () => callback(monaco.editor.getModelMarkers({}).filter((m) => m.resource.scheme === 'file'));
  const sub = monaco.editor.onDidChangeMarkers(emit);
  emit();
  return () => sub.dispose();
}

export const MarkerSeverity = monaco.MarkerSeverity;


// ------------------------------------------------------------------
// One open FILE (shared by every editor group showing it): the text model,
// live-collaboration plumbing (Yjs + Firebase) and the copy known on disk.
// ------------------------------------------------------------------
export class FileDocument {
  // live: { projectId, fileKey } for cloud projects; onDenied(err) when the
  // live document can't be reached (not a member, rules, offline…)
  constructor(filePath, { live = null, currentUser, collaborative = false, onDenied } = {}) {
    Object.assign(this, { filePath, live, currentUser, collaborative, onDenied });
    this.ydoc = collaborative ? new Y.Doc() : null;
    this.provider = null;
    this.binding = null;
    this.model = null;
    this.diskText = '';
    this.editors = new Set();
  }

  init(initialContent = '') {
    defineMulteamThemes();
    configureLanguages();
    // The model's URI is the real file path, so the TS service knows .tsx
    // from .ts (JSX), and diagnostics/markers can be traced back to a file.
    const uri = monaco.Uri.file(this.filePath);
    monaco.editor.getModel(uri)?.dispose();
    // Purely local (non-cloud) projects never touch Yjs/Firebase at all.
    this.model = monaco.editor.createModel(this.collaborative ? '' : initialContent, undefined, uri);
    this.diskText = initialContent;
    if (!this.collaborative) return this;

    const yText = this.ydoc.getText('monaco');
    // The provider seeds the live doc from disk only if none exists yet (once,
    // by transaction); otherwise the shared text arrives from Firebase.
    this.provider = new FirebaseProvider({ ...this.live, seedText: initialContent }, this.ydoc, { onDenied: this.onDenied });
    // The editors set is live: views added later get remote cursors too.
    this.binding = new MonacoBinding(yText, this.model, this.editors, this.provider.awareness);
    this.provider.awareness.on('change', this.binding._rerenderDecorations);
    return this;
  }

  // Called by each EditorView showing this file.
  attach(editor) {
    this.editors.add(editor);
    if (!this.binding) return;
    // broadcast this view's cursor/selection to collaborators
    const ytext = this.binding.ytext;
    editor.onDidChangeCursorSelection(() => {
      if (editor.getModel() !== this.model || !this.editors.has(editor)) return;
      const sel = editor.getSelection();
      if (!sel) return;
      let anchor = this.model.getOffsetAt(sel.getStartPosition());
      let head = this.model.getOffsetAt(sel.getEndPosition());
      if (sel.getDirection() === monaco.SelectionDirection.RTL) [anchor, head] = [head, anchor];
      this.provider.awareness.setLocalStateField('selection', {
        anchor: Y.createRelativePositionFromTypeIndex(ytext, anchor),
        head: Y.createRelativePositionFromTypeIndex(ytext, head)
      });
    });
    this.binding._rerenderDecorations();
  }

  detach(editor) { this.editors.delete(editor); }

  getValue() { return this.model.getValue(); }
  getAwareness() { return this.provider ? this.provider.awareness : null; }

  destroy() {
    if (this.provider && this.binding) this.provider.awareness.off('change', this.binding._rerenderDecorations);
    if (this.binding) this.binding.destroy();
    if (this.provider) this.provider.destroy();
    if (this.model && !this.model.isDisposed()) this.model.dispose();
    if (this.ydoc) this.ydoc.destroy();
    this.editors.clear();
  }
}

// ------------------------------------------------------------------
// One Monaco editor showing a FileDocument inside an editor group. Keeps the
// method names the rest of the app already uses (activeWorkspace.*).
// ------------------------------------------------------------------
export class EditorView {
  constructor(container, doc, theme = 'light') {
    this.doc = doc;
    this.filePath = doc.filePath;
    this.editor = monaco.editor.create(container, {
      model: doc.model,
      theme: monacoThemeFor(theme),
      automaticLayout: true,
      padding: { top: 16, bottom: 16 },
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      cursorSmoothCaretAnimation: 'on',
      scrollBeyondLastLine: false,
      renderLineHighlight: 'all',
      'semanticHighlighting.enabled': true, // language-server colors for functions, params, properties…
      ...monacoOptionsFromSettings()
    });
    doc.attach(this.editor);
  }

  get diskText() { return this.doc.diskText; }
  set diskText(v) { this.doc.diskText = v; }

  // Moves the cursor to a position (optionally selecting `length` chars,
  // e.g. a search hit) and scrolls it into view.
  revealPosition(lineNumber, column, length = 0) {
    this.editor.revealLineInCenterIfOutsideViewport(lineNumber);
    this.editor.setSelection({ startLineNumber: lineNumber, startColumn: column, endLineNumber: lineNumber, endColumn: column + length });
    this.editor.focus();
  }

  // full (possibly multi-line) selection — used by the plugin API
  selectionText() {
    const sel = this.editor.getSelection();
    return sel ? this.editor.getModel().getValueInRange(sel) : '';
  }

  replaceSelection(text) {
    this.editor.pushUndoStop();
    this.editor.executeEdits('plugin', [{ range: this.editor.getSelection(), text, forceMoveMarkers: true }]);
    this.editor.pushUndoStop();
  }

  insertText(text) {
    const p = this.editor.getPosition();
    this.editor.pushUndoStop();
    this.editor.executeEdits('plugin', [{ range: new monaco.Range(p.lineNumber, p.column, p.lineNumber, p.column), text, forceMoveMarkers: true }]);
    this.editor.pushUndoStop();
  }

  languageId() { return this.editor.getModel().getLanguageId(); }

  selectedText() {
    const sel = this.editor.getSelection();
    return sel && !sel.isEmpty() && sel.startLineNumber === sel.endLineNumber ? this.editor.getModel().getValueInRange(sel) : '';
  }

  applyEditorSettings(monacoOptions) { this.editor.updateOptions(monacoOptions); }
  getAwareness() { return this.doc.getAwareness(); }
  getValue() { return this.doc.getValue(); }

  // the view only — the document lives on while another group shows it
  destroy() {
    this.doc.detach(this.editor);
    this.editor.dispose();
  }
}
