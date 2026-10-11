import { watchAuthState, watchCloudConnection, signOut, createCloudProject, deleteCloudProject, upsertDocumentMeta } from './firebase.js';
import { requireAuth, openSignIn } from './authModal.js';
import { CollaborativeWorkspace, setMonacoTheme } from './editor.js';
import { PresenceBar } from './presence.js';
import { applyStoredTheme, setTheme, getTheme, getEffectiveTheme, setAccent, getAccent } from './theme.js';
import { getSettings, updateSettings, monacoOptionsFromSettings } from './settings.js';
import { initCommandPalette } from './commandPalette.js';
import { initBottomPanel } from './panel.js';
import { initProblems } from './problems.js';
import { initTerminal } from './terminal.js';
import { initSearchView } from './searchView.js';
import { enhanceSelects } from './select.js';
import { initMenubar } from './menubar.js';
import { initScm } from './scm.js';
import { initSidebarResize } from './sidebarResize.js';
import { initExtensions } from './extensions.js';
import { initPluginHost } from './pluginHost.js';
import { initPluginSpace } from './pluginSpace.js';
import { initLanguageSupport } from './languageSupport.js';
import { initFormatting } from './formatting.js';
import { initBreadcrumbs } from './breadcrumbs.js';
import {
  fileIconSvg, folderIconSvg, chevronSvg, colorForExtension,
  saveIconSvg, trashIconSvg,
  duplicateIconSvg, renameIconSvg, copyIconSvg,
  plusIconSvg, searchIconSvg, editIconSvg, fileIcon, folderIcon
} from './icons.js';

applyStoredTheme();

/* ============================================================
   Elements
   ============================================================ */
const views = {
  dashboard: document.getElementById('view-dashboard'),
  editor: document.getElementById('view-editor'),
  tutorial: document.getElementById('view-tutorial')
};
const navBtns = [...document.querySelectorAll('.sidearray .ibtn[data-nav]')];

const fileTreeHostId = 'panel-project-list';
const tabBarEl = document.getElementById('tab-bar');
const editorContainerEl = document.getElementById('monaco-container');
const presenceListEl = document.getElementById('presence-list');
const statusDotEl = document.getElementById('status-dot');
const lineCountEl = document.getElementById('line-count');
const charCountEl = document.getElementById('char-count');
const contextMenuEl = document.getElementById('context-menu');
const projectNameLabel = document.getElementById('project-name-label');
const statusTextEl = document.getElementById('status-text');

document.getElementById('newProjectIconMain').innerHTML = plusIconSvg();
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
let pendingReveal = null; // { path, line, column, length } applied once that file finishes opening

/* ============================================================
   Toasts
   ============================================================ */
