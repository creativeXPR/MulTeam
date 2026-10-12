// "Run file" (the ▷ button): works out how to run the active file in the
// integrated terminal — which interpreter/compiler it needs, whether that's
// installed, and the exact command line for the terminal's shell. When the
// tool is missing the renderer offers to install it (winget on Windows) or
// opens its download page.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { shell } = require('electron');

const WIN = process.platform === 'win32';

// ---------- finding executables ----------
// Apps installed after MulTeam started (e.g. via winget from the Run prompt)
// only appear in the registry's PATH, so on Windows it's re-read and merged
// into process.env.PATH — new terminals then find them too.
function regPath(key) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/v', 'Path'], { windowsHide: true, timeout: 4000 }, (err, out) => {
      if (err) return resolve('');
      const m = /Path\s+REG(?:_EXPAND)?_SZ\s+(.*)/i.exec(out || '');
      resolve(m ? m[1].trim().replace(/%([^%]+)%/g, (_, v) => process.env[v] ?? `%${v}%`) : '');
    });
  });
}

async function refreshPath() {
  if (!WIN) return;
  const [machine, user] = await Promise.all([
    regPath('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'),
    regPath('HKCU\\Environment')
  ]);
  const seen = new Set();
  const merged = [...String(process.env.PATH || '').split(';'), ...machine.split(';'), ...user.split(';')]
    .map((p) => p.trim()).filter((p) => p && !seen.has(p.toLowerCase()) && seen.add(p.toLowerCase()));
  process.env.PATH = merged.join(';');
}

function which(name) {
  const exts = WIN ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    // the Microsoft Store "python.exe" stubs only open the Store
    if (WIN && /\\WindowsApps\\?$/i.test(dir) && /^python/i.test(name)) continue;
    for (const ext of WIN && !path.extname(name) ? exts : ['']) {
      const full = path.join(dir, name + ext);
      try { if (fs.statSync(full).isFile()) return full; } catch {
        // app execution aliases (winget.exe in WindowsApps) can't be stat'ed, only lstat'ed
        try { if (WIN && /\\WindowsApps\\?$/i.test(dir) && fs.lstatSync(full)) return full; } catch { /* not here */ }
      }
    }
  }
  return null;
}
const firstOf = (...names) => names.find((n) => which(n)) || null;

const versionCache = new Map();
function versionOf(cmd, args = ['--version']) {
  if (versionCache.has(cmd)) return versionCache.get(cmd);
  const p = new Promise((resolve) => {
    let out = '';
    const exe = which(cmd);
    if (!exe) return resolve('');
    try {
      const proc = spawn(exe, args, { windowsHide: true, shell: /\.(cmd|bat)$/i.test(exe) });
      const timer = setTimeout(() => { proc.kill(); resolve(''); }, 5000);
      proc.stdout.on('data', (d) => { out += d; });
      proc.stderr.on('data', (d) => { out += d; });
      proc.on('error', () => { clearTimeout(timer); resolve(''); });
      proc.on('close', () => { clearTimeout(timer); resolve(out.trim()); });
    } catch { resolve(''); }
  });
  versionCache.set(cmd, p);
  return p;
}
const major = (v) => { const m = /(\d+)\.(\d+)/.exec(v || ''); return m ? [Number(m[1]), Number(m[2])] : [0, 0]; };

// ---------- shell syntax ----------
// family: 'ps7' (pwsh), 'ps5' (Windows PowerShell — no &&), 'cmd', 'sh'
function familyOf(shellId) {
  if (shellId === 'pwsh') return 'ps7';
  if (shellId === 'powershell') return 'ps5';
  if (shellId === 'cmd') return 'cmd';
  return WIN && !shellId ? 'ps5' : 'sh';
}

function syntax(family) {
  const q = (s) => {
    if (family === 'cmd') return `"${s}"`;
    if (family === 'sh') return `'${String(s).replace(/'/g, `'\\''`)}'`;
    return `'${String(s).replace(/'/g, "''")}'`;
  };
  return {
    q,
    // run an executable given by (quoted) path
    exe: (p) => (family.startsWith('ps') ? `& ${q(p)}` : q(p)),
    and: (...cmds) => (family === 'ps5' ? cmds.reduce((a, b) => `${a}; if ($?) { ${b} }`) : cmds.join(' && '))
  };
}

