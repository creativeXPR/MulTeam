import { watchAuthState, watchCloudConnection, signOut, createCloudProject, deleteCloudProject, upsertDocumentMeta, ensureLiveMembership } from './firebase.js';
import { fileKeyFor } from './sync.js';
import { initCollab } from './collab.js';
import { createLiveProject } from './liveProject.js';
import { requireAuth, openSignIn } from './authModal.js';
import { FileDocument, EditorView, setMonacoTheme } from './editor.js';
import { PresenceBar } from './presence.js';
import { applyStoredTheme, setTheme, getTheme, getEffectiveTheme, setAccent, getAccentChoice, hasAppPalette } from './theme.js';
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
import { initPluginDev } from './pluginDev.js';
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
let allProjects = [];   // the CURRENT workspace's projects (what the Explorer/Dashboard show)
let everyProject = [];  // all registered projects, across workspaces
let workspaces = [];
let currentWsId = null;
let collab = null; // collaboration UI (collab.js), set up once the shell is ready
let wsFilter = 'all';

let project = null; // currently open project, or null
let rootFolder = null;
// The FOCUSED editor group's view and file (kept under these names so the
// rest of the app — menus, plugins, formatting, problems — stays unchanged).
let activeWorkspace = null;
let activePresence = null;
let activeTabPath = null;
let projectOpenedAt = null;
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