const TOAST_ICONS = {
  ok: '<path d="m5 13 4 4L19 7"/>',
  error: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.1"/>'
};
function toast(msg, type = 'ok') {
  // With the bell panel open the message lands in its list directly —
  // a floating toast would sit on top of it.
  if (notifPanel.classList.contains('is-open')) { logNotification(msg, type); return; }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${TOAST_ICONS[type]}</svg><span></span>`;
  el.querySelector('span').textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 2600);
  logNotification(msg, type);
}

/* ============================================================
   Notifications — the footer bell keeps a session history of every toast,
   with an unread dot until the panel is opened.
   ============================================================ */
const notifPanel = document.getElementById('notifPanel');
const notifBtn = document.getElementById('notifBtn');
const notifDot = document.getElementById('notifDot');
const notifications = []; // newest first: { msg, type, at }
const MAX_NOTIFICATIONS = 50;

function logNotification(msg, type) {
  notifications.unshift({ msg, type, at: Date.now() });
  notifications.length = Math.min(notifications.length, MAX_NOTIFICATIONS);
  if (notifPanel.classList.contains('is-open')) renderNotifications();
  else notifDot.hidden = false;
}

function renderNotifications() {
  const list = document.getElementById('notifList');
  if (!notifications.length) { list.innerHTML = '<div class="notifs__empty">No notifications yet.</div>'; return; }
  list.innerHTML = notifications.map((n) => `<div class="notif ${n.type}">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${TOAST_ICONS[n.type]}</svg>
    <span class="notif__msg">${escapeHtml(n.msg)}</span>
    <span class="notif__time">${new Date(n.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
  </div>`).join('');
}

notifBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = notifPanel.classList.contains('is-open');
  closeAllOverlays();
  if (open) return;
  renderNotifications();
  notifDot.hidden = true;
  notifPanel.classList.add('is-open');
  notifBtn.classList.add('is-on');
  notifBtn.setAttribute('aria-expanded', 'true');
});
document.addEventListener('click', (e) => {
  if (notifPanel.classList.contains('is-open') && !notifPanel.contains(e.target)) closeNotifications();
});

function closeNotifications() {
  notifPanel.classList.remove('is-open');
  notifBtn.classList.remove('is-on');
  notifBtn.setAttribute('aria-expanded', 'false');
}

/* ============================================================
   Confirm dialog — the app's own "are you sure?" box, used for every
   destructive or session-closing action instead of window.confirm().
   ============================================================ */
const confirmModal = document.getElementById('confirm-modal');
const confirmOkBtn = document.getElementById('confirm-ok');
let confirmResolve = null;

function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-message').textContent = message;
  confirmOkBtn.textContent = confirmLabel;
  confirmOkBtn.classList.toggle('danger', danger);
  confirmModal.hidden = false;
  confirmOkBtn.focus();
  return new Promise((resolve) => { confirmResolve = resolve; });
}

function settleConfirm(result) {
  if (!confirmResolve) return;
  confirmModal.hidden = true;
  const resolve = confirmResolve;
  confirmResolve = null;
  resolve(result);
}
confirmOkBtn.addEventListener('click', () => settleConfirm(true));
document.getElementById('confirm-cancel').addEventListener('click', () => settleConfirm(false));
confirmModal.addEventListener('click', (e) => { if (e.target === confirmModal) settleConfirm(false); });

// Text-input counterpart to confirmDialog (resolves to the string, or null).
const promptModal = document.getElementById('prompt-modal');
const promptInput = document.getElementById('prompt-input');
let promptResolve = null;

function promptDialog({ title, label = 'Name', placeholder = '', value = '', confirmLabel = 'OK' }) {
  document.getElementById('prompt-title').textContent = title;
  document.getElementById('prompt-label').textContent = label;
  document.getElementById('prompt-ok').textContent = confirmLabel;
  promptInput.placeholder = placeholder;
  promptInput.value = value;
  promptModal.hidden = false;
  promptInput.focus();
  promptInput.select();
  return new Promise((resolve) => { promptResolve = resolve; });
}

function settlePrompt(result) {
  if (!promptResolve) return;
  promptModal.hidden = true;
  const resolve = promptResolve;
  promptResolve = null;
  resolve(result);
}
document.getElementById('prompt-form').addEventListener('submit', (e) => { e.preventDefault(); settlePrompt(promptInput.value.trim() || null); });
document.getElementById('prompt-cancel').addEventListener('click', () => settlePrompt(null));
promptModal.addEventListener('click', (e) => { if (e.target === promptModal) settlePrompt(null); });

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
  navBtns.forEach((b) => b.classList.toggle('is-on', b.dataset.nav === view));
  if (view === 'dashboard') renderDashboardCards();
  views[view].scrollTop = 0;
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
    gridEl.innerHTML = `<div class="empty-state"><b>No projects${wsFilter !== 'all' ? ` (${wsFilter})` : ''}</b>Create one to start writing code — no account needed.</div>`;
    return;
  }

  gridEl.innerHTML = list.map((p) => {
    const initial = (p.name[0] || '?').toUpperCase();
    const date = new Date(p.lastOpenedAt || p.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return `<div class="project" role="button" tabindex="0" data-project="${p.id}">
      <div class="project__top">
        <div class="project__ic">${initial}</div>
        <div style="min-width:0">
          <div class="project__name">${escapeHtml(p.name)}</div>
          <div class="project__path">${escapeHtml(p.folderPath)}</div>
        </div>
      </div>
      <span class="pstatus ${p.cloudEnabled ? 'cloud' : 'local'}"><i></i>${p.cloudEnabled ? 'Cloud' : 'Local'}</span>
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

// Errors thrown in the main process arrive prefixed with Electron's
// "Error invoking remote method '<channel>': Error: " — strip that so
// dialogs show only the human-readable part.
function cleanError(err) {
  return String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
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
    icon.innerHTML = folderIcon(p.name, !!(project && project.id === p.id));

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
    projectError.textContent = cleanError(err);
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

const deleteFolderField = document.getElementById('delete-folder-field');
const deleteFolderToggle = document.getElementById('delete-folder-toggle');

function selectedDeleteScope() {
  return deletingProject.cloudEnabled
    ? deleteModal.querySelector('input[name="delete-scope"]:checked').value
    : 'local';
}

// The folder option only makes sense when the local copy is being removed
// (cloud-only keeps the local project), and the button spells out the
// consequence while it's ticked.
function syncDeleteFolderOption() {
  const scope = selectedDeleteScope();
  deleteFolderField.hidden = scope === 'cloud';
  if (scope === 'cloud') deleteFolderToggle.checked = false;
  deleteConfirmBtn.textContent = deleteFolderToggle.checked ? 'Delete project & folder' : 'Delete';
}

function openDeleteModal(p) {
  deletingProject = p;
  deleteError.textContent = '';
  deleteChoices.hidden = !p.cloudEnabled;
  deleteModalSub.hidden = p.cloudEnabled;
  deleteModal.querySelector('input[name="delete-scope"][value="local"]').checked = true;
  deleteFolderToggle.checked = false;
  document.getElementById('delete-folder-path').textContent = p.folderPath;
  syncDeleteFolderOption();
  deleteModal.hidden = false;
}

deleteFolderToggle.addEventListener('change', syncDeleteFolderOption);
deleteChoices.addEventListener('change', syncDeleteFolderOption);

document.getElementById('delete-cancel').addEventListener('click', () => { deleteModal.hidden = true; });
deleteModal.addEventListener('click', (e) => { if (e.target === deleteModal) deleteModal.hidden = true; });

deleteConfirmBtn.addEventListener('click', async () => {
  const scope = selectedDeleteScope();
  const deleteFolder = deleteFolderToggle.checked && scope !== 'cloud';

  deleteConfirmBtn.disabled = true;
  deleteError.textContent = '';

  try {
    if (scope === 'local' || scope === 'both') {
      if (project && project.id === deletingProject.id) closeProjectView();
      await window.electronAPI.deleteProjectLocal(deletingProject.id, { deleteFolder });
    }
    if (scope === 'cloud' || scope === 'both') {
      await deleteCloudProject(deletingProject.id, currentUser.uid);
      if (scope === 'cloud') await window.electronAPI.updateProject(deletingProject.id, { cloudEnabled: false });
    }
    deleteModal.hidden = true;
    if (deleteFolder) toast(`"${deletingProject.name}" and its folder were moved to the Recycle Bin`);
    await refreshProjects();
  } catch (err) {
    deleteError.textContent = cleanError(err);
  } finally {
    deleteConfirmBtn.disabled = false;
  }
});

/* ============================================================
   Editor: opening/closing a project
   ============================================================ */
async function openProjectView(p) {
  if (project && project.id === p.id) { go('editor'); return; }

  // Only one project session stays live at a time (see the plan's scope
  // note) — switching away closes the current one, so make that consequence
  // explicit rather than silently dropping whatever was open.
  if (project) {
    const proceed = await confirmDialog({
      title: `Switch to "${p.name}"?`,
      message: `This closes your session in "${project.name}". Pending changes are saved first, but its open tabs won't stay open.`,
      confirmLabel: 'Switch'
    });
    if (!proceed) return;
    closeProjectView();
  }

  project = p;
  rootFolder = p.folderPath;
  projectOpenedAt = Date.now();
  projectNameLabel.textContent = p.name;
  editorContainerEl.dataset.empty = 'Open a file from the sidebar';
  window.electronAPI.updateProject(p.id, { lastOpenedAt: Date.now() });

  renderPanelProjects(); // mounts #file-tree under this project's panel row
  go('editor');
  scm.refresh();
  document.getElementById('explorerActs').hidden = false;
  window.electronAPI.watchPath(rootFolder).catch(() => { /* explorer still works, just no auto-refresh */ });
}

function closeProjectView() {
  if (rootFolder) window.electronAPI.unwatchPath(rootFolder).catch(() => {});
  languageSupport.onProjectClosed();
  selectedTreePath = null;
  selectedDir = null;
  document.getElementById('explorerActs').hidden = true;
  teardownActiveWorkspace();
  openTabs.length = 0;
  renderTabs();
  project = null;
  rootFolder = null;
  projectOpenedAt = null;
  projectNameLabel.textContent = '';
  editorContainerEl.dataset.empty = 'Open a project from the sidebar';
  renderPanelProjects();
  scm.refresh();
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

// `quiet` skips the loader — used by background refreshes that build the
// new tree off-screen and swap it in, so nothing flickers.
async function loadFileTree(dirPath, container, { quiet = false } = {}) {
  if (!quiet) renderLoader(container);

  if (!window.electronAPI) { container.textContent = 'electronAPI unavailable — the preload script failed to load.'; return; }

  let nodes;
  try { nodes = await window.electronAPI.readDir(dirPath); }
  catch (err) { container.textContent = `Failed to read folder: ${err.message}`; return; }

  container.innerHTML = '';
  if (dirPath === rootFolder) scm.refreshSoon(); // tree reloads follow create/rename/delete
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
    iconEl.innerHTML = node.type === 'directory' ? folderIcon(node.name, false) : fileIcon(node.name);

    const labelEl = document.createElement('span');
    labelEl.className = 'node-label';
    labelEl.textContent = node.name;

    el.append(chevronEl, iconEl, labelEl);
    el.addEventListener('click', () => {
      selectTreeNode(el);
      if (node.type === 'directory') toggleDirectory(node, el);
      else openFile(node.path);
    });
    container.appendChild(el);
  }
}

async function toggleDirectory(node, el, opts) {
  const existing = el.nextElementSibling;
  const iconEl = el.querySelector('.node-icon');
  if (existing && existing.dataset.parentPath === node.path) {
    existing.remove();
    el.classList.remove('expanded');
    if (iconEl) iconEl.innerHTML = folderIcon(el.dataset.name, false);
    return;
  }
  el.classList.add('expanded');
  if (iconEl) iconEl.innerHTML = folderIcon(el.dataset.name, true);
  const childContainer = document.createElement('div');
  childContainer.style.paddingLeft = '14px';
  childContainer.dataset.parentPath = node.path;
  el.insertAdjacentElement('afterend', childContainer);
  await loadFileTree(node.path, childContainer, opts);
}

/* --- explorer: selection, background refresh, collapse --- */
// The folder new files/folders go into: the selected folder, or the
// selected file's folder, else the project root (VS Code behaviour).
let selectedTreePath = null;
let selectedDir = null;

function selectTreeNode(el) {
  currentFileTreeEl()?.querySelectorAll('.file-tree-node.is-sel').forEach((n) => n.classList.remove('is-sel'));
  el.classList.add('is-sel');
  selectedTreePath = el.dataset.path;
  selectedDir = el.dataset.type === 'directory' ? el.dataset.path : parentDir(el.dataset.path);
}

const findTreeNode = (host, p) => [...host.querySelectorAll('.file-tree-node')].find((n) => n.dataset.path === p);

// Re-reads the project folder without losing which folders are expanded
// or what's selected. Builds off-screen, then swaps in one go.
let treeRefreshing = false;
let treeRefreshQueued = false;
async function refreshTree() {
  const host = currentFileTreeEl();
  if (!host || !rootFolder) return;
  if (treeRefreshing) { treeRefreshQueued = true; return; }
  treeRefreshing = true;
  const root = rootFolder;
  try {
    const expanded = [...host.querySelectorAll('.file-tree-node.directory.expanded')].map((n) => n.dataset.path)
      .sort((a, b) => a.length - b.length); // parents before children
    const tmp = document.createElement('div');
    await loadFileTree(root, tmp, { quiet: true });
    for (const p of expanded) {
      const el = findTreeNode(tmp, p);
      if (el && !el.classList.contains('expanded')) await toggleDirectory({ path: p }, el, { quiet: true });
    }
    if (selectedTreePath) findTreeNode(tmp, selectedTreePath)?.classList.add('is-sel');
    const live = currentFileTreeEl();
    if (live && rootFolder === root) live.replaceChildren(...tmp.childNodes);
  } finally {
    treeRefreshing = false;
    if (treeRefreshQueued) { treeRefreshQueued = false; refreshTree(); }
  }
}

function collapseTree() {
  const host = currentFileTreeEl();
  if (!host) return;
  host.querySelectorAll('[data-parent-path]').forEach((c) => c.remove());
  host.querySelectorAll('.file-tree-node.expanded').forEach((n) => {
    n.classList.remove('expanded');
    const ic = n.querySelector('.node-icon');
    if (ic) ic.innerHTML = folderIcon(n.dataset.name, false);
  });
}

function sanitizeDocId(relativePath) {
  return `${project.id}__${relativePath}`.replace(/[.#$\[\]/\\]/g, '_');
}

function currentFileTreeEl() { return document.getElementById('file-tree'); }

// Opens a file (if needed) and puts the cursor at line/column — used by
// Problems, find-in-files and anything else that points into a file.
function openFileAt(filePath, line, column, length = 0) {
  go('editor');
  if (activeWorkspace && samePath(activeTabPath, filePath)) {
    activeWorkspace.revealPosition(line, column, length);
    return;
  }
  pendingReveal = { path: filePath, line, column, length };
  openFile(filePath);
}

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
    iconEl.innerHTML = fileIcon(name);

    const labelEl = document.createElement('span');
    labelEl.className = 'tab-label';
    labelEl.textContent = name;

    const closeEl = document.createElement('span');
    closeEl.className = 'tab-close';
    closeEl.textContent = '×';
    closeEl.addEventListener('click', (e) => { e.stopPropagation(); closeTab(tab.path); });

    tabEl.append(iconEl, labelEl, closeEl);
    tabEl.dataset.path = tab.path;
    tabEl.title = tab.path;
    tabEl.addEventListener('click', () => activateTab(tab.path));
    tabEl.addEventListener('auxclick', (e) => { if (e.button === 1) closeTab(tab.path); });
    tabBarEl.appendChild(tabEl);
  }
}

// save:false = don't flush pending edits (the file is being deleted, or
// changed on disk) — flushing would silently re-create a deleted file.
function closeTab(filePath, { save = true } = {}) {
  const idx = openTabs.findIndex((t) => t.path === filePath);
  if (idx !== -1) openTabs.splice(idx, 1);
  if (activeTabPath === filePath) {
    teardownActiveWorkspace({ save });
    const next = openTabs[openTabs.length - 1];
    if (next) activateTab(next.path);
  }
  renderTabs();
}

function teardownActiveWorkspace({ save = true } = {}) {
  // Flush any pending edit to disk before tearing down — otherwise a switch
  // right after typing (before the 800ms autosave debounce fires) would
  // silently drop it.
  if (save && activeWorkspace && activeTabPath) saveActiveFile(activeTabPath);
  if (activePresence) activePresence.destroy();
  if (activeWorkspace) activeWorkspace.destroy();
  activePresence = null;
  activeWorkspace = null;
  activeTabPath = null;
  editorContainerEl.innerHTML = ''; // shows the :empty hint
  updateFileMeta();
  languageSupport?.refreshStatus();
  breadcrumbs?.setEditor(null);
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
  activeWorkspace.diskText = content; // last text known to be on disk

  if (project.cloudEnabled) {
    activePresence = new PresenceBar(presenceListEl, activeWorkspace.getAwareness(), currentUser);
    upsertDocumentMeta(docId, {
      projectId: project.id, ownerId: currentUser.uid, path: relativePath,
      language: activeWorkspace.editor.getModel().getLanguageId(), userId: currentUser.uid
    });
  }

  updateFileMeta();

  pluginHost.emit('open', { path: filePath, language: activeWorkspace.languageId() });
  breadcrumbs.setEditor(activeWorkspace.editor, filePath);
  languageSupport.onFileOpened(activeWorkspace.editor.getModel());

  if (pendingReveal && samePath(pendingReveal.path, filePath)) {
    activeWorkspace.revealPosition(pendingReveal.line, pendingReveal.column, pendingReveal.length);
    pendingReveal = null;
  }

  let saveTimer = null;
  activeWorkspace.editor.onDidChangeModelContent(() => {
    updateFileMeta();
    if (!getSettings().autosave) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveActiveFile(filePath), 800);
  });
}

// `explicit` = the user asked to save (Ctrl+S / File → Save). Only then is
// "Format on save" applied — autosave never reformats under your cursor.
async function saveActiveFile(filePath, { explicit = false } = {}) {
  if (!activeWorkspace || activeTabPath !== filePath) return;
  if (explicit && getSettings().formatOnSave) {
    try { await activeWorkspace.editor.getAction('editor.action.formatDocument')?.run(); } catch { /* formatter errors are toasted by the formatter */ }
    if (!activeWorkspace || activeTabPath !== filePath) return;
  }
  const text = activeWorkspace.getValue();
  const ws = activeWorkspace;
  window.electronAPI.writeFile(filePath, text).then(() => {
    ws.diskText = text;
    scm.refreshSoon();
    pluginHost.emit('save', { path: filePath });
    if (activeWorkspace && activeTabPath === filePath) languageSupport.onFileSaved(activeWorkspace.editor.getModel());
  });
}

async function saveFileAs(filePath) {
  const content = filePath === activeTabPath && activeWorkspace ? activeWorkspace.getValue() : await window.electronAPI.readFile(filePath);
  const target = await window.electronAPI.showSaveDialog(filePath);
  if (!target) return;
  await window.electronAPI.writeFile(target, content);
  if (target.startsWith(rootFolder)) refreshTree();
}

async function duplicateNode(node) {
  try { await window.electronAPI.duplicateEntry(node.path); refreshTree(); }
  catch (err) { toast(`Failed to duplicate: ${cleanError(err)}`, 'error'); }
}

function copyNodePath(node) {
  navigator.clipboard.writeText(node.path).then(() => toast('Path copied')).catch(() => {});
}

async function deleteNode(node) {
  const ok = await confirmDialog({
    title: `Delete "${node.name}"?`,
    message: "This removes it from disk and can't be undone.",
    confirmLabel: 'Delete',
    danger: true
  });
  if (!ok) return;
  try {
    // close the file (or every open file inside the folder) first, without
    // the usual flush-to-disk, so the deleted file isn't written back
    const inside = (p) => samePath(p, node.path) || p.toLowerCase().startsWith(node.path.toLowerCase().replace(/[\\/]+$/, '') + (node.path.includes('\\') ? '\\' : '/'));
    for (const t of openTabs.filter((t) => inside(t.path))) closeTab(t.path, { save: false });
    await window.electronAPI.deleteEntry(node.path);
    toast(`Deleted ${node.name}`);
    refreshTree();
  } catch (err) {
    toast(`Failed to delete: ${cleanError(err)}`, 'error');
  }
}

async function startInlineCreate(type) {
  const tree = currentFileTreeEl();
  if (!tree) { toast('Open a project first', 'error'); return; }
  tree.querySelector('.inline-input-row')?.remove();

  // target the selected folder (expanding it), else the project root
  let host = tree;
  let targetDir = rootFolder;
  if (selectedDir && !samePath(selectedDir, rootFolder)) {
    const dirEl = findTreeNode(tree, selectedDir);
    if (dirEl) {
      if (!dirEl.classList.contains('expanded')) await toggleDirectory({ path: selectedDir }, dirEl);
      const children = dirEl.nextElementSibling;
      if (children?.dataset.parentPath === selectedDir) { host = children; targetDir = selectedDir; }
    }
  }
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

    const fullPath = joinPath(targetDir, name);
    try {
      if (type === 'file') await window.electronAPI.createFile(fullPath);
      else await window.electronAPI.createDirectory(fullPath);
      selectedTreePath = fullPath.replace(/\//g, rootFolder.includes('\\') ? '\\' : '/');
      refreshTree();
    } catch (err) {
      toast(`Failed to create ${type}: ${cleanError(err)}`, 'error');
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
    refreshTree();
  } catch (err) {
    renameError.textContent = cleanError(err);
  }
});

/* --- right-click context menus (files, folders, empty explorer, tabs) --- */
const relPath = (p) => (rootFolder ? p.slice(rootFolder.length).replace(/^[\\/]/, '') : p);
const copyText = (text, what) => navigator.clipboard.writeText(text).then(() => toast(`${what} copied`)).catch(() => {});
const revealInOs = (p) => window.electronAPI.revealPath(p).catch((err) => toast(cleanError(err), 'error'));
function terminalAt(dir) {
  go('editor');
  if (!bottomPanel.isOpen() || bottomPanel.currentTab() !== 'terminal') bottomPanel.open('terminal');
  terminal.create({ cwd: dir });
}
async function createIn(dir, type) {
  selectedDir = dir;
  showSide('explorer');
  await startInlineCreate(type);
}

// Expand the tree down to a file/folder and select it ("Reveal in Explorer View").
async function revealInTree(target) {
  if (!rootFolder) return;
  showSide('explorer');
  const host = currentFileTreeEl();
  if (!host) return;
  const sep = rootFolder.includes('\\') ? '\\' : '/';
  const parts = relPath(target).split(/[\\/]/).filter(Boolean);
  let cur = rootFolder;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur.replace(/[\\/]+$/, '') + sep + parts[i];
    const el = findTreeNode(host, cur);
    if (el && !el.classList.contains('expanded')) await toggleDirectory({ path: cur }, el);
  }
  const node = findTreeNode(host, target);
  if (node) { selectTreeNode(node); node.scrollIntoView({ block: 'nearest' }); node.focus(); }
}

function nodeMenu(node) {
  const isDir = node.type === 'directory';
  const dir = isDir ? node.path : parentDir(node.path);
  return [
    ...(isDir
      ? [{ label: 'New File…', onClick: () => createIn(dir, 'file') }, { label: 'New Folder…', onClick: () => createIn(dir, 'directory') }]
      : [{ label: 'Open', onClick: () => openFile(node.path) }]),
    '-',
    { label: 'Reveal in File Explorer', onClick: () => revealInOs(node.path) },
    { label: 'Open in Integrated Terminal', onClick: () => terminalAt(dir) },
    '-',
    { label: 'Copy Path', onClick: () => copyText(node.path, 'Path') },
    { label: 'Copy Relative Path', onClick: () => copyText(relPath(node.path), 'Relative path') },
    '-',
    ...(isDir ? [] : [
      { label: 'Save', kbd: 'Ctrl+S', disabled: node.path !== activeTabPath, onClick: () => saveActiveFile(node.path, { explicit: true }) },
      { label: 'Save As…', onClick: () => saveFileAs(node.path) },
      '-'
    ]),
    { label: 'Rename…', kbd: 'F2', onClick: () => openRenameModal(node) },
    { label: 'Duplicate', onClick: () => duplicateNode(node) },
    '-',
    { label: 'Delete', kbd: 'Delete', danger: true, onClick: () => deleteNode(node) }
  ];
}

function explorerBackgroundMenu() {
  return [
    { label: 'New File…', onClick: () => createIn(rootFolder, 'file') },
    { label: 'New Folder…', onClick: () => createIn(rootFolder, 'directory') },
    '-',
    { label: 'Refresh Explorer', onClick: () => refreshTree() },
    { label: 'Collapse Folders', onClick: () => collapseTree() },
    '-',
    { label: 'Reveal in File Explorer', onClick: () => revealInOs(rootFolder) },
    { label: 'Open in Integrated Terminal', onClick: () => terminalAt(rootFolder) }
  ];
}

function tabMenu(filePath) {
  const idx = openTabs.findIndex((t) => t.path === filePath);
  const closeMany = (list) => list.forEach((t) => closeTab(t.path));
  return [
    { label: 'Close', kbd: 'Ctrl+W', onClick: () => closeTab(filePath) },
    { label: 'Close Others', disabled: openTabs.length < 2, onClick: () => closeMany(openTabs.filter((t) => t.path !== filePath)) },
    { label: 'Close to the Right', disabled: idx === openTabs.length - 1, onClick: () => closeMany(openTabs.slice(idx + 1)) },
    { label: 'Close All', onClick: () => closeMany([...openTabs]) },
    '-',
    { label: 'Copy Path', onClick: () => copyText(filePath, 'Path') },
    { label: 'Copy Relative Path', onClick: () => copyText(relPath(filePath), 'Relative path') },
    '-',
    { label: 'Reveal in File Explorer', onClick: () => revealInOs(filePath) },
    { label: 'Reveal in Explorer View', onClick: () => revealInTree(filePath) },
    { label: 'Open in Integrated Terminal', onClick: () => terminalAt(parentDir(filePath)) }
  ];
}

document.addEventListener('contextmenu', (e) => {
  const node = e.target.closest('.file-tree-node');
  if (node && node.dataset.path) {
    e.preventDefault();
    selectTreeNode(node);
    return showMenu(e.clientX, e.clientY, nodeMenu({ path: node.dataset.path, type: node.dataset.type, name: node.dataset.name }));
  }
  const tab = e.target.closest('.tab[data-path]');
  if (tab) { e.preventDefault(); return showMenu(e.clientX, e.clientY, tabMenu(tab.dataset.path)); }
  if (rootFolder && e.target.closest('#panel-project-list')) { e.preventDefault(); return showMenu(e.clientX, e.clientY, explorerBackgroundMenu()); }
});

// items: { label, kbd?, onClick, danger?, disabled? } | '-'
function showMenu(x, y, items) {
  contextMenuEl.innerHTML = '';
  for (const item of items) {
    if (item === '-') {
      if (contextMenuEl.lastElementChild && !contextMenuEl.lastElementChild.classList.contains('menu-divider')) {
        const d = document.createElement('div');
        d.className = 'menu-divider';
        contextMenuEl.appendChild(d);
      }
      continue;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = item.danger ? 'context-menu-item danger' : 'context-menu-item';
    btn.disabled = !!item.disabled;
    const label = document.createElement('span');
    label.className = 'context-menu-label';
    label.textContent = item.label;
    btn.appendChild(label);
    if (item.kbd) {
      const k = document.createElement('span');
      k.className = 'context-menu-kbd';
      k.textContent = item.kbd;
      btn.appendChild(k);
    }
    btn.addEventListener('click', () => { hideContextMenu(); item.onClick(); });
    contextMenuEl.appendChild(btn);
  }
  if (contextMenuEl.lastElementChild?.classList.contains('menu-divider')) contextMenuEl.lastElementChild.remove();
  contextMenuEl.hidden = false;
  // keep the menu inside the window
  const r = contextMenuEl.getBoundingClientRect();
  contextMenuEl.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 6))}px`;
  contextMenuEl.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 6))}px`;
}
function hideContextMenu() { contextMenuEl.hidden = true; }
document.addEventListener('click', (e) => { if (!contextMenuEl.hidden && !contextMenuEl.contains(e.target)) hideContextMenu(); });
document.addEventListener('scroll', hideContextMenu, true);


