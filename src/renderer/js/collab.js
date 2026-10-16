// Collaboration UI (stage 1): Share dialog (members, roles, email invites,
// invite links, join requests), Join dialog (code / multeam:// link),
// invites in the notification bell, and "Shared with you" on the Dashboard.
// Data + rules live in firebase.js / firestore.rules / functions/index.js.
import {
  cloudCalls, watchCloudProject, watchMyCloudProjects, inviteByEmail, watchProjectInvites, revokeInvite,
  createInviteLink, watchInviteLinks, revokeInviteLink, watchJoinRequests, watchMyInvites, formatCode,
  resendVerification, refreshUser, forgetLiveMembership, listMyPastInvites, getCloudProject,
  watchTeam, watchMyTeams
} from './firebase.js';
import { enhanceSelects } from './select.js';

const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', editor: 'Editor', viewer: 'Viewer' };
const ROLE_HINT = { admin: 'manages members and projects', editor: 'can edit code', viewer: 'can watch and follow, not edit' };
const linkFor = (code) => `multeam://join/${formatCode(code)}`;
const codeFrom = (text) => {
  const m = String(text || '').toUpperCase().match(/([A-Z0-9]{4})-?([A-Z0-9]{4})\s*$/);
  return m ? m[1] + m[2] : null;
};
const initialOf = (s) => (String(s || '?').trim()[0] || '?').toUpperCase();