// ---------- languages ----------
const INSTALL = {
  node: { name: 'Node.js', url: 'https://nodejs.org/en/download', winget: 'OpenJS.NodeJS.LTS' },
  python: { name: 'Python', url: 'https://www.python.org/downloads/', winget: 'Python.Python.3.13' },
  php: { name: 'PHP', url: 'https://www.php.net/downloads.php', winget: 'PHP.PHP.8.4' },
  java: { name: 'a Java JDK (17 or newer)', url: 'https://adoptium.net/temurin/releases/', winget: 'EclipseAdoptium.Temurin.21.JDK' },
  gcc: { name: 'a C/C++ compiler (GCC or Clang)', url: 'https://www.msys2.org/', winget: 'BrechtSanders.WinLibs.POSIX.UCRT' },
  dotnet: { name: '.NET SDK 10 or newer', url: 'https://dotnet.microsoft.com/download', winget: 'Microsoft.DotNet.SDK.10' },
  go: { name: 'Go', url: 'https://go.dev/dl/', winget: 'GoLang.Go' },
  ruby: { name: 'Ruby', url: 'https://www.ruby-lang.org/en/downloads/', winget: 'RubyInstallerTeam.Ruby.3.4' },
  rust: { name: 'Rust', url: 'https://www.rust-lang.org/tools/install', winget: 'Rustlang.Rustup' },
  lua: { name: 'Lua', url: 'https://www.lua.org/download.html', winget: 'DEVCOM.Lua' },
  perl: { name: 'Perl', url: 'https://strawberryperl.com/', winget: 'StrawberryPerl.StrawberryPerl' },
  bash: { name: 'Git Bash', url: 'https://git-scm.com/downloads', winget: 'Git.Git' }
};

const outExe = (file) => {
  const dir = path.join(os.tmpdir(), 'multeam-run');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, path.basename(file, path.extname(file)) + (WIN ? '.exe' : ''));
};

