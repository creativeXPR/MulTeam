import { watchAuthState, signOut, createCloudProject, deleteCloudProject, upsertDocumentMeta } from './firebase.js';
import { requireAuth, openSignIn } from './authModal.js';
import { CollaborativeWorkspace, setMonacoTheme } from './editor.js';
import { PresenceBar } from './presence.js';
import { applyStoredTheme, setTheme, getTheme, setAccent, getAccent } from './theme.js';
import { getSettings, updateSettings, monacoOptionsFromSettings } from './settings.js';
import { initCommandPalette } from './commandPalette.js';
import {
  fileIconSvg, folderIconSvg, chevronSvg, colorForExtension,
  newFileIconSvg, newFolderIconSvg, saveIconSvg, trashIconSvg,
  duplicateIconSvg, renameIconSvg, copyIconSvg, chevronDownIconSvg,
  plusIconSvg, searchIconSvg, editIconSvg
} from './icons.js';

applyStoredTheme();

/* ============================================================
   Elements
   ============================================================ */
const views = {
  dashboard: document.getElementById('view-dashboard'),
  editor: document.getElementById('view-editor')
};
const railBtns = [...document.querySelectorAll('.railbtn[data-nav]')];
const navItems = [...document.querySelectorAll('.navitem[data-nav]')];

const fileTreeHostId = 'panel-project-list';
const tabBarEl = document.getElementById('tab-bar');
const editorContainerEl = document.getElementById('monaco-container');
const presenceListEl = document.getElementById('presence-list');
const statusDotEl = document.getElementById('status-dot');
const lineCountEl = document.getElementById('line-count');
const charCountEl = document.getElementById('char-count');
const contextMenuEl = document.getElementById('context-menu');
const projectNameLabel = document.getElementById('project-name-label');

document.getElementById('menu-icon-new-file').innerHTML = newFileIconSvg();
document.getElementById('menu-icon-new-folder').innerHTML = newFolderIconSvg();
document.getElementById('menu-icon-save').innerHTML = saveIconSvg();
document.getElementById('menu-icon-save-as').innerHTML = saveIconSvg();
document.getElementById('menu-icon-rename').innerHTML = renameIconSvg();
document.getElementById('menu-icon-duplicate').innerHTML = duplicateIconSvg();
document.getElementById('menu-icon-delete').innerHTML = trashIconSvg();
document.getElementById('file-menu-chevron').innerHTML = chevronDownIconSvg();
document.getElementById('newProjectIcon').innerHTML = plusIconSvg();
document.getElementById('searchFieldIcon').innerHTML = searchIconSvg();

/* ============================================================
   State
   ============================================================ */
let currentUser = null;
let allProjects = [];
let wsFilter = 'all';

let project = null; // currently open project, or null
let rootFolder = null;
let activeWorkspace = null;
let activePresence = null;
let activeTabPath = null;
let projectOpenedAt = null;
const openTabs = []; // [{ path }]

/* ============================================================
   Toasts
   ============================================================ */
function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 13 4 4L19 7"/></svg><span></span>';
  el.querySelector('span').textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 2600);
}

/* ============================================================
   Auth state
   ============================================================ */
watchAuthState((user) => {
  currentUser = user;
  const initials = user ? (user.displayName || user.email || '?')[0].toUpperCase() : '?';
  document.getElementById('avatarInitials').textContent = initials;
  document.getElementById('profileAvatar').textContent = initials;
  document.getElementById('profileName').textContent = user ? (user.displayName || user.email) : 'Not signed in';
  document.getElementById('profileEmail').textContent = user ? user.email : 'Sign in for cloud sync';
  document.getElementById('profileSigninBtn').hidden = !!user;
  document.getElementById('profileSignoutBtn').hidden = !user;
  document.getElementById('dashboardGreeting').textContent = user ? `Welcome back, ${user.displayName || user.email}` : 'Welcome — sign in to enable cloud sync';
  renderDashboardCards();
});

document.getElementById('profileSigninBtn').addEventListener('click', () => openSignIn());
document.getElementById('profileSignoutBtn').addEventListener('click', () => signOut());

/* ============================================================
   View switching — the core of the "persistent shell" ask: going to the
   dashboard never destroys the editor's state, it just hides it.
   ============================================================ */
let currentView = 'dashboard';
function go(view) {
  currentView = view;
  Object.entries(views).forEach(([name, el]) => { el.hidden = name !== view; });
  railBtns.forEach((b) => b.classList.toggle('is-on', b.dataset.nav === view));
  navItems.forEach((b) => b.classList.toggle('is-active', b.dataset.nav === view));
  if (view === 'dashboard') renderDashboardCards();
  document.querySelector('.main').scrollTop = 0;
}
document.addEventListener('click', (e) => {
  const n = e.target.closest('[data-nav]');
  if (n) go(n.dataset.nav);
});

document.querySelectorAll('[data-tree]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tree = document.getElementById(`tree-${btn.dataset.tree}`);
    const open = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', String(!open));
    tree.classList.toggle('is-collapsed', open);
  });
});

/* ============================================================
   Local project registry — list, create, edit, delete, duplicate
   ============================================================ */
