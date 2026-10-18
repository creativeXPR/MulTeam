// Follow mode (collaboration stage 5) and project-wide presence.
//
// Everyone in a cloud project or live session keeps one small entry under
// {project or session}/presence/{connection}: who they are, which file they
// have open and where they're looking. The footer shows these people;
// clicking one follows them — the editor group you're in opens the file
// they're in and scrolls with them — until you do anything yourself.
// "Follow me" asks everyone else to follow you (each person can decline).
import { ref, push, set, remove, onValue, onDisconnect, serverTimestamp } from 'firebase/database';
import { rtdb } from './firebase.js';
import { colorForClient } from './remoteCursors.js';

const PUBLISH_MS = 150;
const hashOf = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); };
export const colorForUser = (uid) => colorForClient(hashOf(uid));
const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

export function initFollow({ el, toast, confirmDialog, escapeHtml, getUser, getBranch, focusedGroupId, groupEl, groupAlive, followInGroup, onPeersChanged = () => {} }) {
  const esc = escapeHtml;
  let channel = null;    // { path, connRef, conn, peers: Map<conn, entry>, unsub }
  let where = {};        // what I'm looking at: { file, shared, top, line }
  let following = null;  // { conn, groupId, name, color, off() }
  let asking = null;     // timestamp of my "Follow me", or null
  let driving = 0;       // > 0 while follow itself moves the editor
  let publishTimer = null;
  const answeredAsks = new Map(); // conn → followMe stamp already answered

  // ------------------------------------------------------------ channel
  function setChannel(path) {
    if ((channel?.path || null) === (path || null)) return;
    leave();
    const user = getUser();
    if (!path || !user) { render(); onPeersChanged(); return; }
    const connRef = push(ref(rtdb, path));
    const c = { path, connRef, conn: connRef.key, peers: new Map(), unsub: null };
    channel = c;
    onDisconnect(connRef).remove().catch(() => {});
    publishNow();
    c.unsub = onValue(ref(rtdb, path), (snap) => {
      if (channel !== c) return;
      const all = snap.val() || {};
      const me = getUser()?.uid;
      // other people only (my other windows aren't someone to follow)
      c.peers = new Map(Object.entries(all).filter(([k, v]) => k !== c.conn && v?.uid && v.uid !== me));
      changed();
    }, () => { /* lost access: the project/session closes this soon */ });
  }

  function leave() {
    if (!channel) return;
    const c = channel;
    channel = null;
    c.unsub?.();
    clearTimeout(publishTimer);
    publishTimer = null;
    onDisconnect(c.connRef).cancel().catch(() => {});
    remove(c.connRef).catch(() => {});
    if (following) stopFollowing();
    asking = null;
    answeredAsks.clear();
    render();
  }

  // ------------------------------------------------------------ publishing
  function entry() {
    const u = getUser();
    return {
      uid: u.uid,
      name: String(u.displayName || u.email || 'Guest').slice(0, 80),
      color: colorForUser(u.uid),
      branch: getBranch() || null,
      file: where.file || null,
      shared: !!where.shared,
      top: Math.max(1, where.top || 1),
      line: Math.max(1, where.line || 1),
      following: following?.conn || null,
      followMe: asking,
      at: serverTimestamp()
    };
  }

  function publishNow() {
    clearTimeout(publishTimer);
    publishTimer = null;
    if (!channel || !getUser()) return;
    set(channel.connRef, entry()).catch(() => {});
  }

  function setWhere(w) {
    const next = { file: w?.file || null, shared: !!w?.shared, top: w?.top || 1, line: w?.line || 1 };
    if (next.file === where.file && next.shared === where.shared && next.top === where.top && next.line === where.line) return;
    where = next;
    if (!channel || publishTimer) return;
    publishTimer = setTimeout(publishNow, PUBLISH_MS);
  }

  // ------------------------------------------------------------ peers changed
  function changed() {
    if (following) {
      const peer = channel.peers.get(following.conn);
      if (!peer) stopFollowing(`${following.name} left, so you stopped following`);
      else follow(peer);
    }
    for (const [conn, p] of channel.peers) {
      if (!p.followMe) { answeredAsks.delete(conn); continue; }
      if (answeredAsks.get(conn) === p.followMe) continue;
      answeredAsks.set(conn, p.followMe);
      if (following?.conn !== conn) promptToFollow(conn, p);
    }
    render();
    onPeersChanged();
  }

  let prompting = false;
  async function promptToFollow(conn, p) {
    if (prompting) return;
    prompting = true;
    try {
      const yes = await confirmDialog({ title: `${p.name} asks everyone to follow them`, message: 'Your editor will go where they go. Typing, scrolling or clicking in it stops following.', confirmLabel: 'Follow' });
      const still = channel?.peers.get(conn);
      if (yes && still?.followMe) startFollowing(conn);
    } finally { prompting = false; }
  }

  // ------------------------------------------------------------ following
  let latest = null;
  let applying = false;
  async function follow(peer) {
    latest = peer;
    if (applying) return;
    applying = true;
    try {
      while (latest && following) {
        const p = latest;
        latest = null;
        await applyOnce(p);
      }
    } finally { applying = false; }
  }

  async function applyOnce(p) {
    const f = following;
    if (!groupAlive(f.groupId)) { stopFollowing(); return; }
    const mine = getBranch() || null;
    let note = '';
    if (p.branch && mine && p.branch !== mine) note = `${p.name} is on branch ${p.branch}`;
    else if (!p.file) note = `${p.name} has no file open`;
    else if (!p.shared) note = `${p.name} is in ${p.file}, which isn't shared`;
    setNote(note);
    if (note) return;
    driving++;
    try { await followInGroup(f.groupId, p.file, { top: p.top, line: p.line }); }
    catch { setNote(`Couldn't open ${p.file}`); }
    finally { driving--; }
  }

  function startFollowing(conn, groupId = focusedGroupId()) {
    const p = channel?.peers.get(conn);
    if (!p) return;
    if (groupId == null || !groupAlive(groupId)) { toast('Open a file first, then follow someone.', 'error'); return; }
    if (following) stopFollowing();
    const gel = groupEl(groupId);
    gel.classList.add('is-following');
    gel.style.setProperty('--follow-c', p.color || colorForUser(p.uid));
    gel.insertAdjacentHTML('beforeend', `<div class="follow-pill" style="--follow-c:${esc(p.color || colorForUser(p.uid))}">
      <span class="follow-pill__dot"></span><span>Following <b>${esc(p.name)}</b></span><span class="follow-pill__note"></span>
      <button type="button" class="follow-pill__stop" title="Stop following (Esc)">Stop</button></div>`);
    // anything I do myself in that group stops following
    const stop = (e) => { if (!driving && following && e.isTrusted !== false) stopFollowing(); };
    const opts = { capture: true };
    for (const t of ['keydown', 'wheel', 'mousedown', 'touchstart']) gel.addEventListener(t, stop, opts);
    following = {
      conn, groupId, name: p.name, color: p.color,
      off: () => {
        for (const t of ['keydown', 'wheel', 'mousedown', 'touchstart']) gel.removeEventListener(t, stop, opts);
        gel.classList.remove('is-following');
        gel.style.removeProperty('--follow-c');
        gel.querySelector('.follow-pill')?.remove();
      }
    };
    publishNow();
    render();
    follow(p);
  }

  function stopFollowing(message) {
    if (!following) return;
    const f = following;
    following = null;
    latest = null;
    f.off();
    publishNow();
    render();
    if (message) toast(message);
  }

  function setNote(text) {
    const n = following && groupEl(following.groupId)?.querySelector('.follow-pill__note');
    if (n) { n.textContent = text ? ` · ${text}` : ''; n.parentElement.classList.toggle('has-note', !!text); }
  }

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && following && !driving) stopFollowing(); });

  // ------------------------------------------------------------ follow me
  function askAll() {
    if (!channel) { toast('Follow me works in cloud projects and live sessions.', 'error'); return; }
    if (!channel.peers.size) { toast('Nobody else is here yet.', 'error'); return; }
    asking = Date.now();
    publishNow();
    render();
    toast('Asked everyone to follow you');
  }
  function stopAsking() {
    if (!asking) return;
    asking = null;
    publishNow();
    render();
  }

  // ------------------------------------------------------------ footer strip
  function people() {
    if (!channel) return [];
    const byUid = new Map();
    for (const [conn, p] of channel.peers) {
      const prev = byUid.get(p.uid);
      // one avatar per person: the window they used last
      if (!prev || (p.at || 0) > (prev.p.at || 0)) byUid.set(p.uid, { conn, p });
    }
    return [...byUid.values()];
  }

  function render() {
    if (!channel) { el.innerHTML = ''; return; }
    const list = people();
    const followers = [...channel.peers.values()].filter((p) => p.following === channel.conn).length;
    el.innerHTML = list.map(({ conn, p }) => {
      const on = following?.conn === conn;
      const where = p.file ? (p.shared ? p.file : `${p.file} (not shared)`) : 'no file open';
      return `<button type="button" class="presence-avatar follow-av ${on ? 'is-followed' : ''}" data-conn="${esc(conn)}" style="background:${esc(p.color || colorForUser(p.uid))}"
        title="${esc(p.name)} · ${esc(where)}${on ? ' — click to stop following' : ' — click to follow'}">${esc(initials(p.name))}</button>`;
    }).join('') + (list.length ? `
      <span class="follow-meta">${followers ? `<span class="follow-count">${followers} following you</span>` : ''}
      <button type="button" class="footbtn follow-me ${asking ? 'is-on' : ''}" data-follow-me title="${asking ? 'Stop asking everyone to follow you' : 'Ask everyone to follow you'}">${asking ? 'Stop follow me' : 'Follow me'}</button></span>` : '');
  }

  el.addEventListener('click', (e) => {
    const av = e.target.closest('[data-conn]');
    if (av) {
      if (following?.conn === av.dataset.conn) stopFollowing();
      else startFollowing(av.dataset.conn);
      return;
    }
    if (e.target.closest('[data-follow-me]')) (asking ? stopAsking() : askAll());
  });

  return {
    setChannel,
    setWhere,
    // the user opened a file themselves
    userAction: () => { if (following && !driving) stopFollowing(); },
    groupClosed: (id) => { if (following?.groupId === id) stopFollowing(); },
    stopFollowing: () => stopFollowing(),
    askAll,
    stopAsking,
    isAsking: () => !!asking,
    isFollowing: () => !!following,
    active: () => !!channel,
    people: () => people().map(({ p }) => p)
  };
}
