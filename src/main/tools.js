// Runs formatters and linters per request (text in via stdin, result out):
//   Prettier — format JS/TS/JSON/CSS/HTML/Markdown/YAML (installed on demand)
//   Ruff     — format + lint Python (installed on demand)
//   ESLint   — lint JS/TS using the PROJECT's own eslint + config (like
//              VS Code); never downloaded, and the renderer asks the user once
//              per project before running it, since it executes project code.
const fsSync = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { toolPath } = require('./languages');

function runProcess(command, args, { cwd, input, env = {}, timeout = 30000 }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd, env: { ...process.env, ...env }, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { proc.kill(); reject(new Error('The tool took too long and was stopped.')); }, timeout);
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    proc.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    proc.stdin.on('error', () => { /* tool exited before reading all input */ });
    proc.stdin.end(input ?? '');
  });
}

const firstLines = (s, n = 4) => String(s).trim().split(/\r?\n/).filter(Boolean).slice(0, n).join('\n');
const workDir = (filePath, root) => (root && fsSync.existsSync(root) ? root : path.dirname(filePath));

function requireTool(id) {
  const p = toolPath(id);
  if (!p) throw new Error(`${id === 'ruff' ? 'Ruff' : 'Prettier'} isn't installed — get it from Extensions → Formatters & linters.`);
  return p;
}

// ---------- formatting ----------
async function format(id, filePath, text, root) {
  if (id === 'prettier') {
    const bin = requireTool('prettier');
    const r = await runProcess(process.execPath, [bin, '--stdin-filepath', filePath], { cwd: workDir(filePath, root), input: text, env: { ELECTRON_RUN_AS_NODE: '1' } });
    if (r.code !== 0) throw new Error(firstLines(r.stderr) || 'Prettier could not format this file.');
    return r.stdout;
  }
  if (id === 'ruff') {
    const bin = requireTool('ruff');
    const r = await runProcess(bin, ['format', '--stdin-filename', filePath, '-'], { cwd: workDir(filePath, root), input: text });
    if (r.code !== 0) throw new Error(firstLines(r.stderr) || 'Ruff could not format this file.');
    return r.stdout;
  }
  throw new Error(`Unknown formatter "${id}".`);
}

// ---------- linting ----------
// Normalized diagnostic: { severity: 'error'|'warning'|'info', message, code, startLine, startColumn, endLine, endColumn } (1-based)

async function lintRuff(filePath, text, root) {
  const bin = toolPath('ruff');
  if (!bin) return { unavailable: 'not-installed', diagnostics: [] };
  const r = await runProcess(bin, ['check', '--output-format', 'json', '--exit-zero', '--stdin-filename', filePath, '-'], { cwd: workDir(filePath, root), input: text });
  let items;
  try { items = JSON.parse(r.stdout || '[]'); } catch { throw new Error(firstLines(r.stderr) || 'Ruff returned unreadable output.'); }
  return {
    diagnostics: items.map((d) => ({
      severity: !d.code || /^(E9|F63|F7|F82)/.test(d.code) ? 'error' : 'warning', // syntax/undefined-name class issues are errors
      message: d.message,
      code: d.code || 'syntax',
      startLine: d.location.row, startColumn: d.location.column,
      endLine: d.end_location.row, endColumn: d.end_location.column
    }))
  };
}

// The project's own eslint, found by walking up from the file to the root.
function findProjectEslint(filePath, root) {
  let dir = path.dirname(filePath);
  const stop = root ? path.resolve(root) : path.parse(dir).root;
  for (;;) {
    const bin = path.join(dir, 'node_modules', 'eslint', 'bin', 'eslint.js');
    if (fsSync.existsSync(bin)) return { bin, cwd: dir };
    if (path.resolve(dir) === stop || path.dirname(dir) === dir) return null;
    dir = path.dirname(dir);
  }
}

async function lintEslint(filePath, text, root) {
  const found = findProjectEslint(filePath, root);
  if (!found) return { unavailable: 'no-eslint', diagnostics: [] };
  const r = await runProcess(process.execPath, [found.bin, '--format', 'json', '--stdin', '--stdin-filename', filePath], { cwd: found.cwd, input: text, env: { ELECTRON_RUN_AS_NODE: '1' } });
  // exit 0 = clean, 1 = lint problems, 2 = config/crash
  if (r.code === 2 || !r.stdout.trim().startsWith('[')) {
    if (/could not find config|no eslint configuration|couldn't find a configuration/i.test(r.stderr + r.stdout)) return { unavailable: 'no-config', diagnostics: [] };
    throw new Error(firstLines(r.stderr || r.stdout) || 'ESLint failed.');
  }
  const [result] = JSON.parse(r.stdout);
  return {
    diagnostics: (result?.messages || []).filter((m) => !(m.severity === 1 && /File ignored/.test(m.message))).map((m) => ({
      severity: m.severity === 2 || m.fatal ? 'error' : 'warning',
      message: m.message,
      code: m.ruleId || (m.fatal ? 'parse' : ''),
      startLine: m.line || 1, startColumn: m.column || 1,
      endLine: m.endLine || m.line || 1, endColumn: m.endColumn || (m.column || 1) + 1
    }))
  };
}

async function lint(id, filePath, text, root) {
  if (id === 'ruff') return lintRuff(filePath, text, root);
  if (id === 'eslint') return lintEslint(filePath, text, root);
  throw new Error(`Unknown linter "${id}".`);
}

function setupToolHandlers(ipcMain, IPC) {
  ipcMain.handle(IPC.TOOL_FORMAT, (_e, id, filePath, text, root) => format(id, filePath, text, root));
  ipcMain.handle(IPC.TOOL_LINT, (_e, id, filePath, text, root) => lint(id, filePath, text, root));
  ipcMain.handle(IPC.TOOL_HAS_ESLINT, (_e, filePath, root) => !!findProjectEslint(filePath, root));
}

module.exports = { setupToolHandlers };