const PROJECT_COLORS = ['#6D4AFF', '#8B6BFF', '#A78BFA', '#C084FC', '#5A38E8'];
function colorForProject(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return PROJECT_COLORS[hash % PROJECT_COLORS.length];
}

async function refreshProjects() {
  allProjects = await window.electronAPI.listProjects();
  renderProjectsGrid();
  renderPanelProjects();
  renderDashboardCards();
}

function filteredProjects() {
  const term = document.getElementById('project-search').value.trim().toLowerCase();
  return allProjects.filter((p) => {
    if (wsFilter === 'local' && p.cloudEnabled) return false;
    if (wsFilter === 'cloud' && !p.cloudEnabled) return false;
    if (term && !p.name.toLowerCase().includes(term)) return false;
    return true;
  });
}

function renderProjectsGrid() {
  const list = filteredProjects();
  const gridEl = document.getElementById('projects');
  document.getElementById('projCount').textContent = `${allProjects.length} project${allProjects.length === 1 ? '' : 's'}`;

  if (!list.length) {
    gridEl.innerHTML = `<div class="empty"><b>No projects${wsFilter !== 'all' ? ` (${wsFilter})` : ''}</b>Create one to start writing code — no account needed.</div>`;
    return;
  }

  gridEl.innerHTML = list.map((p) => {
    const color = colorForProject(p.id);
    const initial = (p.name[0] || '?').toUpperCase();
    const date = new Date(p.lastOpenedAt || p.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return `<div class="project" role="button" tabindex="0" data-project="${p.id}">
      <div class="project__top">
        <div class="project__ic" style="background:${color}">${initial}</div>
        <div style="min-width:0">
          <div class="project__name">${escapeHtml(p.name)}</div>
          <div class="project__path">${escapeHtml(p.folderPath)}</div>
        </div>
      </div>
      <span class="status ${p.cloudEnabled ? 'cloud' : 'local'}"><i></i>${p.cloudEnabled ? 'Cloud' : 'Local'}</span>
      <div class="project__foot">
        <span class="project__date">Opened ${date}</span>
        <div class="project__row-actions">
          <button type="button" class="row-icon-btn" data-edit="${p.id}" title="Edit">${editIconSvg()}</button>
          <button type="button" class="row-icon-btn" data-duplicate="${p.id}" title="Duplicate">${duplicateIconSvg()}</button>
          <button type="button" class="row-icon-btn" data-delete="${p.id}" title="Delete">${trashIconSvg()}</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

document.getElementById('projects').addEventListener('click', (e) => {
  const editBtn = e.target.closest('[data-edit]');
  const dupBtn = e.target.closest('[data-duplicate]');
  const delBtn = e.target.closest('[data-delete]');
  const card = e.target.closest('[data-project]');

  if (editBtn) { e.stopPropagation(); openProjectModal('edit', allProjects.find((p) => p.id === editBtn.dataset.edit)); return; }
  if (dupBtn) {
    e.stopPropagation();
    dupBtn.disabled = true;
    window.electronAPI.duplicateProject(dupBtn.dataset.duplicate).then(refreshProjects).finally(() => { dupBtn.disabled = false; });
    return;
  }
  if (delBtn) { e.stopPropagation(); openDeleteModal(allProjects.find((p) => p.id === delBtn.dataset.delete)); return; }
  if (card) openProjectView(allProjects.find((p) => p.id === card.dataset.project));
});

document.getElementById('projects').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const card = e.target.closest('[data-project]');
  if (!card) return;
  e.preventDefault();
  openProjectView(allProjects.find((p) => p.id === card.dataset.project));
});

document.getElementById('project-search').addEventListener('input', renderProjectsGrid);

document.getElementById('wsTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-ws]');
  if (!btn) return;
  wsFilter = btn.dataset.ws;
  [...document.querySelectorAll('#wsTabs button')].forEach((b) => b.classList.toggle('is-on', b === btn));
  renderProjectsGrid();
  renderDashboardCards();
});

/* --- panel's compact Projects tree --- */
function renderPanelProjects() {
  const host = document.getElementById(fileTreeHostId);
  host.innerHTML = '';

  if (!allProjects.length) {
    const empty = document.createElement('div');
    empty.className = 'substat';
    empty.style.padding = '6px 9px';
    empty.textContent = 'No projects yet.';
    host.appendChild(empty);
    return;
  }

  for (const p of allProjects) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `subitem directory ${project && project.id === p.id ? 'is-sel expanded' : ''}`;

    const chevron = document.createElement('span');
    chevron.className = 'node-chevron';
    chevron.innerHTML = chevronSvg();

    const icon = document.createElement('span');
    icon.className = 'node-icon';
    icon.innerHTML = folderIconSvg(project && project.id === p.id);

    const label = document.createElement('span');
    label.className = 'node-label';
    label.textContent = p.name;

    row.append(chevron, icon, label);
    row.addEventListener('click', () => openProjectView(p));
    host.appendChild(row);

    if (project && project.id === p.id) {
      const treeContainer = document.createElement('div');
      treeContainer.style.paddingLeft = '14px';
      treeContainer.id = 'file-tree';
      host.appendChild(treeContainer);
      loadFileTree(rootFolder, treeContainer);
    }
  }
}

/* ============================================================
   New / edit project modal
   ============================================================ */
const projectModal = document.getElementById('project-modal');
const projectForm = document.getElementById('project-form');
const projectTitle = document.getElementById('project-modal-title');
const nameInput = document.getElementById('project-name');
const folderBtn = document.getElementById('project-folder-btn');
const folderPathEl = document.getElementById('project-folder-path');
const cloudToggle = document.getElementById('project-cloud-toggle');
const projectError = document.getElementById('project-error');
const projectSubmit = document.getElementById('project-submit');

let modalMode = 'create';
let editingProject = null;
let chosenFolder = null;

function openProjectModal(mode, existing) {
  modalMode = mode;
  editingProject = existing || null;
  projectError.textContent = '';

  if (mode === 'edit') {
    projectTitle.textContent = 'Edit project';
    projectSubmit.textContent = 'Save';
    nameInput.value = existing.name;
    chosenFolder = existing.folderPath;
    folderPathEl.textContent = existing.folderPath;
    cloudToggle.checked = existing.cloudEnabled;
  } else {
    projectTitle.textContent = 'New project';
    projectSubmit.textContent = 'Create';
    nameInput.value = '';
    chosenFolder = null;
    folderPathEl.textContent = '';
    cloudToggle.checked = false;
  }

  projectModal.hidden = false;
  nameInput.focus();
}

document.querySelector('[data-action="newproject"]').addEventListener('click', () => openProjectModal('create', null));
document.getElementById('project-cancel').addEventListener('click', () => { projectModal.hidden = true; });
projectModal.addEventListener('click', (e) => { if (e.target === projectModal) projectModal.hidden = true; });

folderBtn.addEventListener('click', async () => {
  const folder = await window.electronAPI.openDirectory();
  if (folder) { chosenFolder = folder; folderPathEl.textContent = folder; }
});

projectForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  projectError.textContent = '';

  const name = nameInput.value.trim();
  if (!name) return;
  if (!chosenFolder) { projectError.textContent = 'Choose a folder for this project.'; return; }

  const cloudEnabled = cloudToggle.checked;
  projectSubmit.disabled = true;

  try {
    if (modalMode === 'create') {
      const created = await window.electronAPI.createProject({ name, folderPath: chosenFolder, cloudEnabled });
      if (cloudEnabled) await enableCloud(created.id, name);
      projectModal.hidden = true;
      await refreshProjects();
      openProjectView(created);
    } else {
      const wasCloud = editingProject.cloudEnabled;
      await window.electronAPI.updateProject(editingProject.id, { name, folderPath: chosenFolder, cloudEnabled });
      if (cloudEnabled && !wasCloud) await enableCloud(editingProject.id, name);
      if (!cloudEnabled && wasCloud) await deleteCloudProject(editingProject.id, currentUser.uid);
      projectModal.hidden = true;
      await refreshProjects();
    }
  } catch (err) {
    projectError.textContent = err.message;
  } finally {
    projectSubmit.disabled = false;
  }
});

function enableCloud(projectId, name) {
  return new Promise((resolve, reject) => {
    requireAuth(async () => {
      try { await createCloudProject(projectId, name, currentUser.uid); resolve(); }
      catch (err) { reject(err); }
    });
  });
}

/* ============================================================
   Delete project modal
   ============================================================ */
const deleteModal = document.getElementById('delete-modal');
const deleteChoices = document.getElementById('delete-choices');
const deleteModalSub = document.getElementById('delete-modal-sub');
const deleteError = document.getElementById('delete-error');
const deleteConfirmBtn = document.getElementById('delete-confirm');
let deletingProject = null;

function openDeleteModal(p) {
  deletingProject = p;
  deleteError.textContent = '';
  deleteChoices.hidden = !p.cloudEnabled;
  deleteModalSub.hidden = p.cloudEnabled;
  deleteModal.hidden = false;
}

document.getElementById('delete-cancel').addEventListener('click', () => { deleteModal.hidden = true; });
deleteModal.addEventListener('click', (e) => { if (e.target === deleteModal) deleteModal.hidden = true; });

deleteConfirmBtn.addEventListener('click', async () => {
  const scope = deletingProject.cloudEnabled
    ? deleteModal.querySelector('input[name="delete-scope"]:checked').value
    : 'local';

  deleteConfirmBtn.disabled = true;
  deleteError.textContent = '';

  try {
    if (scope === 'local' || scope === 'both') {
      if (project && project.id === deletingProject.id) closeProjectView();
      await window.electronAPI.deleteProjectLocal(deletingProject.id);
    }
    if (scope === 'cloud' || scope === 'both') {
      await deleteCloudProject(deletingProject.id, currentUser.uid);
      if (scope === 'cloud') await window.electronAPI.updateProject(deletingProject.id, { cloudEnabled: false });
    }
    deleteModal.hidden = true;
    await refreshProjects();
  } catch (err) {
    deleteError.textContent = err.message;
  } finally {
    deleteConfirmBtn.disabled = false;
  }
});

/* ============================================================
   Editor: opening/closing a project
   ============================================================ */
function openProjectView(p) {
  if (project && project.id === p.id) { go('editor'); return; }

  // Only one project session stays live at a time (see the plan's scope
  // note) — switching away closes the current one, so make that consequence
  // explicit rather than silently dropping whatever was open.
  if (project) {
    const proceed = window.confirm(
      `Switch to "${p.name}"?\n\nThis closes your current session in "${project.name}" — any unsaved autosave-pending changes are saved first, but the tabs you have open there won't stay open.`
    );
    if (!proceed) return;
    closeProjectView();
  }

  project = p;
  rootFolder = p.folderPath;
  projectOpenedAt = Date.now();
  projectNameLabel.textContent = p.name;
  window.electronAPI.updateProject(p.id, { lastOpenedAt: Date.now() });

  renderPanelProjects(); // mounts #file-tree under this project's panel row
  go('editor');
}

function closeProjectView() {
  teardownActiveWorkspace();
  openTabs.length = 0;
  renderTabs();
  project = null;
  rootFolder = null;
  projectOpenedAt = null;
  renderPanelProjects();
}

function joinPath(...parts) { return parts.map((p) => p.replace(/[\\/]+$/, '')).join('/'); }
function parentDir(fullPath) {
  const idx = Math.max(fullPath.lastIndexOf('/'), fullPath.lastIndexOf('\\'));
  return idx === -1 ? '' : fullPath.slice(0, idx);
}

function formatCount(n) {
  const str = String(n);
  return str.length > 4 ? `${str.slice(0, 4)}…` : str;
}

function updateFileMeta() {
  if (!activeWorkspace) { lineCountEl.textContent = '—'; charCountEl.textContent = '—'; return; }
  const model = activeWorkspace.editor.getModel();
  lineCountEl.textContent = `${formatCount(model.getLineCount())} lines`;
  charCountEl.textContent = `${formatCount(model.getValueLength())} chars`;
}

function renderLoader(container) {
  container.innerHTML = '';
  const loader = document.createElement('div');
  loader.className = 'bounce-loader';
  loader.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
  container.appendChild(loader);
}

async function loadFileTree(dirPath, container) {
  renderLoader(container);

  if (!window.electronAPI) { container.textContent = 'electronAPI unavailable — the preload script failed to load.'; return; }

  let nodes;
  try { nodes = await window.electronAPI.readDir(dirPath); }
  catch (err) { container.textContent = `Failed to read folder: ${err.message}`; return; }

  container.innerHTML = '';
  if (nodes.length === 0) { container.textContent = 'This folder has no visible files.'; return; }

  for (const node of nodes) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `file-tree-node ${node.type}`;
    el.dataset.path = node.path;
    el.dataset.type = node.type;
    el.dataset.name = node.name;

    const chevronEl = document.createElement('span');
    chevronEl.className = node.type === 'directory' ? 'node-chevron' : 'node-chevron-spacer';
    if (node.type === 'directory') chevronEl.innerHTML = chevronSvg();

    const iconEl = document.createElement('span');
    iconEl.className = 'node-icon';
    iconEl.innerHTML = node.type === 'directory' ? folderIconSvg(false) : fileIconSvg(colorForExtension(node.name.split('.').pop()));

    const labelEl = document.createElement('span');
    labelEl.className = 'node-label';
    labelEl.textContent = node.name;

    el.append(chevronEl, iconEl, labelEl);
    el.addEventListener('click', () => (node.type === 'directory' ? toggleDirectory(node, el) : openFile(node.path)));
    container.appendChild(el);
  }
}

