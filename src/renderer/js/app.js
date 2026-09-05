import { watchAuthState, upsertDocumentMeta } from './firebase.js';
import { requireAuth } from './authModal.js';
import { CollaborativeWorkspace } from './editor.js';
import { PresenceBar } from './presence.js';
import {
  fileIconSvg, folderIconSvg, chevronSvg, colorForExtension,
  newFileIconSvg, newFolderIconSvg, saveIconSvg, trashIconSvg,
  duplicateIconSvg, renameIconSvg, copyIconSvg, backArrowIconSvg, chevronDownIconSvg
} from './icons.js';

const params = new URLSearchParams(window.location.search);
const projectId = params.get('projectId');

const fileTreeEl = document.getElementById('file-tree');
const tabBarEl = document.getElementById('tab-bar');
const editorContainerEl = document.getElementById('monaco-container');
const presenceListEl = document.getElementById('presence-list');
const statusDotEl = document.getElementById('status-dot');
const lineCountEl = document.getElementById('line-count');
const charCountEl = document.getElementById('char-count');
const contextMenuEl = document.getElementById('context-menu');
const projectNameLabel = document.getElementById('project-name-label');

let currentUser = null;
let project = null; // { id, name, folderPath, cloudEnabled }
let rootFolder = null;
let activeWorkspace = null;
let activePresence = null;
let activeTabPath = null;
const openTabs = []; // [{ path }]

if (!projectId) window.location.href = 'dashboard.html';

watchAuthState((user) => { currentUser = user; });

// Static icons
document.getElementById('back-icon').innerHTML = backArrowIconSvg();
document.getElementById('file-menu-chevron').innerHTML = chevronDownIconSvg();
document.getElementById('menu-icon-new-file').innerHTML = newFileIconSvg();
document.getElementById('menu-icon-new-folder').innerHTML = newFolderIconSvg();
document.getElementById('menu-icon-save').innerHTML = saveIconSvg();
document.getElementById('menu-icon-save-as').innerHTML = saveIconSvg();
document.getElementById('menu-icon-rename').innerHTML = renameIconSvg();
document.getElementById('menu-icon-duplicate').innerHTML = duplicateIconSvg();
document.getElementById('menu-icon-delete').innerHTML = trashIconSvg();
document.getElementById('new-file-btn').innerHTML = newFileIconSvg();
document.getElementById('new-folder-btn').innerHTML = newFolderIconSvg();

document.getElementById('back-to-dashboard-btn').addEventListener('click', () => {
  window.location.href = 'dashboard.html';
});

async function init() {
  project = await window.electronAPI.getProject(projectId);
  if (!project) { window.location.href = 'dashboard.html'; return; }

  rootFolder = project.folderPath;
  projectNameLabel.textContent = project.name;
  loadFileTree(rootFolder, fileTreeEl);
}
init();

window.addEventListener('online', () => statusDotEl.classList.replace('offline', 'online'));
window.addEventListener('offline', () => statusDotEl.classList.replace('online', 'offline'));
statusDotEl.classList.add(navigator.onLine ? 'online' : 'offline');

function joinPath(...parts) {
  return parts.map((p) => p.replace(/[\\/]+$/, '')).join('/');
}

function parentDir(fullPath) {
  const idx = Math.max(fullPath.lastIndexOf('/'), fullPath.lastIndexOf('\\'));
  return idx === -1 ? '' : fullPath.slice(0, idx);
}

// Long counts would blow out the footer's width, so anything over 4 digits
// gets truncated with an ellipsis rather than pushed wider (e.g. 12345 -> "1234…").
function formatCount(n) {
  const str = String(n);
  return str.length > 4 ? `${str.slice(0, 4)}…` : str;
}

