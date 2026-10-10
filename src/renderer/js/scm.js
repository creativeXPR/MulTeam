// Source Control view (sidebar) + branch indicator (footer). Backed by
// window.electronAPI.git (simple-git in the main process). All operations
// run against the repository root that `status` reports, so a project that
// is a subfolder of a bigger repo still stages the right paths.
import { fileIconSvg, colorForExtension } from './icons.js';

const ICON = {
  stage: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  unstage: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg>',
  discard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>',
  open: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 13 4 4L19 7"/></svg>'
};

const LETTER_LABEL = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', U: 'Untracked', '!': 'Conflict' };

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function initScm({ getRoot, openFile, confirmDialog, promptDialog, toast, onChangeCount }) {
  const api = window.electronAPI?.git;
  const body = document.getElementById('scmBody');
  const branchBtn = document.getElementById('branchBtn');
  const branchName = document.getElementById('branchName');
  const branchSync = document.getElementById('branchSync');
  let state = null;       // last status
  let busy = false;
  let message = '';       // commit message survives re-renders
  const collapsed = { staged: false, changes: false };

  function cleanErr(err) {
    return String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }

  async function run(label, fn, { quiet = false } = {}) {
    if (busy) return;
    busy = true;
    body.classList.add('is-busy');
    try {
      const out = await fn();
      if (!quiet && label) toast(label);
      return out;
    } catch (err) {
      toast(cleanErr(err), 'error');
    } finally {
      busy = false;
      body.classList.remove('is-busy');
      await refresh();
    }
  }

  // ---------- data ----------
  async function refresh() {
    const root = getRoot();
    if (!api || !root) { state = null; render(); return; }
    try { state = await api.status(root); } catch (err) { state = { error: cleanErr(err) }; }
    render();
  }

  function lists() {
    if (!state?.isRepo) return { staged: [], changes: [] };
    const staged = [];
    const changes = [];
    for (const f of state.files) {
      const conflict = f.index === 'U' || f.workingDir === 'U' || (f.index === 'A' && f.workingDir === 'A') || (f.index === 'D' && f.workingDir === 'D');
      if (conflict) { changes.push({ ...f, letter: '!' }); continue; }
      if (f.index !== ' ' && f.index !== '?') staged.push({ ...f, letter: f.index });
      if (f.workingDir !== ' ') changes.push({ ...f, letter: f.workingDir === '?' ? 'U' : f.workingDir, untracked: f.workingDir === '?' });
    }
    return { staged, changes };
  }

  const fullPath = (rel) => {
    const sep = state.repoRoot.includes('\\') ? '\\' : '/';
    return state.repoRoot + sep + rel.split('/').join(sep);
  };

  // ---------- rendering ----------
  function fileRow(f, group) {
    const name = f.path.split('/').pop();
    const dir = f.path.split('/').slice(0, -1).join('/');
    const actions = group === 'staged'
      ? `<button type="button" class="ibtn" data-act="unstage" title="Unstage">${ICON.unstage}</button>`
      : `<button type="button" class="ibtn danger" data-act="discard" title="Discard changes">${ICON.discard}</button>
         <button type="button" class="ibtn" data-act="stage" title="Stage">${ICON.stage}</button>`;
    return `<div class="scm__file" data-path="${escapeHtml(f.path)}" data-group="${group}" title="${escapeHtml(f.path)} — ${LETTER_LABEL[f.letter] || f.letter}">
      <span class="node-icon">${fileIconSvg(colorForExtension(name.split('.').pop()))}</span>
      <span class="scm__name ${f.letter === 'D' ? 'is-deleted' : ''}">${escapeHtml(name)}</span>
      <span class="scm__dir">${escapeHtml(dir)}</span>
      <span class="scm__acts">
        ${f.letter !== 'D' ? `<button type="button" class="ibtn" data-act="open" title="Open file">${ICON.open}</button>` : ''}
        ${actions}
      </span>
      <span class="scm__letter l-${f.letter === '!' ? 'conflict' : f.letter}">${f.letter}</span>
    </div>`;
  }

  function section(key, title, items, headActions) {
    if (!items.length) return '';
    return `<div class="scm__section">
      <div class="scm__shead" data-collapse="${key}">
        <span class="scm__chev ${collapsed[key] ? '' : 'is-open'}">${ICON.chev}</span>
        <span>${title}</span>
        <span class="scm__acts">${headActions}</span>
        <span class="scm__count">${items.length}</span>
      </div>
      <div ${collapsed[key] ? 'hidden' : ''}>${items.map((f) => fileRow(f, key)).join('')}</div>
    </div>`;
  }

  function render() {
    const { staged, changes } = lists();
    onChangeCount(staged.length + changes.length);
    paintBranch();

    if (!api) { body.innerHTML = '<p class="scm__empty">Source control is unavailable.</p>'; return; }
    if (!getRoot()) { body.innerHTML = '<p class="scm__empty">Open a project to see its source control.</p>'; return; }
    if (!state) { body.innerHTML = '<p class="scm__empty">Loading…</p>'; return; }
    if (state.error) { body.innerHTML = `<p class="scm__empty error">${escapeHtml(state.error)}</p>`; return; }
    if (!state.isRepo) {
      body.innerHTML = `<div class="scm__empty">
        <p>This project isn't a Git repository yet.</p>
        <button type="button" class="pillbtn is-primary" data-act="init">Initialize Repository</button>
      </div>`;
      return;
    }

    const focused = document.activeElement?.id === 'scmMessage';
    const caret = focused ? document.activeElement.selectionStart : null;
    body.innerHTML = `
      <div class="scm__commit">
        <textarea id="scmMessage" rows="2" placeholder="Message (Ctrl+Enter to commit on '${escapeHtml(state.branch)}')" spellcheck="true"></textarea>
        <button type="button" class="pillbtn is-primary scm__commitbtn" data-act="commit" ${staged.length + changes.length ? '' : 'disabled'}>
          ${ICON.check} Commit${staged.length ? '' : changes.length ? ' all' : ''}
        </button>
      </div>
      ${section('staged', 'Staged Changes', staged, `<button type="button" class="ibtn" data-act="unstage-all" title="Unstage all">${ICON.unstage}</button>`)}
      ${section('changes', 'Changes', changes, `<button type="button" class="ibtn danger" data-act="discard-all" title="Discard all changes">${ICON.discard}</button><button type="button" class="ibtn" data-act="stage-all" title="Stage all">${ICON.stage}</button>`)}
      ${!staged.length && !changes.length ? '<p class="scm__empty">No changes. Your working tree is clean.</p>' : ''}
    `;
    const ta = document.getElementById('scmMessage');
    ta.value = message;
    if (focused) { ta.focus(); ta.setSelectionRange(caret, caret); }
  }

  function paintBranch() {
    if (!state?.isRepo) { branchBtn.hidden = true; return; }
    branchBtn.hidden = false;
    branchName.textContent = state.branch;
    const parts = [];
    if (state.behind) parts.push(`↓${state.behind}`);
    if (state.ahead) parts.push(`↑${state.ahead}`);
    branchSync.textContent = parts.join(' ');
    branchBtn.title = state.tracking
      ? `${state.branch} → ${state.tracking}${parts.length ? ` (${state.behind} behind, ${state.ahead} ahead)` : ' (up to date)'} — click to switch branch`
      : `${state.branch} (not published) — click to switch branch`;
  }

  // ---------- actions ----------
  const repo = () => state.repoRoot;
  const pathsOf = (items) => items.map((f) => f.path);

  async function commit() {
    message = document.getElementById('scmMessage')?.value ?? message;
    if (!message.trim()) { toast('Write a commit message first', 'error'); document.getElementById('scmMessage')?.focus(); return; }
    const { staged, changes } = lists();
    if (!staged.length) {
      const ok = await confirmDialog({
        title: 'Stage all changes and commit?',
        message: `There are no staged changes. All ${changes.length} changed file${changes.length === 1 ? '' : 's'} will be staged and committed.`,
        confirmLabel: 'Stage all & commit'
      });
      if (!ok) return;
    }
    const msg = message.trim();
    const res = await run('', async () => {
      if (!staged.length) await api.stage(repo(), pathsOf(changes));
      return api.commit(repo(), msg);
    });
    if (res) {
      message = '';
      const ta = document.getElementById('scmMessage');
      if (ta) ta.value = '';
      toast(`Committed ${res.commit ? res.commit.slice(0, 7) : ''} · ${res.summary.changes} file${res.summary.changes === 1 ? '' : 's'} changed`);
    }
  }

  async function discard(items) {
    const n = items.length;
    const ok = await confirmDialog({
      title: n === 1 ? `Discard changes to "${items[0].path.split('/').pop()}"?` : `Discard all ${n} changes?`,
      message: items.some((f) => f.untracked)
        ? "Your edits will be lost, and new (untracked) files will be deleted. This can't be undone."
        : "Your edits will be lost and the files restored to their last committed state. This can't be undone.",
      confirmLabel: n === 1 ? 'Discard' : 'Discard all',
      danger: true
    });
    if (!ok) return;
    await run(n === 1 ? 'Changes discarded' : `${n} changes discarded`, () => api.discard(repo(), {
      tracked: pathsOf(items.filter((f) => !f.untracked)),
      untracked: pathsOf(items.filter((f) => f.untracked))
    }));
  }

  body.addEventListener('input', (e) => { if (e.target.id === 'scmMessage') message = e.target.value; });
  body.addEventListener('keydown', (e) => {
    if (e.target.id === 'scmMessage' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); }
  });

  body.addEventListener('click', async (e) => {
    const col = e.target.closest('[data-collapse]');
    const btn = e.target.closest('[data-act]');
    if (btn) {
      e.stopPropagation();
      const act = btn.dataset.act;
      const row = btn.closest('.scm__file');
      const { staged, changes } = lists();
      const item = row && (row.dataset.group === 'staged' ? staged : changes).find((f) => f.path === row.dataset.path);
      if (act === 'init') return run('Repository initialized', () => api.init(getRoot()));
      if (act === 'commit') return commit();
      if (act === 'stage-all') return run('', () => api.stage(repo(), pathsOf(changes)), { quiet: true });
      if (act === 'unstage-all') return run('', () => api.unstage(repo(), pathsOf(staged)), { quiet: true });
      if (act === 'discard-all') return discard(changes);
      if (!item) return;
      if (act === 'stage') return run('', () => api.stage(repo(), [item.path]), { quiet: true });
      if (act === 'unstage') return run('', () => api.unstage(repo(), [item.path]), { quiet: true });
      if (act === 'discard') return discard([item]);
      if (act === 'open') return openFile(fullPath(item.path));
      return;
    }
    if (col) {
      collapsed[col.dataset.collapse] = !collapsed[col.dataset.collapse];
      render();
      return;
    }
    const row = e.target.closest('.scm__file');
    if (row) {
      const { staged, changes } = lists();
      const item = (row.dataset.group === 'staged' ? staged : changes).find((f) => f.path === row.dataset.path);
      if (item && item.letter !== 'D') openFile(fullPath(item.path));
    }
  });

  // header actions
  document.getElementById('scmRefresh').addEventListener('click', () => run('', async () => {}, { quiet: true }));
  document.getElementById('scmPull').addEventListener('click', () => state?.isRepo && run('Pulled', () => api.pull(repo())));
  document.getElementById('scmPush').addEventListener('click', () => state?.isRepo && run('Pushed', () => api.push(repo())));

  // ---------- branch menu (footer) ----------
  let menu = null;
  function closeMenu() { if (menu) { menu.remove(); menu = null; document.removeEventListener('pointerdown', outside, true); } }
  function outside(e) { if (menu && !menu.contains(e.target) && !branchBtn.contains(e.target)) closeMenu(); }

  async function openBranchMenu() {
    if (menu) { closeMenu(); return; }
    if (!state?.isRepo) return;
    let branches;
    try { branches = await api.branches(repo()); } catch (err) { toast(cleanErr(err), 'error'); return; }

    menu = document.createElement('div');
    menu.className = 'menubar__menu branch-menu';
    menu.innerHTML = `
      <div class="branch-menu__title">Switch branch</div>
      ${branches.all.map((b) => `<button type="button" class="menubar__item" data-branch="${escapeHtml(b)}">
        <span class="cselect__check">${b === branches.current ? ICON.check : ''}</span><span class="menubar__label">${escapeHtml(b)}</span></button>`).join('')}
      <div class="menu-divider"></div>
      <button type="button" class="menubar__item" data-new><span class="cselect__check">${ICON.stage}</span><span class="menubar__label">Create new branch…</span></button>
      ${state.hasRemote ? `<button type="button" class="menubar__item" data-fetch><span class="cselect__check"></span><span class="menubar__label">Fetch from remote</span></button>` : ''}`;
    document.body.appendChild(menu);
    const r = branchBtn.getBoundingClientRect();
    menu.style.left = `${r.left}px`;
    menu.style.top = `${r.top - menu.offsetHeight - 6}px`;
    document.addEventListener('pointerdown', outside, true);

    menu.addEventListener('pointermove', (e) => {
      menu.querySelectorAll('.menubar__item').forEach((i) => i.classList.toggle('is-cursor', i === e.target.closest('.menubar__item')));
    });
    menu.addEventListener('click', async (e) => {
      const item = e.target.closest('.menubar__item');
      if (!item) return;
      closeMenu();
      if (item.dataset.branch && item.dataset.branch !== branches.current) {
        run(`Switched to ${item.dataset.branch}`, () => api.checkout(repo(), item.dataset.branch));
      } else if (item.hasAttribute('data-new')) {
        const name = await promptDialog({ title: 'Create branch', label: 'Branch name', placeholder: 'feature/my-change', confirmLabel: 'Create & switch' });
        if (name) run(`Created and switched to ${name.trim()}`, () => api.createBranch(repo(), name.trim()));
      } else if (item.hasAttribute('data-fetch')) {
        run('Fetched', () => api.fetch(repo()));
      }
    });
  }
  branchBtn.addEventListener('click', (e) => { e.stopPropagation(); openBranchMenu(); });

  // ---------- auto refresh ----------
  window.addEventListener('focus', () => refresh());
  setInterval(() => { if (getRoot() && !document.hidden && !busy) refresh(); }, 10000);

  let soon = null;
  return {
    refresh,
    refreshSoon() { clearTimeout(soon); soon = setTimeout(refresh, 400); },
    pull: () => state?.isRepo && run('Pulled', () => api.pull(repo())),
    push: () => state?.isRepo && run('Pushed', () => api.push(repo())),
    fetch: () => state?.isRepo && run('Fetched', () => api.fetch(repo())),
    focusMessage() { document.getElementById('scmMessage')?.focus(); },
    isRepo: () => !!state?.isRepo,
    hasRemote: () => !!state?.hasRemote,
    openBranchMenu
  };
}