// Three states: no network adapter (offline), network but no live socket to
// Firebase (degraded), or Firebase actually reachable (online). The degraded
// state waits a grace period so the startup handshake doesn't flash amber.
let cloudConnected = false;
let cloudGraceOver = false;
let lastConnState = null;
setTimeout(() => { cloudGraceOver = true; paintConnection(); }, 6000);

function paintConnection() {
  let state;
  if (!navigator.onLine) state = 'offline';
  else if (cloudConnected) state = 'online';
  else state = cloudGraceOver ? 'degraded' : 'connecting';

  const labels = {
    online: 'Online',
    connecting: 'Connecting…',
    degraded: "Can't reach cloud",
    offline: 'Offline · saving locally'
  };
  statusDotEl.className = `status-dot ${state}`;
  statusTextEl.textContent = labels[state];
  statusDotEl.parentElement.title = state === 'online'
    ? 'Connected to MulTeam cloud'
    : state === 'degraded' ? 'Network is up but the cloud server is unreachable — local edits are still saved' : '';

  // Only announce real transitions, not the initial connect.
  if (lastConnState && lastConnState !== state && state !== 'connecting') {
    if (state === 'online') toast('Back online — cloud sync resumed');
    else toast(state === 'offline' ? 'You are offline — changes are saved locally' : "Can't reach the cloud server", 'error');
  }
  if (state !== 'connecting') lastConnState = state;
}
window.addEventListener('online', paintConnection);
window.addEventListener('offline', paintConnection);
watchCloudConnection((connected) => { cloudConnected = connected; paintConnection(); });
paintConnection();

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
document.getElementById('themeBtn').addEventListener('click', () => applyTheme(getEffectiveTheme() === 'dark' ? 'light' : 'dark', { user: true }));
document.querySelectorAll('[data-theme-set]').forEach((b) => b.addEventListener('click', () => applyTheme(b.dataset.themeSet, { user: true })));