async function toggleDirectory(node, el) {
  const existing = el.nextElementSibling;
  if (existing && existing.dataset.parentPath === node.path) { existing.remove(); el.classList.remove('expanded'); return; }
  el.classList.add('expanded');
  const childContainer = document.createElement('div');
  childContainer.style.paddingLeft = '14px';
  childContainer.dataset.parentPath = node.path;
  el.insertAdjacentElement('afterend', childContainer);
  await loadFileTree(node.path, childContainer);
}

function sanitizeDocId(relativePath) {
  return `${project.id}__${relativePath}`.replace(/[.#$\[\]/\\]/g, '_');
}

function currentFileTreeEl() { return document.getElementById('file-tree'); }

async function openFile(filePath) {
  if (!openTabs.some((t) => t.path === filePath)) openTabs.push({ path: filePath });
  renderTabs();
  activateTab(filePath);
}

function renderTabs() {
  tabBarEl.innerHTML = '';
  for (const tab of openTabs) {
    const name = tab.path.split(/[\\/]/).pop();
    const tabEl = document.createElement('div');
    tabEl.className = `tab ${tab.path === activeTabPath ? 'active' : ''}`;

    const iconEl = document.createElement('span');
    iconEl.className = 'tab-icon';
    iconEl.innerHTML = fileIconSvg(colorForExtension(name.split('.').pop()));

    const labelEl = document.createElement('span');
    labelEl.className = 'tab-label';
    labelEl.textContent = name;

    const closeEl = document.createElement('span');
    closeEl.className = 'tab-close';
    closeEl.textContent = '×';
    closeEl.addEventListener('click', (e) => { e.stopPropagation(); closeTab(tab.path); });

    tabEl.append(iconEl, labelEl, closeEl);
    tabEl.addEventListener('click', () => activateTab(tab.path));
    tabBarEl.appendChild(tabEl);
  }
}

function closeTab(filePath) {
  const idx = openTabs.findIndex((t) => t.path === filePath);
  if (idx !== -1) openTabs.splice(idx, 1);
  if (activeTabPath === filePath) {
    teardownActiveWorkspace();
    const next = openTabs[openTabs.length - 1];
    if (next) activateTab(next.path);
  }
  renderTabs();
}

function teardownActiveWorkspace() {
  // Flush any pending edit to disk before tearing down — otherwise a switch
  // right after typing (before the 800ms autosave debounce fires) would
  // silently drop it.
  if (activeWorkspace && activeTabPath) saveActiveFile(activeTabPath);
  if (activePresence) activePresence.destroy();
  if (activeWorkspace) activeWorkspace.destroy();
  activePresence = null;
  activeWorkspace = null;
  activeTabPath = null;
  updateFileMeta();
}

function activateTab(filePath) {
  if (activeTabPath === filePath) return;
  if (project.cloudEnabled) requireAuth(() => activateTabInner(filePath));
  else activateTabInner(filePath);
}

// NOTE: only one file is "live" (bound to Yjs/Monaco) at a time — see the
// scope note in the plan. Opening a different project tears the previous
// one's workspace down first (closeProjectView).
async function activateTabInner(filePath) {
  teardownActiveWorkspace();
  activeTabPath = filePath;
  renderTabs();
  renderLoader(editorContainerEl);

  let content;
  try { content = await window.electronAPI.readFile(filePath); }
  catch (err) { editorContainerEl.textContent = `Failed to open file: ${err.message}`; return; }

  if (activeTabPath !== filePath) return;

  const relativePath = filePath.slice(rootFolder.length).replace(/^[\\/]/, '');
  const docId = sanitizeDocId(relativePath);

  editorContainerEl.innerHTML = '';
  activeWorkspace = new CollaborativeWorkspace(editorContainerEl, {
    docId, filePath, currentUser, collaborative: project.cloudEnabled
  }).initialize(content, getTheme());

  if (project.cloudEnabled) {
    activePresence = new PresenceBar(presenceListEl, activeWorkspace.getAwareness(), currentUser);
    upsertDocumentMeta(docId, {
      projectId: project.id, ownerId: currentUser.uid, path: relativePath,
      language: activeWorkspace.editor.getModel().getLanguageId(), userId: currentUser.uid
    });
  }

  updateFileMeta();

  let saveTimer = null;
  activeWorkspace.editor.onDidChangeModelContent(() => {
    updateFileMeta();
    if (!getSettings().autosave) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveActiveFile(filePath), 800);
  });
}

function saveActiveFile(filePath) {
  if (!activeWorkspace || activeTabPath !== filePath) return;
  window.electronAPI.writeFile(filePath, activeWorkspace.getValue());
}

async function saveFileAs(filePath) {
  const content = filePath === activeTabPath && activeWorkspace ? activeWorkspace.getValue() : await window.electronAPI.readFile(filePath);
  const target = await window.electronAPI.showSaveDialog(filePath);
  if (!target) return;
  await window.electronAPI.writeFile(target, content);
  if (target.startsWith(rootFolder)) loadFileTree(rootFolder, currentFileTreeEl());
}

async function duplicateNode(node) {
  try { await window.electronAPI.duplicateEntry(node.path); loadFileTree(rootFolder, currentFileTreeEl()); }
  catch (err) { alert(`Failed to duplicate: ${err.message}`); }
}

function copyNodePath(node) {
  navigator.clipboard.writeText(node.path).then(() => toast('Path copied')).catch(() => {});
}

// window.prompt() is unsupported in Electron's renderer (throws outright);
// alert()/confirm() work fine, so a plain confirm() is the simplest honest
// option here rather than a custom modal for one Yes/No decision.
async function deleteNode(node) {
  if (!window.confirm(`Delete "${node.name}"? This can't be undone.`)) return;
  try {
    await window.electronAPI.deleteEntry(node.path);
    if (openTabs.some((t) => t.path === node.path)) closeTab(node.path);
    loadFileTree(rootFolder, currentFileTreeEl());
  } catch (err) {
    alert(`Failed to delete: ${err.message}`);
  }
}

function startInlineCreate(type) {
  const host = currentFileTreeEl();
  if (!host) return;
  const existing = host.querySelector('.inline-input-row');
  if (existing) existing.remove();
  if (host.textContent === 'This folder has no visible files.') host.textContent = '';

  const row = document.createElement('div');
  row.className = 'file-tree-node inline-input-row';
  const spacer = document.createElement('span');
  spacer.className = 'node-chevron-spacer';
  const iconEl = document.createElement('span');
  iconEl.className = 'node-icon';
  iconEl.innerHTML = type === 'file' ? fileIconSvg() : folderIconSvg(false);
  const input = document.createElement('input');
  input.className = 'inline-input';
  input.placeholder = type === 'file' ? 'filename.ext' : 'folder name';

  row.append(spacer, iconEl, input);
  host.insertBefore(row, host.firstChild);
  input.focus();

  let settled = false;
  const cleanup = () => { if (!settled) { settled = true; row.remove(); } };

  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') { cleanup(); return; }
    if (e.key !== 'Enter') return;
    const name = input.value.trim();
    settled = true;
    row.remove();
    if (!name) return;

    const fullPath = joinPath(rootFolder, name);
    try {
      if (type === 'file') await window.electronAPI.createFile(fullPath);
      else await window.electronAPI.createDirectory(fullPath);
      loadFileTree(rootFolder, currentFileTreeEl());
    } catch (err) {
      alert(`Failed to create ${type}: ${err.message}`);
    }
  });
  input.addEventListener('blur', cleanup);
}