// altLabel adds a second action; the promise then resolves to 'alt' for it.
function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false, altLabel = '' }) {
  const alt = document.getElementById('confirm-alt');
  alt.hidden = !altLabel;
  alt.textContent = altLabel;
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
document.getElementById('confirm-alt').addEventListener('click', () => settleConfirm('alt'));
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
// Signed out: a person icon. Signed in: the account photo, else the initial.
const PERSON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8.5" r="3.6"/><path d="M5 20c.9-3.6 3.7-5.6 7-5.6s6.1 2 7 5.6"/></svg>';
function paintAvatar(el, user) {
  el.classList.toggle('is-anon', !user);
  if (!user) { el.innerHTML = PERSON_SVG; return; }
  const initial = escapeHtml((user.displayName || user.email || '?')[0].toUpperCase());
  if (!user.photoURL) { el.textContent = initial; return; }
  const img = document.createElement('img');
  img.alt = '';
  img.referrerPolicy = 'no-referrer';
  img.src = user.photoURL;
  img.onerror = () => { el.textContent = initial; };
  el.replaceChildren(img);
}
paintAvatar(document.getElementById('avatarInitials'), null);
paintAvatar(document.getElementById('profileAvatar'), null);

watchAuthState((user) => {
  currentUser = user;
  paintAvatar(document.getElementById('avatarInitials'), user);
  paintAvatar(document.getElementById('profileAvatar'), user);
  document.getElementById('profileName').textContent = user ? (user.displayName || user.email) : 'Not signed in';
  document.getElementById('profileEmail').textContent = user ? user.email : 'Sign in for cloud sync';
  document.getElementById('profileSigninBtn').hidden = !!user;
  document.getElementById('profileSignoutBtn').hidden = !user;
  document.getElementById('dashboardGreeting').textContent = user ? `Welcome back, ${user.displayName || user.email}` : 'Welcome — sign in to enable cloud sync';
  renderDashboardCards();
  collab?.onAuth(user);
  if (user && project?.cloudEnabled && !liveSyncReady) startLiveSync();
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
const wsOf = (p) => p.workspaceId || workspaces[0]?.id;
const currentWs = () => workspaces.find((w) => w.id === currentWsId) || workspaces[0];

async function refreshProjects() {
  const [list, ws] = await Promise.all([window.electronAPI.listProjects(), window.electronAPI.workspaces.list()]);
  workspaces = ws.workspaces;
  currentWsId = ws.currentId;
  everyProject = list;
  allProjects = list.filter((p) => wsOf(p) === currentWsId);
  // the open project left this workspace (switched away, or moved elsewhere)
  if (project && !allProjects.some((p) => p.id === project.id)) closeProjectView();
  paintWorkspaceName();
  collab?.projectsChanged();
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
    row.dataset.projectRow = p.id;

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
   Workspaces — groups of projects; the Explorer + Dashboard show the
   current one. Stored locally by the main process (projects.js).
   ============================================================ */
function paintWorkspaceName() {
  const name = currentWs()?.name || 'Workspace';
  document.getElementById('wsExplorerName').textContent = name;
  document.getElementById('wsDashName').textContent = name;
  document.getElementById('wsStatLabel').textContent = name;
  document.getElementById('wsExplorerBtn').title = `Workspace: ${name} (switch, create or manage)`;
}

async function switchWorkspace(id) {
  if (id === currentWsId) return;
  try { await window.electronAPI.workspaces.setCurrent(id); } catch (err) { toast(cleanError(err), 'error'); }
  await refreshProjects();
  toast(`Switched to ${currentWs().name}`);
}

function pickWorkspace() {
  closeAllOverlays();
  palette.pick({
    title: 'Switch workspace',
    items: workspaces.map((w) => ({ label: w.name, detail: `${everyProject.filter((p) => wsOf(p) === w.id).length} projects`, value: w.id })),
    current: currentWsId,
    onPick: (it) => switchWorkspace(it.value)
  });
}

async function newWorkspace() {
  const name = await promptDialog({ title: 'New workspace', label: 'Name', placeholder: 'e.g. Client work', confirmLabel: 'Create' });
  if (!name?.trim()) return;
  try { await window.electronAPI.workspaces.create(name); } catch (err) { toast(cleanError(err), 'error'); return; }
  await refreshProjects();
  toast(`Created ${currentWs().name}. New projects go here.`);
}

async function renameWorkspace(ws = currentWs()) {
  const name = await promptDialog({ title: 'Rename workspace', label: 'Name', value: ws.name, confirmLabel: 'Rename' });
  if (!name?.trim() || name.trim() === ws.name) return;
  try { await window.electronAPI.workspaces.rename(ws.id, name); } catch (err) { toast(cleanError(err), 'error'); return; }
  await refreshProjects();
}

async function deleteWorkspace(ws = currentWs()) {
  if (workspaces.length < 2) return;
  const target = workspaces.find((w) => w.id !== ws.id);
  const count = everyProject.filter((p) => wsOf(p) === ws.id).length;
  const ok = await confirmDialog({
    title: `Delete the "${ws.name}" workspace?`,
    message: count
      ? `Its ${count} project${count === 1 ? '' : 's'} will move to "${target.name}". No projects, files or folders are deleted.`
      : 'It has no projects. No files or folders are touched.',
    confirmLabel: 'Delete workspace',
    danger: true
  });
  if (!ok) return;
  try { await window.electronAPI.workspaces.remove(ws.id, target.id); } catch (err) { toast(cleanError(err), 'error'); return; }
  await refreshProjects();
  toast(`Deleted ${ws.name}`);
}

function workspaceMenuItems() {
  return [
    ...workspaces.map((w) => ({
      label: w.name,
      kbd: String(everyProject.filter((p) => wsOf(p) === w.id).length),
      checked: w.id === currentWsId,
      onClick: () => switchWorkspace(w.id)
    })),
    '-',
    { label: 'New Workspace…', onClick: newWorkspace },
    { label: 'Rename Workspace…', onClick: () => renameWorkspace() },
    { label: 'Delete Workspace…', danger: true, disabled: workspaces.length < 2, onClick: () => deleteWorkspace() }
  ];
}

function openWorkspaceMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  showMenu(r.left, r.bottom + 4, workspaceMenuItems());
}
for (const id of ['wsExplorerBtn', 'wsDashBtn']) {
  document.getElementById(id).addEventListener('click', (e) => { e.stopPropagation(); openWorkspaceMenu(e.currentTarget); });
}

async function moveProjectToWorkspace(p, wsId) {
  try { await window.electronAPI.updateProject(p.id, { workspaceId: wsId }); } catch (err) { toast(cleanError(err), 'error'); return; }
  await refreshProjects();
  toast(`Moved ${p.name} to ${workspaces.find((w) => w.id === wsId)?.name}`);
}

// right-click on a project (Explorer row or Dashboard card)
function projectMenu(p) {
  const others = workspaces.filter((w) => w.id !== wsOf(p));
  return [
    { label: 'Open', onClick: () => openProjectView(p) },
    p.cloudEnabled
      ? { label: 'Share…', onClick: () => collab.openShare(p.id) }
      : { label: 'Share… (turn on cloud sync first)', onClick: () => openProjectModal('edit', p) },
    { label: 'Edit…', onClick: () => openProjectModal('edit', p) },
    '-',
    ...(others.length
      ? others.map((w) => ({ label: `Move to ${w.name}`, onClick: () => moveProjectToWorkspace(p, w.id) }))
      : [{ label: 'Move to… (create another workspace first)', disabled: true, onClick: () => {} }]),
    '-',
    { label: p.joined ? 'Remove from this computer…' : 'Delete…', danger: true, onClick: () => openDeleteModal(p) }
  ];
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
    cloudToggle.disabled = !!existing.joined;
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
      const created = await window.electronAPI.createProject({ name, folderPath: chosenFolder, cloudEnabled, workspaceId: currentWsId });
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
      try { await createCloudProject(projectId, name, currentUser); resolve(); }
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
  return deletingProject.cloudEnabled && !deletingProject.joined
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
  deleteChoices.hidden = !p.cloudEnabled || !!p.joined;
  deleteModalSub.hidden = p.cloudEnabled && !p.joined;
  deleteModalSub.textContent = p.joined
    ? "Removes it from MulTeam on this computer. You stay a member of the shared project (leave it from Share). Your files stay on disk unless you choose otherwise below."
    : 'Removes it from MulTeam. Your files stay on disk unless you choose otherwise below.';
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
/* ============================================================
   Live project sync (cloud projects): every file with live edits on the
   current Git branch stays in step on everyone's disk — see liveProject.js.
   ============================================================ */
let liveSync = null;        // the running sync for the open cloud project
let liveSyncReady = null;   // Promise<liveSync | null>
let liveRole = null;
let liveDeniedShown = false;
let branchCheckTimer = null;

const relOf = (filePath) => filePath.slice(rootFolder.length).replace(/^[\\/]+/, '').split('\\').join('/');

function startLiveSync() {
  if (!project?.cloudEnabled || !currentUser) return Promise.resolve(null);
  if (liveSyncReady) return liveSyncReady;
  const p = project;
  const root = rootFolder;
  liveDeniedShown = false;
  liveSyncReady = (async () => {
    let role = null;
    try { role = await ensureLiveMembership(p.id, currentUser.uid); } catch (err) { console.warn('[cloud] membership check failed:', err?.message || err); }
    const st = await window.electronAPI.git.status(root).catch(() => ({ isRepo: false }));
    if (project !== p) return null;
    liveRole = role;
    const api = window.electronAPI;
    liveSync = createLiveProject({
      projectId: p.id,
      root,
      branch: st.isRepo ? st.branch : null,
      isGit: !!st.isRepo,
      uid: currentUser.uid,
      canEdit: role === 'owner' || role === 'editor',
      api: {
        readFile: api.readFile, writeFile: api.writeFile, readDir: api.readDir, createDirectory: api.createDirectory,
        trashEntry: api.trashEntry, backupFile: api.backupFile, headContent: (r, rel) => api.git.headContent(r, rel)
      },
      toast,
      onDenied: () => {
        if (liveDeniedShown) return;
        liveDeniedShown = true;
        toast("Live editing isn't available for this project right now. You may not be a member, or you're offline. Edits stay local.", 'error');
      }
    });
    return liveSync;
  })();
  return liveSyncReady;
}

function stopLiveSync() {
  liveSync?.dispose();
  liveSync = null;
  liveSyncReady = null;
  liveRole = null;
}

// Git moved HEAD (commit, pull, checkout…). A different branch = a different
// live session: reopen the editors against it (without saving — the files on
// disk are now the other branch's).
function scheduleBranchCheck() {
  clearTimeout(branchCheckTimer);
  branchCheckTimer = setTimeout(async () => {
    if (!liveSync || !rootFolder) return;
    const st = await window.electronAPI.git.status(rootFolder).catch(() => null);
    if (!st?.isRepo || !liveSync || st.branch === liveSync.branch) return;
    const reopen = orderedGroups().flatMap((g) => g.tabs);
    const active = activeTabPath;
    closeAllEditors({ save: false });
    stopLiveSync();
    await startLiveSync();
    for (const path of reopen) if (!samePath(path, active)) await openFile(path).catch(() => {});
    if (active) openFile(active).catch(() => {});
    toast(`Switched to branch ${st.branch}. You're now in its live session.`);
  }, 700);
}

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
  setEmptyHints();
  window.electronAPI.updateProject(p.id, { lastOpenedAt: Date.now() });

  renderPanelProjects(); // mounts #file-tree under this project's panel row
  go('editor');
  // A plugin's own project (Plugins workspace): point the Plugin tab at it.
  if (p.pluginId) { pluginDev.select(p.pluginId); pluginDev.check(p.pluginId, { quiet: true }); }
  scm.refresh();
  document.getElementById('explorerActs').hidden = false;
  window.electronAPI.watchPath(rootFolder).catch(() => { /* explorer still works, just no auto-refresh */ });
  if (p.cloudEnabled && currentUser) startLiveSync();
}

function closeProjectView() {
  if (rootFolder) window.electronAPI.unwatchPath(rootFolder).catch(() => {});
  languageSupport.onProjectClosed();
  selectedTreePath = null;
  selectedDir = null;
  document.getElementById('explorerActs').hidden = true;
  closeAllEditors({ save: true });
  stopLiveSync();
  project = null;
  rootFolder = null;
  projectOpenedAt = null;
  projectNameLabel.textContent = '';
  setEmptyHints();
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
    if (node.type === 'file') {
      el.draggable = true;
      el.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData(FILE_MIME, node.path);
        e.dataTransfer.setData('text/plain', node.path);
        e.dataTransfer.effectAllowed = 'move';
      });
    }
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


function currentFileTreeEl() { return document.getElementById('file-tree'); }

/* ============================================================
   Editor groups (VS Code style splits). Each group has its own tabs and
   shows one editor at a time; a FileDocument (text model + collaboration +
   the copy on disk) is shared by every group showing that file.
   Layout is a tree: { type:'group', id } | { type:'split', dir:'row'|'col', a, b, ratio }.
   ============================================================ */
const gridEl = document.getElementById('editorGrid');
const documents = new Map();   // pathKey → { doc, opening, saveTimer, sub }
const groups = new Map();      // id → group
let groupSeq = 0;
let focusedGroup = null;
let layout = null;
const pathKey = (p) => String(p).replace(/\\/g, '/').toLowerCase();
const TAB_MIME = 'application/x-multeam-tab';
const FILE_MIME = 'application/x-multeam-file';
const GICON = {
  run: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.6v12.8a1 1 0 0 0 1.5.86l10.2-6.4a1 1 0 0 0 0-1.72L9.5 4.74A1 1 0 0 0 8 5.6Z"/></svg>',
  right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M12 4.5v15"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 12h17"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M7 7l10 10M17 7 7 17"/></svg>'
};

function setEmptyHints() {
  for (const g of groups.values()) g.editorEl.dataset.empty = rootFolder ? 'Open a file from the sidebar' : 'Open a project from the sidebar';
}

// ---------- groups ----------
function createGroup() {
  const id = ++groupSeq;
  const el = document.createElement('section');
  el.className = 'egroup';
  el.dataset.group = String(id);
  el.innerHTML = `<div class="egroup__head">
      <div class="tab-bar" role="tablist"></div>
      <div class="egroup__acts">
        <button type="button" class="ibtn egroup__run" data-gact="run" title="Run File in Terminal (Ctrl+F5)" hidden>${GICON.run}</button>
        <button type="button" class="ibtn" data-gact="split-right" title="Split Editor Right (Ctrl+\\)">${GICON.right}</button>
        <button type="button" class="ibtn" data-gact="split-down" title="Split Editor Down">${GICON.down}</button>
        <button type="button" class="ibtn" data-gact="close-group" title="Close Group">${GICON.close}</button>
      </div>
    </div>
    <nav class="crumbs" aria-label="Breadcrumbs"></nav>
    <div class="egroup__editor"></div>
    <div class="egroup__drop" hidden></div>`;
  const g = { id, el, tabBar: el.querySelector('.tab-bar'), editorEl: el.querySelector('.egroup__editor'), dropEl: el.querySelector('.egroup__drop'), tabs: [], activePath: null, view: null };
  g.editorEl.dataset.empty = rootFolder ? 'Open a file from the sidebar' : 'Open a project from the sidebar';
  g.crumbs = initBreadcrumbs({
    el: el.querySelector('.crumbs'),
    getRoot: () => rootFolder,
    getProjectName: () => project?.name,
    lspSymbols: (model) => languageSupport.symbolsFor(model),
    onReveal: (p) => revealInTree(p)
  });
  el.addEventListener('pointerdown', () => focusGroup(g), true);
  el.querySelector('.egroup__acts').addEventListener('click', (e) => {
    const b = e.target.closest('[data-gact]');
    if (!b) return;
    if (b.dataset.gact === 'run') { focusGroup(g); runFile(g.activePath); }
    if (b.dataset.gact === 'split-right') splitEditor(g, 'right');
    if (b.dataset.gact === 'split-down') splitEditor(g, 'bottom');
    if (b.dataset.gact === 'close-group') closeGroup(g);
  });
  wireGroupDnD(g);
  groups.set(id, g);
  return g;
}

function focusGroup(g) {
  if (!g || !groups.has(g.id)) return;
  if (focusedGroup !== g) {
    focusedGroup = g;
    for (const x of groups.values()) x.el.classList.toggle('is-focused', x === g);
  }
  syncActive();
}

// keep the legacy "active" names pointing at the focused group
function syncActive() {
  const g = focusedGroup;
  activeWorkspace = g?.view || null;
  const prevPath = activeTabPath;
  activeTabPath = g?.activePath || null;
  // the Explorer highlight follows the focused editor (like VS Code)
  if (activeTabPath && activeTabPath !== prevPath) {
    const host = currentFileTreeEl();
    const node = host && findTreeNode(host, activeTabPath);
    if (node) selectTreeNode(node);
  }
  updateFileMeta();
  languageSupport.refreshStatus();
  const aw = activeWorkspace?.getAwareness();
  if (activePresence?.awareness !== aw) {
    activePresence?.destroy();
    activePresence = null;
    presenceListEl.innerHTML = '';
    if (aw && currentUser) activePresence = new PresenceBar(presenceListEl, aw, currentUser);
  }
}

function orderedGroups(node = layout, out = []) {
  if (!node) return out;
  if (node.type === 'group') { if (groups.has(node.id)) out.push(groups.get(node.id)); return out; }
  orderedGroups(node.a, out);
  return orderedGroups(node.b, out);
}

function findLeaf(node, id, parent = null) {
  if (!node) return null;
  if (node.type === 'group') return node.id === id ? { leaf: node, parent } : null;
  return findLeaf(node.a, id, node) || findLeaf(node.b, id, node);
}

function replaceNode(node, next) {
  for (const k of Object.keys(node)) delete node[k];
  Object.assign(node, next);
}

function resetLayout() {
  for (const g of groups.values()) { g.view?.destroy(); g.el.remove(); }
  groups.clear();
  const g = createGroup();
  layout = { type: 'group', id: g.id };
  focusedGroup = null;
  renderLayout();
  focusGroup(g);
}

// Split `target` and return the new (empty) group placed on `zone`'s side.
function splitGroup(target, zone) {
  const found = findLeaf(layout, target.id);
  if (!found) return null;
  const g = createGroup();
  const oldLeaf = { type: 'group', id: target.id };
  const newLeaf = { type: 'group', id: g.id };
  const before = zone === 'left' || zone === 'top';
  replaceNode(found.leaf, { type: 'split', dir: zone === 'left' || zone === 'right' ? 'row' : 'col', a: before ? newLeaf : oldLeaf, b: before ? oldLeaf : newLeaf, ratio: 0.5 });
  renderLayout();
  return g;
}

function removeGroup(g) {
  if (groups.size <= 1 || !groups.has(g.id)) return;
  const found = findLeaf(layout, g.id);
  if (found?.parent) {
    const sibling = found.parent.a === found.leaf ? found.parent.b : found.parent.a;
    replaceNode(found.parent, { ...sibling });
  }
  g.view?.destroy();
  groups.delete(g.id);
  g.el.remove();
  if (focusedGroup === g) { focusedGroup = null; focusGroup(orderedGroups()[0]); }
  renderLayout();
}

function renderLayout() {
  gridEl.replaceChildren(buildNode(layout));
  const only = groups.size === 1;
  for (const g of groups.values()) g.el.classList.toggle('is-only', only);
}

function buildNode(node) {
  if (node.type === 'group') return groups.get(node.id).el;
  const box = document.createElement('div');
  box.className = `esplit ${node.dir}`;
  const pane = (child, r) => { const p = document.createElement('div'); p.className = 'esplit__pane'; p.style.flex = `${r} 1 0`; p.append(child); return p; };
  const a = pane(buildNode(node.a), node.ratio);
  const b = pane(buildNode(node.b), 1 - node.ratio);
  const sash = document.createElement('div');
  sash.className = 'esplit__sash';
  sash.title = 'Drag to resize';
  sash.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { sash.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    const rect = box.getBoundingClientRect();
    document.body.classList.add(node.dir === 'row' ? 'is-resizing-h' : 'is-resizing-v');
    const move = (ev) => {
      const r = node.dir === 'row' ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
      node.ratio = Math.min(0.85, Math.max(0.15, r));
      a.style.flex = `${node.ratio} 1 0`;
      b.style.flex = `${1 - node.ratio} 1 0`;
    };
    const up = () => { sash.removeEventListener('pointermove', move); document.body.classList.remove('is-resizing-h', 'is-resizing-v'); };
    sash.addEventListener('pointermove', move);
    sash.addEventListener('pointerup', up, { once: true });
    sash.addEventListener('lostpointercapture', up, { once: true });
  });
  sash.addEventListener('dblclick', () => { node.ratio = 0.5; a.style.flex = '0.5 1 0'; b.style.flex = '0.5 1 0'; });
  box.append(a, sash, b);
  return box;
}

// "Split Editor Right/Down": the current file opens again beside it
function splitEditor(g = focusedGroup, zone = 'right') {
  if (!g) return;
  const path = g.activePath;
  const ng = splitGroup(g, zone);
  if (ng && path) openFile(path, { group: ng });
  else if (ng) focusGroup(ng);
}

function closeGroup(g = focusedGroup) {
  if (!g) return;
  for (const p of [...g.tabs]) closeTab(p, { group: g });
  if (groups.has(g.id)) removeGroup(g);
}

// ---------- documents (one per open file, shared across groups) ----------
async function openDoc(filePath) {
  const key = pathKey(filePath);
  const existing = documents.get(key);
  if (existing) return existing.doc || existing.opening;
  const rec = { doc: null, saveTimer: null, sub: null };
  rec.opening = (async () => {
    const content = await window.electronAPI.readFile(filePath);
    const rel = relOf(filePath);
    const engine = project?.cloudEnabled ? await startLiveSync() : null;
    // ignored files (.env, build output…) and big/binary files stay local
    const cloud = !!engine && engine.isShared(rel) && typeof content === 'string' && content.length <= 512 * 1024;
    const fileKey = fileKeyFor(rel);
    const docId = `${project.id}__${fileKey}`;
    const role = cloud ? liveRole : null;
    const doc = new FileDocument(filePath, {
      live: cloud ? { acquire: (seed) => engine.acquire(rel, seed), release: () => engine.release(rel) } : null,
      currentUser,
      collaborative: cloud
    }).init(content);
    doc.readOnly = role === 'viewer';
    if (cloud) {
      const live = await doc.ready; // the shared text is in before anyone can type
      if (!live && role && role !== 'viewer') toast(`Couldn't reach the live session for ${rel}. Editing your local copy; it joins the session when reopened.`, 'error');
    }
    rec.doc = doc;
    rec.opening = null;
    rec.sub = doc.model.onDidChangeContent(() => {
      updateFileMeta();
      if (!getSettings().autosave) return;
      clearTimeout(rec.saveTimer);
      rec.saveTimer = setTimeout(() => saveActiveFile(doc.filePath), 800);
    });
    if (cloud) {
      upsertDocumentMeta(docId, { projectId: project.id, path: rel, language: doc.model.getLanguageId(), userId: currentUser.uid }).catch(() => {});
    }
    return doc;
  })();
  documents.set(key, rec);
  try { return await rec.opening; } catch (err) { documents.delete(key); throw err; }
}

const shownAnywhere = (p) => [...groups.values()].some((g) => g.activePath && samePath(g.activePath, p));

function writeDoc(doc) {
  const text = doc.getValue();
  if (rootFolder && liveSync) liveSync.noteWritten(relOf(doc.filePath), text); // not an outside change
  return window.electronAPI.writeFile(doc.filePath, text).then(() => { doc.diskText = text; });
}

// Drop a file's document once no group shows it (saving pending edits first).
function releaseDoc(filePath, { save = true } = {}) {
  if (shownAnywhere(filePath)) return;
  const key = pathKey(filePath);
  const rec = documents.get(key);
  if (!rec?.doc) return;
  clearTimeout(rec.saveTimer);
  if (save) writeDoc(rec.doc).catch(() => {});
  rec.sub?.dispose();
  rec.doc.destroy();
  documents.delete(key);
}

function closeAllEditors({ save = true } = {}) {
  for (const g of groups.values()) { g.view?.destroy(); g.view = null; g.activePath = null; g.tabs = []; }
  for (const rec of documents.values()) {
    clearTimeout(rec.saveTimer);
    if (save && rec.doc) writeDoc(rec.doc).catch(() => {});
    rec.sub?.dispose();
    rec.doc?.destroy();
  }
  documents.clear();
  resetLayout();
}

// ---------- tabs ----------
function renderGroupTabs(g) {
  g.tabBar.innerHTML = '';
  for (const p of g.tabs) {
    const name = p.split(/[\\/]/).pop();
    const tabEl = document.createElement('div');
    tabEl.className = `tab ${g.activePath && samePath(p, g.activePath) ? 'active' : ''}`;
    tabEl.draggable = true;
    tabEl.dataset.path = p;
    tabEl.title = p;

    const iconEl = document.createElement('span');
    iconEl.className = 'tab-icon';
    iconEl.innerHTML = fileIcon(name);
    const labelEl = document.createElement('span');
    labelEl.className = 'tab-label';
    labelEl.textContent = name;
    const closeEl = document.createElement('span');
    closeEl.className = 'tab-close';
    closeEl.textContent = '×';
    closeEl.addEventListener('click', (e) => { e.stopPropagation(); closeTab(p, { group: g }); });

    tabEl.append(iconEl, labelEl, closeEl);
    tabEl.addEventListener('click', () => { focusGroup(g); activateTab(p, g); });
    tabEl.addEventListener('auxclick', (e) => { if (e.button === 1) closeTab(p, { group: g }); });
    tabEl.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData(TAB_MIME, JSON.stringify({ group: g.id, path: p }));
      e.dataTransfer.setData('text/plain', p);
      e.dataTransfer.effectAllowed = 'move';
      tabEl.classList.add('is-dragging');
    });
    tabEl.addEventListener('dragend', () => { tabEl.classList.remove('is-dragging'); clearAllDropMarks(); });
    g.tabBar.appendChild(tabEl);
  }
  g.el.classList.toggle('has-tabs', g.tabs.length > 0);
  g.el.querySelector('[data-gact="run"]').hidden = !isRunnable(g.activePath);
}

