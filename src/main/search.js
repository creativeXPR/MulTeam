// Project-wide file listing (Ctrl+P quick open) and text search (Ctrl+Shift+F).
// Runs in the main process so big folders never block the UI; both walks
// skip dependency/VCS/build folders and stop at hard caps.
const fs = require('node:fs/promises');
const path = require('node:path');

const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.cache', 'coverage', '__pycache__', '.venv', 'venv']);
const MAX_FILES = 20000;
const MAX_FILE_BYTES = 1024 * 1024; // don't text-search files over 1 MB
const MAX_MATCHES = 2000;
const MAX_LINE_PREVIEW = 240;

async function walk(root, onFile) {
  const stack = [root];
  let count = 0;
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(path.join(dir, e.name));
      } else if (e.isFile()) {
        if (++count > MAX_FILES) return true; // truncated
        if ((await onFile(path.join(dir, e.name))) === false) return true;
      }
    }
  }
  return false;
}

async function listFiles(root) {
  const files = [];
  const truncated = await walk(root, (full) => { files.push(path.relative(root, full)); });
  return { files, truncated };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function searchText(root, query, { caseSensitive = false, wholeWord = false, regex = false } = {}) {
  if (!query) return { results: [], matchCount: 0, truncated: false };

  let source = regex ? query : escapeRegExp(query);
  if (wholeWord) source = `\\b(?:${source})\\b`;
  let re;
  try { re = new RegExp(source, caseSensitive ? 'g' : 'gi'); } catch (err) { throw new Error(`Invalid regular expression: ${err.message}`); }

  const results = [];
  let matchCount = 0;

  const truncated = await walk(root, async (full) => {
    let stat;
    try { stat = await fs.stat(full); } catch { return; }
    if (stat.size > MAX_FILE_BYTES) return;
    let buf;
    try { buf = await fs.readFile(full); } catch { return; }
    if (buf.subarray(0, 8000).includes(0)) return; // binary

    const lines = buf.toString('utf8').split(/\r?\n/);
    const matches = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line))) {
        if (m[0].length === 0) { re.lastIndex++; continue; } // zero-width regex
        // trim long lines around the first hit so previews stay readable
        const start = Math.max(0, m.index - 60);
        matches.push({
          line: i + 1,
          column: m.index + 1,
          length: m[0].length,
          preview: line.slice(start, start + MAX_LINE_PREVIEW),
          previewOffset: m.index - start
        });
        if (++matchCount >= MAX_MATCHES) break;
      }
      if (matchCount >= MAX_MATCHES) break;
    }
    if (matches.length) results.push({ path: full, rel: path.relative(root, full), matches });
    if (matchCount >= MAX_MATCHES) return false; // stop walking
  });

  return { results, matchCount, truncated: truncated || matchCount >= MAX_MATCHES };
}

function setupSearchHandlers(ipcMain, IPC) {
  ipcMain.handle(IPC.LIST_FILES, (_e, root) => listFiles(root));
  ipcMain.handle(IPC.SEARCH_TEXT, (_e, root, query, options) => searchText(root, query, options));
}

module.exports = { setupSearchHandlers };