// `user` = the person chose light/dark (switch, settings, menu). With a
// color theme active, that moves to the theme's own light/dark variant; if
// it has none, ask before falling back to MulTeam's look.
async function applyTheme(t, { user = false } = {}) {
  if (user) {
    const res = await extensions.switchColorThemeMode(t);
    if (res?.switched) {
      toast(`Switched to ${res.switched}`);
      setTheme(t); // remember the preference too
      document.querySelectorAll('[data-theme-set]').forEach((b) => b.classList.toggle('is-on', b.dataset.themeSet === t));
      return;
    }
    if (res?.same) return;
    if (res?.missing) {
      const ok = await confirmDialog({
        title: `${res.missing} has no ${t} version`,
        message: `The installed theme only comes in ${t === 'light' ? 'dark' : 'light'}. Switch to MulTeam\u2019s own ${t} theme instead?`,
        confirmLabel: `Use MulTeam ${t === 'light' ? 'Light' : 'Dark'}`
      });
      if (!ok) return;
      await extensions.resetColorTheme();
    }
  }
  setTheme(t);
  setMonacoTheme(getEffectiveTheme());
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
document.getElementById('toggleFormatOnSave').classList.toggle('is-on', !!s0.formatOnSave);
document.getElementById('toggleFormatOnSave').addEventListener('click', function () {
  this.classList.toggle('is-on');
  updateSettings({ formatOnSave: this.classList.contains('is-on') });
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
  closeNotifications();
  document.getElementById('avatarBtn').setAttribute('aria-expanded', 'false');
  document.querySelectorAll('.ibtn[data-action]').forEach((b) => b.classList.remove('is-on'));
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
  document.querySelector('.ibtn[data-action="settings"]')?.classList.add('is-on');
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-action]');
  if (!a) return;
  const act = a.dataset.action;
  if (act === 'search') { const open = palette.isOpen(); closeAllOverlays(); if (!open) { palette.open(); scrim.classList.add('is-open'); document.querySelector('.sidearray .ibtn[data-action="search"]')?.classList.add('is-on'); } }
  if (act === 'settings') openSettings();
  if (act === 'newproject') { closeAllOverlays(); openProjectModal('create', null); }
  if (act === 'panel') toggleSidebar();
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
   Bottom panel + Problems
   ============================================================ */
const bottomPanel = initBottomPanel();

// Monaco's Uri.fsPath lower-cases the drive letter, so compare loosely.
const samePath = (a, b) => a && b && a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();

initProblems({ onReveal: (fsPath, line, col) => openFileAt(fsPath, line, col) });

function toggleProblems() {
  if (currentView !== 'editor') { go('editor'); bottomPanel.open('problems'); }
  else bottomPanel.toggle('problems');
}
document.getElementById('problemsBtn').addEventListener('click', toggleProblems);

const terminal = initTerminal({ panel: bottomPanel, getCwd: () => rootFolder, confirmDialog });
document.addEventListener('multeam:panelchange', (e) => {
  if (e.detail.open && e.detail.tab === 'terminal') terminal.ensureOne();
});

/* ============================================================
   Side panes (explorer / search) + find in files
   ============================================================ */
const searchView = initSearchView({
  getRoot: () => rootFolder,
  onOpenMatch: (filePath, line, column, length) => openFileAt(filePath, line, column, length)
});

const scmBadge = document.getElementById('scmBadge');
const scm = initScm({
  getRoot: () => rootFolder,
  openFile: (filePath) => { go('editor'); openFile(filePath); },
  confirmDialog,
  promptDialog,
  toast,
  onChangeCount: (n) => { scmBadge.hidden = n === 0; scmBadge.textContent = n > 99 ? '99+' : String(n); }
});

let currentSide = 'explorer';
function showSide(name) {
  currentSide = name;
  document.querySelectorAll('[data-sidepane]').forEach((p) => { p.hidden = p.dataset.sidepane !== name; });
  document.querySelectorAll('.sidearray [data-side]').forEach((b) => b.classList.toggle('is-on', b.dataset.side === name));
  if (name === 'scm') scm.refresh();
  if (name === 'ext') extensions.onShow();
  if (name === 'plugins') pluginSpace.onShow();
  if (isSidebarCollapsed()) { setSidebarCollapsed(false); sidebarResize.remember(false); }
}
// The Editor (</>) icon doubles as "Explorer": it always brings the
// project tree back, from Search / Source Control / Extensions.
document.querySelector('.sidearray [data-nav="editor"]').addEventListener('click', () => showSide('explorer'));

document.querySelectorAll('.sidearray [data-side]').forEach((b) => b.addEventListener('click', () => {
  if (currentSide === b.dataset.side) showSide('explorer');
  else {
    showSide(b.dataset.side);
    if (b.dataset.side === 'search') searchView.focus();
    if (b.dataset.side === 'scm') setTimeout(() => scm.focusMessage(), 150);
  }
}));

function openFindInFiles() {
  showSide('search');
  searchView.focus(activeWorkspace ? activeWorkspace.selectedText() : '');
}

function toggleTerminal() {
  if (currentView !== 'editor') { go('editor'); bottomPanel.open('terminal'); }
  else bottomPanel.toggle('terminal');
}

/* ============================================================
   Command palette
   ============================================================ */
let paletteCommands; // filled below; plugins add their commands to it
const palette = initCommandPalette({
  getProjects: () => allProjects,
  getOpenFiles: () => (project ? openTabs.map((t) => ({ name: t.path.split(/[\\/]/).pop(), path: t.path })) : []),
  listProjectFiles: async () => (rootFolder ? { root: rootFolder, ...(await window.electronAPI.listFiles(rootFolder)) } : null),
  onOpenProject: (p) => openProjectView(p),
  onOpenFile: (path) => openFile(path),
  commands: paletteCommands = [
    { label: 'New project', action: () => openProjectModal('create', null) },
    { label: 'Toggle theme', action: () => applyTheme(getEffectiveTheme() === 'dark' ? 'light' : 'dark', { user: true }) },
    { label: 'Open settings', action: () => openSettings() },
    { label: 'Toggle panel', hint: 'Ctrl+J', action: () => toggleProblems() },
    { label: 'Toggle terminal', hint: 'Ctrl+`', action: () => toggleTerminal() },
    { label: 'Go to file', hint: 'Ctrl+P', action: () => setTimeout(() => openQuickOpen(), 0) },
    { label: 'Find in files', hint: 'Ctrl+Shift+F', action: () => openFindInFiles() },
    { label: 'Preferences: Color Theme', action: () => setTimeout(() => extensions.openThemePicker(), 0) },
    { label: 'Preferences: File Icon Theme', action: () => setTimeout(() => extensions.openIconThemePicker(), 0) },
    { label: 'Format Document', hint: 'Shift+Alt+F', action: () => setTimeout(() => activeWorkspace && activeWorkspace.editor.getAction('editor.action.formatDocument')?.run(), 0) },
    { label: 'ESLint: Ask again before running project ESLint', action: () => formatting.resetEslintPermission() },
    { label: 'Plugins: Open gallery', action: () => { showSide('plugins'); pluginSpace.showTab('gallery'); } },
    { label: 'Plugins: New from template', action: () => { showSide('plugins'); pluginSpace.showTab('templates'); } },
    { label: 'Plugins: Tutorial', action: () => go('tutorial') },
    { label: 'Plugins: Reload all', action: () => pluginHost.reloadAll().then(() => toast('Plugins reloaded')) },
    { label: 'Extensions: Install themes & snippets', hint: 'Ctrl+Shift+X', action: () => showSide('ext') },
    { label: 'Refresh Explorer', action: () => refreshTree() },
    { label: 'Collapse folders in Explorer', action: () => collapseTree() },
    { label: 'Git: Commit', hint: 'Ctrl+Shift+G', action: () => openSourceControl() },
    { label: 'Git: Pull', action: () => scm.pull() },
    { label: 'Git: Push', action: () => scm.push() },
    { label: 'Git: Fetch', action: () => scm.fetch() },
    { label: 'Git: Switch branch', action: () => setTimeout(() => scm.openBranchMenu(), 0) },
    { label: currentUser ? 'Sign out' : 'Sign in', action: () => (currentUser ? signOut() : openSignIn()) }
  ]
});

function setSidebarCollapsed(collapsed) {
  document.getElementById('sidebar').classList.toggle('is-collapsed', collapsed);
  document.getElementById('panelToggleBtn').classList.toggle('is-on', collapsed);
}
const isSidebarCollapsed = () => document.getElementById('sidebar').classList.contains('is-collapsed');
const sidebarResize = initSidebarResize({ setCollapsed: setSidebarCollapsed, isCollapsed: isSidebarCollapsed });

// Explorer keyboard: F2 renames, Delete deletes the selected item
document.getElementById('panel-project-list').addEventListener('keydown', (e) => {
  const node = e.target.closest('.file-tree-node');
  if (!node || !node.dataset.path || e.target.tagName === 'INPUT') return;
  const info = { path: node.dataset.path, type: node.dataset.type, name: node.dataset.name };
  if (e.key === 'F2') { e.preventDefault(); openRenameModal(info); }
  if (e.key === 'Delete') { e.preventDefault(); deleteNode(info); }
});

// Files created/renamed/deleted outside the app (terminal, file manager,
// git checkout…) show up without a manual refresh. Content-only changes
// ('change' events, e.g. our own autosave) don't rebuild the tree.
let externalChangeTimer = null;
let diskCheckTimer = null;
let tabsCheckTimer = null;
window.electronAPI.onFileExternalChange(({ path: watched, eventType, filename }) => {
  if (!rootFolder || !samePath(watched, rootFolder)) return;
  scm.refreshSoon();
  const changed = filename ? joinPath(rootFolder, String(filename).replace(/\\/g, '/')) : null;
  if (changed && activeTabPath && samePath(changed, activeTabPath)) {
    clearTimeout(diskCheckTimer);
    diskCheckTimer = setTimeout(syncActiveFromDisk, 200);
  }
  if (eventType !== 'rename') return;
  clearTimeout(externalChangeTimer);
  externalChangeTimer = setTimeout(refreshTree, 250);
  clearTimeout(tabsCheckTimer);
  tabsCheckTimer = setTimeout(closeTabsWhoseFileIsGone, 350);
});

// The open file changed on disk (another app, the terminal, git, a plugin…).
// Unchanged editor → reload in place (cursor kept). Unsaved edits → ask.
let askingReload = false;
async function syncActiveFromDisk() {
  const ws = activeWorkspace;
  const filePath = activeTabPath;
  if (!ws || !filePath || project?.cloudEnabled) return; // cloud files sync through Yjs
  let disk;
  try { disk = await window.electronAPI.readFile(filePath); } catch { return closeTabsWhoseFileIsGone(); }
  if (ws !== activeWorkspace || disk === ws.diskText) return; // our own save, or nothing new
  const model = ws.editor.getModel();
  const apply = () => {
    const selections = ws.editor.getSelections();
    ws.editor.pushUndoStop();
    model.pushEditOperations(selections, [{ range: model.getFullModelRange(), text: disk }], () => selections);
    ws.editor.pushUndoStop();
    ws.diskText = disk;
  };
  if (model.getValue() === ws.diskText) { apply(); return; }
  if (askingReload) return;
  askingReload = true;
  const name = filePath.split(/[\\/]/).pop();
  const ok = await confirmDialog({
    title: `${name} changed on disk`,
    message: 'Another program changed this file while you have edits that aren\u2019t saved yet. Reload it from disk (your unsaved edits are dropped), or keep your version (saving will overwrite the disk version)?',
    confirmLabel: 'Reload from disk'
  });
  askingReload = false;
  if (ok && ws === activeWorkspace) apply();
  else if (ws === activeWorkspace) ws.diskText = disk; // keep mine: don't ask again for this change
}

// Open files that were deleted or moved elsewhere close (without saving).
async function closeTabsWhoseFileIsGone() {
  const gone = [];
  for (const t of [...openTabs]) {
    try { await window.electronAPI.readFile(t.path); } catch { gone.push(t.path); }
  }
  for (const p of gone) closeTab(p, { save: false });
  if (gone.length) toast(gone.length === 1 ? `${gone[0].split(/[\\/]/).pop()} was deleted or moved` : `${gone.length} open files were deleted or moved`, 'error');
}

document.getElementById('explorerActs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-explorer]');
  if (!b) return;
  const act = b.dataset.explorer;
  if (act === 'new-file') startInlineCreate('file');
  if (act === 'new-folder') startInlineCreate('directory');
  if (act === 'collapse') collapseTree();
  if (act === 'refresh') {
    b.classList.remove('is-spinning'); void b.offsetWidth; b.classList.add('is-spinning');
    refreshTree();
    scm.refresh();
  }
});