function updateFileMeta() {
  if (!activeWorkspace) {
    lineCountEl.textContent = '—';
    charCountEl.textContent = '—';
    return;
  }
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

  if (!window.electronAPI) {
    container.textContent = 'electronAPI unavailable — the preload script failed to load. Check the DevTools console.';
    return;
  }

  let nodes;
  try {
    nodes = await window.electronAPI.readDir(dirPath);
  } catch (err) {
    container.textContent = `Failed to read folder: ${err.message}`;
    return;
  }

  container.innerHTML = '';

  if (nodes.length === 0) {
    container.textContent = 'This folder has no visible files.';
    return;
  }

  for (const node of nodes) {
    const el = document.createElement('div');
    el.className = `file-tree-node ${node.type}`;
    el.dataset.path = node.path;
    el.dataset.type = node.type;
    el.dataset.name = node.name;

    const chevronEl = document.createElement('span');
    chevronEl.className = node.type === 'directory' ? 'node-chevron' : 'node-chevron-spacer';
    if (node.type === 'directory') chevronEl.innerHTML = chevronSvg();

    const iconEl = document.createElement('span');
    iconEl.className = 'node-icon';
    iconEl.innerHTML = node.type === 'directory'
      ? folderIconSvg(false)
      : fileIconSvg(colorForExtension(node.name.split('.').pop()));

    const labelEl = document.createElement('span');
    labelEl.className = 'node-label';
    labelEl.textContent = node.name;

    el.append(chevronEl, iconEl, labelEl);

    if (node.type === 'directory') {
      el.addEventListener('click', () => toggleDirectory(node, el));
    } else {
      el.addEventListener('click', () => openFile(node.path));
    }

    container.appendChild(el);
  }
}

async function toggleDirectory(node, el) {
  const existing = el.nextElementSibling;
  if (existing && existing.dataset.parentPath === node.path) {
    existing.remove();
    el.classList.remove('expanded');
    return;
  }

  el.classList.add('expanded');
  const childContainer = document.createElement('div');
  childContainer.style.paddingLeft = '14px';
  childContainer.dataset.parentPath = node.path;
  el.insertAdjacentElement('afterend', childContainer);
  await loadFileTree(node.path, childContainer);
}

function sanitizeDocId(relativePath) {
  return `${projectId}__${relativePath}`.replace(/[.#$\[\]/\\]/g, '_');
}

async function openFile(filePath) {
  if (!openTabs.some((t) => t.path === filePath)) {
    openTabs.push({ path: filePath });
  }
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
    closeEl.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(tab.path);
    });

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
  if (activePresence) activePresence.destroy();
  if (activeWorkspace) activeWorkspace.destroy();
  activePresence = null;
  activeWorkspace = null;
  activeTabPath = null;
  updateFileMeta();
}

function activateTab(filePath) {
  if (activeTabPath === filePath) return;

  if (project.cloudEnabled) {
    requireAuth(() => activateTabInner(filePath));
  } else {
    activateTabInner(filePath);
  }
}

// NOTE: only one file is "live" (bound to Yjs/Monaco) at a time. Keeping every
// open tab's CRDT doc + awareness connection alive simultaneously is the
// natural next step but adds real memory/connection cost — deferred until
// there's a reason to pay it.
async function activateTabInner(filePath) {
  teardownActiveWorkspace();
  activeTabPath = filePath;
  renderTabs();
  renderLoader(editorContainerEl);

  let content;
  try {
    content = await window.electronAPI.readFile(filePath);
  } catch (err) {
    editorContainerEl.textContent = `Failed to open file: ${err.message}`;
    return;
  }

  if (activeTabPath !== filePath) return; // user switched tabs while this was loading

  const relativePath = filePath.slice(rootFolder.length).replace(/^[\\/]/, '');
  const docId = sanitizeDocId(relativePath);

  editorContainerEl.innerHTML = '';
  activeWorkspace = new CollaborativeWorkspace(editorContainerEl, {
    docId,
    filePath,
    currentUser,
    collaborative: project.cloudEnabled
  }).initialize(content);

  if (project.cloudEnabled) {
    activePresence = new PresenceBar(presenceListEl, activeWorkspace.getAwareness(), currentUser);
    upsertDocumentMeta(docId, {
      projectId,
      ownerId: currentUser.uid,
      path: relativePath,
      language: activeWorkspace.editor.getModel().getLanguageId(),
      userId: currentUser.uid
    });
  }

  updateFileMeta();

  let saveTimer = null;
  activeWorkspace.editor.onDidChangeModelContent(() => {
    updateFileMeta();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveActiveFile(filePath), 800);
  });
}

function saveActiveFile(filePath) {
  if (!activeWorkspace || activeTabPath !== filePath) return;
  window.electronAPI.writeFile(filePath, activeWorkspace.getValue());
}