export function initCollab({ toast, confirmDialog, escapeHtml, getUser, requireAuth, getLocalProjects, refreshProjects, openProjectById, chooseFolder, createLocalProject, removeLocalProject, github, onTeamsChanged = () => {}, onJoinedTeam = () => {}, onLeftTeam = () => {}, workspaceForTeam = () => null }) {
  const esc = escapeHtml;
  const cleanErr = (err) => String(err?.message || err).replace(/^(FirebaseError: )?/, '');

  // ---------------------------------------------------------------- markup
  document.body.insertAdjacentHTML('beforeend', `
    <div class="modal-overlay" id="share-modal" hidden>
      <div class="modal-card share" role="dialog" aria-labelledby="share-title">
        <div class="share__head">
          <div>
            <h2 id="share-title">Share</h2>
            <p class="modal-sub" id="share-sub"></p>
          </div>
          <button type="button" class="ibtn" id="share-close" title="Close" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M7 7l10 10M17 7 7 17"/></svg></button>
        </div>
        <div class="share__body scroll">
          <section class="share__sec" data-owner-only>
            <h3>Invite people</h3>
            <form class="share__row" id="share-invite-form">
              <div class="share__combo">
                <input type="text" inputmode="email" class="share__input" id="share-email" placeholder="Name or email" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="false" aria-controls="share-suggest" aria-autocomplete="list" required />
                <div class="cselect__menu share__suggest" id="share-suggest" role="listbox" hidden></div>
              </div>
              <select class="pill" id="share-invite-role"><option value="editor">Editor</option><option value="viewer">Viewer</option></select>
              <button type="submit" class="primary sm" id="share-invite-btn">Invite</button>
            </form>
            <p class="field-hint">Search MulTeam users by name, or type an exact email. Emails are never shown in results. Invites appear in their MulTeam notifications.</p>
            <div class="share__list" id="share-invites"></div>
          </section>

          <section class="share__sec">
            <h3>Members <span class="muted" id="share-count"></span></h3>
            <div class="share__list" id="share-members"></div>
          </section>

          <section class="share__sec" data-owner-only id="share-requests-sec" hidden>
            <h3>Join requests</h3>
            <div class="share__list" id="share-requests"></div>
          </section>

          <section class="share__sec" data-owner-only>
            <h3>Invite links</h3>
            <div class="share__row">
              <select class="pill" id="share-link-role"><option value="editor">Joins as Editor</option><option value="viewer">Joins as Viewer</option></select>
              <select class="pill" id="share-link-expiry"><option value="1">Expires in 1 day</option><option value="7" selected>Expires in 7 days</option><option value="30">Expires in 30 days</option><option value="0">Never expires</option></select>
              <label class="toggle-field sm"><input type="checkbox" id="share-link-approval" /><span class="toggle-track"><span class="toggle-thumb"></span></span><span class="toggle-label">Needs my approval</span></label>
              <button type="button" class="secondary sm" id="share-link-create">Create link</button>
            </div>
            <div class="share__list" id="share-links"></div>
          </section>
        </div>
        <div class="modal-actions">
          <button type="button" class="secondary danger-text" id="share-leave" hidden>Leave project</button>
          <span class="spacer"></span>
          <button type="button" class="primary" id="share-done">Done</button>
        </div>
      </div>
    </div>

    <div class="modal-overlay" id="clone-modal" hidden>
      <div class="modal-card">
        <h2 id="clone-title">Cloning…</h2>
        <p class="modal-sub" id="clone-repo"></p>
        <p class="clone__line"><span class="btn-spinner" aria-hidden="true"></span><span id="clone-line">Starting…</span></p>
      </div>
    </div>

    <div class="modal-overlay" id="join-modal" hidden>
      <form class="modal-card" id="join-form">
        <h2>Join a project</h2>
        <p class="modal-sub">Paste the invite code or link someone sent you.</p>
        <div class="field">
          <label for="join-code">Invite code or link</label>
          <input id="join-code" type="text" placeholder="AB12-CD34 or multeam://join/AB12-CD34" autocomplete="off" required />
        </div>
        <div class="join__preview" id="join-preview" hidden></div>
        <p class="error-text" id="join-error"></p>
        <div class="modal-actions">
          <button type="button" class="secondary" id="join-cancel">Cancel</button>
          <button type="submit" class="primary" id="join-submit">Continue</button>
        </div>
      </form>
    </div>`);

  const $ = (id) => document.getElementById(id);
  enhanceSelects($('share-modal'));

  // ---------------------------------------------------------------- share
  // share.project is the open target: a project, or a team workspace (kind 'team')
  const share = { project: null, unsubs: [], projectId: null, kind: 'project' };
  const isTeam = () => share.kind === 'team';
  const tgt = (extra = {}) => (isTeam() ? { teamId: share.projectId, ...extra } : { projectId: share.projectId, ...extra });
  const myRoleIn = (p) => p?.members?.[getUser()?.uid]?.role || null;
  const canManage = (p) => (isTeam() ? ['owner', 'admin'].includes(myRoleIn(p)) : myRoleIn(p) === 'owner');
  // roles this person may hand out here (only a workspace owner grants Admin)
  const grantable = (p) => (isTeam() ? (myRoleIn(p) === 'owner' ? ['admin', 'editor', 'viewer'] : ['editor', 'viewer']) : ['editor', 'viewer']);
  const roleOptions = (roles, selected, prefix = '') => roles.map((r) => `<option value="${r}" ${r === selected ? 'selected' : ''}>${prefix}${ROLE_LABEL[r]}</option>`).join('');
  const shareModal = $('share-modal');

  function closeShare() {
    share.unsubs.forEach((u) => u());
    share.unsubs = [];
    share.project = null;
    shareModal.hidden = true;
  }
  $('share-close').addEventListener('click', closeShare);
  $('share-done').addEventListener('click', closeShare);
  shareModal.addEventListener('click', (e) => { if (e.target === shareModal) closeShare(); });

  function openShare(projectId, kind = 'project') {
    requireAuth(() => {
      const me = getUser();
      closeShare();
      share.projectId = projectId;
      share.kind = kind;
      shareModal.hidden = false;
      $('share-title').textContent = 'Share';
      $('share-sub').textContent = 'Loading…';
      // nothing from the previously shared project may linger
      for (const id of ['share-members', 'share-invites', 'share-links', 'share-requests']) $(id).innerHTML = '';
      $('share-requests-sec').hidden = true;
      $('share-email').value = '';
      share.invites = [];
      const watch = kind === 'team' ? watchTeam : watchCloudProject;
      share.unsubs.push(watch(projectId, (p) => {
        if (!p) {
          $('share-sub').textContent = kind === 'team' ? "This workspace isn't shared any more, or you're no longer in it." : "This project isn't in the cloud, or you no longer have access to it.";
          shareModal.querySelectorAll('[data-owner-only]').forEach((el) => { el.hidden = true; });
          $('share-members').innerHTML = '';
          return;
        }
        const firstLoad = !share.project;
        p.kind = kind;
        share.project = p;
        const myRole = p.members?.[me.uid]?.role;
        const owner = myRole === 'owner';
        const manage = canManage(p);
        const noun = kind === 'team' ? 'workspace' : 'project';
        $('share-title').textContent = kind === 'team' ? `Share workspace “${p.name}”` : `Share “${p.name}”`;
        const repo = p.repoUrl ? ` · Repository: ${p.repoUrl.replace(/^https:\/\//, '')}` : '';
        const viaTeam = kind === 'project' && p.teamId ? ' · Also shared through its team workspace' : '';
        const youAre = owner ? `You own this ${noun}.` : myRole ? `You're ${myRole === 'admin' ? 'an admin' : myRole === 'editor' ? 'an editor' : 'a viewer'} here.` : 'You have access through its team workspace.';
        $('share-sub').textContent = youAre + (kind === 'team' ? ' Everyone here gets every project in the workspace.' : '') + repo + viaTeam;
        shareModal.querySelectorAll('[data-owner-only]').forEach((el) => { if (el.id !== 'share-requests-sec') el.hidden = !manage; });
        $('share-leave').hidden = owner || !myRole;
        $('share-leave').textContent = kind === 'team' ? 'Leave workspace' : 'Leave project';
        renderMembers(p, manage, me.uid);
        if (firstLoad) {
          // role pickers for inviting: only what this person may grant
          const roles = grantable(p);
          $('share-invite-role').innerHTML = roleOptions(roles, 'editor');
          $('share-link-role').innerHTML = roleOptions(roles, 'editor', 'Joins as ');
        }
        if (firstLoad && manage) {
          listMyPastInvites(me.uid).then((list) => { pastInvites = list; }).catch(() => {});
          const target = { kind, id: projectId };
          share.unsubs.push(watchProjectInvites(target, me.uid, renderInvites));
          share.unsubs.push(watchInviteLinks(target, me.uid, renderLinks));
          share.unsubs.push(watchJoinRequests(target, renderRequests));
        }
      }));
    });
  }

  function renderMembers(p, manage, myUid) {
    const roles = grantable(p);
    const list = Object.entries(p.members || {}).sort(([, a], [, b]) => (b.role === 'owner') - (a.role === 'owner') || String(a.name).localeCompare(String(b.name)));
    $('share-count').textContent = `(${list.length})`;
    $('share-members').innerHTML = list.map(([uid, m]) => `
      <div class="share__item" data-uid="${esc(uid)}">
        <span class="share__av">${m.photo ? `<img src="${esc(m.photo)}" alt="" referrerpolicy="no-referrer" />` : esc(initialOf(m.name))}</span>
        <span class="share__who"><b>${esc(m.name || 'Member')}${uid === myUid ? ' (you)' : ''}</b><small>${esc(m.email || '')}</small></span>
        ${manage && m.role !== 'owner' && uid !== myUid && roles.includes(m.role)
          ? `<select class="pill sm" data-role-for="${esc(uid)}">${roleOptions(roles, m.role)}</select>
             <button type="button" class="ibtn" data-remove="${esc(uid)}" title="Remove" aria-label="Remove"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M7 7l10 10M17 7 7 17"/></svg></button>`
          : `<span class="share__role">${ROLE_LABEL[m.role] || m.role}</span>`}
      </div>`).join('');
    enhanceSelects($('share-members'));
  }

  $('share-members').addEventListener('change', async (e) => {
    const sel = e.target.closest('[data-role-for]');
    if (!sel || !share.project) return;
    const uid = sel.dataset.roleFor;
    const name = share.project.members?.[uid]?.name || 'them';
    try {
      await cloudCalls.setMemberRole(tgt({ uid, role: sel.value }));
      toast(`${name} is now ${sel.value === 'admin' ? 'an Admin' : sel.value === 'editor' ? 'an Editor' : 'a Viewer'}`);
    } catch (err) { toast(cleanErr(err), 'error'); sel.value = share.project.members?.[uid]?.role || 'viewer'; }
  });

  $('share-members').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-remove]');
    if (!btn || !share.project) return;
    const uid = btn.dataset.remove;
    const name = share.project.members?.[uid]?.name || 'this member';
    const ok = await confirmDialog({ title: `Remove ${name}?`, message: isTeam() ? `${name} loses access to "${share.project.name}" and every project in it right away. Their local copies of the files aren't touched.` : `${name} loses access to "${share.project.name}" right away. Their local copy of the files isn't touched.`, confirmLabel: 'Remove', danger: true });
    if (!ok) return;
    try { await cloudCalls.removeMember(tgt({ uid })); toast(`Removed ${name}`); } catch (err) { toast(cleanErr(err), 'error'); }
  });

  $('share-leave').addEventListener('click', async () => {
    const p = share.project;
    if (!p) return;
    const team = isTeam();
    const ok = await confirmDialog({
      title: `Leave "${p.name}"?`,
      message: team
        ? "You'll lose access to the workspace and its projects. Your local folders and files stay on this computer; MulTeam just stops listing them."
        : "You'll lose access to the shared project. Your local folder and files stay on this computer; MulTeam just stops listing the project.",
      confirmLabel: team ? 'Leave workspace' : 'Leave project',
      danger: true
    });
    if (!ok) return;
    try {
      await cloudCalls.removeMember(tgt());
      if (team) await onLeftTeam(p.id);
      else {
        forgetLiveMembership(p.id, getUser().uid);
        await removeLocalProject(p.id);
      }
      closeShare();
      toast(`You left ${p.name}`);
    } catch (err) { toast(cleanErr(err), 'error'); }
  });

  // ---- email field: search people you already work with ----
  // Contacts = members of your other cloud projects + people you invited
  // before. (There's no search over all MulTeam users — that would expose
  // everyone's email.)
  let pastInvites = [];
  let suggestions = [];
  let cursor = -1;
  let picked = null;     // { uid, name } when a MulTeam user was chosen from search
  let remote = [];       // searchUsers results for the current query
  let remoteQ = '';
  let searchTimer = null;
  let searchSeq = 0;
  const emailEl = $('share-email');
  const suggestEl = $('share-suggest');

  function contacts() {
    const me = getUser();
    const inProject = new Set(Object.values(share.project?.members || {}).map((m) => m.email));
    for (const i of share.invites || []) if (i.email) inProject.add(i.email);
    const byEmail = new Map();
    for (const p of myCloud) {
      for (const [uid, m] of Object.entries(p.members || {})) {
        if (uid === me?.uid || !m.email || inProject.has(m.email)) continue;
        const c = byEmail.get(m.email) || { email: m.email, name: m.name || '', photo: m.photo || '', projects: [] };
        if (!c.projects.includes(p.name)) c.projects.push(p.name);
        byEmail.set(m.email, c);
      }
    }
    for (const i of pastInvites) {
      if (!i.email || inProject.has(i.email) || byEmail.has(i.email)) continue;
      byEmail.set(i.email, { email: i.email, name: '', photo: '', projects: [], invited: true });
    }
    return [...byEmail.values()];
  }

  // Server search (all MulTeam users by name, or exact email), debounced.
  function searchRemote() {
    clearTimeout(searchTimer);
    const q = emailEl.value.trim().toLowerCase();
    if (q.length < 2) { remote = []; remoteQ = q; return; }
    if (q === remoteQ) return;
    searchTimer = setTimeout(async () => {
      const seq = ++searchSeq;
      try {
        const res = await cloudCalls.searchUsers(tgt({ q }));
        if (seq !== searchSeq) return;
        remote = res.users || [];
        remoteQ = q;
        if (document.activeElement === emailEl) renderSuggest({ keepCursor: true });
      } catch { /* offline / functions not deployed: contacts still work */ }
    }, 250);
  }

  function renderSuggest({ keepCursor = false } = {}) {
    const q = emailEl.value.trim().toLowerCase();
    const local = contacts()
      .filter((c) => !q || c.email.includes(q) || c.name.toLowerCase().includes(q))
      .sort((a, b) => b.projects.length - a.projects.length || a.email.localeCompare(b.email));
    const localNames = new Set(local.map((c) => `${c.name}|${c.photo}`));
    const fromSearch = (q && remoteQ === q ? remote : [])
      .filter((u) => !localNames.has(`${u.name}|${u.photo}`))
      .map((u) => ({ uid: u.uid, name: u.name || q, photo: u.photo, member: u.member, exactEmail: u.exactEmail, projects: [] }));
    const prevCursor = cursor;
    suggestions = [...local, ...fromSearch].slice(0, 10);
    cursor = keepCursor && prevCursor >= 0 ? Math.min(prevCursor, suggestions.length - 1) : (suggestions.length && q ? 0 : -1);
    cursor = suggestions.length && q ? 0 : -1;
    if (!suggestions.length || document.activeElement !== emailEl) { closeSuggest(); return; }
    const detail = (c) => {
      if (c.uid) return c.member ? `already ${c.member === 'owner' ? 'the owner' : `a${c.member === 'editor' ? 'n editor' : ' viewer'}`} here` : c.exactEmail ? 'MulTeam user with this email' : 'MulTeam user';
      return `${c.name ? `${esc(c.email)} · ` : ''}${c.projects.length ? `in ${esc(c.projects.slice(0, 2).join(', '))}${c.projects.length > 2 ? ` +${c.projects.length - 2}` : ''}` : 'invited before'}`;
    };
    suggestEl.innerHTML = suggestions.map((c, i) => `
      <button type="button" class="cselect__opt share__opt ${i === cursor ? 'is-cursor' : ''}" role="option" data-i="${i}" ${c.member ? 'disabled' : ''}>
        <span class="share__av">${c.photo ? `<img src="${esc(c.photo)}" alt="" referrerpolicy="no-referrer" />` : esc(initialOf(c.name || c.email))}</span>
        <span class="share__who"><b>${esc(c.name || c.email)}</b><small>${detail(c)}</small></span>
      </button>`).join('');
    suggestEl.hidden = false;
    emailEl.setAttribute('aria-expanded', 'true');
  }
  function closeSuggest() { suggestEl.hidden = true; emailEl.setAttribute('aria-expanded', 'false'); cursor = -1; }
  function moveCursor(d) {
    if (suggestEl.hidden || !suggestions.length) return;
    cursor = (cursor + d + suggestions.length) % suggestions.length;
    suggestEl.querySelectorAll('.share__opt').forEach((b, i) => b.classList.toggle('is-cursor', i === cursor));
    suggestEl.querySelector('.is-cursor')?.scrollIntoView({ block: 'nearest' });
  }
  function pick(i) {
    const c = suggestions[i];
    if (!c || c.member) return;
    // a user from search is invited by account (no email needed or shown)
    picked = c.uid ? { uid: c.uid, name: c.name } : null;
    emailEl.value = c.uid ? c.name : c.email;
    closeSuggest();
    emailEl.focus();
  }
  emailEl.addEventListener('input', () => { picked = null; renderSuggest(); searchRemote(); });
  emailEl.addEventListener('focus', () => renderSuggest());
  emailEl.addEventListener('blur', () => setTimeout(closeSuggest, 120));
  emailEl.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (suggestEl.hidden) renderSuggest(); else moveCursor(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveCursor(-1); }
    else if (e.key === 'Enter' && !suggestEl.hidden && cursor >= 0 && !picked && suggestions[cursor]?.email !== emailEl.value.trim().toLowerCase()) { e.preventDefault(); pick(cursor); }
    else if (e.key === 'Escape' && !suggestEl.hidden) { e.preventDefault(); e.stopPropagation(); closeSuggest(); }
  });
  suggestEl.addEventListener('mousedown', (e) => {
    const b = e.target.closest('[data-i]');
    if (b) { e.preventDefault(); pick(Number(b.dataset.i)); }
  });

  // email invites
  $('share-invite-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const p = share.project;
    if (!p) return;
    closeSuggest();
    const btn = $('share-invite-btn');
    btn.disabled = true;
    const role = $('share-invite-role').value;
    try {
      if (picked && emailEl.value === picked.name) {
        await cloudCalls.inviteUser(tgt({ uid: picked.uid, role }));
        toast(`Invite sent to ${picked.name}`);
      } else {
        const typed = emailEl.value.trim();
        if (!typed.includes('@')) throw new Error('Pick someone from the list, or type their full email address.');
        await inviteByEmail(p, getUser(), typed, role);
        toast(`Invite sent to ${typed}`);
      }
      emailEl.value = '';
      picked = null;
    } catch (err) { toast(cleanErr(err), 'error'); } finally { btn.disabled = false; }
  });

  function renderInvites(list) {
    share.invites = list;
    $('share-invites').innerHTML = list.length ? list.map((i) => `
      <div class="share__item">
        <span class="share__av is-pending">${i.inviteePhoto ? `<img src="${esc(i.inviteePhoto)}" alt="" referrerpolicy="no-referrer" />` : esc(initialOf(i.inviteeName || i.email))}</span>
        <span class="share__who"><b>${esc(i.inviteeName || i.email)}</b><small>Invited as ${ROLE_LABEL[i.role]} · waiting</small></span>
        <button type="button" class="secondary sm" data-revoke-invite="${esc(i.id)}" data-email="${esc(i.inviteeName || i.email)}">Withdraw</button>
      </div>`).join('') : '';
  }
  $('share-invites').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-revoke-invite]');
    if (!b) return;
    const ok = await confirmDialog({ title: 'Withdraw this invite?', message: `${b.dataset.email} won't be able to use it.`, confirmLabel: 'Withdraw', danger: true });
    if (!ok) return;
    try { await revokeInvite(b.dataset.revokeInvite); } catch (err) { toast(cleanErr(err), 'error'); }
  });

  // invite links
  $('share-link-create').addEventListener('click', async () => {
    const p = share.project;
    if (!p) return;
    const btn = $('share-link-create');
    btn.disabled = true;
    try {
      const code = await createInviteLink({ kind: share.kind, id: p.id }, getUser().uid, {
        role: $('share-link-role').value,
        expiresInDays: Number($('share-link-expiry').value),
        requiresApproval: $('share-link-approval').checked
      });
      await navigator.clipboard.writeText(linkFor(code)).catch(() => {});
      toast(`Link created and copied: ${formatCode(code)}`);
    } catch (err) { toast(cleanErr(err), 'error'); } finally { btn.disabled = false; }
  });

  const expiryText = (l) => {
    if (!l.expiresAt) return 'never expires';
    const ms = l.expiresAt.toMillis() - Date.now();
    if (ms <= 0) return 'expired';
    const days = Math.ceil(ms / 86400000);
    return days <= 1 ? 'expires within a day' : `expires in ${days} days`;
  };
  function renderLinks(list) {
    list.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
    $('share-links').innerHTML = list.length ? list.map((l) => `
      <div class="share__item${l.pending ? ' is-pending' : ''}">
        <span class="share__code">${esc(formatCode(l.code))}</span>
        <span class="share__who"><small>${l.pending ? 'creating…' : `${ROLE_LABEL[l.role]}${l.requiresApproval ? ' · needs approval' : ''} · ${expiryText(l)}`}</small></span>
        <button type="button" class="secondary sm" data-copy-link="${esc(l.code)}" ${l.pending ? 'disabled' : ''}>Copy link</button>
        <button type="button" class="secondary sm" data-copy-code="${esc(l.code)}" ${l.pending ? 'disabled' : ''}>Copy code</button>
        <button type="button" class="ibtn" data-revoke-link="${esc(l.code)}" title="Turn off this link" aria-label="Turn off"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M7 7l10 10M17 7 7 17"/></svg></button>
      </div>`).join('') : '<p class="field-hint">No active links. Anyone with a link can join until it expires or you turn it off.</p>';
  }
  $('share-links').addEventListener('click', async (e) => {
    const copyLink = e.target.closest('[data-copy-link]');
    const copyCode = e.target.closest('[data-copy-code]');
    const revoke = e.target.closest('[data-revoke-link]');
    if (copyLink) { await navigator.clipboard.writeText(linkFor(copyLink.dataset.copyLink)); toast('Invite link copied'); }
    if (copyCode) { await navigator.clipboard.writeText(formatCode(copyCode.dataset.copyCode)); toast('Invite code copied'); }
    if (revoke) {
      const ok = await confirmDialog({ title: 'Turn off this link?', message: `Code ${formatCode(revoke.dataset.revokeLink)} will stop working. People who already joined stay members.`, confirmLabel: 'Turn off', danger: true });
      if (!ok) return;
      try { await revokeInviteLink(revoke.dataset.revokeLink); } catch (err) { toast(cleanErr(err), 'error'); }
    }
  });

  // join requests
  function renderRequests(list) {
    $('share-requests-sec').hidden = !list.length || !canManage(share.project);
    $('share-requests').innerHTML = list.map((r) => `
      <div class="share__item">
        <span class="share__av">${r.photo ? `<img src="${esc(r.photo)}" alt="" referrerpolicy="no-referrer" />` : esc(initialOf(r.name))}</span>
        <span class="share__who"><b>${esc(r.name || 'Someone')}</b><small>${esc(r.email || '')}</small></span>
        <select class="pill sm" data-req-role="${esc(r.uid)}">${roleOptions(grantable(share.project), grantable(share.project).includes(r.role) ? r.role : 'viewer')}</select>
        <button type="button" class="primary sm" data-approve="${esc(r.uid)}">Approve</button>
        <button type="button" class="secondary sm" data-deny="${esc(r.uid)}" data-name="${esc(r.name || 'them')}">Deny</button>
      </div>`).join('');
    enhanceSelects($('share-requests'));
  }
  $('share-requests').addEventListener('click', async (e) => {
    const approve = e.target.closest('[data-approve]');
    const deny = e.target.closest('[data-deny]');
    const p = share.project;
    if (!p || (!approve && !deny)) return;
    const uid = (approve || deny).dataset.approve || deny.dataset.deny;
    if (deny) {
      const ok = await confirmDialog({ title: `Deny ${deny.dataset.name}?`, message: "They won't join. They can ask again with a valid link.", confirmLabel: 'Deny', danger: true });
      if (!ok) return;
    }
    const role = shareModal.querySelector(`[data-req-role="${CSS.escape(uid)}"]`)?.value;
    try { await cloudCalls.respondJoinRequest(tgt({ uid, approve: !!approve, role })); toast(approve ? 'Request approved' : 'Request denied'); } catch (err) { toast(cleanErr(err), 'error'); }
  });

  // ---------------------------------------------------------------- join
  const joinModal = $('join-modal');
  const join = { code: null, preview: null };

  function openJoin(prefill = '') {
    requireAuth(() => {
      join.code = null;
      join.preview = null;
      $('join-code').value = prefill;
      $('join-preview').hidden = true;
      $('join-error').textContent = '';
      $('join-submit').textContent = 'Continue';
      joinModal.hidden = false;
      $('join-code').focus();
      if (prefill) $('join-form').requestSubmit();
    });
  }
  const closeJoin = () => { joinModal.hidden = true; };
  $('join-cancel').addEventListener('click', closeJoin);
  $('join-code').addEventListener('input', () => { join.preview = null; $('join-preview').hidden = true; $('join-submit').textContent = 'Continue'; });

  $('join-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('join-error').textContent = '';
    const code = codeFrom($('join-code').value);
    if (!code) { $('join-error').textContent = 'That doesn’t look like an invite code (e.g. AB12-CD34).'; return; }
    const btn = $('join-submit');
    btn.disabled = true;
    try {
      if (!join.preview || join.code !== code) {
        const pv = await cloudCalls.redeemCode({ code, preview: true });
        join.code = code;
        join.preview = pv;
        $('join-preview').hidden = false;
        $('join-preview').innerHTML = `<b>${pv.kind === 'team' ? 'Workspace: ' : ''}${esc(pv.name)}</b>
          <span>Owner: ${esc(pv.ownerName || 'unknown')}</span>${pv.kind === 'team' ? '<span>You get every project in this workspace.</span>' : ''}
          <span>${pv.member ? `You're already a member (${ROLE_LABEL[pv.member]}).` : `You'll join as <b>${ROLE_LABEL[pv.role]}</b> (${ROLE_HINT[pv.role]})${pv.requiresApproval ? ', after the owner approves.' : '.'}`}</span>`;
        btn.textContent = pv.member ? (pv.kind === 'team' ? 'Open workspace' : 'Set up on this computer') : pv.requiresApproval ? 'Ask to join' : pv.kind === 'team' ? 'Join workspace' : 'Join project';
        return;
      }
      const res = await cloudCalls.redeemCode({ code });
      if (res.pending) {
        closeJoin();
        toast(`Request sent. You'll get access to ${res.name} once the owner approves.`);
        return;
      }
      closeJoin();
      toast(res.already ? `You're a member of ${res.name}` : `Joined ${res.name} as ${ROLE_LABEL[res.role]}`);
      if (res.kind === 'team') await onJoinedTeam(res.teamId, res.name);
      else await setUpLocally({ id: res.projectId, name: res.name });
    } catch (err) {
      $('join-error').textContent = cleanErr(err);
    } finally { btn.disabled = false; }
  });

  // A cloud project you're in needs a local folder (stage 2 will clone the
  // repo here); the local record reuses the cloud project's id.
  async function setUpLocally({ id, name, repoUrl }) {
    const local = getLocalProjects().find((p) => p.id === id);
    if (local) { openProjectById(id); return; }
    if (repoUrl === undefined) repoUrl = (await getCloudProject(id))?.repoUrl || '';
    let folder = null;
    if (repoUrl) {
      // Git project: clone it (recommended) or point at an existing clone
      const choice = await confirmDialog({
        title: `Set up “${name}” on this computer`,
        message: `This project's code is in ${repoUrl.replace(/^https:\/\//, '')}. Clone it into a folder, or choose a folder where you've already cloned it.`,
        confirmLabel: 'Clone into a folder…',
        altLabel: 'Use an existing folder…'
      });
      if (!choice) return;
      if (choice === 'alt') folder = await chooseFolder();
      else folder = await cloneRepo(repoUrl);
    } else {
      const ok = await confirmDialog({
        title: `Set up “${name}” on this computer`,
        message: 'Choose a folder for this project (an empty one is fine). MulTeam fills it with the shared files and keeps them in sync.',
        confirmLabel: 'Choose folder…'
      });
      if (!ok) return;
      folder = await chooseFolder();
    }
    if (!folder) return;
    try {
      await createLocalProject({ id, name, folderPath: folder, cloudEnabled: true, joined: true, workspaceId: workspaceForTeam(myCloud.find((p) => p.id === id)?.teamId) || undefined });
      await refreshProjects();
      openProjectById(id);
    } catch (err) { toast(cleanErr(err), 'error'); }
  }

  // Pick where to clone, then clone with progress. A private GitHub repo
  // without a login asks to connect GitHub, then retries.
  async function cloneRepo(repoUrl) {
    const parent = await chooseFolder();
    if (!parent) return null;
    const cloneModal = $('clone-modal');
    const isGitHub = /^https:\/\/github\.com\//i.test(repoUrl);
    for (let attempt = 0; attempt < 2; attempt++) {
      $('clone-title').textContent = 'Cloning…';
      $('clone-repo').textContent = `${repoUrl.replace(/^https:\/\//, '')} → ${parent}`;
      $('clone-line').textContent = 'Starting…';
      cloneModal.hidden = false;
      const off = window.electronAPI.github.onCloneProgress((line) => { $('clone-line').textContent = line; });
      try {
        const dest = await window.electronAPI.github.clone({ url: repoUrl, parentDir: parent });
        toast(`Cloned into ${dest}`);
        return dest;
      } catch (err) {
        const msg = cleanErr(err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
        cloneModal.hidden = true;
        if (attempt === 0 && isGitHub && /needs a GitHub login/i.test(msg) && github && !github.status().connected) {
          if (await github.connect('This repository is private. Connect GitHub so MulTeam can clone it with your access.')) continue;
          return null;
        }
        toast(msg, 'error');
        return null;
      } finally {
        off();
        cloneModal.hidden = true;
      }
    }
    return null;
  }

  // multeam://join/CODE
  function handleLink(url) {
    const m = /^multeam:\/\/join\/([A-Za-z0-9-]+)/i.exec(String(url || ''));
    if (m) openJoin(m[1]);
  }
  window.electronAPI.onOpenLink?.(handleLink);
  window.electronAPI.takeLaunchLink?.().then(handleLink).catch(() => {});

  // ---------------------------------------------------------------- invites in the bell
  const notifPanel = $('notifPanel');
  notifPanel.querySelector('.notifs__head').insertAdjacentHTML('afterend', '<div class="invites" id="inviteBox" hidden></div>');
  const inviteBox = $('inviteBox');
  let myInvites = [];
  let seenInvites = new Set();
  let unsubInvites = () => {};

  function renderInviteBox() {
    const user = getUser();
    const unverified = user && user.email && !user.emailVerified && user.providerData?.some((p) => p.providerId === 'password');
    const parts = [];
    if (unverified) {
      parts.push(`<div class="invite is-note"><span>Verify <b>${esc(user.email)}</b> to receive project invites.</span>
        <span class="invite__acts"><button type="button" class="secondary sm" data-verify="resend">Resend email</button><button type="button" class="secondary sm" data-verify="check">I've verified</button></span></div>`);
    }
    for (const i of myInvites) {
      parts.push(`<div class="invite"><span><b>${esc(i.invitedBy?.name || 'Someone')}</b> invited you to ${i.teamId ? 'the workspace ' : ''}<b>${esc(i.projectName || i.teamName || 'a project')}</b> as ${ROLE_LABEL[i.role] || i.role}.</span>
        <span class="invite__acts"><button type="button" class="primary sm" data-accept="${esc(i.id)}">Accept</button><button type="button" class="secondary sm" data-decline="${esc(i.id)}">Decline</button></span></div>`);
    }
    inviteBox.innerHTML = parts.join('');
    inviteBox.hidden = !parts.length;
  }

  inviteBox.addEventListener('click', async (e) => {
    const accept = e.target.closest('[data-accept]');
    const decline = e.target.closest('[data-decline]');
    const verify = e.target.closest('[data-verify]');
    try {
      if (verify?.dataset.verify === 'resend') { await resendVerification(); toast('Verification email sent. Check your inbox.'); }
      if (verify?.dataset.verify === 'check') {
        const u = await refreshUser();
        if (u?.emailVerified) { toast('Email verified'); watchInvites(u); } else toast("Not verified yet. Click the link in the email first.", 'error');
      }
      if (accept) {
        const inv = myInvites.find((i) => i.id === accept.dataset.accept);
        accept.disabled = true;
        const res = await cloudCalls.acceptInvite({ inviteId: accept.dataset.accept });
        toast(`Joined ${res.name} as ${ROLE_LABEL[res.role]}`);
        if (res.kind === 'team') await onJoinedTeam(res.teamId, res.name || inv?.teamName);
        else await setUpLocally({ id: res.projectId, name: res.name || inv?.projectName });
      }
      if (decline) {
        const ok = await confirmDialog({ title: 'Decline this invite?', message: 'The owner can invite you again later.', confirmLabel: 'Decline', danger: true });
        if (ok) await cloudCalls.declineInvite({ inviteId: decline.dataset.decline });
      }
    } catch (err) { toast(cleanErr(err), 'error'); if (accept) accept.disabled = false; }
  });

  function watchInvites(user) {
    unsubInvites();
    myInvites = [];
    renderInviteBox();
    if (!user) { unsubInvites = () => {}; return; }
    unsubInvites = watchMyInvites(user, (list) => {
      const fresh = list.filter((i) => !seenInvites.has(i.id));
      myInvites = list;
      renderInviteBox();
      if (fresh.length) {
        fresh.forEach((i) => seenInvites.add(i.id));
        toast(fresh.length === 1 ? `${fresh[0].invitedBy?.name || 'Someone'} invited you to ${fresh[0].projectName || fresh[0].teamName}. Open notifications to respond.` : `${fresh.length} new invites. Open notifications to respond.`);
      }
    });
  }

  // ---------------------------------------------------------------- shared with you
  let unsubMine = () => {};
  let myCloud = [];
  function renderSharedWithMe() {
    const host = $('sharedWithMe');
    if (!host) return;
    const localIds = new Set(getLocalProjects().map((p) => p.id));
    const me = getUser();
    const list = myCloud.filter((p) => !localIds.has(p.id) && p.ownerId !== me?.uid && (p.memberUids || []).includes(me?.uid));
    host.hidden = !list.length;
    host.querySelector('.shared__list').innerHTML = list.map((p) => {
      const direct = p.members?.[me.uid]?.role;
      const team = p.teamId ? myTeams.find((t) => t.id === p.teamId) : null;
      const owner = Object.values(p.members || {}).find((m) => m.role === 'owner');
      const how = direct ? ROLE_LABEL[direct] : team ? `via workspace “${esc(team.name)}”` : 'shared';
      return `<div class="shared__item">
        <span class="share__av">${esc(initialOf(p.name))}</span>
        <span class="share__who"><b>${esc(p.name)}</b><small>${how} · owned by ${esc(owner?.name || 'someone')}</small></span>
        <button type="button" class="primary sm" data-setup="${esc(p.id)}">Set up on this computer</button>
      </div>`;
    }).join('');
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('#sharedWithMe [data-setup]');
    if (!b) return;
    const p = myCloud.find((x) => x.id === b.dataset.setup);
    if (p) setUpLocally({ id: p.id, name: p.name, repoUrl: p.repoUrl });
  });

  let myTeams = [];
  let unsubTeams = () => {};
  function onAuth(user) {
    watchInvites(user);
    unsubMine();
    unsubTeams();
    myCloud = [];
    myTeams = [];
    renderSharedWithMe();
    if (user) {
      unsubMine = watchMyCloudProjects(user.uid, (list) => { myCloud = list; renderSharedWithMe(); });
      // team workspaces I'm in → keep matching local workspaces
      unsubTeams = watchMyTeams(user.uid, (teams) => { myTeams = teams; onTeamsChanged(teams); renderSharedWithMe(); });
    } else {
      unsubMine = () => {};
      unsubTeams = () => {};
      onTeamsChanged(null);
    }
  }

  return {
    openShare,
    openJoin,
    onAuth,
    projectsChanged: renderSharedWithMe,
    openShareWorkspace: (teamId) => openShare(teamId, 'team'),
    teams: () => myTeams,
    cloudProjects: () => myCloud,
    isOpen: () => !shareModal.hidden || !joinModal.hidden,
    close: () => { closeShare(); closeJoin(); }
  };
}