document.getElementById('view-tutorial').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tutorial]');
  if (b) { showSide('plugins'); pluginSpace.showTab(b.dataset.tutorial); }
  const a = e.target.closest('.tutorial__toc a');
  if (a) { e.preventDefault(); document.querySelector(a.getAttribute('href'))?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
});

function toggleSidebar() {
  setSidebarCollapsed(!isSidebarCollapsed());
  sidebarResize.remember(isSidebarCollapsed());
}

/* ============================================================
   Menu bar — only real, working actions. Add items here as features land.
   ============================================================ */
const hasProject = () => !!project;
const hasEditor = () => !!activeWorkspace;
const activeNode = () => ({ path: activeTabPath, type: 'file', name: activeTabPath.split(/[\\/]/).pop() });

// Runs a built-in Monaco command on the open editor (undo, find, format…).
function editorCmd(id) {
  return () => {
    if (!activeWorkspace) return;
    activeWorkspace.editor.focus();
    activeWorkspace.editor.trigger('menu', id, null);
  };
}
// Clipboard/undo items also work in ordinary text fields. Clicking a menu
// title steals focus, so remember what was focused just before.
let lastFocused = null;
document.addEventListener('focusin', (e) => {
  if (!e.target.closest('.menubar, .menubar__menu')) lastFocused = e.target;
});
const isTextField = (el) => el && el.isConnected && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && !el.closest('.monaco-editor, .xterm');
function editOrField(monacoId, execName) {
  return () => {
    if (isTextField(lastFocused)) { lastFocused.focus(); document.execCommand(execName); }
    else editorCmd(monacoId)();
  };
}
const canEdit = () => hasEditor() || isTextField(lastFocused);

