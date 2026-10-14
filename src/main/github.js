// "Sign in with GitHub" (collaboration stage 2.3) — GitHub's device flow for
// MulTeam's OAuth App. The person approves MulTeam on github.com with a short
// code; the access token then lives ONLY here, in the main process,
// encrypted with the OS keychain (Electron safeStorage) under userData. The
// renderer never sees it and it never goes to Firebase.
//
// Git uses it for https://github.com remotes (clone, pull, push) through an
// Authorization header passed in the environment — not in the URL, the
// command line or .git/config.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app, safeStorage, shell } = require('electron');

// Public by design (device flow needs no client secret).
const CLIENT_ID = 'Ov23ligAKggEAEhacOHG';
const SCOPES = 'repo read:user user:email';
const tokenFile = () => path.join(app.getPath('userData'), 'github-auth.bin');

let token = null;      // decrypted, in memory only
let profile = null;    // { login, name, avatar }
let loaded = false;
let pendingFlow = null;

async function load() {
  if (loaded) return;
  loaded = true;
  try {
    const buf = await fs.readFile(tokenFile());
    if (!safeStorage.isEncryptionAvailable()) return;
    const data = JSON.parse(safeStorage.decryptString(buf));
    token = data.token || null;
    profile = data.profile || null;
  } catch { /* not connected */ }
}

async function save() {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("This computer's secure storage isn't available, so MulTeam can't keep a GitHub login safely.");
  await fs.writeFile(tokenFile(), safeStorage.encryptString(JSON.stringify({ token, profile })));
}

async function api(url, { method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      'User-Agent': 'MulTeam',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token && url.startsWith('https://api.github.com/') ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !('error' in data)) throw new Error(data.message || `GitHub answered ${res.status}.`);
  return { status: res.status, data };
}

async function fetchProfile() {
  const { status, data } = await api('https://api.github.com/user');
  if (status === 401) return null;
  return { login: data.login, name: data.name || data.login, avatar: data.avatar_url || '' };
}

async function status() {
  await load();
  return token ? { connected: true, ...profile } : { connected: false };
}

// Step 1: get a code for the person to enter on github.com.
async function startSignIn() {
  const { data } = await api('https://github.com/login/device/code', { method: 'POST', body: { client_id: CLIENT_ID, scope: SCOPES } });
  if (data.error) throw new Error(data.error_description || data.error);
  const flow = { id: Math.random().toString(36).slice(2), deviceCode: data.device_code, interval: Math.max(5, data.interval || 5), expiresAt: Date.now() + (data.expires_in || 900) * 1000, cancelled: false };
  pendingFlow = flow;
  return { flowId: flow.id, userCode: data.user_code, verificationUri: data.verification_uri, expiresIn: data.expires_in };
}

// Step 2: wait until they approve (or deny / let it expire / cancel).
async function finishSignIn(flowId) {
  const flow = pendingFlow;
  if (!flow || flow.id !== flowId) throw new Error('That sign-in was cancelled. Start again.');
  let interval = flow.interval;
  while (!flow.cancelled) {
    if (Date.now() > flow.expiresAt) throw new Error('The code expired. Start the sign-in again.');
    await new Promise((r) => setTimeout(r, interval * 1000));
    if (flow.cancelled) break;
    const { data } = await api('https://github.com/login/oauth/access_token', {
      method: 'POST',
      body: { client_id: CLIENT_ID, device_code: flow.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }
    });
    if (data.access_token) {
      token = data.access_token;
      profile = await fetchProfile();
      if (!profile) { token = null; throw new Error('GitHub gave MulTeam a login it then refused. Try again.'); }
      await save();
      pendingFlow = null;
      return { connected: true, ...profile };
    }
    if (data.error === 'authorization_pending') continue;
    if (data.error === 'slow_down') { interval = (data.interval || interval + 5); continue; }
    if (data.error === 'access_denied') throw new Error('Sign-in was declined on GitHub.');
    if (data.error === 'expired_token') throw new Error('The code expired. Start the sign-in again.');
    throw new Error(data.error_description || data.error || 'GitHub sign-in failed.');
  }
  throw new Error('Sign-in cancelled.');
}

