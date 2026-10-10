// Tells Monaco where its language-service workers live (built into
// dist/workers/ by build/bundle.js). Must be evaluated before monaco-editor
// itself, so editor.js imports this module first.
const WORKERS = {
  json: 'json.worker.js',
  css: 'css.worker.js', scss: 'css.worker.js', less: 'css.worker.js',
  html: 'html.worker.js', handlebars: 'html.worker.js', razor: 'html.worker.js',
  typescript: 'ts.worker.js', javascript: 'ts.worker.js'
};

self.MonacoEnvironment = {
  getWorker(_moduleId, label) {
    const file = WORKERS[label] || 'editor.worker.js';
    return new Worker(new URL(`js/dist/workers/${file}`, location.origin + '/'), { name: label });
  }
};
