// Integrated terminal backend: real pseudo-terminals via node-pty, one per
// renderer terminal session. Output streams back to the window that owns
// the session; every session is killed when that window goes away.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pty = require('node-pty');

const sessions = new Map(); // id -> { proc, owner: WebContents }
let nextId = 1;

function detectShells() {
  if (process.platform !== 'win32') {
    const sh = process.env.SHELL || '/bin/bash';
    return [{ id: 'default', label: path.basename(sh), file: sh, args: ['-l'] }];
  }
  const sys = process.env.SystemRoot || 'C:\\Windows';
  const candidates = [
    { id: 'pwsh', label: 'PowerShell 7', file: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', args: ['-NoLogo'] },
    { id: 'powershell', label: 'PowerShell', file: path.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoLogo'] },
    { id: 'cmd', label: 'Command Prompt', file: path.join(sys, 'System32', 'cmd.exe'), args: [] },
    { id: 'gitbash', label: 'Git Bash', file: 'C:\\Program Files\\Git\\bin\\bash.exe', args: ['--login', '-i'] }
  ];
  return candidates.filter((s) => fs.existsSync(s.file));
}

function setupTerminalHandlers(ipcMain, IPC) {
  const shells = detectShells();

  ipcMain.handle(IPC.TERM_SHELLS, () => shells.map(({ id, label }) => ({ id, label })));

  ipcMain.handle(IPC.TERM_CREATE, (event, { shellId, cwd, cols, rows } = {}) => {
    const shell = shells.find((s) => s.id === shellId) || shells[0];
    if (!shell) throw new Error('No shell found on this system.');
    const workDir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();

    const proc = pty.spawn(shell.file, shell.args, {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: workDir,
      env: { ...process.env, TERM_PROGRAM: 'MulTeam' }
    });

    const id = nextId++;
    const owner = event.sender;
    sessions.set(id, { proc, owner });

    proc.onData((data) => { if (!owner.isDestroyed()) owner.send(IPC.TERM_DATA, id, data); });
    proc.onExit(({ exitCode }) => {
      sessions.delete(id);
      if (!owner.isDestroyed()) owner.send(IPC.TERM_EXIT, id, exitCode);
    });

    // A reload/close of the owning window takes its shells with it.
    owner.once('destroyed', () => killSession(id));
    owner.once('did-navigate', () => killSession(id)); // main-frame loads/reloads only

    return { id, shell: shell.label, cwd: workDir };
  });

  ipcMain.on(IPC.TERM_WRITE, (_e, id, data) => sessions.get(id)?.proc.write(data));
  ipcMain.on(IPC.TERM_RESIZE, (_e, id, cols, rows) => {
    const s = sessions.get(id);
    if (s && cols > 0 && rows > 0) {
      try { s.proc.resize(cols, rows); } catch { /* process already exiting */ }
    }
  });
  ipcMain.handle(IPC.TERM_KILL, (_e, id) => killSession(id));
}

function killSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  try { s.proc.kill(); } catch { /* already gone */ }
}

function killAllTerminals() {
  for (const id of [...sessions.keys()]) killSession(id);
}

module.exports = { setupTerminalHandlers, killAllTerminals };