function renderTabs() { for (const g of groups.values()) renderGroupTabs(g); }

async function showInGroup(g, filePath) {
  if (!g || !groups.has(g.id)) return;
  if (g.view && g.activePath && samePath(g.activePath, filePath)) { if (focusedGroup === g) syncActive(); return; }
  const prev = g.activePath;
  g.view?.destroy();
  g.view = null;
  g.activePath = filePath;
  g.crumbs.setEditor(null);
  renderGroupTabs(g);
  if (prev && !samePath(prev, filePath)) releaseDoc(prev);
  if (focusedGroup === g) syncActive();
  renderLoader(g.editorEl);

  let doc;
  try { doc = await openDoc(filePath); } catch (err) { g.editorEl.textContent = `Failed to open file: ${cleanError(err)}`; return; }
  if (!groups.has(g.id) || !g.activePath || !samePath(g.activePath, filePath) || g.view) return;

  g.editorEl.innerHTML = '';
  g.view = new EditorView(g.editorEl, doc, getEffectiveTheme());
  if (doc.readOnly) g.view.editor.updateOptions({ readOnly: true, readOnlyMessage: { value: "You're a viewer in this project, so you can watch and follow but not edit." } });
  g.view.editor.onDidFocusEditorWidget(() => focusGroup(g));
  g.crumbs.setEditor(g.view.editor, filePath);
  if (focusedGroup === g) syncActive();
  pluginHost.emit('open', { path: filePath, language: g.view.languageId() });
  languageSupport.onFileOpened(doc.model);
  if (pendingReveal && samePath(pendingReveal.path, filePath) && focusedGroup === g) {
    g.view.revealPosition(pendingReveal.line, pendingReveal.column, pendingReveal.length);
    pendingReveal = null;
  }
}