// each: (file, s) => { cmd } | { missing: INSTALL key }
const RUNNERS = {
  js: async (f, s) => (which('node') ? { cmd: `node ${s.q(f)}` } : { missing: 'node' }),
  ts: async (f, s) => {
    if (!which('node')) return { missing: 'node' };
    const [ma, mi] = major(await versionOf('node'));
    // Node 22.18+ / 23.6+ run TypeScript directly; older ones via tsx
    return ma > 23 || (ma === 23 && mi >= 6) || (ma === 22 && mi >= 18) ? { cmd: `node ${s.q(f)}` } : { cmd: `npx --yes tsx ${s.q(f)}` };
  },
  py: async (f, s) => {
    const py = WIN ? firstOf('python', 'py', 'python3') : firstOf('python3', 'python');
    return py ? { cmd: `${py} ${s.q(f)}` } : { missing: 'python' };
  },
  php: async (f, s) => (which('php') ? { cmd: `php ${s.q(f)}` } : { missing: 'php' }),
  java: async (f, s) => (which('java') ? { cmd: `java ${s.q(f)}` } : { missing: 'java' }), // single-file launch (JDK 11+)
  c: async (f, s) => {
    const cc = firstOf('gcc', 'clang');
    if (!cc) return { missing: 'gcc' };
    const out = outExe(f);
    return { cmd: s.and(`${cc} ${s.q(f)} -o ${s.q(out)}`, s.exe(out)) };
  },
  cpp: async (f, s) => {
    const cc = firstOf('g++', 'clang++');
    if (!cc) return { missing: 'gcc' };
    const out = outExe(f);
    return { cmd: s.and(`${cc} -std=c++17 ${s.q(f)} -o ${s.q(out)}`, s.exe(out)) };
  },
  cs: async (f, s) => {
    if (!which('dotnet')) return { missing: 'dotnet' };
    // `dotnet run file.cs` (no project) needs .NET 10+
    const [ma] = major(await versionOf('dotnet'));
    return ma >= 10 ? { cmd: `dotnet run ${s.q(f)}` } : { missing: 'dotnet', outdated: true };
  },
  go: async (f, s) => (which('go') ? { cmd: `go run ${s.q(f)}` } : { missing: 'go' }),
  rb: async (f, s) => (which('ruby') ? { cmd: `ruby ${s.q(f)}` } : { missing: 'ruby' }),
  rs: async (f, s) => {
    if (!which('rustc')) return { missing: 'rust' };
    const out = outExe(f);
    return { cmd: s.and(`rustc ${s.q(f)} -o ${s.q(out)}`, s.exe(out)) };
  },
  lua: async (f, s) => { const l = firstOf('lua', 'lua54', 'luajit'); return l ? { cmd: `${l} ${s.q(f)}` } : { missing: 'lua' }; },
  pl: async (f, s) => (which('perl') ? { cmd: `perl ${s.q(f)}` } : { missing: 'perl' }),
  sh: async (f, s, family) => {
    if (family === 'sh') return { cmd: `bash ${s.q(f)}` };
    const bash = WIN ? (fs.existsSync('C:\\Program Files\\Git\\bin\\bash.exe') ? 'C:\\Program Files\\Git\\bin\\bash.exe' : which('bash')) : which('bash');
    return bash ? { cmd: `${s.exe(bash)} ${s.q(f)}` } : { missing: 'bash' };
  },
  ps1: async (f, s, family) => (family.startsWith('ps') ? { cmd: `& ${s.q(f)}` } : { cmd: `powershell -ExecutionPolicy Bypass -File ${s.q(f)}` }),
  bat: async (f, s, family) => (family === 'cmd' ? { cmd: s.q(f) } : family.startsWith('ps') ? { cmd: `& ${s.q(f)}` } : { cmd: `cmd //c ${s.q(f)}` })
};
const ALIASES = { mjs: 'js', cjs: 'js', mts: 'ts', cts: 'ts', cc: 'cpp', cxx: 'cpp', 'c++': 'cpp', bash: 'sh', cmd: 'bat' };
const LANG_NAMES = { js: 'JavaScript', ts: 'TypeScript', py: 'Python', php: 'PHP', java: 'Java', c: 'C', cpp: 'C++', cs: 'C#', go: 'Go', rb: 'Ruby', rs: 'Rust', lua: 'Lua', pl: 'Perl', sh: 'shell script', ps1: 'PowerShell script', bat: 'batch file' };

const kindOf = (file) => {
  const ext = path.extname(file).slice(1).toLowerCase();
  const k = ALIASES[ext] || ext;
  return RUNNERS[k] ? k : null;
};

// → { cmd, cwd } | { missing: { key, name, url, winget, outdated }, language } | { unsupported: true }
async function plan(file, shellId) {
  const kind = kindOf(file);
  if (!kind) return { unsupported: true };
  await refreshPath();
  const family = familyOf(shellId);
  const res = await RUNNERS[kind](file, syntax(family), family);
  if (res.missing) {
    const info = INSTALL[res.missing];
    return {
      language: LANG_NAMES[kind],
      missing: { key: res.missing, name: info.name, url: info.url, outdated: !!res.outdated, winget: WIN && which('winget') ? info.winget : null }
    };
  }
  return { cmd: res.cmd, cwd: path.dirname(file), family };
}

// The command that installs a missing tool (typed into the terminal so the
// user sees winget's progress and any prompts).
function installCommand(key) {
  const info = INSTALL[key];
  if (!info?.winget || !WIN) return null;
  return `winget install --id ${info.winget} -e --accept-source-agreements --accept-package-agreements`;
}

function setupRunHandlers(ipcMain, IPC) {
  ipcMain.handle(IPC.RUN_EXTENSIONS, () => [...Object.keys(RUNNERS), ...Object.keys(ALIASES)]);
  ipcMain.handle(IPC.RUN_PLAN, (_e, file, shellId) => plan(String(file), shellId ? String(shellId) : ''));
  ipcMain.handle(IPC.RUN_INSTALL_CMD, (_e, key) => installCommand(String(key)));
  // only the download pages listed above can be opened
  ipcMain.handle(IPC.RUN_OPEN_DOWNLOAD, (_e, key) => { const info = INSTALL[String(key)]; if (info) shell.openExternal(info.url); return !!info; });
}

module.exports = { setupRunHandlers, plan, kindOf };
