// VS Code-style bottom panel under the editor: tabbed (Problems, Terminal),
// toggled with Ctrl+J, resizable by dragging its top edge. Height
// and open state are remembered per machine.
const STATE_KEY = 'multeam:bottomPanel';
const MIN_H = 90;

export function initBottomPanel() {
  const panel = document.getElementById('bottomPanel');
  const handle = document.getElementById('bpanelResize');
  const tabsEl = document.getElementById('bpanelTabs');

  let state = { open: false, height: 220, tab: 'problems' };
  try { state = { ...state, ...JSON.parse(localStorage.getItem(STATE_KEY) || '{}') }; } catch { /* defaults */ }
  const save = () => { try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch { /* non-fatal */ } };

  function maxHeight() {
    return Math.max(MIN_H, panel.parentElement.clientHeight - 120); // always leave room for the editor
  }

  function paint() {
    panel.hidden = !state.open;
    panel.style.height = `${Math.min(state.height, maxHeight())}px`;
    tabsEl.querySelectorAll('[data-ptab]').forEach((b) => b.classList.toggle('is-on', b.dataset.ptab === state.tab));
    panel.querySelectorAll('[data-ppane]').forEach((p) => { p.hidden = p.dataset.ppane !== state.tab; });
    panel.querySelectorAll('[data-pfor]').forEach((p) => { p.hidden = p.dataset.pfor !== state.tab; });
    document.dispatchEvent(new CustomEvent('multeam:panelchange', { detail: { ...state } }));
  }

  function open(tab = state.tab) { state.open = true; state.tab = tab; save(); paint(); }
  function close() { state.open = false; save(); paint(); }
  function toggle(tab) {
    if (state.open && (!tab || tab === state.tab)) close();
    else open(tab);
  }

  tabsEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ptab]');
    if (b) open(b.dataset.ptab);
  });
  document.getElementById('bpanelClose').addEventListener('click', close);

  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { handle.setPointerCapture(e.pointerId); } catch { /* synthetic or already-released pointer */ }
    const startY = e.clientY;
    const startH = panel.getBoundingClientRect().height;
    document.body.classList.add('is-resizing-v');
    const move = (ev) => {
      state.height = Math.round(Math.min(maxHeight(), Math.max(MIN_H, startH + (startY - ev.clientY))));
      panel.style.height = `${state.height}px`;
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      document.body.classList.remove('is-resizing-v');
      save();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up, { once: true });
  });

  paint();
  return { open, close, toggle, isOpen: () => state.open, currentTab: () => state.tab };
}
