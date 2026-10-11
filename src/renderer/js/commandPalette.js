// Ctrl+K command palette / Ctrl+P quick open. Real data only — projects
// (local registry), files of the open project, open tabs, and a small set of
// genuine app actions.
//   mode 'all'   (Ctrl+K): projects + open files + commands
//   mode 'files' (Ctrl+P): fuzzy file search across the open project;
//                          typing ">" switches to commands, like VS Code.
const folderIconPath = '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>';
const filePathIcon = '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>';
const cmdIconPath = '<path d="m7.5 9 2.5 3-2.5 3M13 15h4"/><rect x="3" y="4" width="18" height="16" rx="4"/>';
const MAX_FILE_RESULTS = 60;

// Subsequence fuzzy match. Rewards consecutive runs, matches at word/path
// boundaries, and matches inside the file name itself. Returns null when
// the query isn't a subsequence, else { score, hits: [indices] }.
function fuzzy(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const nameStart = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\')) + 1;
  let ti = 0;
  let score = 0;
  let prev = -2;
  const hits = [];
  for (const ch of q) {
    if (ch === ' ') continue;
    const idx = t.indexOf(ch, ti);
    if (idx === -1) return null;
    let s = 1;
    if (idx === prev + 1) s += 5;
    const before = text[idx - 1];
    if (idx === 0 || before === '/' || before === '\\' || before === '.' || before === '-' || before === '_') s += 4;
    if (idx >= nameStart) s += 3;
    score += s;
    hits.push(idx);
    prev = idx;
    ti = idx + 1;
  }
  return { score: score - text.length * 0.01, hits };
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function highlight(text, hits, from = 0) {
  const set = new Set(hits.map((h) => h - from));
  return [...text].map((c, i) => (set.has(i) ? `<mark>${escapeHtml(c)}</mark>` : escapeHtml(c))).join('');
}

export function initCommandPalette({ getProjects, getOpenFiles, listProjectFiles, onOpenProject, onOpenFile, commands }) {
  const box = document.getElementById('searchBox');
  const input = document.getElementById('searchInput');
  const resultsEl = document.getElementById('results');
  const scrim = document.getElementById('scrim');

  let flat = [];
  let cursor = 0;
  let mode = 'all';
  let fileIndex = null; // { root, files, truncated } for the current open
  let indexLoading = null;
  let picker = null;    // { items, onPreview, onPick, onCancel, picked } in 'pick' mode

  function commandItems(q) {
    return commands
      .filter((c) => !q || c.label.toLowerCase().includes(q))
      .map((c) => ({ t: c.label, s: c.hint || '', tag: 'run', action: c.action }));
  }

  function renderGroups(groups, emptyText) {
    groups = groups.filter((g) => g.items.length);
    flat = [];
    if (!groups.length) {
      resultsEl.innerHTML = `<div class="empty-state" style="padding:34px 10px"><b>No matches</b>${emptyText}</div>`;
      return;
    }
    resultsEl.innerHTML = groups.map((g) =>
      `<div class="results__title">${g.title}</div>` +
      g.items.map((it) => {
        flat.push(it);
        return `<button class="result" type="button" data-idx="${flat.length - 1}">
          <span class="result__ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round">${g.icon}</svg></span>
          <span style="min-width:0"><b>${it.html || escapeHtml(it.t)}</b><span>${escapeHtml(it.s)}</span></span>
          <span class="tag">${it.tag}</span>
        </button>`;
      }).join('')
    ).join('');
    cursor = 0;
    paintCursor();
  }

  function renderAll(query) {
    const q = query.trim().toLowerCase();
    const projects = getProjects().filter((p) => !q || p.name.toLowerCase().includes(q) || p.folderPath.toLowerCase().includes(q));
    const files = getOpenFiles().filter((f) => !q || f.name.toLowerCase().includes(q));
    renderGroups([
      { title: 'Projects', icon: folderIconPath, items: projects.map((p) => ({ t: p.name, s: p.folderPath, tag: p.cloudEnabled ? 'cloud' : 'local', action: () => onOpenProject(p) })) },
      { title: 'Open files', icon: filePathIcon, items: files.map((f) => ({ t: f.name, s: f.path, tag: 'file', action: () => onOpenFile(f.path) })) },
      { title: 'Commands', icon: cmdIconPath, items: commandItems(q) }
    ], 'Try a project name, a file, or a command.');
  }

  function renderFiles(query) {
    if (query.startsWith('>')) {
      renderGroups([{ title: 'Commands', icon: cmdIconPath, items: commandItems(query.slice(1).trim().toLowerCase()) }], 'No command by that name.');
      return;
    }
    if (!fileIndex) {
      resultsEl.innerHTML = indexLoading
        ? '<div class="results__title">Indexing files…</div>'
        : '<div class="empty-state" style="padding:34px 10px"><b>No project open</b>Open a project to search its files, or type &gt; for commands.</div>';
      return;
    }

    const q = query.trim();
    const sep = fileIndex.root.includes('\\') ? '\\' : '/';
    let ranked;
    if (!q) {
      // no query: open tabs first, then files in walk order
      const open = new Set(getOpenFiles().map((f) => f.path));
      ranked = fileIndex.files
        .map((rel) => ({ rel, score: open.has(fileIndex.root + sep + rel) ? 1 : 0, hits: [] }))
        .sort((a, b) => b.score - a.score);
    } else {
      ranked = [];
      for (const rel of fileIndex.files) {
        const m = fuzzy(q, rel);
        if (m) ranked.push({ rel, ...m });
      }
      ranked.sort((a, b) => b.score - a.score);
    }

    const items = ranked.slice(0, MAX_FILE_RESULTS).map(({ rel, hits }) => {
      const cut = Math.max(rel.lastIndexOf('/'), rel.lastIndexOf('\\')) + 1;
      const name = rel.slice(cut);
      return {
        t: name,
        html: highlight(name, hits.filter((h) => h >= cut), cut),
        s: rel.slice(0, Math.max(0, cut - 1)) || '.',
        tag: name.includes('.') ? name.split('.').pop() : 'file',
        action: () => onOpenFile(fileIndex.root + sep + rel)
      };
    });
    const note = fileIndex.truncated ? ' (large project — only the first 20,000 files are indexed)' : '';
    renderGroups([{ title: `Files${note}`, icon: filePathIcon, items }], 'No file name matches. Type &gt; for commands.');
  }

  function renderPick(query) {
    const q = query.trim().toLowerCase();
    const p = picker; // close() clears `picker` before the action runs
    const items = p.items
      .filter((it) => !q || it.label.toLowerCase().includes(q) || (it.detail || '').toLowerCase().includes(q))
      .map((it) => ({ t: it.label, s: it.detail || '', tag: it.value === p.current ? 'current' : '', action: () => { p.picked = true; p.onPick?.(it); }, item: it }));
    renderGroups([{ title: picker.title, icon: cmdIconPath, items }], 'Nothing matches.');
    const cur = flat.findIndex((f) => f.item.value === picker.current);
    if (cur > 0 && !q) { cursor = cur; paintCursor(); }
  }

  function render() {
    if (mode === 'pick') renderPick(input.value);
    else if (mode === 'files') renderFiles(input.value);
    else renderAll(input.value);
  }

  function paintCursor() {
    [...resultsEl.querySelectorAll('.result')].forEach((r, i) => {
      r.classList.toggle('is-cursor', i === cursor);
      if (i === cursor) r.scrollIntoView({ block: 'nearest' });
    });
    if (mode === 'pick' && flat[cursor]) picker.onPreview?.(flat[cursor].item);
  }

  function open(nextMode = 'all') {
    mode = nextMode;
    input.placeholder = mode === 'files' ? 'Search files by name (type > for commands)' : 'Search projects, files, commands…';
    box.classList.add('is-open');
    scrim.classList.add('is-open');
    input.value = '';

    if (mode === 'files') {
      // Re-index on every Ctrl+P: cheap, and always reflects files created
      // or deleted since last time (in the app or outside it).
      fileIndex = null;
      indexLoading = listProjectFiles().then((idx) => {
        fileIndex = idx;
        indexLoading = null;
        if (box.classList.contains('is-open') && mode === 'files') render();
      }).catch(() => { indexLoading = null; render(); });
    }
    render();
    setTimeout(() => input.focus(), 60);
  }

  function close() {
    const wasOpen = box.classList.contains('is-open');
    box.classList.remove('is-open');
    scrim.classList.remove('is-open');
    if (wasOpen && mode === 'pick' && picker && !picker.picked) picker.onCancel?.();
    if (mode === 'pick') { picker = null; mode = 'all'; }
  }

  // Generic quick pick: { title, items: [{label, detail, value}], current,
  // onPreview(item), onPick(item), onCancel() } — used e.g. by the theme picker.
  function pick(opts) {
    close();
    picker = { ...opts, picked: false };
    mode = 'pick';
    input.placeholder = opts.title || 'Select…';
    box.classList.add('is-open');
    scrim.classList.add('is-open');
    input.value = '';
    render();
    setTimeout(() => input.focus(), 60);
  }

  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); cursor = Math.min(flat.length - 1, cursor + 1); paintCursor(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); cursor = Math.max(0, cursor - 1); paintCursor(); }
    if (e.key === 'Enter' && flat[cursor]) { const act = flat[cursor].action; if (mode === 'pick') picker.picked = true; close(); act(); }
  });
  resultsEl.addEventListener('click', (e) => {
    const r = e.target.closest('.result');
    if (!r) return;
    const act = flat[Number(r.dataset.idx)].action;
    if (mode === 'pick') picker.picked = true;
    close();
    act();
  });
  // in pick mode, hovering a row previews it too
  resultsEl.addEventListener('pointermove', (e) => {
    if (mode !== 'pick') return;
    const r = e.target.closest('.result');
    if (r && Number(r.dataset.idx) !== cursor) { cursor = Number(r.dataset.idx); paintCursor(); }
  });

  return { open, close, pick, isOpen: () => box.classList.contains('is-open'), mode: () => mode };
}
