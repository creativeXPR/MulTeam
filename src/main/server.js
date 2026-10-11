// Serves src/renderer/ over http://127.0.0.1 instead of file://.
//
// This exists solely because Firebase Auth's popup/redirect sign-in checks
// the page's origin against a project's "authorized domains" list, and a
// file:// page has no hostname that check can match — it fails with
// auth/unauthorized-domain regardless of console settings. "localhost" is
// authorized by default for every Firebase project, so serving locally
// sidesteps the problem entirely without any config change.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER_PORT = 47321;

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon'
};

// `mounts` maps a URL prefix to an extra folder, e.g. installed extensions'
// icon files at /ext-assets/<id>/... (read-only, same path-escape guard).
function startRendererServer(rootDir, mounts = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      let base = rootDir;
      let relativePath = urlPath === '/' ? 'app.html' : urlPath.replace(/^\/+/, '');
      for (const [prefix, dir] of Object.entries(mounts)) {
        if (urlPath.startsWith(`/${prefix}/`)) { base = dir; relativePath = urlPath.slice(prefix.length + 2); break; }
      }
      const filePath = path.normalize(path.join(base, relativePath));

      if (!filePath.startsWith(base)) {
        res.writeHead(403);
        res.end();
        return;
      }

      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream' });
        res.end(data);
      });
    });

    // A FIXED port matters: localStorage/IndexedDB are scoped to the origin
    // (host + port), so a random port would make every launch a new origin
    // and silently wipe the theme, editor settings and Firebase sign-in.
    // Falls back to a random port only if the fixed one is taken.
    server.once('error', (err) => {
      if (err.code !== 'EADDRINUSE') return reject(err);
      console.warn(`[multeam] port ${RENDERER_PORT} busy — using a random port; saved preferences won't load this session`);
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve(server));
    });
    server.listen(RENDERER_PORT, '127.0.0.1', () => resolve(server));
  });
}

module.exports = { startRendererServer };
