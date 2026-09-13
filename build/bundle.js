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
