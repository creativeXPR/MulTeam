// Bundles the renderer's ES module entry point (which pulls in yjs, y-monaco,
// monaco-editor, and the Firebase SDK — all packages with internal bare
// imports that only resolve through a bundler) into plain browser-loadable
// ESM. app.html is the only page in the app — dashboard, editor and auth are
// all views inside its one persistent shell (shell.js) rather than separate
// page loads.
const esbuild = require('esbuild');
const path = require('node:path');

const rendererJs = path.join(__dirname, '..', 'src', 'renderer', 'js');
const preloadDir = path.join(__dirname, '..', 'src', 'preload');

esbuild.buildSync({
  entryPoints: {
    app: path.join(rendererJs, 'shell.js')
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outdir: path.join(rendererJs, 'dist'),
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.ttf': 'dataurl' },
  logLevel: 'info'
});

// Monaco's language services (TS/JS type checking + IntelliSense, JSON, CSS,
// HTML) run in Web Workers. Each worker is its own self-contained IIFE
// bundle in dist/workers/, loaded by URL from monacoEnv.js.
const monacoEsm = path.join(__dirname, '..', 'node_modules', 'monaco-editor', 'esm', 'vs');
esbuild.buildSync({
  entryPoints: {
    'editor.worker': path.join(monacoEsm, 'editor', 'editor.worker.js'),
    'ts.worker': path.join(monacoEsm, 'language', 'typescript', 'ts.worker.js'),
    'json.worker': path.join(monacoEsm, 'language', 'json', 'json.worker.js'),
    'css.worker': path.join(monacoEsm, 'language', 'css', 'css.worker.js'),
    'html.worker': path.join(monacoEsm, 'language', 'html', 'html.worker.js')
  },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  outdir: path.join(rendererJs, 'dist', 'workers'),
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info'
});

// BrowserWindow uses sandbox: true, which restricts the preload script's
// require() to Node built-ins and 'electron' only — a plain
// require('../shared/constants') fails there with "module not found" even
// though the file exists. Bundling collapses that import away entirely.
esbuild.buildSync({
  entryPoints: { bridge: path.join(preloadDir, 'bridge.js') },
  bundle: true,
  format: 'cjs',
  platform: 'node',
  external: ['electron'],
  outdir: path.join(preloadDir, 'dist'),
  logLevel: 'info'
});
