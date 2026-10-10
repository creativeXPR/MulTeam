// Drag-to-resize for the sidebar, VS Code style: drag the gap between the
// sidebar and the editor; dragging far enough left snaps the list shut
// (icon strip stays), dragging back out reopens it; double-click resets.
// Width + collapsed state are remembered per machine.
const KEY = 'multeam:sidebar';
const DEFAULT_W = 320;
const MIN_W = 220;           // narrowest open width (strip + list)
const SNAP_W = 140;          // below this while dragging → collapse
const MAX_FRACTION = 0.6;    // never take more than 60% of the window

export function initSidebarResize({ setCollapsed, isCollapsed }) {
  const sidebar = document.getElementById('sidebar');
  const sash = document.getElementById('sidebarSash');
  const root = document.documentElement;

  let state = { width: DEFAULT_W, collapsed: false };
  try { state = { ...state, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { /* defaults */ }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* non-fatal */ } };

  const maxW = () => Math.max(MIN_W, Math.round(window.innerWidth * MAX_FRACTION));
  const apply = (w) => root.style.setProperty('--side-w', `${w}px`);

  state.width = Math.min(maxW(), Math.max(MIN_W, state.width));
  apply(state.width);
  if (state.collapsed) setCollapsed(true);

  sash.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try { sash.setPointerCapture(e.pointerId); } catch { /* synthetic or already-released pointer */ }
    document.body.classList.add('is-resizing-h');
    const left = sidebar.getBoundingClientRect().left;

    const move = (ev) => {
      const w = ev.clientX - left;
      if (w < SNAP_W) {
        if (!isCollapsed()) setCollapsed(true);
      } else {
        if (isCollapsed()) setCollapsed(false);
        state.width = Math.min(maxW(), Math.max(MIN_W, Math.round(w)));
        apply(state.width);
      }
    };
    const up = () => {
      sash.removeEventListener('pointermove', move);
      document.body.classList.remove('is-resizing-h');
      state.collapsed = isCollapsed();
      save();
    };
    sash.addEventListener('pointermove', move);
    sash.addEventListener('pointerup', up, { once: true });
    sash.addEventListener('lostpointercapture', up, { once: true });
  });

  sash.addEventListener('dblclick', () => {
    state.width = DEFAULT_W;
    apply(DEFAULT_W);
    if (isCollapsed()) setCollapsed(false);
    state.collapsed = false;
    save();
  });

  // keep the width sane if the window shrinks
  window.addEventListener('resize', () => {
    if (state.width > maxW()) { state.width = maxW(); apply(state.width); }
  });

  return {
    // called by the Ctrl+B / strip toggle so the remembered state follows it
    remember(collapsed) { state.collapsed = collapsed; save(); }
  };
}