function activateTab(filePath, group = focusedGroup) {
  if (!group) return;
  if (project?.cloudEnabled) requireAuth(() => showInGroup(group, filePath));
  else showInGroup(group, filePath);
}

async function openFile(filePath, { group = focusedGroup, index } = {}) {
  if (!group) return;
  if (!group.tabs.some((p) => samePath(p, filePath))) {
    const at = index === undefined ? group.tabs.length : Math.max(0, Math.min(index, group.tabs.length));
    group.tabs.splice(at, 0, filePath);
  }
  focusGroup(group);
  activateTab(filePath, group);
}

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

// save:false = don't flush pending edits (the file is being deleted or was
// changed on disk) — flushing would silently re-create a deleted file.
function closeTab(filePath, { group = focusedGroup, save = true } = {}) {
  if (!group || !filePath) return;
  const idx = group.tabs.findIndex((p) => samePath(p, filePath));
  if (idx === -1) return;
  group.tabs.splice(idx, 1);
  if (group.activePath && samePath(group.activePath, filePath)) {
    group.view?.destroy();
    group.view = null;
    group.activePath = null;
    group.crumbs.setEditor(null);
    group.editorEl.innerHTML = '';
    releaseDoc(filePath, { save });
    const next = group.tabs[Math.min(idx, group.tabs.length - 1)];
    if (next) activateTab(next, group);
    else if (groups.size > 1) { removeGroup(group); return; }
  }
  renderGroupTabs(group);
  if (focusedGroup === group) syncActive();
}

