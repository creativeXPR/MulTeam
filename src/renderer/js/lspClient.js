// Minimal Language Server Protocol client for Monaco. One instance per
// running server (main/languages.js spawns it; messages travel over IPC).
// Covers what matters day to day: document sync, completions (+resolve),
// hover, signature help, go to definition, semantic highlighting and diagnostics.
import * as monaco from 'monaco-editor';
import { MONACO_LEGEND, STANDARD_TYPES, STANDARD_MODIFIERS, makeRemapper } from './semanticTokens.js';

const CompletionKind = monaco.languages.CompletionItemKind;
// LSP CompletionItemKind (1-based) -> Monaco
const KIND_MAP = [null, CompletionKind.Text, CompletionKind.Method, CompletionKind.Function, CompletionKind.Constructor, CompletionKind.Field,
  CompletionKind.Variable, CompletionKind.Class, CompletionKind.Interface, CompletionKind.Module, CompletionKind.Property, CompletionKind.Unit,
  CompletionKind.Value, CompletionKind.Enum, CompletionKind.Keyword, CompletionKind.Snippet, CompletionKind.Color, CompletionKind.File,
  CompletionKind.Reference, CompletionKind.Folder, CompletionKind.EnumMember, CompletionKind.Constant, CompletionKind.Struct,
  CompletionKind.Event, CompletionKind.Operator, CompletionKind.TypeParameter];
const SEVERITY = [null, monaco.MarkerSeverity.Error, monaco.MarkerSeverity.Warning, monaco.MarkerSeverity.Info, monaco.MarkerSeverity.Hint];

// Compare file URIs regardless of drive-letter case / %3A encoding.
export function uriKey(uri) {
  try { return monaco.Uri.parse(uri).fsPath.replace(/\\/g, '/').toLowerCase(); } catch { return String(uri).toLowerCase(); }
}

const toRange = (r) => new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);
const toPosition = (p) => ({ line: p.lineNumber - 1, character: p.column - 1 });

