// Integrated terminal UI: xterm.js views over node-pty sessions running in
// the main process (window.electronAPI.terminal). Lives in the bottom
// panel's "Terminal" tab; several sessions can run side by side.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { getSettings } from './settings.js';

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// xterm needs concrete colors; derived from the app's tokens so the
// terminal follows light/dark and the accent.
function xtermTheme() {
  const dark = document.documentElement.dataset.theme === 'dark';
  return {
    background: cssVar('--bg'),
    foreground: dark ? '#e6e6ea' : '#26272b',
    cursor: cssVar('--violet-500'),
    cursorAccent: cssVar('--bg'),
    selectionBackground: dark ? '#8b6bff40' : '#6d4aff2e',
    black: dark ? '#3a3b42' : '#26272b', brightBlack: dark ? '#6b6c75' : '#8a8b93',
    red: '#e14b63', brightRed: '#ff6b81',
    green: '#12b76a', brightGreen: '#3fd68c',
    yellow: '#d98a1f', brightYellow: '#ffb45c',
    blue: '#4f6bed', brightBlue: '#7d93ff',
    magenta: cssVar('--violet-500'), brightMagenta: cssVar('--violet-400'),
    cyan: '#0e9fb3', brightCyan: '#33c3d6',
    white: dark ? '#d4d4da' : '#6b6c75', brightWhite: dark ? '#ffffff' : '#26272b'
  };
}

export function initTerminal({ panel, getCwd, confirmDialog }) {
  const api = window.electronAPI?.terminal;
  const host = document.getElementById('termHost');
  const listEl = document.getElementById('termList');
  const shellSelect = document.getElementById('termShell');
  const sessions = new Map(); // id -> { term, fit, el, label, exited }
  let activeId = null;

  if (!api) { host.textContent = 'Terminal unavailable — the preload script failed to load.'; return { ensureOne() {}, create() {}, killActive() {}, hasActive: () => false }; }

  api.listShells().then((shells) => {
    shellSelect.innerHTML = shells.map((s) => `<option value="${s.id}">${s.label}</option>`).join('');
  });

  api.onData((id, data) => sessions.get(id)?.term.write(data));
  api.onExit((id, code) => {
    const s = sessions.get(id);
    if (!s) return;
    s.exited = true;
    s.term.write(`\r\n\x1b[2m[process exited with code ${code}]\x1b[0m\r\n`);
    renderList();
  });

  function fitActive() {
    const s = sessions.get(activeId);
    if (!s || host.offsetParent === null) return; // hidden — nothing to measure
    try {
      s.fit.fit();
      if (!s.exited) api.resize(activeId, s.term.cols, s.term.rows);
    } catch { /* not laid out yet */ }
  }
  new ResizeObserver(() => fitActive()).observe(host);

  async function create({ cwd } = {}) {
    const settings = getSettings();
    const term = new Terminal({
      fontFamily: settings.fontFamily,
      fontSize: Math.max(11, settings.fontSize - 1),
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
      theme: xtermTheme()
    });
    const fit = new FitAddon();
    term.loadAddon(fit);

    const el = document.createElement('div');
    el.className = 'term__view';
    host.appendChild(el);
    term.open(el);
    try { fit.fit(); } catch { /* sized on first show */ }

    let info;
    try {
      info = await api.create({ shellId: shellSelect.value, cwd: cwd || getCwd(), cols: term.cols, rows: term.rows });
    } catch (err) {
      term.write(`\x1b[31mCouldn't start the shell: ${String(err.message || err)}\x1b[0m\r\n`);
      return;
    }

    sessions.set(info.id, { term, fit, el, label: info.shell, exited: false });
    term.onData((data) => api.write(info.id, data));
    activate(info.id);
  }

  function activate(id) {
    activeId = id;
    for (const [sid, s] of sessions) s.el.hidden = sid !== id;
    renderList();
    requestAnimationFrame(() => { fitActive(); sessions.get(id)?.term.focus(); });
  }

  async function kill(id) {
    const s = sessions.get(id);
    if (!s) return;
    if (!s.exited) {
      const ok = await confirmDialog({
        title: 'Kill this terminal?',
        message: `Anything still running in "${s.label}" will be stopped.`,
        confirmLabel: 'Kill terminal',
        danger: true
      });
      if (!ok) return;
      await api.kill(id);
    }
    s.term.dispose();
    s.el.remove();
    sessions.delete(id);
    const next = [...sessions.keys()].pop();
    if (next) activate(next);
    else { activeId = null; renderList(); }
  }

  function renderList() {
    // VS Code style: the session list only appears with 2+ terminals.
    listEl.hidden = sessions.size < 2;
    listEl.innerHTML = [...sessions].map(([id, s], i) => `
      <button type="button" class="term__item ${id === activeId ? 'is-on' : ''}" data-term="${id}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m5 8 4 4-4 4M12 16h7"/></svg>
        <span>${i + 1}: ${s.label}${s.exited ? ' (exited)' : ''}</span>
      </button>`).join('');
    host.dataset.empty = sessions.size ? '' : 'No terminals. Press + to start one.';
  }

  listEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-term]');
    if (b) activate(Number(b.dataset.term));
  });
  document.getElementById('termNew').addEventListener('click', () => create());
  document.getElementById('termKill').addEventListener('click', () => { if (activeId) kill(activeId); });

  document.addEventListener('multeam:panelchange', (e) => {
    if (e.detail.open && e.detail.tab === 'terminal') requestAnimationFrame(fitActive);
  });
  document.addEventListener('multeam:themechange', () => {
    requestAnimationFrame(() => { for (const s of sessions.values()) s.term.options.theme = xtermTheme(); });
  });
  document.addEventListener('multeam:settingschange', (e) => {
    for (const s of sessions.values()) {
      s.term.options.fontFamily = e.detail.fontFamily;
      s.term.options.fontSize = Math.max(11, e.detail.fontSize - 1);
    }
    fitActive();
  });

  renderList();

  return {
    // Opening the Terminal tab with nothing running starts a shell, like VS Code.
    ensureOne() { if (!sessions.size) create(); else requestAnimationFrame(fitActive); },
    create,
    killActive() { if (activeId) kill(activeId); },
    hasActive: () => activeId !== null
  };
}
