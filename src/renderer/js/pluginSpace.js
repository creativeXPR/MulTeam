// The Plugins space (its own sidebar icon): Installed · Gallery · Templates ·
// Learn. Installed is drawn by pluginHost.js; this module runs the tabs, the
// shared gallery (Firestore — see firebase.js), the starter templates and the
// tutorial entry point. Installing always shows publisher + permissions first.
import { auth, galleryList, galleryVersion, galleryPublish, galleryCountDownload, galleryUnpublish } from './firebase.js';
import { requireAuth } from './authModal.js';

const PERMISSION_TEXT = {
  editor: 'read and change the code in the open file',
  'workspace.read': 'read files in your open project',
  'workspace.write': 'create and change files in your open project'
};

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 1.10.0 > 1.9.3
function newer(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

const cleanErr = (err) => {
  const msg = String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  if (/permission|insufficient/i.test(msg) && /missing|insufficient/i.test(msg)) {
    return 'The plugin gallery isn’t set up on the server yet (its Firestore security rules haven’t been deployed).';
  }
  return msg;
};

const permissionList = (perms) => (perms?.length ? perms.map((p) => `• ${PERMISSION_TEXT[p] || p}`).join('\n') : '• no special permissions');

export function initPluginSpace({ toast, confirmDialog, promptDialog, getPluginHost, openTutorial, editPlugin }) {
  const api = window.electronAPI.plugins;
  const tabsEl = document.getElementById('pluginTabs');
  const search = document.getElementById('pluginSearch');
  const panes = {
    installed: document.getElementById('pluginList'),
    gallery: document.getElementById('pluginGallery'),
    templates: document.getElementById('pluginTemplates'),
    learn: document.getElementById('pluginLearn')
  };
  let tab = 'installed';
  let gallery = null;          // [{ id, name, … }] once loaded
  let galleryError = '';
  let templates = [];
  const busy = new Set();

  const host = () => getPluginHost();
  const installedVersion = (id) => host()?.installed().find((p) => p.id === id)?.version || null;

  // ---------- tabs ----------
  function setTab(next) {
    tab = next;
    tabsEl.querySelectorAll('[data-ptab2]').forEach((b) => b.classList.toggle('is-on', b.dataset.ptab2 === tab));
    for (const [k, el] of Object.entries(panes)) el.hidden = k !== tab;
    search.parentElement.hidden = tab === 'learn';
    search.placeholder = { installed: 'Filter installed plugins', gallery: 'Search the gallery', templates: 'Filter templates' }[tab] || '';
    if (tab === 'gallery' && !gallery) loadGallery();
    if (tab === 'templates' && !templates.length) loadTemplates();
    applyFilter();
  }
  tabsEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ptab2]');
    if (b) setTab(b.dataset.ptab2);
  });
  function applyFilter() {
    const q = search.value.trim();
    if (tab === 'installed') host()?.setFilter(q);
    if (tab === 'gallery') renderGallery();
    if (tab === 'templates') renderTemplates();
  }
  search.addEventListener('input', applyFilter);

  // ---------- gallery ----------
  async function loadGallery() {
    gallery = null;
    galleryError = '';
    renderGallery();
    try { gallery = await galleryList(); } catch (err) { gallery = []; galleryError = cleanErr(err); }
    renderGallery();
    host()?.rerender(); // "Unpublish" buttons depend on ownership
  }

  function renderGallery() {
    const el = panes.gallery;
    const head = `<div class="ext__section">Gallery <span class="ext__src">shared by MulTeam users</span>
      <span class="plugin__headacts"><button type="button" class="chipbtn" data-gal="refresh">Refresh</button></span></div>`;
    if (!gallery) { el.innerHTML = `${head}<div class="bounce-loader"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>`; return; }
    if (galleryError) { el.innerHTML = `${head}<p class="scm__empty error">${escapeHtml(galleryError)}</p>`; return; }
    const q = search.value.trim().toLowerCase();
    const items = gallery.filter((g) => !q || `${g.name} ${g.description} ${g.id} ${g.authorName}`.toLowerCase().includes(q));
    if (!items.length) {
      el.innerHTML = `${head}<p class="scm__empty">${gallery.length ? 'Nothing matches.' : 'No plugins published yet. Be the first: Installed → Publish…'}</p>`;
      return;
    }
    el.innerHTML = head + items.map((g) => {
      const have = installedVersion(g.id);
      let action;
      if (busy.has(g.id)) action = '<span class="ext__busy">Working…</span>';
      else if (!have) action = `<button type="button" class="chipbtn is-primary" data-gal="install" data-id="${escapeHtml(g.id)}">Install</button>`;
      else if (newer(g.latestVersion, have)) action = `<button type="button" class="chipbtn is-primary" data-gal="install" data-id="${escapeHtml(g.id)}">Update to ${escapeHtml(g.latestVersion)}</button>`;
      else action = '<span class="plugin__live">✓ installed</span>';
      return `<div class="ext">
        <div class="ext__media"><span class="ext__ic plugin__ic">${escapeHtml((g.name?.[0] || '?').toUpperCase())}</span></div>
        <div class="ext__info">
          <div class="ext__top"><b>${escapeHtml(g.name)}</b><span class="ext__dl">↓ ${g.downloads || 0}</span></div>
          <div class="ext__desc">${escapeHtml(g.description)}</div>
          <div class="ext__meta"><span>${escapeHtml(g.authorName)}</span><span>v${escapeHtml(g.latestVersion)}</span>${(g.permissions || []).map((p) => `<span class="perm">${escapeHtml(p)}</span>`).join('')}</div>
          <div class="ext__acts">${action}</div>
        </div>
      </div>`;
    }).join('');
  }

  async function installFromGallery(id) {
    const g = gallery.find((x) => x.id === id);
    if (!g) return;
    const have = installedVersion(id);
    let message = `Publisher: ${g.authorName}\nVersion: ${g.latestVersion}\n\nThis plugin will be able to:\n${permissionList(g.permissions)}`;
    if (have) {
      const before = new Set(host()?.installed().find((p) => p.id === id)?.permissions || []);
      const added = (g.permissions || []).filter((p) => !before.has(p));
      if (added.length) message = `This update asks for NEW permissions:\n${permissionList(added)}\n\n${message}`;
    }
    const ok = await confirmDialog({ title: have ? `Update ${g.name}?` : `Install ${g.name}?`, message: `${message}\n\nOnly install plugins from people you trust.`, confirmLabel: have ? 'Update' : 'Install' });
    if (!ok) return;
    busy.add(id); renderGallery();
    try {
      const v = await galleryVersion(id, g.latestVersion);
      const manifest = await api.installFromGallery(v.package, v.sha256);
      galleryCountDownload(id);
      await host()?.reloadAll();
      g.downloads = (g.downloads || 0) + 1;
      toast(`${have ? 'Updated' : 'Installed'} ${manifest.name} ${manifest.version}`);
    } catch (err) {
      toast(cleanErr(err), 'error');
    } finally { busy.delete(id); renderGallery(); }
  }

  panes.gallery.addEventListener('click', (e) => {
    const b = e.target.closest('[data-gal]');
    if (!b) return;
    if (b.dataset.gal === 'refresh') loadGallery();
    if (b.dataset.gal === 'install') installFromGallery(b.dataset.id);
  });

  // ---------- publish / unpublish (from Installed cards) ----------
  async function publish(p) {
    await new Promise((resolve) => requireAuth(resolve)); // opens sign-in if needed; resolves once signed in
    if (!auth.currentUser) return;
    let pack;
    try { pack = await api.pack(p.id); } catch (err) { toast(cleanErr(err), 'error'); return; }
    const ok = await confirmDialog({
      title: `Publish ${pack.manifest.name} ${pack.manifest.version}?`,
      message: `It becomes public in the MulTeam plugin gallery under your name (${auth.currentUser.displayName || 'MulTeam publisher'}).\n\nId: ${pack.manifest.id}\nSize: ${(pack.size / 1024).toFixed(1)} KB\nAsks for:\n${permissionList(pack.manifest.permissions)}\n\nPublished versions can't be changed — publish fixes as a new version.`,
      confirmLabel: 'Publish'
    });
    if (!ok) return;
    const changelog = await promptDialog({ title: 'What’s new? (optional)', label: 'Changelog', placeholder: 'First release', confirmLabel: 'Publish' });
    if (changelog === null) return;
    try {
      await galleryPublish({ manifest: pack.manifest, base64: pack.base64, sha256: pack.sha256, size: pack.size, changelog });
      toast(`Published ${pack.manifest.name} ${pack.manifest.version} to the gallery`);
      await loadGallery();
    } catch (err) {
      toast(cleanErr(err), 'error');
    }
  }

  async function unpublish(p) {
    const ok = await confirmDialog({
      title: `Unpublish ${p.name}?`,
      message: 'It’s removed from the gallery, with every published version. People who already installed it keep their copy. Your local plugin isn’t touched.',
      confirmLabel: 'Unpublish',
      danger: true
    });
    if (!ok) return;
    try {
      await galleryUnpublish(p.id);
      toast(`${p.name} removed from the gallery`);
      await loadGallery();
    } catch (err) { toast(cleanErr(err), 'error'); }
  }

  // ---------- templates ----------
  async function loadTemplates() {
    try { templates = await api.templates(); } catch (err) { toast(cleanErr(err), 'error'); }
    renderTemplates();
  }

  function renderTemplates() {
    const q = search.value.trim().toLowerCase();
    const items = templates.filter((t) => !q || `${t.title} ${t.summary}`.toLowerCase().includes(q));
    panes.templates.innerHTML = `<div class="ext__section">Templates <span class="ext__src">free starting points</span></div>` + (items.length ? items.map((t) => `
      <div class="ext">
        <div class="ext__media"><span class="ext__ic lang__ic">❖</span></div>
        <div class="ext__info">
          <div class="ext__top"><b>${escapeHtml(t.title)}</b></div>
          <div class="ext__desc">${escapeHtml(t.summary)}</div>
          <div class="ext__meta">${t.permissions.length ? t.permissions.map((p) => `<span class="perm">${escapeHtml(p)}</span>`).join('') : '<span>no permissions</span>'}</div>
          <div class="ext__acts"><button type="button" class="chipbtn is-primary" data-tpl="${escapeHtml(t.id)}">Use template</button></div>
        </div>
      </div>`).join('') : '<p class="scm__empty">Nothing matches.</p>') +
      '<p class="plugin__tip">New to plugins? <button type="button" class="linkbtn" data-learn="tutorial">Read the tutorial</button> — about 10 minutes.</p>';
  }

  panes.templates.addEventListener('click', async (e) => {
    if (e.target.closest('[data-learn]')) return openTutorial();
    const b = e.target.closest('[data-tpl]');
    if (!b) return;
    const tpl = templates.find((t) => t.id === b.dataset.tpl);
    const name = await promptDialog({ title: `New plugin from “${tpl.title}”`, label: 'Plugin name', placeholder: 'My Plugin', confirmLabel: 'Create' });
    if (!name) return;
    try {
      const made = await api.scaffold(name, tpl.id);
      await host()?.reloadAll();
      setTab('installed');
      toast(`Created ${made.id} — opening it for editing`);
      editPlugin?.(made.id);
    } catch (err) { toast(cleanErr(err), 'error'); }
  });

  // ---------- learn ----------
  panes.learn.innerHTML = `
    <div class="ext__section">Learn</div>
    <div class="learn">
      <button type="button" class="learn__card" data-learn="tutorial">
        <b>Plugin tutorial</b>
        <span>Build your first plugin step by step: templates, the API, permissions, testing, packaging and publishing.</span>
      </button>
      <button type="button" class="learn__card" data-learn="templates">
        <b>Start from a template</b>
        <span>Six working examples — commands, status items, text tools, snippets, file generators and save hooks.</span>
      </button>
      <div class="learn__ref">
        <b>Quick reference</b>
        <pre>multeam.commands.register(id, title, fn)
multeam.window.showMessage(text)
await multeam.window.showInput({ title })
multeam.window.setStatus(text)
await multeam.editor.getText()        // editor
await multeam.editor.replaceSelection(t)
await multeam.workspace.readFile(path) // workspace.read
multeam.languages.registerCompletions(lang, fn)
multeam.on('open' | 'save', fn)</pre>
      </div>
    </div>`;
  panes.learn.addEventListener('click', (e) => {
    const b = e.target.closest('[data-learn]');
    if (!b) return;
    if (b.dataset.learn === 'tutorial') openTutorial();
    if (b.dataset.learn === 'templates') setTab('templates');
  });

  return {
    onShow() { setTab(tab); },
    showTab: setTab,
    // used by pluginHost cards
    onCreate: () => setTab('templates'),
    onEdit: (p) => editPlugin?.(p.id),
    onPublish: publish,
    onUnpublish: unpublish,
    isPublishedByMe: (id) => !!(gallery && auth.currentUser && gallery.find((g) => g.id === id && g.authorUid === auth.currentUser.uid))
  };
}