function openTerminalNew() {
  go('editor');
  if (!bottomPanel.isOpen() || bottomPanel.currentTab() !== 'terminal') bottomPanel.open('terminal');
  if (terminal.hasActive()) terminal.create();
}

function toggleMinimap() {
  const on = !getSettings().minimap;
  updateSettings({ minimap: on });
  document.getElementById('toggleMinimap').classList.toggle('is-on', on);
  applyLiveEditorSettings();
}

function openSourceControl() {
  showSide('scm');
  setTimeout(() => scm.focusMessage(), 150);
}

const openHelp = () => { closeAllOverlays(); document.getElementById('help-modal').hidden = false; };
const openPalette = () => { closeAllOverlays(); palette.open('all'); };

initMenubar(document.getElementById('menubar'), [
  { label: 'File', items: [
    { label: 'New Project…', run: () => openProjectModal('create', null) },
    { label: 'New File', run: () => startInlineCreate('file'), enabled: hasProject },
    { label: 'New Folder', run: () => startInlineCreate('directory'), enabled: hasProject },
    '-',
    { label: 'Open Project…', kbd: 'Ctrl+K', run: openPalette },
    '-',
    { label: 'Save', kbd: 'Ctrl+S', run: () => saveActiveFile(activeTabPath, { explicit: true }), enabled: hasEditor },
    { label: 'Save As…', run: () => saveFileAs(activeTabPath), enabled: hasEditor },
    '-',
    { label: 'Rename File…', run: () => openRenameModal(activeNode()), enabled: hasEditor },
    { label: 'Duplicate File', run: () => duplicateNode(activeNode()), enabled: hasEditor },
    '-',
    { label: 'Close Editor', kbd: 'Ctrl+W', run: () => closeTab(activeTabPath), enabled: hasEditor },
    { label: 'Close Project', run: () => { closeProjectView(); go('dashboard'); }, enabled: hasProject },
    '-',
    { label: 'Settings', kbd: 'Ctrl+,', run: () => openSettings() },
    '-',
    { label: 'Delete File…', run: () => deleteNode(activeNode()), enabled: hasEditor, danger: true }
  ] },
  { label: 'Edit', items: [
    { label: 'Undo', kbd: 'Ctrl+Z', run: editOrField('undo', 'undo'), enabled: canEdit },
    { label: 'Redo', kbd: 'Ctrl+Y', run: editOrField('redo', 'redo'), enabled: canEdit },
    '-',
    { label: 'Cut', kbd: 'Ctrl+X', run: editOrField('editor.action.clipboardCutAction', 'cut'), enabled: canEdit },
    { label: 'Copy', kbd: 'Ctrl+C', run: editOrField('editor.action.clipboardCopyAction', 'copy'), enabled: canEdit },
    { label: 'Paste', kbd: 'Ctrl+V', run: editOrField('editor.action.clipboardPasteAction', 'paste'), enabled: canEdit },
    '-',
    { label: 'Find', kbd: 'Ctrl+F', run: editorCmd('actions.find'), enabled: hasEditor },
    { label: 'Replace', kbd: 'Ctrl+H', run: editorCmd('editor.action.startFindReplaceAction'), enabled: hasEditor },
    '-',
    { label: 'Find in Files', kbd: 'Ctrl+Shift+F', run: () => openFindInFiles() },
    '-',
    { label: 'Toggle Line Comment', kbd: 'Ctrl+/', run: editorCmd('editor.action.commentLine'), enabled: hasEditor },
    { label: 'Format Document', kbd: 'Shift+Alt+F', run: editorCmd('editor.action.formatDocument'), enabled: hasEditor }
  ] },
  { label: 'Selection', items: [
    { label: 'Select All', kbd: 'Ctrl+A', run: editorCmd('editor.action.selectAll'), enabled: hasEditor },
    { label: 'Expand Selection', kbd: 'Shift+Alt+→', run: editorCmd('editor.action.smartSelect.expand'), enabled: hasEditor },
    { label: 'Shrink Selection', kbd: 'Shift+Alt+←', run: editorCmd('editor.action.smartSelect.shrink'), enabled: hasEditor },
    '-',
    { label: 'Copy Line Up', kbd: 'Shift+Alt+↑', run: editorCmd('editor.action.copyLinesUpAction'), enabled: hasEditor },
    { label: 'Copy Line Down', kbd: 'Shift+Alt+↓', run: editorCmd('editor.action.copyLinesDownAction'), enabled: hasEditor },
    { label: 'Move Line Up', kbd: 'Alt+↑', run: editorCmd('editor.action.moveLinesUpAction'), enabled: hasEditor },
    { label: 'Move Line Down', kbd: 'Alt+↓', run: editorCmd('editor.action.moveLinesDownAction'), enabled: hasEditor },
    { label: 'Duplicate Selection', run: editorCmd('editor.action.duplicateSelection'), enabled: hasEditor },
    '-',
    { label: 'Add Cursor Above', kbd: 'Ctrl+Alt+↑', run: editorCmd('editor.action.insertCursorAbove'), enabled: hasEditor },
    { label: 'Add Cursor Below', kbd: 'Ctrl+Alt+↓', run: editorCmd('editor.action.insertCursorBelow'), enabled: hasEditor },
    { label: 'Add Next Occurrence', kbd: 'Ctrl+D', run: editorCmd('editor.action.addSelectionToNextFindMatch'), enabled: hasEditor },
    { label: 'Select All Occurrences', kbd: 'Ctrl+Shift+L', run: editorCmd('editor.action.selectHighlights'), enabled: hasEditor }
  ] },
  { label: 'View', items: [
    { label: 'Command Palette', kbd: 'Ctrl+Shift+P', run: openPalette },
    '-',
    { label: 'Dashboard', run: () => go('dashboard') },
    { label: 'Explorer', run: () => showSide('explorer') },
    { label: 'Refresh Explorer', run: () => refreshTree(), enabled: hasProject },
    { label: 'Collapse Folders in Explorer', run: () => collapseTree(), enabled: hasProject },
    { label: 'Search', kbd: 'Ctrl+Shift+F', run: () => openFindInFiles() },
    { label: 'Source Control', kbd: 'Ctrl+Shift+G', run: () => openSourceControl() },
    { label: 'Extensions', kbd: 'Ctrl+Shift+X', run: () => showSide('ext') },
    { label: 'Plugins', run: () => showSide('plugins') },
    '-',
    { label: 'Problems', run: () => { go('editor'); bottomPanel.open('problems'); } },
    { label: 'Terminal', kbd: 'Ctrl+`', run: () => { go('editor'); bottomPanel.open('terminal'); } },
    { label: 'Toggle Panel', kbd: 'Ctrl+J', run: () => (bottomPanel.isOpen() ? bottomPanel.close() : (go('editor'), bottomPanel.open())) },
    { label: 'Toggle Sidebar', kbd: 'Ctrl+B', run: () => toggleSidebar() },
    '-',
    { label: 'Zoom In', kbd: 'Ctrl+=', run: () => window.electronAPI.zoom('in') },
    { label: 'Zoom Out', kbd: 'Ctrl+-', run: () => window.electronAPI.zoom('out') },
    { label: 'Reset Zoom', kbd: 'Ctrl+0', run: () => window.electronAPI.zoom('reset') },
    '-',
    { label: 'Color Theme…', run: () => extensions.openThemePicker() },
    { label: 'File Icon Theme…', run: () => extensions.openIconThemePicker() },
    { label: 'Toggle Minimap', run: () => toggleMinimap() },
    { label: 'Toggle Theme', run: () => applyTheme(getEffectiveTheme() === 'dark' ? 'light' : 'dark', { user: true }) }
  ] },
  { label: 'Go', items: [
    { label: 'Go to File…', kbd: 'Ctrl+P', run: () => openQuickOpen() },
    { label: 'Go to Line…', kbd: 'Ctrl+G', run: editorCmd('editor.action.gotoLine'), enabled: hasEditor },
    { label: 'Go to Symbol in Editor…', kbd: 'Ctrl+Shift+O', run: editorCmd('editor.action.quickOutline'), enabled: hasEditor },
    '-',
    { label: 'Go to Definition', kbd: 'F12', run: editorCmd('editor.action.revealDefinition'), enabled: hasEditor },
    { label: 'Go to References', kbd: 'Shift+F12', run: editorCmd('editor.action.goToReferences'), enabled: hasEditor },
    '-',
    { label: 'Next Problem', kbd: 'F8', run: editorCmd('editor.action.marker.next'), enabled: hasEditor },
    { label: 'Previous Problem', kbd: 'Shift+F8', run: editorCmd('editor.action.marker.prev'), enabled: hasEditor }
  ] },
  { label: 'Terminal', items: [
    { label: 'New Terminal', kbd: 'Ctrl+Shift+`', run: () => openTerminalNew() },
    { label: 'Toggle Terminal', kbd: 'Ctrl+`', run: () => toggleTerminal() },
    '-',
    { label: 'Kill Terminal…', run: () => terminal.killActive(), enabled: () => terminal.hasActive(), danger: true }
  ] },
  { label: 'Help', items: [
    { label: 'Show Help', run: openHelp },
    { label: 'Keyboard Shortcuts', run: openHelp },
    { label: 'Plugin Tutorial', run: () => go('tutorial') },
    '-',
    { label: 'About MulTeam', run: async () => toast(`MulTeam v${await window.electronAPI.getAppVersion()} · Electron, Monaco, Yjs & Firebase`) }
  ] }
]);