/* --- rename modal (shared by context menu + File menu) --- */
const renameModal = document.getElementById('rename-modal');
const renameForm = document.getElementById('rename-form');
const renameInput = document.getElementById('rename-input');
const renameError = document.getElementById('rename-error');
let renamingNode = null;

function openRenameModal(node) {
  renamingNode = node;
  renameError.textContent = '';
  renameInput.value = node.name;
  renameModal.hidden = false;
  renameInput.focus();
  const dot = node.name.lastIndexOf('.');
  renameInput.setSelectionRange(0, dot > 0 ? dot : node.name.length);
}

document.getElementById('rename-cancel').addEventListener('click', () => { renameModal.hidden = true; });
renameModal.addEventListener('click', (e) => { if (e.target === renameModal) renameModal.hidden = true; });

renameForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const newName = renameInput.value.trim();
  if (!newName || newName === renamingNode.name) { renameModal.hidden = true; return; }

  const newPath = joinPath(parentDir(renamingNode.path), newName);
  try {
    await window.electronAPI.renameEntry(renamingNode.path, newPath);
    if (activeTabPath === renamingNode.path) activeTabPath = newPath;
    const tab = openTabs.find((t) => t.path === renamingNode.path);
    if (tab) tab.path = newPath;
    renderTabs();
    renameModal.hidden = true;
    loadFileTree(rootFolder, currentFileTreeEl());
  } catch (err) {
    renameError.textContent = err.message;
  }
});

