// Live sessions (collaboration stage 4) — VS Code Live Share style.
//
// Host: "Start live session" on the open project shares its whole folder
// (sessions/{id} in RTDB, via the same sync engine as cloud projects). The
// host admits or denies each guest, can make anyone read-only, remove them,
// and End the session — which deletes everything in it.
// Guest: opens multeam://session/{id} (no account needed — a name is
// enough), waits to be admitted, then gets the host's project as a
// temporary project in a scratch folder that's deleted when it ends.
import { ref, get, set, update, remove, onValue, onDisconnect } from 'firebase/database';
import { rtdb, auth, signInAsGuest } from './firebase.js';
import { createLiveProject } from './liveProject.js';

const sessionLink = (sid) => `multeam://session/${sid}`;
export const sessionIdFrom = (text) => (/multeam:\/\/session\/([a-z0-9]{6,40})/i.exec(String(text || '')) || [])[1] || null;
const newSid = () => Array.from(crypto.getRandomValues(new Uint32Array(12)), (n) => 'abcdefghijkmnpqrstuvwxyz23456789'[n % 32]).join('');

export function initSessions({ toast, confirmDialog, promptDialog, escapeHtml, getProject, getRoot, getUser, requireAuth, makeApi, openSessionProject, closeSessionProject, setHostEngine }) {
  const esc = escapeHtml;
  const cleanErr = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '').replace(/^Firebase: /, '');

  // ---------------------------------------------------------------- markup
  document.body.insertAdjacentHTML('beforeend', `
    <div class="sessionpanel" id="sessionPanel" role="dialog" aria-label="Live session">
      <div class="notifs__head" id="sessionHead">Live session</div>
      <div class="session__body" id="sessionBody"></div>
    </div>
    <div class="modal-overlay" id="session-wait" hidden>
      <div class="modal-card">
        <h2 id="session-wait-title">Joining…</h2>
        <p class="modal-sub" id="session-wait-sub"></p>
        <p class="clone__line"><span class="btn-spinner" aria-hidden="true"></span><span id="session-wait-line">Asking the host to let you in…</span></p>
        <div class="modal-actions"><button type="button" class="secondary" id="session-wait-cancel">Cancel</button></div>
      </div>
    </div>`);
  const footer = document.querySelector('.footerbar .box');
  footer.insertAdjacentHTML('beforeend', `<button type="button" class="footbtn session-foot" id="sessionBtn" hidden title="Live session">
    <span class="session-foot__dot"></span><span id="sessionBtnText">Live</span></button>`);
  const $ = (id) => document.getElementById(id);
  const panel = $('sessionPanel');

  // ---------------------------------------------------------------- state
  let hosting = null;   // { sid, engine, unsubs, members }
  let guesting = null;  // { sid, role, unsubs, hostName, projectName }

  const ref$ = (p) => ref(rtdb, p);
  function setFoot() {
    const btn = $('sessionBtn');
    if (hosting) {
      const guests = Object.values(hosting.members || {});
      const pending = guests.filter((m) => m.status === 'pending').length;
      const inSession = guests.filter((m) => m.status === 'admitted').length;
      btn.hidden = false;
      btn.classList.toggle('has-pending', pending > 0);
      $('sessionBtnText').textContent = pending ? `Live · ${pending} waiting` : `Live · ${inSession} guest${inSession === 1 ? '' : 's'}`;
    } else if (guesting) {
      btn.hidden = false;
      btn.classList.remove('has-pending');
      $('sessionBtnText').textContent = `Live with ${guesting.hostName}${guesting.role === 'viewer' ? ' · read-only' : ''}`;
    } else {
      btn.hidden = true;
      closePanel();
    }
  }

  function closePanel() { panel.classList.remove('is-open'); $('sessionBtn').classList.remove('is-on'); }
  $('sessionBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const open = panel.classList.contains('is-open');
    closePanel();
    if (open) return;
    renderPanel();
    panel.classList.add('is-open');
    $('sessionBtn').classList.add('is-on');
  });
  document.addEventListener('click', (e) => { if (panel.classList.contains('is-open') && !panel.contains(e.target) && !e.target.closest('#sessionBtn')) closePanel(); });

  function renderPanel() {
    const body = $('sessionBody');
    if (hosting) {
      const entries = Object.entries(hosting.members || {});
      const pending = entries.filter(([, m]) => m.status === 'pending');
      const guests = entries.filter(([, m]) => m.status === 'admitted');
      $('sessionHead').textContent = 'Live session · you are hosting';
      body.innerHTML = `
        <div class="session__link"><code>${esc(sessionLink(hosting.sid))}</code><button type="button" class="secondary sm" data-s="copy">Copy link</button></div>
        <p class="field-hint">Anyone with the link can ask to join. You admit each person.</p>
        ${pending.length ? `<h3 class="session__h">Waiting to join</h3>${pending.map(([uid, m]) => `
          <div class="share__item"><span class="share__av">${esc((m.name || '?')[0].toUpperCase())}</span>
            <span class="share__who"><b>${esc(m.name)}</b><small>wants to join</small></span>
            <button type="button" class="primary sm" data-s="admit" data-uid="${esc(uid)}">Admit</button>
            <button type="button" class="secondary sm" data-s="deny" data-uid="${esc(uid)}" data-name="${esc(m.name)}">Deny</button></div>`).join('')}` : ''}
        <h3 class="session__h">Guests (${guests.length})</h3>
        ${guests.length ? guests.map(([uid, m]) => `
          <div class="share__item"><span class="share__av">${esc((m.name || '?')[0].toUpperCase())}</span>
            <span class="share__who"><b>${esc(m.name)}</b><small>${m.role === 'viewer' ? 'read-only' : 'can edit'}</small></span>
            <button type="button" class="secondary sm" data-s="role" data-uid="${esc(uid)}" data-role="${m.role === 'viewer' ? 'editor' : 'viewer'}">${m.role === 'viewer' ? 'Allow editing' : 'Make read-only'}</button>
            <button type="button" class="ibtn" data-s="kick" data-uid="${esc(uid)}" data-name="${esc(m.name)}" title="Remove from session" aria-label="Remove"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M7 7l10 10M17 7 7 17"/></svg></button></div>`).join('') : '<p class="field-hint">No one has joined yet.</p>'}
        <div class="session__acts"><button type="button" class="secondary danger-text" data-s="end">End session</button></div>`;
    } else if (guesting) {
      $('sessionHead').textContent = `Live session · ${guesting.projectName}`;
      body.innerHTML = `
        <p class="session__p">You're in <b>${esc(guesting.hostName)}</b>'s session${guesting.role === 'viewer' ? ' as <b>read-only</b>' : ''}. Your changes are saved on their computer; nothing stays on yours after the session.</p>
        <div class="session__acts"><button type="button" class="secondary danger-text" data-s="leave">Leave session</button></div>`;
    }
  }

  $('sessionBody').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-s]');
    if (!b) return;
    const act = b.dataset.s;
    try {
      if (act === 'copy') { await navigator.clipboard.writeText(sessionLink(hosting.sid)); toast('Session link copied'); }
      if (act === 'admit') await update(ref$(`sessions/${hosting.sid}/members/${b.dataset.uid}`), { status: 'admitted' });
      if (act === 'deny') {
        if (await confirmDialog({ title: `Deny ${b.dataset.name}?`, message: "They won't join this session.", confirmLabel: 'Deny', danger: true })) {
          await update(ref$(`sessions/${hosting.sid}/members/${b.dataset.uid}`), { status: 'denied' });
        }
      }
      if (act === 'role') await set(ref$(`sessions/${hosting.sid}/members/${b.dataset.uid}/role`), b.dataset.role);
      if (act === 'kick') {
        if (await confirmDialog({ title: `Remove ${b.dataset.name}?`, message: 'They leave the session right away. Changes they already made stay in your files.', confirmLabel: 'Remove', danger: true })) {
          await remove(ref$(`sessions/${hosting.sid}/members/${b.dataset.uid}`));
        }
      }
      if (act === 'end') endSession();
      if (act === 'leave') leaveSession();
    } catch (err) { toast(cleanErr(err), 'error'); }
  });

  // ---------------------------------------------------------------- host
  function startSession() {
    const project = getProject();
    if (!project) { toast('Open a project first, then start a live session.', 'error'); return; }
    if (project.session) { toast("You're a guest in this session; only its host can share it.", 'error'); return; }
    // a cloud project is already live for its members (Share adds people)
    if (project.cloudEnabled) { toast('This cloud project is already live for its members. Use Share to add people.', 'error'); return; }
    if (hosting) { renderPanel(); panel.classList.add('is-open'); return; }
    requireAuth(async () => {
      const user = getUser();
      const sid = newSid();
      try {
        await update(ref(rtdb), {
          [`sessions/${sid}/hostUid`]: user.uid,
          [`sessions/${sid}/info`]: { projectName: project.name, hostName: user.displayName || user.email || 'Host', createdAt: Date.now(), hostOnline: true }
        });
        onDisconnect(ref$(`sessions/${sid}/info/hostOnline`)).set(false);
        const engine = createLiveProject({ projectId: `session-${sid}`, root: getRoot(), branch: null, isGit: false, uid: user.uid, canEdit: true, api: makeApi(), toast, basePath: `sessions/${sid}` });
        hosting = { sid, engine, members: {}, unsubs: [] };
        hosting.unsubs.push(onValue(ref$(`sessions/${sid}/members`), (snap) => {
          const before = hosting?.members || {};
          if (!hosting) return;
          hosting.members = snap.val() || {};
          for (const [uid, m] of Object.entries(hosting.members)) {
            if (m.status === 'pending' && before[uid]?.status !== 'pending') toast(`${m.name} wants to join your live session. Open Live in the footer to admit them.`);
            if (m.status === 'admitted' && before[uid]?.status !== 'admitted') toast(`${m.name} joined the session`);
          }
          setFoot();
          if (panel.classList.contains('is-open')) renderPanel();
        }));
        await setHostEngine(engine);
        await navigator.clipboard.writeText(sessionLink(sid)).catch(() => {});
        setFoot();
        renderPanel();
        panel.classList.add('is-open');
        toast('Live session started. The link is copied; send it to whoever you want to pair with.');
      } catch (err) {
        toast(`Couldn't start the session: ${cleanErr(err)}`, 'error');
      }
    });
  }

  async function endSession({ ask = true } = {}) {
    if (!hosting) return;
    if (ask && !(await confirmDialog({ title: 'End the live session?', message: 'Everyone in it is disconnected and the session is deleted. Your files are kept as they are.', confirmLabel: 'End session', danger: true }))) return;
    const h = hosting;
    hosting = null;
    h.unsubs.forEach((u) => u());
    h.engine.dispose();
    await setHostEngine(null);
    try { await remove(ref$(`sessions/${h.sid}`)); } catch { /* offline: it'll be stale but unreadable to guests' engines */ }
    setFoot();
    toast('Live session ended');
  }

  // ---------------------------------------------------------------- guest
  let waitCancel = null;
  $('session-wait-cancel').addEventListener('click', () => waitCancel?.());

  async function joinSession(sid) {
    if (!sid) return;
    if (hosting) { toast('End your own live session before joining another.', 'error'); return; }
    if (guesting?.sid === sid) return;
    let user = getUser() || auth.currentUser;
    if (!user) {
      const name = await promptDialog({ title: 'Join a live session', label: 'Your name (shown to the host)', placeholder: 'e.g. Ada', confirmLabel: 'Continue' });
      if (!name?.trim()) return;
      try { user = await signInAsGuest(name.trim()); } catch (err) { toast(`Couldn't join as a guest: ${cleanErr(err)}`, 'error'); return; }
    }
    let info;
    try { info = (await get(ref$(`sessions/${sid}/info`))).val(); } catch { info = null; }
    if (!info) { toast('That live session has ended, or the link is wrong.', 'error'); return; }
    const name = user.displayName || user.email || 'Guest';
    $('session-wait-title').textContent = `Joining “${info.projectName}”`;
    $('session-wait-sub').textContent = `Hosted by ${info.hostName}.`;
    $('session-wait-line').textContent = `Asking ${info.hostName} to let you in…`;
    $('session-wait').hidden = false;
    const meRef = ref$(`sessions/${sid}/members/${user.uid}`);
    try {
      const existing = (await get(meRef)).val();
      if (!existing) await set(meRef, { name, status: 'pending', role: 'editor', at: Date.now() });
    } catch (err) { $('session-wait').hidden = true; toast(cleanErr(err), 'error'); return; }
    let unsub = null;
    waitCancel = async () => {
      unsub?.();
      $('session-wait').hidden = true;
      await remove(meRef).catch(() => {});
    };
    unsub = onValue(meRef, async (snap) => {
      const m = snap.val();
      if (!m) return;
      if (m.status === 'denied') { unsub(); $('session-wait').hidden = true; toast(`${info.hostName} didn't let you into the session`, 'error'); return; }
      if (m.status !== 'admitted') return;
      unsub();
      $('session-wait').hidden = true;
      await enterSession(sid, info, m.role, user.uid);
    });
  }

  async function enterSession(sid, info, role, uid) {
    guesting = { sid, role, hostName: info.hostName, projectName: info.projectName, unsubs: [] };
    await openSessionProject({ sid, role, hostName: info.hostName, projectName: info.projectName });
    // the session ends when the host ends it or removes me
    let seenInfo = false;
    guesting.unsubs.push(onValue(ref$(`sessions/${sid}/info`), (snap) => {
      const v = snap.val();
      if (!v) { if (seenInfo || guesting) finishGuest(`${info.hostName} ended the live session`); return; }
      seenInfo = true;
      if (v.hostOnline === false) toast(`${info.hostName} is offline. Your edits sync when they're back.`, 'error');
    }, () => finishGuest('You were removed from the live session')));
    guesting.unsubs.push(onValue(ref$(`sessions/${sid}/members/${uid}`), async (snap) => {
      const m = snap.val();
      if (!guesting) return;
      if (!m) { finishGuest('You were removed from the live session'); return; }
      if (m.role !== guesting.role) {
        guesting.role = m.role;
        toast(m.role === 'viewer' ? `${info.hostName} made you read-only` : `${info.hostName} allowed you to edit`);
        setFoot();
        await openSessionProject({ sid, role: m.role, hostName: info.hostName, projectName: info.projectName, reopen: true });
      }
    }));
    setFoot();
    toast(`You're in ${info.hostName}'s live session${role === 'viewer' ? ' (read-only)' : ''}`);
  }

  async function finishGuest(message) {
    if (!guesting) return;
    const g = guesting;
    guesting = null;
    g.unsubs.forEach((u) => u());
    setFoot();
    await closeSessionProject(g.sid);
    if (message) toast(message);
  }

  async function leaveSession() {
    if (!guesting) return;
    if (!(await confirmDialog({ title: 'Leave the live session?', message: "You'll be disconnected. Nothing from the session stays on this computer.", confirmLabel: 'Leave session', danger: true }))) return;
    const g = guesting;
    await remove(ref$(`sessions/${g.sid}/members/${auth.currentUser?.uid}`)).catch(() => {});
    await finishGuest('You left the live session');
  }

  return {
    startSession,
    endSession,
    joinSession,
    isHosting: () => !!hosting,
    isGuest: () => !!guesting,
    hostEngine: () => hosting?.engine || null,
    // the open project is closing: a host's session ends with it; a guest
    // closing the session's project leaves (after the close has finished)
    projectClosing: (p) => {
      if (hosting && !p?.session) endSession({ ask: false });
      if (guesting && p?.session?.sid === guesting.sid) {
        const g = guesting;
        setTimeout(async () => {
          if (guesting !== g) return;
          await remove(ref$(`sessions/${g.sid}/members/${auth.currentUser?.uid}`)).catch(() => {});
          finishGuest('You left the live session');
        }, 0);
      }
    }
  };
}
