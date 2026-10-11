// y-monaco imports monaco-editor's ESM build directly (for its own Range/
// Selection classes), so esbuild pulls the full editor into the bundle
// regardless of how we load it here — there's no bundle-size win left in
// keeping our own import separate, so `monaco` is just imported normally.
//
// Language services (type checking, IntelliSense, hovers, diagnostics) run
// in real Web Workers — monacoEnv.js points Monaco at them and must load
// before monaco-editor, hence the import order.
import './monacoEnv.js';
import * as monaco from 'monaco-editor';
import * as Y from 'yjs';
import { MonacoBinding } from 'y-monaco';
import { FirebaseProvider } from './sync.js';
import { monacoOptionsFromSettings } from './settings.js';

let themesDefined = false;
let languagesConfigured = false;

// One-time TS/JS language-service setup. Each open file is checked on its
// own (only one model is alive at a time), so "Cannot find module" for
// relative imports would be pure noise and is suppressed.
function configureLanguages() {
  if (languagesConfigured) return;
  languagesConfigured = true;

  const ts = monaco.languages.typescript;
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
    rules: [],
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
    rules: [],
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

function languageFromPath(filePath) {
  const ext = filePath.split('.').pop();
  const map = {
    js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
    json: 'json', html: 'html', css: 'css', md: 'markdown', py: 'python'
  };
  return map[ext] || 'plaintext';
}

export class CollaborativeWorkspace {
  constructor(containerElement, { docId, filePath, currentUser, collaborative = true }) {
    this.container = containerElement;
    this.docId = docId;
    this.filePath = filePath;
    this.currentUser = currentUser;
    this.collaborative = collaborative;

    this.doc = collaborative ? new Y.Doc() : null;
    this.provider = null;
    this.binding = null;
    this.editor = null;
    this.model = null;
  }

  initialize(initialContent = '', theme = 'light') {
    defineMulteamThemes();
    configureLanguages();

    // The model's URI is the real file path, so the TS service knows .tsx
    // from .ts (JSX), and diagnostics/markers can be traced back to a file.
    const uri = monaco.Uri.file(this.filePath);
    monaco.editor.getModel(uri)?.dispose();
    this.model = monaco.editor.createModel(
      // Purely local (non-cloud) projects never touch Yjs/Firebase at all —
      // just a plain Monaco editor seeded straight from disk content.
      this.collaborative ? '' : initialContent,
      languageFromPath(this.filePath),
      uri
    );

    this.editor = monaco.editor.create(this.container, {
      model: this.model,
      theme: monacoThemeFor(theme),
      automaticLayout: true,
      padding: { top: 16, bottom: 16 },
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      cursorSmoothCaretAnimation: 'on',
      scrollBeyondLastLine: false,
      renderLineHighlight: 'all',
      ...monacoOptionsFromSettings()
    });

    if (!this.collaborative) return this;

    const yText = this.doc.getText('monaco');

    // Seed the shared type from disk only if no one has synced content yet —
    // otherwise every new peer opening the file would stomp the live doc.
    if (yText.length === 0 && initialContent) {
      yText.insert(0, initialContent);
    }

    this.provider = new FirebaseProvider(this.docId, this.doc);

    this.binding = new MonacoBinding(
      yText,
      this.editor.getModel(),
      new Set([this.editor]),
      this.provider.awareness
    );

    return this;
  }

  // Moves the cursor to a position (optionally selecting `length` chars,
  // e.g. a search hit) and scrolls it into view.
  revealPosition(lineNumber, column, length = 0) {
    if (!this.editor) return;
    this.editor.revealLineInCenterIfOutsideViewport(lineNumber);
    this.editor.setSelection({ startLineNumber: lineNumber, startColumn: column, endLineNumber: lineNumber, endColumn: column + length });
    this.editor.focus();
  }

  // full (possibly multi-line) selection — used by the plugin API
  selectionText() {
    const sel = this.editor?.getSelection();
    return sel ? this.editor.getModel().getValueInRange(sel) : '';
  }

  replaceSelection(text) {
    if (!this.editor) return;
    this.editor.pushUndoStop();
    this.editor.executeEdits('plugin', [{ range: this.editor.getSelection(), text, forceMoveMarkers: true }]);
    this.editor.pushUndoStop();
  }

  insertText(text) {
    if (!this.editor) return;
    const p = this.editor.getPosition();
    this.editor.pushUndoStop();
    this.editor.executeEdits('plugin', [{ range: new monaco.Range(p.lineNumber, p.column, p.lineNumber, p.column), text, forceMoveMarkers: true }]);
    this.editor.pushUndoStop();
  }

  languageId() {
    return this.editor ? this.editor.getModel().getLanguageId() : null;
  }

  selectedText() {
    if (!this.editor) return '';
    const sel = this.editor.getSelection();
    return sel && !sel.isEmpty() && sel.startLineNumber === sel.endLineNumber ? this.editor.getModel().getValueInRange(sel) : '';
  }

  applyEditorSettings(monacoOptions) {
    if (this.editor) this.editor.updateOptions(monacoOptions);
  }

  getAwareness() {
    return this.provider ? this.provider.awareness : null;
  }

  getValue() {
    return this.editor.getModel().getValue();
  }

  destroy() {
    if (this.binding) this.binding.destroy();
    if (this.provider) this.provider.destroy();
    if (this.editor) this.editor.dispose();
    if (this.model) this.model.dispose();
    if (this.doc) this.doc.destroy();
  }
}