function closeEverywhere(filePath, opts = {}) {
  for (const g of [...groups.values()]) if (g.tabs.some((p) => samePath(p, filePath))) closeTab(filePath, { ...opts, group: g });
}

function allOpenPaths() {
  const seen = new Map();
  for (const g of groups.values()) for (const p of g.tabs) seen.set(pathKey(p), p);
  return [...seen.values()];
}

// Move a tab within its group (reorder) or into another group.
function moveTab(from, filePath, to, index) {
  if (!from || !to) return;
  if (from === to) {
    const i = from.tabs.findIndex((p) => samePath(p, filePath));
    if (i === -1) return;
    from.tabs.splice(i, 1);
    let at = index === undefined ? from.tabs.length : index;
    if (at > i) at -= 1;
    from.tabs.splice(Math.max(0, Math.min(at, from.tabs.length)), 0, filePath);
    renderGroupTabs(from);
    return;
  }
  if (!to.tabs.some((p) => samePath(p, filePath))) {
    const at = index === undefined ? to.tabs.length : Math.max(0, Math.min(index, to.tabs.length));
    to.tabs.splice(at, 0, filePath);
  }
  focusGroup(to);
  // show it in the destination first so its document stays alive, then
  // take it out of the source group
  const shown = project?.cloudEnabled ? new Promise((r) => requireAuth(() => showInGroup(to, filePath).then(r))) : showInGroup(to, filePath);
  Promise.resolve(shown).then(() => closeTab(filePath, { group: from }));
  renderGroupTabs(to);
}

// ---------- drag & drop: reorder tabs, move between groups, split ----------
function zoneAt(g, e) {
  const r = g.editorEl.getBoundingClientRect();
  if (!r.width || !r.height) return 'center';
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  const [side, dist] = Object.entries({ left: x, right: 1 - x, top: y, bottom: 1 - y }).sort((a, b) => a[1] - b[1])[0];
  return dist < 0.25 ? side : 'center';
}

function tabInsertIndex(g, clientX) {
  const tabsEls = [...g.tabBar.querySelectorAll('.tab')];
  const i = tabsEls.findIndex((t) => { const r = t.getBoundingClientRect(); return clientX < r.left + r.width / 2; });
  return i === -1 ? tabsEls.length : i;
}