async function saveFileAs(filePath) {
  const content = filePath === activeTabPath && activeWorkspace
    ? activeWorkspace.getValue()
    : await window.electronAPI.readFile(filePath);

  const target = await window.electronAPI.showSaveDialog(filePath);
  if (!target) return;

  await window.electronAPI.writeFile(target, content);
  if (target.startsWith(rootFolder)) loadFileTree(rootFolder, fileTreeEl);
}

async function duplicateNode(node) {
  try {
    await window.electronAPI.duplicateEntry(node.path);
    loadFileTree(rootFolder, fileTreeEl);
  } catch (err) {
    alert(`Failed to duplicate: ${err.message}`);
  }
}

function copyNodePath(node) {
  navigator.clipboard.writeText(node.path).catch(() => {});
}

// Deleting is intentionally a plain confirm() rather than a custom modal —
// window.prompt() is unsupported in Electron's renderer (throws outright),
// but alert()/confirm() work fine, so this is the simplest honest option.
async function deleteNode(node) {
  if (!window.confirm(`Delete "${node.name}"? This can't be undone.`)) return;

  try {
    await window.electronAPI.deleteEntry(node.path);
    if (openTabs.some((t) => t.path === node.path)) closeTab(node.path);
    // Reloads the whole tree from root — simplest correct option, at the
    // cost of collapsing any other expanded folders. Fine for now.
    loadFileTree(rootFolder, fileTreeEl);
  } catch (err) {
    alert(`Failed to delete: ${err.message}`);
  }
}

// --- Create new file/folder (sidebar toolbar + File menu) ---

function startInlineCreate(type) {
  const existing = fileTreeEl.querySelector('.inline-input-row');
  if (existing) existing.remove();

  if (fileTreeEl.textContent === 'This folder has no visible files.') fileTreeEl.textContent = '';

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
  fileTreeEl.insertBefore(row, fileTreeEl.firstChild);
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
      loadFileTree(rootFolder, fileTreeEl);
    } catch (err) {
      alert(`Failed to create ${type}: ${err.message}`);
    }
  });

  input.addEventListener('blur', cleanup);
}

document.getElementById('new-file-btn').addEventListener('click', () => startInlineCreate('file'));
document.getElementById('new-folder-btn').addEventListener('click', () => startInlineCreate('directory'));

// --- Rename modal (shared by the context menu and the File menu) ---

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
    loadFileTree(rootFolder, fileTreeEl);
  } catch (err) {
    renameError.textContent = err.message;
  }
});

// --- Right-click context menu on file-tree entries ---

fileTreeEl.addEventListener('contextmenu', (e) => {
  const el = e.target.closest('.file-tree-node');
  if (!el || !el.dataset.path) return;
  e.preventDefault();
  showContextMenu(e.clientX, e.clientY, { path: el.dataset.path, type: el.dataset.type, name: el.dataset.name });
});

function showContextMenu(x, y, node) {
  const items = [];

  if (node.type === 'file') {
    if (node.path === activeTabPath) {
      items.push({ label: 'Save', icon: saveIconSvg(), onClick: () => saveActiveFile(node.path) });
    }
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

document.addEventListener('click', (e) => {
  if (!contextMenuEl.hidden && !contextMenuEl.contains(e.target)) hideContextMenu();
});
document.addEventListener('scroll', hideContextMenu, true);

// --- Top "File" menu — mirrors the context menu/toolbar, acting on the
// currently active tab for save/rename/duplicate/delete ---

const fileMenuBtn = document.getElementById('file-menu-btn');
const fileMenuDropdown = document.getElementById('file-menu-dropdown');

fileMenuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  fileMenuDropdown.hidden = !fileMenuDropdown.hidden;
});
document.addEventListener('click', () => { fileMenuDropdown.hidden = true; });

fileMenuDropdown.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;

  if (action === 'new-file') return startInlineCreate('file');
  if (action === 'new-folder') return startInlineCreate('directory');

  if (!activeTabPath) return; // remaining actions need an open file
  const node = { path: activeTabPath, type: 'file', name: activeTabPath.split(/[\\/]/).pop() };

  if (action === 'save') saveActiveFile(activeTabPath);
  if (action === 'save-as') saveFileAs(activeTabPath);
  if (action === 'rename') openRenameModal(node);
  if (action === 'duplicate') duplicateNode(node);
  if (action === 'delete') deleteNode(node);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideContextMenu();
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    if (activeTabPath) saveActiveFile(activeTabPath);
  }
});
