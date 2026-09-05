import { watchAuthState, signOut, createCloudProject, deleteCloudProject } from './firebase.js';
import { requireAuth } from './authModal.js';
import {
  folderIconSvg, chevronSvg, plusIconSvg, logoutIconSvg,
  editIconSvg, duplicateIconSvg, trashIconSvg, cloudIconSvg, searchIconSvg
} from './icons.js';

const listEl = document.getElementById('project-list');
const emptyStateEl = document.getElementById('empty-state');
const searchInput = document.getElementById('project-search');
const newProjectBtn = document.getElementById('new-project-btn');
const signOutBtn = document.getElementById('sign-out-btn');
const topbarSignedIn = document.getElementById('topbar-signed-in');
const topbarSignedOut = document.getElementById('topbar-signed-out');
const userLabel = document.getElementById('user-label');

document.getElementById('new-project-icon').innerHTML = plusIconSvg();
document.getElementById('signout-icon').innerHTML = logoutIconSvg();
document.getElementById('search-icon').innerHTML = searchIconSvg();

let currentUser = null;
let allProjects = [];

watchAuthState((user) => {
  currentUser = user;
  topbarSignedIn.hidden = !user;
  topbarSignedOut.hidden = !!user;
  if (user) userLabel.textContent = user.displayName || user.email;
});

document.getElementById('topbar-signin-btn').addEventListener('click', () => {
  window.location.href = 'login.html';
});
signOutBtn.addEventListener('click', () => signOut());

async function refreshProjects() {
  allProjects = await window.electronAPI.listProjects();
  renderProjects();
}

const PROJECT_COLORS = ['c-sky', 'c-pink-purple', 'c-cream', 'c-pink', 'c-lavender'];
function colorClassForProject(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return PROJECT_COLORS[hash % PROJECT_COLORS.length];
}

function renderProjects() {
  const term = searchInput.value.trim().toLowerCase();
  const projects = term ? allProjects.filter((p) => p.name.toLowerCase().includes(term)) : allProjects;

  listEl.innerHTML = '';
  emptyStateEl.hidden = allProjects.length > 0;
  listEl.hidden = allProjects.length === 0;

  for (const project of projects) {
    const li = document.createElement('li');
    li.className = 'project-item';

    const icon = document.createElement('span');
    icon.className = `project-icon ${colorClassForProject(project.id)}`;
    icon.innerHTML = folderIconSvg(false);
    if (project.cloudEnabled) {
      const badge = document.createElement('span');
      badge.className = 'cloud-badge';
      badge.innerHTML = cloudIconSvg();
      icon.appendChild(badge);
    }

    const info = document.createElement('div');
    info.className = 'project-info';
    const name = document.createElement('span');
    name.className = 'project-name';
    name.textContent = project.name;
    info.appendChild(name);

    const actions = document.createElement('div');
    actions.className = 'project-actions';

    const editBtn = iconButton(editIconSvg(), 'Edit', (e) => { e.stopPropagation(); openProjectModal('edit', project); });
    const dupBtn = iconButton(duplicateIconSvg(), 'Duplicate', async (e) => {
      e.stopPropagation();
      dupBtn.disabled = true;
      try { await window.electronAPI.duplicateProject(project.id); await refreshProjects(); }
      finally { dupBtn.disabled = false; }
    });
    const delBtn = iconButton(trashIconSvg(), 'Delete', (e) => { e.stopPropagation(); openDeleteModal(project); });

    actions.append(editBtn, dupBtn, delBtn);

    const arrow = document.createElement('span');
    arrow.className = 'project-open-arrow';
    arrow.innerHTML = chevronSvg();

    li.append(icon, info, actions, arrow);
    li.addEventListener('click', () => openProject(project));
    listEl.appendChild(li);
  }
}

function iconButton(svg, label, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'row-icon-btn';
  btn.title = label;
  btn.innerHTML = svg;
  btn.addEventListener('click', onClick);
  return btn;
}

searchInput.addEventListener('input', renderProjects);

function openProject(project) {
  window.electronAPI.updateProject(project.id, { lastOpenedAt: Date.now() });
  window.location.href = `index.html?projectId=${encodeURIComponent(project.id)}`;
}

// --- Create / edit project modal ---

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

function openProjectModal(mode, project) {
  modalMode = mode;
  editingProject = project || null;
  projectError.textContent = '';

  if (mode === 'edit') {
    projectTitle.textContent = 'Edit project';
    projectSubmit.textContent = 'Save';
    nameInput.value = project.name;
    chosenFolder = project.folderPath;
    folderPathEl.textContent = project.folderPath;
    cloudToggle.checked = project.cloudEnabled;
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

newProjectBtn.addEventListener('click', () => openProjectModal('create', null));
document.getElementById('project-cancel').addEventListener('click', () => { projectModal.hidden = true; });
projectModal.addEventListener('click', (e) => { if (e.target === projectModal) projectModal.hidden = true; });

folderBtn.addEventListener('click', async () => {
  const folder = await window.electronAPI.openDirectory();
  if (folder) {
    chosenFolder = folder;
    folderPathEl.textContent = folder;
  }
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
      const project = await window.electronAPI.createProject({ name, folderPath: chosenFolder, cloudEnabled });
      if (cloudEnabled) await enableCloud(project.id, name);
      projectModal.hidden = true;
      window.location.href = `index.html?projectId=${encodeURIComponent(project.id)}`;
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
      try {
        await createCloudProject(projectId, name, currentUser.uid);
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  });
}

// --- Delete modal ---

const deleteModal = document.getElementById('delete-modal');
const deleteChoices = document.getElementById('delete-choices');
const deleteModalSub = document.getElementById('delete-modal-sub');
const deleteError = document.getElementById('delete-error');
const deleteConfirmBtn = document.getElementById('delete-confirm');

let deletingProject = null;

function openDeleteModal(project) {
  deletingProject = project;
  deleteError.textContent = '';
  deleteChoices.hidden = !project.cloudEnabled;
  deleteModalSub.hidden = project.cloudEnabled;
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

refreshProjects();
