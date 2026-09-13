// Ctrl+K command palette. Real data only — projects (local registry) and
// files (within whichever project is currently open, if any) — plus a small
// set of genuine app actions. No fabricated "commands"/"builds" content.
const folderIconPath = '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>';
const filePathIcon = '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>';
const cmdIconPath = '<path d="m7.5 9 2.5 3-2.5 3M13 15h4"/><rect x="3" y="4" width="18" height="16" rx="4"/>';

export function initCommandPalette({ getProjects, getOpenFiles, onOpenProject, onOpenFile, commands }) {
  const box = document.getElementById('searchBox');
  const input = document.getElementById('searchInput');
  const resultsEl = document.getElementById('results');
  const scrim = document.getElementById('scrim');

  let flat = [];
  let cursor = 0;

  function render(query) {
    const q = query.trim().toLowerCase();
    const projects = getProjects().filter((p) => !q || p.name.toLowerCase().includes(q) || p.folderPath.toLowerCase().includes(q));
    const files = getOpenFiles().filter((f) => !q || f.name.toLowerCase().includes(q));
    const cmds = commands.filter((c) => !q || c.label.toLowerCase().includes(q));

    const groups = [
      { title: 'Projects', icon: folderIconPath, items: projects.map((p) => ({ t: p.name, s: p.folderPath, tag: p.cloudEnabled ? 'cloud' : 'local', action: () => onOpenProject(p) })) },
      { title: 'Files', icon: filePathIcon, items: files.map((f) => ({ t: f.name, s: f.path, tag: 'file', action: () => onOpenFile(f.path) })) },
      { title: 'Commands', icon: cmdIconPath, items: cmds.map((c) => ({ t: c.label, s: c.hint || '', tag: 'run', action: c.action })) }
    ].filter((g) => g.items.length);

    flat = [];
    if (!groups.length) {
      resultsEl.innerHTML = '<div class="empty" style="border:0;padding:34px 10px"><b>No matches</b>Try a project name, a file, or a command.</div>';
      return;
    }

    resultsEl.innerHTML = groups.map((g) =>
      `<div class="results__title">${g.title}</div>` +
      g.items.map((it) => {
        flat.push(it);
        return `<button class="result" type="button" data-idx="${flat.length - 1}">
          <span class="result__ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round">${g.icon}</svg></span>
          <span style="min-width:0"><b>${escapeHtml(it.t)}</b><span>${escapeHtml(it.s)}</span></span>
          <span class="tag">${it.tag}</span>
        </button>`;
      }).join('')
    ).join('');

    cursor = 0;
    paintCursor();
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function paintCursor() {
    [...resultsEl.querySelectorAll('.result')].forEach((r, i) => {
      r.classList.toggle('is-cursor', i === cursor);
      if (i === cursor) r.scrollIntoView({ block: 'nearest' });
    });
  }

  function open() {
    box.classList.add('is-open');
    scrim.classList.add('is-open');
    input.value = '';
    render('');
    setTimeout(() => input.focus(), 60);
  }

  function close() {
    box.classList.remove('is-open');
    scrim.classList.remove('is-open');
  }

  input.addEventListener('input', (e) => render(e.target.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); cursor = Math.min(flat.length - 1, cursor + 1); paintCursor(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); cursor = Math.max(0, cursor - 1); paintCursor(); }
    if (e.key === 'Enter' && flat[cursor]) { close(); flat[cursor].action(); }
  });
  resultsEl.addEventListener('click', (e) => {
    const r = e.target.closest('.result');
    if (!r) return;
    close();
    flat[Number(r.dataset.idx)].action();
  });

  return { open, close, isOpen: () => box.classList.contains('is-open') };
}