/* --- right-click context menu --- */
document.addEventListener('contextmenu', (e) => {
  const el = e.target.closest('.file-tree-node');
  if (!el || !el.dataset.path) return;
  e.preventDefault();
  showContextMenu(e.clientX, e.clientY, { path: el.dataset.path, type: el.dataset.type, name: el.dataset.name });
});

function showContextMenu(x, y, node) {
  const items = [];
  if (node.type === 'file') {
    if (node.path === activeTabPath) items.push({ label: 'Save', icon: saveIconSvg(), onClick: () => saveActiveFile(node.path) });
    items.push({ label: 'Save As…', icon: saveIconSvg(), onClick: () => saveFileAs(node.path) });
  }
  items.push({ label: 'Rename', icon: renameIconSvg(), onClick: () => openRenameModal(node) });
  items.push({ label: 'Duplicate', icon: duplicateIconSvg(), onClick: () => duplicateNode(node) });
  items.push({ label: 'Copy Path', icon: copyIconSvg(), onClick: () => copyNodePath(node) });
  items.push({ label: 'Delete', icon: trashIconSvg(), danger: true, onClick: () => deleteNode(node) });

  contextMenuEl.innerHTML = '';
  for (const item of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = item.danger ? 'context-menu-item danger' : 'context-menu-item';
    btn.innerHTML = `<span class="btn-icon">${item.icon}</span>${item.label}`;
    btn.addEventListener('click', () => { hideContextMenu(); item.onClick(); });
    contextMenuEl.appendChild(btn);
  }
  contextMenuEl.style.left = `${x}px`;
  contextMenuEl.style.top = `${y}px`;
  contextMenuEl.hidden = false;
}
function hideContextMenu() { contextMenuEl.hidden = true; }
document.addEventListener('click', (e) => { if (!contextMenuEl.hidden && !contextMenuEl.contains(e.target)) hideContextMenu(); });
document.addEventListener('scroll', hideContextMenu, true);