function markdownOf(content) {
  if (!content) return null;
  if (typeof content === 'string') return { value: content };
  if (Array.isArray(content)) {
    const value = content.map((c) => markdownOf(c)?.value).filter(Boolean).join('\n\n');
    return value ? { value } : null;
  }
  if (content.kind === 'markdown') return { value: content.value };
  if (content.kind === 'plaintext') return { value: content.value.replace(/[\\`*_{}[\]()#+\-.!]/g, '\\$&') };
  if (content.language) return { value: `\`\`\`${content.language}\n${content.value}\n\`\`\`` };
  return content.value ? { value: content.value } : null;
}

export class LspClient {
  constructor({ id, name, languages, rootPath, initializationOptions, api, onState, onDiagnosticsChange, shouldFormat = () => true }) {
    Object.assign(this, { id, name, languages, rootPath, initializationOptions, api, onState, onDiagnosticsChange, shouldFormat });
    this.seq = 0;
    this.pending = new Map();
    this.docs = new Map();        // uriKey -> { model, version, sub }
    this.disposables = [];
    this.capabilities = {};
    this.state = 'starting';
    this.diagnostics = new Map(); // uriKey -> lsp diagnostics
  }

  // ---------- transport ----------
  send(msg) { this.api.send(this.id, { jsonrpc: '2.0', ...msg }); }
  notify(method, params) { this.send({ method, params }); }
  request(method, params, timeoutMs = 15000) {
    const id = ++this.seq;
    this.send({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  handle(msg) {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && !msg.method) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      return;
    }
    if (msg.method && msg.id !== undefined) return this.handleServerRequest(msg);
    if (msg.method === 'textDocument/publishDiagnostics') return this.applyDiagnostics(msg.params);
    // window/logMessage, $/progress, telemetry… ignored
  }

  // Servers ask a few things back; answer the common ones so they don't stall.
  handleServerRequest(msg) {
    let result = null;
    if (msg.method === 'workspace/configuration') result = (msg.params?.items || []).map((it) => this.settingsFor(it.section));
    else if (msg.method === 'workspace/workspaceFolders') result = this.rootPath ? [{ uri: monaco.Uri.file(this.rootPath).toString(), name: this.rootPath.split(/[\\/]/).pop() }] : [];
    else if (msg.method === 'workspace/semanticTokens/refresh') this.semanticChanged?.fire();
    // client/registerCapability, window/workDoneProgress/create … → null is fine
    this.send({ id: msg.id, result });
  }

  // Settings servers ask for. Python defaults to "standard" checking — the
  // strictest mode flags ordinary code (e.g. every unused call result).
  settingsFor(section = '') {
    if (/^(basedpyright|python)\.analysis$/.test(section)) return { typeCheckingMode: 'standard', autoImportCompletions: true };
    if (section === 'basedpyright' || section === 'python') return { analysis: { typeCheckingMode: 'standard', autoImportCompletions: true } };
    return null;
  }

  // ---------- lifecycle ----------
  async start() {
    const rootUri = this.rootPath ? monaco.Uri.file(this.rootPath).toString() : null;
    const res = await this.request('initialize', {
      processId: null,
      clientInfo: { name: 'MulTeam' },
      rootUri,
      rootPath: this.rootPath || null,
      workspaceFolders: rootUri ? [{ uri: rootUri, name: this.rootPath.split(/[\\/]/).pop() }] : null,
      initializationOptions: this.initializationOptions || {},
      capabilities: {
        workspace: { configuration: true, workspaceFolders: true },
        textDocument: {
          synchronization: { didSave: true, dynamicRegistration: false },
          completion: { completionItem: { snippetSupport: true, labelDetailsSupport: true, documentationFormat: ['markdown', 'plaintext'], resolveSupport: { properties: ['documentation', 'detail'] } }, contextSupport: true },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          signatureHelp: { signatureInformation: { documentationFormat: ['markdown', 'plaintext'], parameterInformation: { labelOffsetSupport: true } } },
          definition: { linkSupport: false },
          formatting: { dynamicRegistration: false },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          semanticTokens: {
            dynamicRegistration: false,
            requests: { full: true, range: false },
            tokenTypes: STANDARD_TYPES,
            tokenModifiers: STANDARD_MODIFIERS,
            formats: ['relative'],
            overlappingTokenSupport: false,
            multilineTokenSupport: false
          },
          publishDiagnostics: { relatedInformation: false }
        }
      }
    }, 60000);
    this.capabilities = res?.capabilities || {};
    if (!this.semanticChanged) this.semanticChanged = new monaco.Emitter();
    this.notify('initialized', {});
    this.registerProviders();
    // pick up models that are already open
    monaco.editor.getModels().forEach((m) => this.maybeOpen(m));
    this.disposables.push(monaco.editor.onDidCreateModel((m) => this.maybeOpen(m)));
    this.disposables.push(monaco.editor.onWillDisposeModel((m) => this.close(m)));
    this.setState('running');
  }

  setState(state, detail = '') { this.state = state; this.onState?.(this, state, detail); }

  async stop() {
    try { await this.request('shutdown', null, 2000); this.notify('exit', null); } catch { /* server may already be gone */ }
    this.dispose();
  }

  dispose() {
    for (const d of this.disposables) d.dispose?.();
    this.disposables = [];
    for (const { sub } of this.docs.values()) sub.dispose();
    this.docs.clear();
    for (const m of monaco.editor.getModels()) monaco.editor.setModelMarkers(m, `lsp-${this.id}`, []);
    this.diagnostics.clear();
    this.onDiagnosticsChange?.();
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Language server stopped')); }
    this.pending.clear();
  }

  // ---------- documents ----------
  handles(model) { return model.uri.scheme === 'file' && this.languages.includes(model.getLanguageId()); }

  maybeOpen(model) {
    if (!this.handles(model)) return;
    const key = uriKey(model.uri.toString());
    if (this.docs.has(key)) return;
    const doc = { model, version: 1, timer: null };
    doc.sub = model.onDidChangeContent(() => {
      clearTimeout(doc.timer);
      doc.timer = setTimeout(() => {
        if (model.isDisposed()) return;
        doc.version += 1;
        this.notify('textDocument/didChange', { textDocument: { uri: model.uri.toString(), version: doc.version }, contentChanges: [{ text: model.getValue() }] });
      }, 150);
    });
    this.docs.set(key, doc);
    this.notify('textDocument/didOpen', { textDocument: { uri: model.uri.toString(), languageId: model.getLanguageId(), version: 1, text: model.getValue() } });
    this.applyStoredDiagnostics(model);
  }

  close(model) {
    const key = uriKey(model.uri.toString());
    const doc = this.docs.get(key);
    if (!doc) return;
    clearTimeout(doc.timer);
    doc.sub.dispose();
    this.docs.delete(key);
    this.notify('textDocument/didClose', { textDocument: { uri: model.uri.toString() } });
  }

  didSave(model) {
    if (this.docs.has(uriKey(model.uri.toString()))) this.notify('textDocument/didSave', { textDocument: { uri: model.uri.toString() } });
  }

  // flush pending edits before asking the server anything about the doc
  sync(model) {
    const doc = this.docs.get(uriKey(model.uri.toString()));
    if (doc?.timer) {
      clearTimeout(doc.timer);
      doc.timer = null;
      doc.version += 1;
      this.notify('textDocument/didChange', { textDocument: { uri: model.uri.toString(), version: doc.version }, contentChanges: [{ text: model.getValue() }] });
    }
  }

  // ---------- diagnostics ----------
  applyDiagnostics({ uri, diagnostics }) {
    this.diagnostics.set(uriKey(uri), diagnostics || []);
    const model = monaco.editor.getModels().find((m) => uriKey(m.uri.toString()) === uriKey(uri));
    if (model) this.applyStoredDiagnostics(model);
    this.onDiagnosticsChange?.();
  }

  applyStoredDiagnostics(model) {
    const list = this.diagnostics.get(uriKey(model.uri.toString())) || [];
    monaco.editor.setModelMarkers(model, `lsp-${this.id}`, list.map((d) => {
      const r = toRange(d.range);
      return {
        severity: SEVERITY[d.severity || 1] || monaco.MarkerSeverity.Error,
        message: d.message,
        source: d.source || this.name,
        code: d.code !== undefined ? String(d.code) : undefined,
        startLineNumber: r.startLineNumber, startColumn: r.startColumn, endLineNumber: r.endLineNumber, endColumn: r.endColumn
      };
    }));
  }

  // ---------- language features ----------
  registerProviders() {
    const caps = this.capabilities;
    for (const lang of this.languages) {
      if (caps.completionProvider) {
        this.disposables.push(monaco.languages.registerCompletionItemProvider(lang, {
          triggerCharacters: caps.completionProvider.triggerCharacters || ['.'],
          provideCompletionItems: (model, position, context) => this.completions(model, position, context),
          resolveCompletionItem: caps.completionProvider.resolveProvider ? (item) => this.resolveCompletion(item) : undefined
        }));
      }
      if (caps.hoverProvider) {
        this.disposables.push(monaco.languages.registerHoverProvider(lang, { provideHover: (model, position) => this.hover(model, position) }));
      }
      if (caps.signatureHelpProvider) {
        this.disposables.push(monaco.languages.registerSignatureHelpProvider(lang, {
          signatureHelpTriggerCharacters: caps.signatureHelpProvider.triggerCharacters || ['(', ','],
          signatureHelpRetriggerCharacters: caps.signatureHelpProvider.retriggerCharacters || [],
          provideSignatureHelp: (model, position) => this.signatureHelp(model, position)
        }));
      }
      // formatting from the server unless a dedicated formatter (Prettier/Ruff) covers the language
      if (caps.documentFormattingProvider && this.shouldFormat(lang)) {
        this.disposables.push(monaco.languages.registerDocumentFormattingEditProvider(lang, {
          displayName: this.name,
          provideDocumentFormattingEdits: (model, options) => this.formatting(model, options)
        }));
      }
      if (caps.definitionProvider) {
        this.disposables.push(monaco.languages.registerDefinitionProvider(lang, { provideDefinition: (model, position) => this.definition(model, position) }));
      }
      const sem = caps.semanticTokensProvider;
      if (sem?.full && sem.legend) {
        this.remapSemantic = this.remapSemantic || makeRemapper(sem.legend);
        this.disposables.push(monaco.languages.registerDocumentSemanticTokensProvider(lang, {
          onDidChange: this.semanticChanged.event,
          getLegend: () => MONACO_LEGEND,
          provideDocumentSemanticTokens: (model) => this.semanticTokens(model),
          releaseDocumentSemanticTokens: () => {}
        }));
      }
    }
  }

  // Semantic tokens (functions, parameters, properties…) remapped onto
  // MulTeam's style keys — see semanticTokens.js.
  async semanticTokens(model) {
    if (!this.handles(model) || !this.remapSemantic) return null;
    this.sync(model);
    const version = model.getVersionId();
    try {
      const res = await this.request('textDocument/semanticTokens/full', { textDocument: { uri: model.uri.toString() } }, 10000);
      if (!res?.data || model.isDisposed() || model.getVersionId() !== version) return null;
      return { data: this.remapSemantic(res.data) };
    } catch { return null; }
  }

  position(model, position) {
    this.sync(model);
    return { textDocument: { uri: model.uri.toString() }, position: toPosition(position) };
  }

  async completions(model, position, context) {
    if (!this.handles(model)) return { suggestions: [] };
    let res;
    try {
      res = await this.request('textDocument/completion', {
        ...this.position(model, position),
        context: context.triggerKind === monaco.languages.CompletionTriggerKind.TriggerCharacter
          ? { triggerKind: 2, triggerCharacter: context.triggerCharacter }
          : { triggerKind: 1 }
      });
    } catch { return { suggestions: [] }; }
    const items = Array.isArray(res) ? res : res?.items || [];
    const word = model.getWordUntilPosition(position);
    const defaultRange = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
    return {
      incomplete: !!res?.isIncomplete,
      suggestions: items.slice(0, 500).map((it) => {
        const edit = it.textEdit;
        const range = edit ? toRange(edit.range || edit.insert) : defaultRange;
        const text = edit ? edit.newText : (it.insertText ?? it.label);
        return {
          // labelDetails tells same-named items apart (e.g. which module an auto-import comes from)
          label: it.labelDetails ? { label: it.label, detail: it.labelDetails.detail, description: it.labelDetails.description } : it.label,
          kind: KIND_MAP[it.kind] ?? CompletionKind.Text,
          detail: it.detail,
          documentation: markdownOf(it.documentation) || undefined,
          sortText: it.sortText,
          filterText: it.filterText,
          insertText: text,
          insertTextRules: it.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
          range,
          additionalTextEdits: (it.additionalTextEdits || []).map((e) => ({ range: toRange(e.range), text: e.newText })),
          _lsp: it
        };
      })
    };
  }

  async resolveCompletion(item) {
    try {
      const r = await this.request('completionItem/resolve', item._lsp, 4000);
      if (r?.detail) item.detail = r.detail;
      if (r?.documentation) item.documentation = markdownOf(r.documentation);
      if (r?.additionalTextEdits) item.additionalTextEdits = r.additionalTextEdits.map((e) => ({ range: toRange(e.range), text: e.newText }));
    } catch { /* keep what we have */ }
    return item;
  }

  async hover(model, position) {
    if (!this.handles(model)) return null;
    try {
      const r = await this.request('textDocument/hover', this.position(model, position), 6000);
      const md = r && markdownOf(r.contents);
      return md ? { contents: [md], range: r.range ? toRange(r.range) : undefined } : null;
    } catch { return null; }
  }

  async signatureHelp(model, position) {
    if (!this.handles(model)) return null;
    try {
      const r = await this.request('textDocument/signatureHelp', this.position(model, position), 6000);
      if (!r?.signatures?.length) return null;
      return {
        value: {
          activeSignature: r.activeSignature || 0,
          activeParameter: r.activeParameter || 0,
          signatures: r.signatures.map((s) => ({
            label: s.label,
            documentation: markdownOf(s.documentation) || undefined,
            parameters: (s.parameters || []).map((p) => ({ label: p.label, documentation: markdownOf(p.documentation) || undefined }))
          }))
        },
        dispose() {}
      };
    } catch { return null; }
  }

  async formatting(model, options) {
    if (!this.handles(model)) return [];
    this.sync(model);
    try {
      const edits = await this.request('textDocument/formatting', {
        textDocument: { uri: model.uri.toString() },
        options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces }
      }, 15000);
      return (edits || []).map((e) => ({ range: toRange(e.range), text: e.newText }));
    } catch { return []; }
  }

  // Normalized symbol tree for breadcrumbs: [{ name, start, end, children }]
  async documentSymbols(model) {
    if (!this.capabilities.documentSymbolProvider || !this.handles(model)) return null;
    this.sync(model);
    try {
      const res = await this.request('textDocument/documentSymbol', { textDocument: { uri: model.uri.toString() } }, 8000);
      if (!Array.isArray(res)) return null;
      const norm = (d) => {
        const r = d.range || d.location?.range;
        return r && {
          name: d.name,
          start: { line: r.start.line + 1, col: r.start.character + 1 },
          end: { line: r.end.line + 1, col: r.end.character + 1 },
          children: (d.children || []).map(norm).filter(Boolean)
        };
      };
      // flat SymbolInformation[] has no hierarchy; containment still works
      return res.map(norm).filter(Boolean);
    } catch { return null; }
  }

  async definition(model, position) {
    if (!this.handles(model)) return null;
    try {
      const r = await this.request('textDocument/definition', this.position(model, position), 8000);
      const list = !r ? [] : Array.isArray(r) ? r : [r];
      const locations = list.map((l) => ({ uri: monaco.Uri.parse(l.uri || l.targetUri), range: toRange(l.range || l.targetSelectionRange || l.targetRange) }));
      // Monaco only navigates to resources it has a model for; load other
      // files' text so the jump can happen (the app then opens it as a tab).
      await Promise.all(locations.map(async (loc) => {
        if (loc.uri.scheme !== 'file' || monaco.editor.getModel(loc.uri)) return;
        try { monaco.editor.createModel(await window.electronAPI.readFile(loc.uri.fsPath), undefined, loc.uri); } catch { /* unreadable: Monaco just won't jump */ }
      }));
      return locations;
    } catch { return null; }
  }
}