function markTabInsert(g, clientX) {
  const tabsEls = [...g.tabBar.querySelectorAll('.tab')];
  const i = tabInsertIndex(g, clientX);
  tabsEls.forEach((t, k) => { t.classList.toggle('drop-before', k === i); t.classList.toggle('drop-after', i === tabsEls.length && k === tabsEls.length - 1); });
  g.tabBar.classList.toggle('drop-empty', !tabsEls.length);
}

function clearAllDropMarks() {
  for (const g of groups.values()) {
    g.dropEl.hidden = true;
    g.tabBar.classList.remove('drop-empty');
    g.tabBar.querySelectorAll('.drop-before, .drop-after').forEach((t) => t.classList.remove('drop-before', 'drop-after'));
  }
}

const isOurDrag = (e) => { const t = [...(e.dataTransfer?.types || [])]; return t.includes(TAB_MIME) || t.includes(FILE_MIME); };

function wireGroupDnD(g) {
  // capture phase: Monaco has its own drag handling for text
  g.el.addEventListener('dragover', (e) => {
    if (!isOurDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    clearAllDropMarks();
    if (e.target.closest('.egroup__head')) markTabInsert(g, e.clientX);
    else { g.dropEl.hidden = false; g.dropEl.className = `egroup__drop zone-${zoneAt(g, e)}`; }
  }, true);
  g.el.addEventListener('drop', (e) => {
    if (!isOurDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const inHead = !!e.target.closest('.egroup__head');
    const index = inHead ? tabInsertIndex(g, e.clientX) : undefined;
    const zone = inHead ? 'center' : zoneAt(g, e);
    clearAllDropMarks();
    handleDrop(e.dataTransfer, g, zone, index);
  }, true);
}

function handleDrop(dt, g, zone, index) {
  const rawTab = dt.getData(TAB_MIME);
  const file = dt.getData(FILE_MIME);
  if (rawTab) {
    const { group: fromId, path: p } = JSON.parse(rawTab);
    const from = groups.get(fromId);
    if (!from) return;
    if (zone !== 'center' && from === g && from.tabs.length === 1) return; // splitting a group off its only tab changes nothing
    const target = zone === 'center' ? g : splitGroup(g, zone);
    moveTab(from, p, target, index);
  } else if (file) {
    const target = zone === 'center' ? g : splitGroup(g, zone);
    openFile(file, { group: target, index });
  }
}
document.addEventListener('dragend', clearAllDropMarks);
document.addEventListener('drop', clearAllDropMarks);

// ---------- run file (▷): in the terminal, with the right interpreter ----------
let runnableExts = new Set();
window.electronAPI.run?.extensions().then((list) => { runnableExts = new Set(list); renderTabs(); }).catch(() => {});
const isRunnable = (p) => !!p && runnableExts.has(p.split(/[\/]/).pop().split('.').pop().toLowerCase());

async function runFile(filePath = focusedGroup?.activePath) {
  if (!filePath) return;
  const name = filePath.split(/[\/]/).pop();
  const rec = documents.get(pathKey(filePath));
  if (rec?.doc) {
    try { await writeDoc(rec.doc); } catch (err) { toast(`Couldn't save ${name}: ${cleanError(err)}`, 'error'); return; }
  }
  let plan;
  try { plan = await window.electronAPI.run.plan(filePath, terminal.runShellId()); } catch (err) { toast(cleanError(err), 'error'); return; }
  if (plan.unsupported) { toast(`MulTeam can't run ${name} in the terminal`, 'error'); return; }
  if (plan.missing) { promptInstallRunner(plan); return; }
  await runInTerminal(plan.cmd, plan.cwd);
}

async function runInTerminal(cmd, cwd) {
  go('editor');
  const ok = await terminal.run(() => cmd, { cwd });
  if (ok && (!bottomPanel.isOpen() || bottomPanel.currentTab() !== 'terminal')) bottomPanel.open('terminal');
}

// The interpreter/compiler isn't installed: install it (winget, in the
// terminal so progress and prompts are visible) or open its download page.
async function promptInstallRunner({ language, missing }) {
  const why = missing.outdated
    ? `Running ${language} files needs ${missing.name} — the version installed is too old.`
    : `Running ${language} files needs ${missing.name}, which isn't installed (or isn't on your PATH).`;
  const choice = await confirmDialog({
    title: `Install ${missing.name.replace(/^an? /, '')}?`,
    message: missing.winget
      ? `${why} MulTeam can install it now with winget in the terminal. When it finishes, press Run again.`
      : `${why} Open the download page to install it, then press Run again.`,
    confirmLabel: missing.winget ? 'Install now' : 'Open download page',
    altLabel: missing.winget ? 'Download page' : ''
  });
  if (choice === 'alt' || (choice === true && !missing.winget)) { window.electronAPI.run.openDownload(missing.key); return; }
  if (choice !== true) return;
  const cmd = await window.electronAPI.run.installCommand(missing.key);
  if (cmd) runInTerminal(cmd);
}

// ---------- saving ----------
// `explicit` = the user asked to save (Ctrl+S / File → Save). Only then is
// "Format on save" applied — autosave never reformats under your cursor.
async function saveActiveFile(filePath, { explicit = false } = {}) {
  const doc = filePath && documents.get(pathKey(filePath))?.doc;
  if (!doc) return;
  if (explicit && getSettings().formatOnSave) {
    const g = focusedGroup?.view?.doc === doc ? focusedGroup : [...groups.values()].find((x) => x.view?.doc === doc);
    try { await g?.view?.editor.getAction('editor.action.formatDocument')?.run(); } catch { /* formatter errors are toasted by the formatter */ }
    if (documents.get(pathKey(filePath))?.doc !== doc) return;
  }
  writeDoc(doc).then(() => {
    scm.refreshSoon();
    pluginHost.emit('save', { path: filePath });
    pluginDev.onSaved(filePath);
    languageSupport.onFileSaved(doc.model);
  });
}

async function saveFileAs(filePath) {
  const doc = documents.get(pathKey(filePath))?.doc;
  const content = doc ? doc.getValue() : await window.electronAPI.readFile(filePath);
  const target = await window.electronAPI.showSaveDialog(filePath);
  if (!target) return;
  await window.electronAPI.writeFile(target, content);
  if (target.startsWith(rootFolder)) refreshTree();
}

// A file (or folder) was renamed: open tabs follow it to the new path.
async function renameOpenPaths(oldPath, newPath) {
  const oldKey = pathKey(oldPath).replace(/\/+$/, '');
  const mapPath = (p) => {
    const k = pathKey(p);
    if (k === oldKey) return newPath;
    if (k.startsWith(oldKey + '/')) return newPath + p.slice(oldPath.replace(/[\\/]+$/, '').length);
    return null;
  };
  for (const g of groups.values()) {
    let reopen = null;
    g.tabs = g.tabs.map((p) => {
      const np = mapPath(p);
      if (np && g.activePath && samePath(g.activePath, p)) reopen = np;
      return np || p;
    });
    if (reopen) {
      const old = g.activePath;
      g.view?.destroy();
      g.view = null;
      g.activePath = null;
      releaseDoc(old, { save: false }); // its edits were flushed before the rename
      activateTab(reopen, g);
    }
    renderGroupTabs(g);
  }
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
    for (const p of allOpenPaths().filter(inside)) closeEverywhere(p, { save: false });
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

  const sep = renamingNode.path.includes('\\') ? '\\' : '/';
  const newPath = parentDir(renamingNode.path) + sep + newName;
  try {
    // flush unsaved edits of anything open under the old path first
    await Promise.all([...documents.values()].filter((r) => r.doc && pathKey(r.doc.filePath).startsWith(pathKey(renamingNode.path))).map((r) => writeDoc(r.doc)));
    await window.electronAPI.renameEntry(renamingNode.path, newPath);
    await renameOpenPaths(renamingNode.path, newPath);
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
      { label: 'Save', kbd: 'Ctrl+S', disabled: !documents.get(pathKey(node.path))?.doc, onClick: () => saveActiveFile(node.path, { explicit: true }) },
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

function tabMenu(filePath, g = focusedGroup) {
  const tabs = g.tabs;
  const idx = tabs.findIndex((p) => samePath(p, filePath));
  const closeMany = (list) => list.forEach((p) => closeTab(p, { group: g }));
  return [
    { label: 'Close', kbd: 'Ctrl+W', onClick: () => closeTab(filePath, { group: g }) },
    { label: 'Close Others', disabled: tabs.length < 2, onClick: () => closeMany(tabs.filter((p) => !samePath(p, filePath))) },
    { label: 'Close to the Right', disabled: idx === tabs.length - 1, onClick: () => closeMany(tabs.slice(idx + 1)) },
    { label: 'Close All', onClick: () => closeMany([...tabs]) },
    '-',
    { label: 'Split Right', kbd: 'Ctrl+\\', onClick: () => { const ng = splitGroup(g, 'right'); openFile(filePath, { group: ng }); } },
    { label: 'Split Down', onClick: () => { const ng = splitGroup(g, 'bottom'); openFile(filePath, { group: ng }); } },
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
  if (tab) {
    e.preventDefault();
    const g = groups.get(Number(tab.closest('.egroup')?.dataset.group)) || focusedGroup;
    focusGroup(g);
    return showMenu(e.clientX, e.clientY, tabMenu(tab.dataset.path, g));
  }
  const projRow = e.target.closest('[data-project-row], #projects [data-project]');
  if (projRow) {
    const p = allProjects.find((x) => x.id === (projRow.dataset.projectRow || projRow.dataset.project));
    if (p) { e.preventDefault(); return showMenu(e.clientX, e.clientY, projectMenu(p)); }
  }
  if (e.target.closest('.sidelist__headrow') && !e.target.closest('#explorerActs')) { e.preventDefault(); return showMenu(e.clientX, e.clientY, workspaceMenuItems()); }
  if (rootFolder && e.target.closest('#panel-project-list')) { e.preventDefault(); return showMenu(e.clientX, e.clientY, explorerBackgroundMenu()); }
});

// items: { label, kbd?, onClick, danger?, disabled?, checked? } | '-'
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
    if (item.checked !== undefined) btn.classList.add('is-checkable', ...(item.checked ? ['is-checked'] : []));
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
  paintThemeButtons();
}

// The Light/Dark buttons always reflect what's on screen: an active color
// theme's mode (GitHub Dark → Dark), otherwise MulTeam's preference.
function paintThemeButtons() {
  const mode = getEffectiveTheme();
  document.querySelectorAll('[data-theme-set]').forEach((b) => b.classList.toggle('is-on', b.dataset.themeSet === mode));
}
document.addEventListener('multeam:themechange', paintThemeButtons);
applyTheme(getTheme());

// Accent: a picked color always wins (even over a color theme); "Auto"
// follows the color theme's own accent, or MulTeam violet without one.
function paintAccentSwatches() {
  const choice = getAccentChoice().toLowerCase();
  document.querySelectorAll('[data-accent]').forEach((x) => x.classList.toggle('is-on', x.dataset.accent.toLowerCase() === choice));
  const hint = document.getElementById('accentHint');
  if (hint) hint.textContent = choice ? 'Used for actions and active states' : (hasAppPalette() ? 'Auto · from the color theme' : 'Auto · MulTeam violet');
}
document.querySelectorAll('[data-accent]').forEach((b) => b.addEventListener('click', () => setAccent(b.dataset.accent)));
document.addEventListener('multeam:themechange', paintAccentSwatches);
paintAccentSwatches();

function applyLiveEditorSettings() {
  for (const g of groups.values()) g.view?.applyEditorSettings(monacoOptionsFromSettings());
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
  getOpenFiles: () => (project ? allOpenPaths().map((p) => ({ name: p.split(/[\\/]/).pop(), path: p })) : []),
  listProjectFiles: async () => (rootFolder ? { root: rootFolder, ...(await window.electronAPI.listFiles(rootFolder)) } : null),
  onOpenProject: (p) => openProjectView(p),
  onOpenFile: (path) => openFile(path),
  commands: paletteCommands = [
    { label: 'New project', action: () => openProjectModal('create', null) },
    { label: 'Workspaces: Switch Workspace…', action: () => setTimeout(pickWorkspace, 0) },
    { label: 'Workspaces: New Workspace…', action: () => setTimeout(newWorkspace, 0) },
    { label: 'Share Project…', action: () => setTimeout(() => (project?.cloudEnabled ? collab.openShare(project.id) : toast('Open a cloud project first (turn on cloud sync in Edit project)', 'error')), 0) },
    { label: 'Join Project…', action: () => setTimeout(() => collab.openJoin(), 0) },
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
    { label: 'Plugins: Check current plugin', action: () => { bottomPanel.open('plugin'); pluginDev.check(); } },
    { label: 'Plugins: Show plugin output', action: () => { bottomPanel.open('plugin'); pluginDev.render(); } },
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
let tabsCheckTimer = null;
const diskTimers = new Map();
window.electronAPI.onFileExternalChange(({ path: watched, eventType, filename, git }) => {
  if (!rootFolder || !samePath(watched, rootFolder)) return;
  scm.refreshSoon();
  liveSync?.onDiskEvent({ filename, git });
  if (git) { if (liveSync) scheduleBranchCheck(); return; }
  const changed = filename ? joinPath(rootFolder, String(filename).replace(/\\/g, '/')) : null;
  if (changed && documents.has(pathKey(changed))) {
    const key = pathKey(changed);
    clearTimeout(diskTimers.get(key));
    diskTimers.set(key, setTimeout(() => syncDocFromDisk(changed), 200));
  }
  if (eventType !== 'rename') return;
  clearTimeout(externalChangeTimer);
  externalChangeTimer = setTimeout(refreshTree, 250);
  clearTimeout(tabsCheckTimer);
  tabsCheckTimer = setTimeout(closeTabsWhoseFileIsGone, 350);
});

// An open file changed on disk (another app, the terminal, git, a plugin…).
// Unchanged editor → reload in place (cursor kept). Unsaved edits → ask.
const askingReload = new Set();
async function syncDocFromDisk(filePath) {
  const key = pathKey(filePath);
  const doc = documents.get(key)?.doc;
  if (!doc || doc.collaborative) return; // cloud files sync through Yjs
  let disk;
  try { disk = await window.electronAPI.readFile(doc.filePath); } catch { return closeTabsWhoseFileIsGone(); }
  if (documents.get(key)?.doc !== doc || disk === doc.diskText) return; // our own save, or nothing new
  const model = doc.model;
  const apply = () => {
    const view = [...groups.values()].find((g) => g.view?.doc === doc)?.view;
    const selections = view ? view.editor.getSelections() : [];
    model.pushEditOperations(selections || [], [{ range: model.getFullModelRange(), text: disk }], () => selections);
    doc.diskText = disk;
  };
  if (model.getValue() === doc.diskText) { apply(); return; }
  if (askingReload.has(key)) return;
  askingReload.add(key);
  const name = doc.filePath.split(/[\\/]/).pop();
  const ok = await confirmDialog({
    title: `${name} changed on disk`,
    message: 'Another program changed this file while you have edits that aren’t saved yet. Reload it from disk (your unsaved edits are dropped), or keep your version (saving will overwrite the disk version)?',
    confirmLabel: 'Reload from disk'
  });
  askingReload.delete(key);
  if (documents.get(key)?.doc !== doc) return;
  if (ok) apply();
  else doc.diskText = disk; // keep mine: don't ask again for this change
}

// Open files that were deleted or moved elsewhere close (without saving).
async function closeTabsWhoseFileIsGone() {
  const gone = [];
  for (const p of allOpenPaths()) {
    try { await window.electronAPI.readFile(p); } catch { gone.push(p); }
  }
  for (const p of gone) closeEverywhere(p, { save: false });
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
    { label: 'New Workspace…', run: () => newWorkspace() },
    { label: 'New File', run: () => startInlineCreate('file'), enabled: hasProject },
    { label: 'New Folder', run: () => startInlineCreate('directory'), enabled: hasProject },
    '-',
    { label: 'Open Project…', kbd: 'Ctrl+K', run: openPalette },
    { label: 'Switch Workspace…', run: () => pickWorkspace(), enabled: () => workspaces.length > 1 },
    '-',
    { label: 'Share Project…', run: () => collab.openShare(project.id), enabled: () => !!project?.cloudEnabled },
    { label: 'Join Project…', run: () => collab.openJoin() },
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
    { label: 'Split Editor Right', kbd: 'Ctrl+\\', run: () => { go('editor'); splitEditor(focusedGroup, 'right'); }, enabled: hasEditor },
    { label: 'Split Editor Down', run: () => { go('editor'); splitEditor(focusedGroup, 'bottom'); }, enabled: hasEditor },
    { label: 'Close Editor Group', run: () => closeGroup(focusedGroup), enabled: () => groups.size > 1 },
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
    { label: 'Kill Terminal…', run: () => terminal.killActive(), enabled: () => terminal.hasActive(), danger: true },
    '-',
    { label: 'Run Active File', kbd: 'Ctrl+F5', run: () => runFile(), enabled: () => isRunnable(activeTabPath) }
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

collab = initCollab({
  toast,
  confirmDialog,
  escapeHtml,
  requireAuth,
  getUser: () => currentUser,
  getLocalProjects: () => everyProject,
  refreshProjects,
  openProjectById: async (id) => {
    let p = everyProject.find((x) => x.id === id);
    if (p && wsOf(p) !== currentWsId) { await switchWorkspace(wsOf(p)); p = allProjects.find((x) => x.id === id); }
    if (p) openProjectView(p);
  },
  chooseFolder: () => window.electronAPI.openDirectory(),
  createLocalProject: (o) => window.electronAPI.createProject({ ...o, workspaceId: currentWsId }),
  removeLocalProject: async (id) => {
    if (project?.id === id) closeProjectView();
    await window.electronAPI.deleteProjectLocal(id);
    await refreshProjects();
  }
});
collab.onAuth(currentUser);
document.getElementById('joinProjectBtn').addEventListener('click', () => collab.openJoin());



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
  openTutorial: () => go('tutorial'),
  editPlugin: (id) => editPlugin(id)
});

// Plugin debug engine (bottom panel → Plugin): checks + live output.
const pluginDev = initPluginDev({
  getHost: () => pluginHost,
  openFileAt: (filePath, line, column) => openFileAt(filePath, line, column),
  openPanel: () => bottomPanel.open('plugin'),
  toast,
  getProject: () => project,
  joinPath: (dir, rel) => joinPath(dir, rel)
});

// "Edit in MulTeam" on a plugin card: open the plugin's folder as its own
// project in the Plugins workspace (main/plugins.js openForEditing), open
// its entry file, check it and show the Plugin tab.
async function editPlugin(id) {
  let res;
  try { res = await window.electronAPI.plugins.edit(id); } catch (err) { toast(cleanError(err), 'error'); return; }
  await refreshProjects(); // main switched the current workspace to Plugins
  await openProjectView(res.project);
  if (project?.id !== res.project.id) return; // switch was cancelled
  try { await openFile(res.mainPath); } catch { await openFile(res.manifestPath).catch(() => {}); }
  await pluginDev.focus(id);
}

// What plugins may touch (each call is permission-checked in pluginHost.js).
const pluginHost = initPluginHost({
  space: pluginSpace,
  onLog: (id, entry) => pluginDev.addLog(id, entry),
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
  if (!e.shiftKey && e.key === 'F5' && isRunnable(activeTabPath)) return () => runFile();
  if (!e.shiftKey && e.key === '\\') return () => { go('editor'); splitEditor(focusedGroup, 'right'); };
  if (!e.shiftKey && /^[1-9]$/.test(e.key) && currentView === 'editor') {
    const target = orderedGroups()[Number(e.key) - 1];
    if (target) return () => { focusGroup(target); target.view?.editor.focus(); };
  }
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
resetLayout(); // the first (only) editor group
enhanceSelects(); // after settings have set each <select>'s initial value
go('dashboard');
refreshProjects();