const extensions = initExtensions({
  toast,
  confirmDialog,
  pick: (opts) => { closeAllOverlays(); palette.pick(opts); },
  onTabChange: (tab, query) => languageSupport.setView(tab, query),
  // re-draw everything that shows file/folder icons
  onIconThemeChange: () => {
    document.querySelectorAll('#panel-project-list > .subitem.directory').forEach((row) => {
      const p = allProjects.find((x) => x.name === row.querySelector('.node-label')?.textContent);
      const ic = row.querySelector('.node-icon');
      if (p && ic) ic.innerHTML = folderIcon(p.name, !!(project && project.id === p.id));
    });
    refreshTree();
    renderTabs();
    scm.refresh();
  }
});

const formatting = initFormatting({ toast, confirmDialog, getRoot: () => rootFolder });

const breadcrumbs = initBreadcrumbs({
  getRoot: () => rootFolder,
  getProjectName: () => project?.name,
  lspSymbols: (model) => languageSupport.symbolsFor(model),
  onReveal: (p) => revealInTree(p)
});

const languageSupport = initLanguageSupport({
  onCatalogChange: (catalog) => formatting.setCatalog(catalog),
  lspShouldFormat: (lang) => !formatting.hasFormatter(lang),
  toast,
  confirmDialog,
  getRoot: () => rootFolder,
  getActiveModel: () => (activeWorkspace ? activeWorkspace.editor.getModel() : null),
  openFileAt: (filePath, line, column) => openFileAt(filePath, line, column),
  showExtensions: () => showSide('ext')
});

