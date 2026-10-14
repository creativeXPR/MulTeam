// Collaborators' cursors in the editor: a coloured caret + selection (the
// classes y-monaco puts on its decorations) and a name label. The label is a
// Monaco content widget with allowEditorOverflow, so it's drawn above the
// editor's clipping and never cut off at the top/left/right edges; Monaco
// shows it above the cursor, or below on the first line. It shows while the
// person is active and fades a few seconds after they stop.
import * as monaco from 'monaco-editor';
import * as Y from 'yjs';

// Readable with white text in light and dark themes.
export const CURSOR_COLORS = ['#E5484D', '#3E63DD', '#30A46C', '#F76B15', '#8E4EC6', '#12A594', '#D6409F', '#AB6400'];
export const colorForClient = (clientId) => CURSOR_COLORS[Math.abs(Number(clientId) || 0) % CURSOR_COLORS.length];

const LABEL_VISIBLE_MS = 3000;

// One stylesheet for every client's caret/selection colour.
const sheet = document.createElement('style');
sheet.id = 'remote-cursor-colors';
document.head.appendChild(sheet);
const styled = new Map(); // clientId → color
function ensureColor(clientId, color) {
  if (styled.get(clientId) === color) return;
  styled.set(clientId, color);
  sheet.textContent = [...styled].map(([id, c]) => `
    .monaco-editor .yRemoteSelection-${id} { background-color: ${c}33; }
    .monaco-editor .yRemoteSelectionHead-${id} { border-left-color: ${c}; }
    .rcursor-${id} { background: ${c}; }`).join('\n');
}

// Shows labels for everyone in `awareness` (except me) in this editor.
export function attachRemoteCursors(editor, doc) {
  const awareness = doc.provider?.awareness;
  if (!awareness) return { dispose() {} };
  const widgets = new Map(); // clientId → { widget, el, timer, last }

  function headPosition(state) {
    const ytext = doc.binding?.ytext;
    const sel = state.selection;
    if (!ytext || !sel?.head) return null;
    const abs = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(sel.head), doc.ydoc);
    if (!abs || abs.type !== ytext) return null;
    return editor.getModel()?.getPositionAt(abs.index) || null;
  }

  function render() {
    if (!editor.getModel()) return;
    const seen = new Set();
    for (const [clientId, state] of awareness.getStates()) {
      if (clientId === awareness.clientID || !state?.user) continue;
      const color = state.user.color || colorForClient(clientId);
      ensureColor(clientId, color);
      const pos = headPosition(state);
      if (!pos) continue;
      seen.add(clientId);
      let w = widgets.get(clientId);
      if (!w) {
        const el = document.createElement('div');
        el.className = `rcursor rcursor-${clientId}`;
        el.setAttribute('aria-hidden', 'true');
        w = {
          el,
          pos,
          widget: {
            allowEditorOverflow: true,
            suppressMouseDown: true,
            getId: () => `multeam.rcursor.${clientId}`,
            getDomNode: () => el,
            getPosition: () => ({ position: w.pos, preference: [monaco.editor.ContentWidgetPositionPreference.ABOVE, monaco.editor.ContentWidgetPositionPreference.BELOW] })
          }
        };
        widgets.set(clientId, w);
        editor.addContentWidget(w.widget);
      }
      w.el.textContent = state.user.name || 'Collaborator';
      const key = `${pos.lineNumber}:${pos.column}`;
      if (w.last !== key) {
        // they moved/typed: show the name for a moment
        w.last = key;
        w.pos = pos;
        editor.layoutContentWidget(w.widget);
        w.el.classList.add('is-active');
        clearTimeout(w.timer);
        w.timer = setTimeout(() => w.el.classList.remove('is-active'), LABEL_VISIBLE_MS);
      }
    }
    for (const [clientId, w] of widgets) {
      if (seen.has(clientId)) continue;
      clearTimeout(w.timer);
      editor.removeContentWidget(w.widget);
      widgets.delete(clientId);
    }
  }

  awareness.on('change', render);
  const subs = [editor.onDidChangeModelContent(() => setTimeout(render, 0))];
  render();
  return {
    refresh: render,
    dispose() {
      awareness.off('change', render);
      subs.forEach((d) => d.dispose());
      for (const w of widgets.values()) { clearTimeout(w.timer); editor.removeContentWidget(w.widget); }
      widgets.clear();
    }
  };
}
