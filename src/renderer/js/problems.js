// Problems view + footer counts, fed by Monaco's markers (see
// editor.js#watchMarkers). Only files open in the editor are checked —
// there's no project-wide language service yet.
import { watchMarkers, MarkerSeverity } from './editor.js';
import { fileIcon } from './icons.js';

const ICONS = {
  error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/></svg>',
  warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2 20h20Z"/><path d="M12 10v4M12 17v.1"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.1"/></svg>'
};

function kindOf(severity) {
  if (severity === MarkerSeverity.Error) return 'error';
  if (severity === MarkerSeverity.Warning) return 'warning';
  return 'info';
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function initProblems({ onReveal }) {
  const listEl = document.getElementById('problemsList');
  const errCountEl = document.getElementById('errCount');
  const warnCountEl = document.getElementById('warnCount');
  const tabCountEl = document.getElementById('problemsTabCount');
  let flat = [];

  document.getElementById('errIcon').innerHTML = ICONS.error;
  document.getElementById('warnIcon').innerHTML = ICONS.warning;

  function render(markers) {
    const errors = markers.filter((m) => m.severity === MarkerSeverity.Error).length;
    const warnings = markers.filter((m) => m.severity === MarkerSeverity.Warning).length;
    errCountEl.textContent = errors;
    warnCountEl.textContent = warnings;
    tabCountEl.textContent = markers.length;
    tabCountEl.hidden = markers.length === 0;

    if (!markers.length) {
      flat = [];
      listEl.innerHTML = '<div class="problems__empty">No problems have been detected in open files.</div>';
      return;
    }

    // group by file, errors first within each file
    const byFile = new Map();
    for (const m of markers) {
      const key = m.resource.toString();
      if (!byFile.has(key)) byFile.set(key, []);
      byFile.get(key).push(m);
    }

    flat = [];
    let html = '';
    for (const [, items] of byFile) {
      items.sort((a, b) => b.severity - a.severity || a.startLineNumber - b.startLineNumber);
      const fsPath = items[0].resource.fsPath;
      const name = fsPath.split(/[\\/]/).pop();
      html += `<div class="problems__file">
        <span class="node-icon">${fileIcon(name)}</span>
        <b>${escapeHtml(name)}</b><span class="problems__path">${escapeHtml(fsPath)}</span>
        <span class="problems__badge">${items.length}</span>
      </div>`;
      for (const m of items) {
        flat.push(m);
        const kind = kindOf(m.severity);
        const code = m.code ? (typeof m.code === 'object' ? m.code.value : m.code) : '';
        html += `<button type="button" class="problem ${kind}" data-idx="${flat.length - 1}">
          <span class="problem__ic">${ICONS[kind]}</span>
          <span class="problem__msg">${escapeHtml(m.message)}</span>
          <span class="problem__src">${escapeHtml([m.source, code].filter(Boolean).join(' '))}</span>
          <span class="problem__pos">Ln ${m.startLineNumber}, Col ${m.startColumn}</span>
        </button>`;
      }
    }
    listEl.innerHTML = html;
  }

  listEl.addEventListener('click', (e) => {
    const row = e.target.closest('.problem');
    if (!row) return;
    const m = flat[Number(row.dataset.idx)];
    onReveal(m.resource.fsPath, m.startLineNumber, m.startColumn);
  });

  return watchMarkers(render);
}