const pluginSpace = initPluginSpace({
  toast,
  confirmDialog,
  promptDialog,
  getPluginHost: () => pluginHost,
  openTutorial: () => go('tutorial')
});

// What plugins may touch (each call is permission-checked in pluginHost.js).
const pluginHost = initPluginHost({
  space: pluginSpace,
  toast,
  confirmDialog,
  promptDialog,
  commands: paletteCommands,
  app: {
    editorText: () => (activeWorkspace ? activeWorkspace.getValue() : null),
    selectedText: () => (activeWorkspace ? activeWorkspace.selectionText() : ''),
    replaceSelection: (text) => { if (!activeWorkspace) throw new Error('No file is open.'); activeWorkspace.replaceSelection(text); return null; },
    insertText: (text) => { if (!activeWorkspace) throw new Error('No file is open.'); activeWorkspace.insertText(text); return null; },
    currentFile: () => (activeWorkspace && activeTabPath ? { path: activeTabPath, language: activeWorkspace.languageId() } : null),
    root: () => rootFolder,
    join: (root, rel) => joinPath(root, rel)
  }
});

function openQuickOpen() {
  closeAllOverlays();
  palette.open('files');
}

function togglePalette() {
  const open = palette.isOpen() && palette.mode() === 'all';
  closeAllOverlays();
  if (!open) { palette.open('all'); scrim.classList.add('is-open'); }
}

// App-wide shortcuts. Registered in the CAPTURE phase so they win over the
// focused editor/terminal — Monaco otherwise swallows e.g. Ctrl+K (its chord
// prefix) and the palette would never open while typing. A matched shortcut
// is stopped so Monaco/xterm don't also act on it.
function appShortcut(e) {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod || e.altKey) return null;
  const k = e.key.toLowerCase();
  if (!e.shiftKey && k === 'k') return togglePalette;
  if (e.shiftKey && k === 'p') return togglePalette;                       // VS Code habit
  if (!e.shiftKey && k === 'p') return () => (palette.isOpen() && palette.mode() === 'files' ? closeAllOverlays() : openQuickOpen());
  if (e.shiftKey && k === 'f') return openFindInFiles;
  if (e.shiftKey && k === 'g') return openSourceControl;
  if (e.shiftKey && k === 'x') return () => showSide('ext');
  if (e.shiftKey && (e.key === '`' || e.key === '~')) return openTerminalNew;
  if (!e.shiftKey && e.key === '`') return toggleTerminal;
  if (!e.shiftKey && k === 'b') return toggleSidebar;
  if (!e.shiftKey && k === 'j') return () => (bottomPanel.isOpen() ? bottomPanel.close() : (go('editor'), bottomPanel.open()));
  if (!e.shiftKey && k === 'w' && activeTabPath) return () => closeTab(activeTabPath);
  if (!e.shiftKey && k === 's') return () => { if (activeTabPath) saveActiveFile(activeTabPath, { explicit: true }); };
  if (e.key === ',') return openSettings;
  return null;
}

document.addEventListener('keydown', (e) => {
  const run = appShortcut(e);
  if (!run) return;
  e.preventDefault();
  e.stopPropagation();
  run();
}, true);

// Escape stays in the normal (bubble) phase so the editor can close its own
// find widget / suggestions first.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeAllOverlays(); hideContextMenu(); settleConfirm(false); settlePrompt(null); }
});

/* ============================================================
   Boot
   ============================================================ */
enhanceSelects(); // after settings have set each <select>'s initial value
go('dashboard');
refreshProjects();
