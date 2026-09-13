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

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

function startRendererServer(rootDir) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      const relativePath = urlPath === '/' ? 'app.html' : urlPath.replace(/^\/+/, '');
      const filePath = path.normalize(path.join(rootDir, relativePath));

      if (!filePath.startsWith(rootDir)) {
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

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

module.exports = { startRendererServer };