/* --- File menu (acts on the currently active tab) --- */
const fileMenuBtn = document.getElementById('file-menu-btn');
const fileMenuDropdown = document.getElementById('file-menu-dropdown');
fileMenuBtn.addEventListener('click', (e) => { e.stopPropagation(); fileMenuDropdown.hidden = !fileMenuDropdown.hidden; });
document.addEventListener('click', () => { fileMenuDropdown.hidden = true; });

fileMenuDropdown.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === 'new-file') return startInlineCreate('file');
  if (action === 'new-folder') return startInlineCreate('directory');
  if (!activeTabPath) return;
  const node = { path: activeTabPath, type: 'file', name: activeTabPath.split(/[\\/]/).pop() };
  if (action === 'save') saveActiveFile(activeTabPath);
  if (action === 'save-as') saveFileAs(activeTabPath);
  if (action === 'rename') openRenameModal(node);
  if (action === 'duplicate') duplicateNode(node);
  if (action === 'delete') deleteNode(node);
});

window.addEventListener('online', () => statusDotEl.classList.replace('offline', 'online'));
window.addEventListener('offline', () => statusDotEl.classList.replace('online', 'offline'));
statusDotEl.classList.add(navigator.onLine ? 'online' : 'offline');

/* ============================================================
   Dashboard cards — repurposed to real data (see plan §5)
   ============================================================ */
