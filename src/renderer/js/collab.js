// Collaboration UI (stage 1): Share dialog (members, roles, email invites,
// invite links, join requests), Join dialog (code / multeam:// link),
// invites in the notification bell, and "Shared with you" on the Dashboard.
// Data + rules live in firebase.js / firestore.rules / functions/index.js.
import {
  cloudCalls, watchCloudProject, watchMyCloudProjects, inviteByEmail, watchProjectInvites, revokeInvite,
  createInviteLink, watchInviteLinks, revokeInviteLink, watchJoinRequests, watchMyInvites, formatCode,
  resendVerification, refreshUser, forgetLiveMembership
} from './firebase.js';

const ROLE_LABEL = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer' };
const ROLE_HINT = { editor: 'can edit code', viewer: 'can watch and follow, not edit' };
const linkFor = (code) => `multeam://join/${formatCode(code)}`;
const codeFrom = (text) => {
  const m = String(text || '').toUpperCase().match(/([A-Z0-9]{4})-?([A-Z0-9]{4})\s*$/);
  return m ? m[1] + m[2] : null;
};
const initialOf = (s) => (String(s || '?').trim()[0] || '?').toUpperCase();

export function initCollab({ toast, confirmDialog, escapeHtml, getUser, requireAuth, getLocalProjects, refreshProjects, openProjectById, chooseFolder, createLocalProject, removeLocalProject }) {
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
            <h3>Invite by email</h3>
            <form class="share__row" id="share-invite-form">
              <input type="email" id="share-email" placeholder="teammate@example.com" autocomplete="off" required />
              <select class="pill" id="share-invite-role"><option value="editor">Editor</option><option value="viewer">Viewer</option></select>
              <button type="submit" class="primary sm" id="share-invite-btn">Invite</button>
            </form>
            <p class="field-hint">They'll see it in MulTeam's notifications after signing in with that (verified) email.</p>
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
              <label class="check-inline"><input type="checkbox" id="share-link-approval" /> Needs my approval</label>
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

  // ---------------------------------------------------------------- share
  const share = { project: null, unsubs: [], projectId: null };
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

  function openShare(projectId) {
    requireAuth(() => {
      const me = getUser();
      closeShare();
      share.projectId = projectId;
      shareModal.hidden = false;
      $('share-title').textContent = 'Share';
      $('share-sub').textContent = 'Loading…';
      $('share-members').innerHTML = '';
      share.unsubs.push(watchCloudProject(projectId, (p) => {
        if (!p) {
          $('share-sub').textContent = "This project isn't in the cloud, or you no longer have access to it.";
          shareModal.querySelectorAll('[data-owner-only]').forEach((el) => { el.hidden = true; });
          $('share-members').innerHTML = '';
          return;
        }
        const firstLoad = !share.project;
        share.project = p;
        const myRole = p.members?.[me.uid]?.role;
        const owner = myRole === 'owner';
        $('share-title').textContent = `Share “${p.name}”`;
        $('share-sub').textContent = owner ? 'You own this project.' : `You're ${myRole === 'editor' ? 'an editor' : 'a viewer'} here.`;
        shareModal.querySelectorAll('[data-owner-only]').forEach((el) => { if (el.id !== 'share-requests-sec') el.hidden = !owner; });
        $('share-leave').hidden = owner || !myRole;
        renderMembers(p, owner, me.uid);
        if (firstLoad && owner) {
          share.unsubs.push(watchProjectInvites(projectId, me.uid, renderInvites));
          share.unsubs.push(watchInviteLinks(projectId, me.uid, renderLinks));
          share.unsubs.push(watchJoinRequests(projectId, renderRequests));
        }
      }));
    });
  }

  function renderMembers(p, owner, myUid) {
    const list = Object.entries(p.members || {}).sort(([, a], [, b]) => (b.role === 'owner') - (a.role === 'owner') || String(a.name).localeCompare(String(b.name)));
    $('share-count').textContent = `(${list.length})`;
    $('share-members').innerHTML = list.map(([uid, m]) => `
      <div class="share__item" data-uid="${esc(uid)}">
        <span class="share__av">${m.photo ? `<img src="${esc(m.photo)}" alt="" referrerpolicy="no-referrer" />` : esc(initialOf(m.name))}</span>
        <span class="share__who"><b>${esc(m.name || 'Member')}${uid === myUid ? ' (you)' : ''}</b><small>${esc(m.email || '')}</small></span>
        ${owner && m.role !== 'owner'
          ? `<select class="pill sm" data-role-for="${esc(uid)}"><option value="editor" ${m.role === 'editor' ? 'selected' : ''}>Editor</option><option value="viewer" ${m.role === 'viewer' ? 'selected' : ''}>Viewer</option></select>
             <button type="button" class="ibtn" data-remove="${esc(uid)}" title="Remove from project" aria-label="Remove"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M7 7l10 10M17 7 7 17"/></svg></button>`
          : `<span class="share__role">${ROLE_LABEL[m.role] || m.role}</span>`}
      </div>`).join('');
  }

  $('share-members').addEventListener('change', async (e) => {
    const sel = e.target.closest('[data-role-for]');
    if (!sel || !share.project) return;
    const uid = sel.dataset.roleFor;
    const name = share.project.members?.[uid]?.name || 'them';
    try {
      await cloudCalls.setMemberRole({ projectId: share.project.id, uid, role: sel.value });
      toast(`${name} is now ${sel.value === 'editor' ? 'an Editor' : 'a Viewer'}`);
    } catch (err) { toast(cleanErr(err), 'error'); sel.value = share.project.members?.[uid]?.role || 'viewer'; }
  });

  $('share-members').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-remove]');
    if (!btn || !share.project) return;
    const uid = btn.dataset.remove;
    const name = share.project.members?.[uid]?.name || 'this member';
    const ok = await confirmDialog({ title: `Remove ${name}?`, message: `${name} loses access to "${share.project.name}" right away. Their local copy of the files isn't touched.`, confirmLabel: 'Remove', danger: true });
    if (!ok) return;
    try { await cloudCalls.removeMember({ projectId: share.project.id, uid }); toast(`Removed ${name}`); } catch (err) { toast(cleanErr(err), 'error'); }
  });

  $('share-leave').addEventListener('click', async () => {
    const p = share.project;
    if (!p) return;
    const ok = await confirmDialog({ title: `Leave "${p.name}"?`, message: "You'll lose access to the shared project. Your local folder and files stay on this computer; MulTeam just stops listing the project.", confirmLabel: 'Leave project', danger: true });
    if (!ok) return;
    try {
      await cloudCalls.removeMember({ projectId: p.id });
      forgetLiveMembership(p.id, getUser().uid);
      await removeLocalProject(p.id);
      closeShare();
      toast(`You left ${p.name}`);
    } catch (err) { toast(cleanErr(err), 'error'); }
  });

  // email invites
  $('share-invite-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const p = share.project;
    if (!p) return;
    const btn = $('share-invite-btn');
    btn.disabled = true;
    try {
      await inviteByEmail(p, getUser(), $('share-email').value, $('share-invite-role').value);
      toast(`Invite sent to ${$('share-email').value.trim()}`);
      $('share-email').value = '';
    } catch (err) { toast(cleanErr(err), 'error'); } finally { btn.disabled = false; }
  });

  function renderInvites(list) {
    $('share-invites').innerHTML = list.length ? list.map((i) => `
      <div class="share__item">
        <span class="share__av is-pending">${esc(initialOf(i.email))}</span>
        <span class="share__who"><b>${esc(i.email)}</b><small>Invited as ${ROLE_LABEL[i.role]} · waiting</small></span>
        <button type="button" class="secondary sm" data-revoke-invite="${esc(i.id)}" data-email="${esc(i.email)}">Withdraw</button>
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
      const code = await createInviteLink(p.id, getUser().uid, {
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
      <div class="share__item">
        <span class="share__code">${esc(formatCode(l.code))}</span>
        <span class="share__who"><small>${ROLE_LABEL[l.role]}${l.requiresApproval ? ' · needs approval' : ''} · ${expiryText(l)}</small></span>
        <button type="button" class="secondary sm" data-copy-link="${esc(l.code)}">Copy link</button>
        <button type="button" class="secondary sm" data-copy-code="${esc(l.code)}">Copy code</button>
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
    $('share-requests-sec').hidden = !list.length || share.project?.members?.[getUser()?.uid]?.role !== 'owner';
    $('share-requests').innerHTML = list.map((r) => `
      <div class="share__item">
        <span class="share__av">${r.photo ? `<img src="${esc(r.photo)}" alt="" referrerpolicy="no-referrer" />` : esc(initialOf(r.name))}</span>
        <span class="share__who"><b>${esc(r.name || 'Someone')}</b><small>${esc(r.email || '')}</small></span>
        <select class="pill sm" data-req-role="${esc(r.uid)}"><option value="editor" ${r.role === 'editor' ? 'selected' : ''}>Editor</option><option value="viewer" ${r.role === 'viewer' ? 'selected' : ''}>Viewer</option></select>
        <button type="button" class="primary sm" data-approve="${esc(r.uid)}">Approve</button>
        <button type="button" class="secondary sm" data-deny="${esc(r.uid)}" data-name="${esc(r.name || 'them')}">Deny</button>
      </div>`).join('');
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
    try { await cloudCalls.respondJoinRequest({ projectId: p.id, uid, approve: !!approve, role }); toast(approve ? 'Request approved' : 'Request denied'); } catch (err) { toast(cleanErr(err), 'error'); }
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
        $('join-preview').innerHTML = `<b>${esc(pv.name)}</b>
          <span>Owner: ${esc(pv.ownerName || 'unknown')}</span>
          <span>${pv.member ? `You're already a member (${ROLE_LABEL[pv.member]}).` : `You'll join as <b>${ROLE_LABEL[pv.role]}</b> (${ROLE_HINT[pv.role]})${pv.requiresApproval ? ', after the owner approves.' : '.'}`}</span>`;
        btn.textContent = pv.member ? 'Set up on this computer' : pv.requiresApproval ? 'Ask to join' : 'Join project';
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
      await setUpLocally({ id: res.projectId, name: res.name });
    } catch (err) {
      $('join-error').textContent = cleanErr(err);
    } finally { btn.disabled = false; }
  });

  // A cloud project you're in needs a local folder (stage 2 will clone the
  // repo here); the local record reuses the cloud project's id.
  async function setUpLocally({ id, name, repoUrl }) {
    const local = getLocalProjects().find((p) => p.id === id);
    if (local) { openProjectById(id); return; }
    const ok = await confirmDialog({
      title: `Set up “${name}” on this computer`,
      message: `Choose the folder that holds this project's code${repoUrl ? ` (your clone of ${repoUrl})` : ' (for example your clone of its Git repository)'}. MulTeam links it to the shared project so you can edit together.`,
      confirmLabel: 'Choose folder…'
    });
    if (!ok) return;
    const folder = await chooseFolder();
    if (!folder) return;
    try {
      await createLocalProject({ id, name, folderPath: folder, cloudEnabled: true, joined: true });
      await refreshProjects();
      openProjectById(id);
    } catch (err) { toast(cleanErr(err), 'error'); }
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
      parts.push(`<div class="invite"><span><b>${esc(i.invitedBy?.name || 'Someone')}</b> invited you to <b>${esc(i.projectName || 'a project')}</b> as ${ROLE_LABEL[i.role] || i.role}.</span>
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
        await setUpLocally({ id: res.projectId, name: res.name || inv?.projectName });
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
        toast(fresh.length === 1 ? `${fresh[0].invitedBy?.name || 'Someone'} invited you to ${fresh[0].projectName}. Open notifications to respond.` : `${fresh.length} new project invites. Open notifications to respond.`);
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
    const list = myCloud.filter((p) => !localIds.has(p.id) && p.members?.[me?.uid]);
    host.hidden = !list.length;
    host.querySelector('.shared__list').innerHTML = list.map((p) => {
      const role = p.members[me.uid].role;
      const owner = Object.values(p.members).find((m) => m.role === 'owner');
      return `<div class="shared__item">
        <span class="share__av">${esc(initialOf(p.name))}</span>
        <span class="share__who"><b>${esc(p.name)}</b><small>${ROLE_LABEL[role]} · owned by ${esc(owner?.name || 'someone')} · ${Object.keys(p.members).length} member${Object.keys(p.members).length === 1 ? '' : 's'}</small></span>
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

  function onAuth(user) {
    watchInvites(user);
    unsubMine();
    myCloud = [];
    renderSharedWithMe();
    if (user) unsubMine = watchMyCloudProjects(user.uid, (list) => { myCloud = list; renderSharedWithMe(); });
    else unsubMine = () => {};
  }

  return {
    openShare,
    openJoin,
    onAuth,
    projectsChanged: renderSharedWithMe,
    isOpen: () => !shareModal.hidden || !joinModal.hidden,
    close: () => { closeShare(); closeJoin(); }
  };
}
