// Find in files (Ctrl+Shift+F): the sidebar's Search pane. Queries run in
// the main process (main/search.js); results are grouped by file and each
// hit jumps to its line/column in the editor.
import { fileIcon, chevronSvg } from './icons.js';

const OPTS_KEY = 'multeam:searchOptions';

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function initSearchView({ getRoot, onOpenMatch }) {
  const input = document.getElementById('fsearchInput');
  const summary = document.getElementById('fsearchSummary');
  const resultsEl = document.getElementById('fsearchResults');
  const optBtns = [...document.querySelectorAll('[data-fopt]')];

  let options = { caseSensitive: false, wholeWord: false, regex: false };
  try { options = { ...options, ...JSON.parse(localStorage.getItem(OPTS_KEY) || '{}') }; } catch { /* defaults */ }
  let seq = 0;
  let timer = null;
  let lastResults = [];

  function paintOptions() {
    optBtns.forEach((b) => b.classList.toggle('is-on', !!options[b.dataset.fopt]));
  }

  function setSummary(text, isError = false) {
    summary.textContent = text;
    summary.classList.toggle('error', isError);
  }

  async function run() {
    const query = input.value;
    const root = getRoot();
    const mySeq = ++seq;

    if (!query) { resultsEl.innerHTML = ''; setSummary(''); lastResults = []; return; }
    if (!root) { resultsEl.innerHTML = ''; setSummary('Open a project to search its files.'); return; }

    setSummary('Searching…');
    let res;
    try {
      res = await window.electronAPI.searchText(root, query, options);
    } catch (err) {
      if (mySeq !== seq) return;
      resultsEl.innerHTML = '';
      setSummary(String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true);
      return;
    }
    if (mySeq !== seq) return; // a newer search started meanwhile

    lastResults = res.results;
    const files = res.results.length;
    if (!files) { resultsEl.innerHTML = ''; setSummary('No results found.'); return; }
    setSummary(`${res.matchCount}${res.truncated ? '+' : ''} result${res.matchCount === 1 ? '' : 's'} in ${files} file${files === 1 ? '' : 's'}${res.truncated ? ' — showing the first 2,000' : ''}`);
    render();
  }

  function render() {
    resultsEl.innerHTML = lastResults.map((f, fi) => {
      const cut = Math.max(f.rel.lastIndexOf('/'), f.rel.lastIndexOf('\\')) + 1;
      const name = f.rel.slice(cut);
      const dir = f.rel.slice(0, Math.max(0, cut - 1));
      const hits = f.matches.map((m, mi) => {
        const p = m.preview;
        const a = m.previewOffset;
        const b = a + m.length;
        return `<button type="button" class="fsearch__hit" data-f="${fi}" data-m="${mi}" title="${escapeHtml(p.trim())}">` +
          `<span class="ln">${m.line}</span>${escapeHtml(p.slice(0, a).trimStart())}<mark>${escapeHtml(p.slice(a, b))}</mark>${escapeHtml(p.slice(b))}</button>`;
      }).join('');
      return `<div class="fsearch__group">
        <button type="button" class="fsearch__file" data-toggle="${fi}">
          <span class="chev">${chevronSvg()}</span>
          <span class="node-icon">${fileIcon(name)}</span>
          <span class="name">${escapeHtml(name)}</span>
          <span class="dir">${escapeHtml(dir)}</span>
          <span class="count">${f.matches.length}</span>
        </button>
        <div class="fsearch__hits">${hits}</div>
      </div>`;
    }).join('');
    // chevron starts pointing down (expanded)
    resultsEl.querySelectorAll('.fsearch__file .chev').forEach((c) => { c.style.transform = 'rotate(90deg)'; });
  }

  resultsEl.addEventListener('click', (e) => {
    const toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      const hits = toggle.nextElementSibling;
      hits.hidden = !hits.hidden;
      toggle.querySelector('.chev').style.transform = hits.hidden ? '' : 'rotate(90deg)';
      return;
    }
    const hit = e.target.closest('.fsearch__hit');
    if (!hit) return;
    const f = lastResults[Number(hit.dataset.f)];
    const m = f.matches[Number(hit.dataset.m)];
    onOpenMatch(f.path, m.line, m.column, m.length);
  });

  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 250); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(timer); run(); } });
  optBtns.forEach((b) => b.addEventListener('click', () => {
    options[b.dataset.fopt] = !options[b.dataset.fopt];
    try { localStorage.setItem(OPTS_KEY, JSON.stringify(options)); } catch { /* non-fatal */ }
    paintOptions();
    run();
  }));

  paintOptions();

  return {
    focus(prefill) {
      if (prefill) input.value = prefill;
      input.focus();
      input.select();
      if (input.value) run();
    },
    rerun: run
  };
}