function renderDashboardCards() {
  const local = allProjects.filter((p) => !p.cloudEnabled).length;
  const cloud = allProjects.filter((p) => p.cloudEnabled).length;
  const stat = wsFilter === 'local' ? local : wsFilter === 'cloud' ? cloud : allProjects.length;
  document.getElementById('wsBigstat').textContent = stat;
  document.getElementById('wsSub').textContent = `${local} local · ${cloud} cloud`;

  // Live session + collaborators — reuses whatever's alive in the
  // background editor session, which is exactly the point of not tearing
  // it down when you switch to the dashboard.
  const liveKey = document.getElementById('liveSessionKey');
  const liveEmpty = document.getElementById('liveSessionEmpty');
  const avatarsEl = document.getElementById('liveAvatars');
  const avatarsEmptyEl = document.getElementById('liveAvatarsEmpty');
  const awareness = project && project.cloudEnabled && activeWorkspace ? activeWorkspace.getAwareness() : null;

  if (awareness) {
    const states = [...awareness.getStates().values()].filter((s) => s.user);
    document.getElementById('liveSessionLabel').textContent = project.name;
    const mins = Math.max(0, Math.round((Date.now() - projectOpenedAt) / 60000));
    document.getElementById('liveSessionAmount').textContent = mins < 1 ? 'Just started' : `${mins} min${mins === 1 ? '' : 's'}`;
    document.getElementById('liveSessionId').textContent = `id: ${project.id.slice(0, 8)}…`;
    liveKey.hidden = false;
    liveEmpty.hidden = true;

    if (states.length) {
      avatarsEl.innerHTML = states.map((s) => `<span style="background:${s.user.color}" title="${escapeHtml(s.user.name)}">${escapeHtml((s.user.name || '?')[0].toUpperCase())}</span>`).join('');
      avatarsEmptyEl.hidden = true;
    } else {
      avatarsEl.innerHTML = '';
      avatarsEmptyEl.hidden = false;
    }
  } else {
    document.getElementById('liveSessionLabel').textContent = 'No live session';
    document.getElementById('liveSessionAmount').textContent = '—';
    liveKey.hidden = true;
    liveEmpty.hidden = false;
    avatarsEl.innerHTML = '';
    avatarsEmptyEl.hidden = false;
  }

  // recent projects
  const recent = [...allProjects].sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0)).slice(0, 3);
  const recentEl = document.getElementById('recentProjects');
  recentEl.innerHTML = recent.length
    ? recent.map((p) => `<button type="button" class="subitem" data-recent="${p.id}"><span class="node-chevron-spacer"></span><span class="node-icon">${folderIconSvg(false)}</span><span class="node-label">${escapeHtml(p.name)}</span></button>`).join('')
    : '<div class="substat">Nothing opened yet.</div>';
}

document.getElementById('recentProjects').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-recent]');
  if (btn) openProjectView(allProjects.find((p) => p.id === btn.dataset.recent));
});

document.getElementById('copyProjectIdBtn').addEventListener('click', () => {
  if (!project) return;
  navigator.clipboard.writeText(project.id).then(() => toast('Project ID copied')).catch(() => {});
});

setInterval(() => { if (currentView === 'dashboard') renderDashboardCards(); }, 30000);

/* ============================================================
   Theme + settings panel
   ============================================================ */
document.getElementById('themeBtn').addEventListener('click', () => applyTheme(getTheme() === 'dark' ? 'light' : 'dark'));
document.querySelectorAll('[data-theme-set]').forEach((b) => b.addEventListener('click', () => applyTheme(b.dataset.themeSet)));

function applyTheme(t) {
  setTheme(t);
  setMonacoTheme(t);
  document.querySelectorAll('[data-theme-set]').forEach((b) => b.classList.toggle('is-on', b.dataset.themeSet === t));
}
applyTheme(getTheme());

document.querySelectorAll('[data-accent]').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('[data-accent]').forEach((x) => x.classList.remove('is-on'));
    b.classList.add('is-on');
    setAccent(b.dataset.accent);
  });
});
(() => {
  const accent = getAccent();
  const match = document.querySelector(`[data-accent="${accent}"]`);
  if (match) { document.querySelectorAll('[data-accent]').forEach((x) => x.classList.remove('is-on')); match.classList.add('is-on'); }
  setAccent(accent);
})();

function applyLiveEditorSettings() {
  if (activeWorkspace) activeWorkspace.applyEditorSettings(monacoOptionsFromSettings());
}

const settingsPanel = document.getElementById('settingsPanel');
const s0 = getSettings();
document.getElementById('fontSize').value = s0.fontSize;
document.getElementById('fsLabel').textContent = `${s0.fontSize} px`;
document.getElementById('fontFamily').value = s0.fontFamily;
document.getElementById('toggleLigatures').classList.toggle('is-on', s0.ligatures);
document.getElementById('toggleMinimap').classList.toggle('is-on', s0.minimap);
document.getElementById('toggleAutosave').classList.toggle('is-on', s0.autosave);
document.querySelectorAll('#segTab button').forEach((b) => b.classList.toggle('is-on', Number(b.dataset.tab) === s0.tabSize));