function cancelSignIn() {
  if (pendingFlow) pendingFlow.cancelled = true;
  pendingFlow = null;
}

async function disconnect() {
  token = null;
  profile = null;
  await fs.rm(tokenFile(), { force: true });
}

// ---------- Git over https://github.com ----------
const isGitHubHttps = (url) => /^https:\/\/github\.com\//i.test(String(url || ''));

// Environment that makes git send the login to github.com only (git ≥ 2.31
// reads GIT_CONFIG_* — keeps the token out of argv and .git/config).
async function gitEnv() {
  await load();
  const env = { GIT_TERMINAL_PROMPT: '0' };
  if (!token) return env;
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    ...env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`
  };
}

// "github.com/owner/repo" from any remote form (https, ssh, scp-style).
function normalizeRepoUrl(url) {
  const s = String(url || '').trim();
  const m = s.match(/github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (m) return `https://github.com/${m[1]}/${m[2]}`;
  return /^(https?:\/\/|git@|ssh:\/\/)/i.test(s) ? s.replace(/\.git$/i, '') : '';
}

// git clone with progress lines sent to the window.
async function clone(sender, IPC, { url, parentDir, folderName }) {
  const repo = normalizeRepoUrl(url);
  if (!repo) throw new Error("That isn't a repository URL.");
  const name = String(folderName || repo.split('/').pop()).replace(/[<>:"/\\|?*]/g, '').trim() || 'repo';
  const dest = path.join(String(parentDir), name);
  try { await fs.access(dest); throw Object.assign(new Error(`A folder named "${name}" already exists there. Pick another place.`), { exists: true }); } catch (err) { if (err.exists) throw err; }
  const env = { ...process.env, ...(isGitHubHttps(repo) ? await gitEnv() : { GIT_TERMINAL_PROMPT: '0' }) };
  const cloneUrl = isGitHubHttps(repo) ? `${repo}.git` : repo;
  await new Promise((resolve, reject) => {
    const proc = spawn('git', ['clone', '--progress', cloneUrl, dest], { env, windowsHide: true });
    let lastErr = '';
    const onData = (d) => {
      const text = String(d);
      lastErr = (lastErr + text).slice(-2000);
      for (const line of text.split(/[\r\n]+/).filter(Boolean)) {
        if (!sender.isDestroyed()) sender.send(IPC.GITHUB_CLONE_PROGRESS, line.slice(0, 200));
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', () => reject(new Error("Git isn't installed (or isn't on your PATH). Install Git, then try again.")));
    proc.on('close', (code) => {
      if (code === 0) return resolve();
      if (/Authentication failed|could not read Username|Repository not found|403/i.test(lastErr)) {
        reject(new Error(token
          ? "GitHub refused access. Your GitHub account may not have access to this repository; ask the owner to add you on GitHub."
          : 'This repository needs a GitHub login. Connect GitHub (Settings → Accounts), then try again.'));
      } else reject(new Error(lastErr.split(/\r?\n/).filter((l) => /fatal|error/i.test(l)).slice(-2).join(' ') || 'Clone failed.'));
    });
  });
  return dest;
}

function setupGitHubHandlers(ipcMain, IPC) {
  ipcMain.handle(IPC.GITHUB_STATUS, () => status());
  ipcMain.handle(IPC.GITHUB_START, () => startSignIn());
  ipcMain.handle(IPC.GITHUB_FINISH, (_e, flowId) => finishSignIn(String(flowId)));
  ipcMain.handle(IPC.GITHUB_CANCEL, () => cancelSignIn());
  ipcMain.handle(IPC.GITHUB_DISCONNECT, () => disconnect());
  ipcMain.handle(IPC.GITHUB_OPEN_VERIFY, () => shell.openExternal('https://github.com/login/device'));
  ipcMain.handle(IPC.GITHUB_CLONE, (event, opts) => clone(event.sender, IPC, opts || {}));
}

module.exports = { setupGitHubHandlers, gitEnv, isGitHubHttps, normalizeRepoUrl };
