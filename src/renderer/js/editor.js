// y-monaco imports monaco-editor's ESM build directly (for its own Range/
// Selection classes), so esbuild pulls the full editor into the bundle
// regardless of how we load it here — there's no bundle-size win left in
// keeping our own import separate, so `monaco` is just imported normally.
//
// KNOWN LIMITATION: no MonacoEnvironment.getWorkerUrl/getWorker is configured,
// so Monaco falls back to running its language workers (JSON/CSS/TS
// suggestions, etc.) on the main thread with a console warning instead of a
// real Worker. Editing, syntax highlighting and folding all work fine either
// way; wiring real workers is a bundler-config task for when that degraded
// mode actually becomes a problem.
import * as monaco from 'monaco-editor';
import * as Y from 'yjs';
import { MonacoBinding } from 'y-monaco';
import { FirebaseProvider } from './sync.js';

let themeDefined = false;

// White editing surface for now (chrome around it — sidebar/tabs/living-room
// bar — stays the dark purple theme). Revisit once a final look is picked.
function defineMulteamTheme() {
  if (themeDefined) return;
  themeDefined = true;

  monaco.editor.defineTheme('multeam-light', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#ffffff',
      'editor.lineHighlightBackground': '#f4f4fa',
      'editorGutter.background': '#ffffff',
      'editorCursor.foreground': '#6b4ef0',
      'editor.selectionBackground': '#c7b9f755'
    }
  });
}

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
  }

  initialize(initialContent = '') {
    defineMulteamTheme();

    // Purely local (non-cloud) projects never touch Yjs/Firebase at all —
    // just a plain Monaco editor seeded straight from disk content.
    this.editor = monaco.editor.create(this.container, {
      value: this.collaborative ? '' : initialContent,
      language: languageFromPath(this.filePath),
      theme: 'multeam-light',
      automaticLayout: true,
      tabSize: 2,
      fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, Consolas, monospace",
      fontSize: 14,
      lineHeight: 22,
      padding: { top: 16, bottom: 16 },
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      cursorSmoothCaretAnimation: 'on',
      scrollBeyondLastLine: false,
      minimap: { enabled: true, scale: 1 },
      renderLineHighlight: 'all'
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
    if (this.doc) this.doc.destroy();
  }
}