document.getElementById('fontSize').addEventListener('input', (e) => {
  document.getElementById('fsLabel').textContent = `${e.target.value} px`;
  document.getElementById('preview').style.fontSize = `${e.target.value}px`;
  updateSettings({ fontSize: Number(e.target.value) });
  applyLiveEditorSettings();
});
document.getElementById('fontFamily').addEventListener('change', (e) => {
  document.getElementById('preview').style.fontFamily = e.target.value;
  updateSettings({ fontFamily: e.target.value });
  applyLiveEditorSettings();
});
document.querySelectorAll('#segTab button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('#segTab button').forEach((x) => x.classList.remove('is-on'));
  b.classList.add('is-on');
  document.getElementById('ind').textContent = ' '.repeat(Number(b.dataset.tab));
  updateSettings({ tabSize: Number(b.dataset.tab) });
  applyLiveEditorSettings();
}));
document.getElementById('toggleLigatures').addEventListener('click', function () {
  this.classList.toggle('is-on');
  updateSettings({ ligatures: this.classList.contains('is-on') });
  applyLiveEditorSettings();
});
document.getElementById('toggleMinimap').addEventListener('click', function () {
  this.classList.toggle('is-on');
  updateSettings({ minimap: this.classList.contains('is-on') });
  applyLiveEditorSettings();
});
document.getElementById('toggleAutosave').addEventListener('click', function () {
  this.classList.toggle('is-on');
  updateSettings({ autosave: this.classList.contains('is-on') });
});
document.getElementById('keymap').addEventListener('change', (e) => toast(`Keybindings set to ${e.target.value}`));

/* ============================================================
   Overlays: search, settings, profile
   ============================================================ */
const scrim = document.getElementById('scrim');
function closeAllOverlays() {
  document.getElementById('searchBox').classList.remove('is-open');
  settingsPanel.classList.remove('is-open');
  document.getElementById('profileMenu').classList.remove('is-open');
  document.getElementById('avatarBtn').setAttribute('aria-expanded', 'false');
  document.querySelectorAll('.railbtn[data-action]').forEach((b) => b.classList.remove('is-on'));
  scrim.classList.remove('is-open');
  palette.close();
}
scrim.addEventListener('click', closeAllOverlays);

function openSettings() {
  const open = settingsPanel.classList.contains('is-open');
  closeAllOverlays();
  if (open) return;
  settingsPanel.classList.add('is-open');
  scrim.classList.add('is-open');
  document.querySelector('[data-action="settings"].railbtn')?.classList.add('is-on');
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-action]');
  if (!a) return;
  const act = a.dataset.action;
  if (act === 'search') { const open = palette.isOpen(); closeAllOverlays(); if (!open) { palette.open(); scrim.classList.add('is-open'); document.querySelector('[data-action="search"].railbtn')?.classList.add('is-on'); } }
  if (act === 'settings') openSettings();
  if (act === 'panel') {
    const collapsed = document.getElementById('panel').classList.toggle('is-collapsed');
    document.getElementById('panelToggleBtn').classList.toggle('is-on', collapsed);
  }
  if (act === 'help') { closeAllOverlays(); document.getElementById('help-modal').hidden = false; }
});

document.getElementById('help-close').addEventListener('click', () => { document.getElementById('help-modal').hidden = true; });
document.getElementById('help-modal').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.hidden = true; });
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeAllOverlays));

document.getElementById('avatarBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const open = document.getElementById('profileMenu').classList.contains('is-open');
  closeAllOverlays();
  if (open) return;
  document.getElementById('profileMenu').classList.add('is-open');
  document.getElementById('avatarBtn').setAttribute('aria-expanded', 'true');
  scrim.classList.add('is-open');
});

/* ============================================================
   Command palette
   ============================================================ */
const palette = initCommandPalette({
  getProjects: () => allProjects,
  getOpenFiles: () => (project ? openTabs.map((t) => ({ name: t.path.split(/[\\/]/).pop(), path: t.path })) : []),
  onOpenProject: (p) => openProjectView(p),
  onOpenFile: (path) => openFile(path),
  commands: [
    { label: 'New project', action: () => openProjectModal('create', null) },
    { label: 'Toggle theme', action: () => applyTheme(getTheme() === 'dark' ? 'light' : 'dark') },
    { label: 'Open settings', action: () => openSettings() },
    { label: currentUser ? 'Sign out' : 'Sign in', action: () => (currentUser ? signOut() : openSignIn()) }
  ]
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); const open = palette.isOpen(); closeAllOverlays(); if (!open) { palette.open(); scrim.classList.add('is-open'); } }
  if (e.key === 'Escape') { closeAllOverlays(); hideContextMenu(); }
  if (e.key === ',' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); openSettings(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); if (activeTabPath) saveActiveFile(activeTabPath); }
});

/* ============================================================
   Boot
   ============================================================ */
go('dashboard');
refreshProjects();
