// A login form rendered as a modal overlay, injected into the page on first
// use. This exists so a cloud action (toggling a project to cloud sync,
// etc.) can ask for sign-in without switching to the dedicated auth view —
// that switch would lose in-progress modal state (typed project name,
// chosen folder, toggle position) that this overlay preserves instead.
import { auth, signIn, signUp, signInWithGoogle } from './firebase.js';

let modalEl = null;
let mode = 'signin';
let onSuccess = null;
let busy = false;

// Firebase's errors ("Firebase: Error (auth/wrong-password).") in plain words.
// null = not an error worth showing (the person closed the Google window).
function friendlyError(err) {
  const code = err?.code || (/\(([^)]+)\)/.exec(err?.message || '') || [])[1] || '';
  const map = {
    'auth/popup-closed-by-user': null,
    'auth/cancelled-popup-request': null,
    'auth/user-cancelled': null,
    'auth/popup-blocked': 'The Google sign-in window was blocked. Try again.',
    'auth/invalid-credential': 'Wrong email or password.',
    'auth/wrong-password': 'Wrong email or password.',
    'auth/user-not-found': 'No account with that email. Sign up instead?',
    'auth/invalid-email': "That email address doesn't look right.",
    'auth/email-already-in-use': 'An account with that email already exists. Sign in instead.',
    'auth/weak-password': 'Use a password with at least 6 characters.',
    'auth/too-many-requests': 'Too many attempts. Wait a minute and try again.',
    'auth/network-request-failed': "Couldn't reach the sign-in service. Check your connection.",
    'auth/account-exists-with-different-credential': 'This email is already registered with a different sign-in method.'
  };
  if (code in map) return map[code];
  const text = String(err?.message || err).replace(/^Firebase: /, '').replace(/\s*\(auth\/[^)]+\)\.?$/, '').trim();
  if (!text || /^error$/i.test(text)) return `Sign-in failed${code ? ` (${code.replace(/^auth\//, '')})` : ''}. Try again.`;
  return text;
}

// While signing in: everything is locked and the clicked button shows a
// spinner, so a second popup / double submit can't start.
function setBusy(el, btn, label) {
  busy = !!btn;
  el.querySelectorAll('input, button').forEach((c) => { c.disabled = busy; });
  el.querySelector('.modal-card').classList.toggle('is-busy', busy);
  if (btn) {
    btn.dataset.label = btn.textContent;
    btn.innerHTML = `<span class="btn-spinner" aria-hidden="true"></span><span></span>`;
    btn.lastChild.textContent = label;
  } else {
    el.querySelectorAll('button[data-label]').forEach((b) => { b.textContent = b.dataset.label; delete b.dataset.label; });
  }
}

function build() {
  const el = document.createElement('div');
  el.className = 'modal-overlay';
  el.hidden = true;
  el.innerHTML = `
    <form class="modal-card">
      <h2 id="auth-modal-title">Sign in to continue</h2>
      <p class="modal-sub">Cloud sync needs an account so collaborators can find your project.</p>
      <div class="field" id="auth-modal-name-field" hidden>
        <label for="auth-modal-name">Name</label>
        <input id="auth-modal-name" type="text" autocomplete="name" />
      </div>
      <div class="field">
        <label for="auth-modal-email">Email</label>
        <input id="auth-modal-email" type="email" autocomplete="email" required />
      </div>
      <div class="field">
        <label for="auth-modal-password">Password</label>
        <input id="auth-modal-password" type="password" autocomplete="current-password" required minlength="6" />
      </div>
      <p class="error-text" id="auth-modal-error"></p>
      <button type="submit" class="primary" id="auth-modal-submit">Sign in</button>
      <button type="button" class="secondary" id="auth-modal-google">Continue with Google</button>
      <button type="button" class="secondary" id="auth-modal-toggle">Don't have an account? Sign up</button>
    </form>
  `;
  document.body.appendChild(el);
  wire(el);
  return el;
}

function setMode(el, next) {
  mode = next;
  el.querySelector('#auth-modal-title').textContent = mode === 'signin' ? 'Sign in to continue' : 'Create your account';
  el.querySelector('#auth-modal-submit').textContent = mode === 'signin' ? 'Sign in' : 'Sign up';
  el.querySelector('#auth-modal-toggle').textContent =
    mode === 'signin' ? "Don't have an account? Sign up" : 'Have an account? Sign in';
  el.querySelector('#auth-modal-name-field').hidden = mode !== 'signup';
}

function close(el) {
  if (busy) return; // finish or abort the sign-in first
  el.hidden = true;
  el.querySelector('#auth-modal-error').textContent = '';
  el.querySelector('form').reset();
  onSuccess = null;
}

function wire(el) {
  const form = el.querySelector('form');
  const errorEl = el.querySelector('#auth-modal-error');
  const submitBtn = el.querySelector('#auth-modal-submit');

  el.addEventListener('click', (e) => {
    if (e.target === el) close(el);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.hidden) close(el);
  });

  el.querySelector('#auth-modal-toggle').addEventListener('click', () => {
    setMode(el, mode === 'signin' ? 'signup' : 'signin');
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    errorEl.textContent = '';
    setBusy(el, submitBtn, mode === 'signin' ? 'Signing in…' : 'Creating account…');

    try {
      const email = el.querySelector('#auth-modal-email').value;
      const password = el.querySelector('#auth-modal-password').value;
      if (mode === 'signin') {
        await signIn(email, password);
      } else {
        await signUp(email, password, el.querySelector('#auth-modal-name').value);
      }
      setBusy(el, null);
      const callback = onSuccess;
      close(el);
      if (callback) callback();
    } catch (err) {
      setBusy(el, null);
      errorEl.textContent = friendlyError(err) || '';
    }
  });

  // If the Google window is closed without signing in, unlock right away
  // (Firebase itself takes ~8s to report it); a successful sign-in resolves
  // well within the grace period.
  let googleAttempt = 0;
  window.electronAPI?.onAuthPopupClosed?.(() => {
    const attempt = googleAttempt;
    setTimeout(() => { if (busy && attempt === googleAttempt && !auth.currentUser) { googleAttempt++; setBusy(el, null); } }, 1200);
  });

  el.querySelector('#auth-modal-google').addEventListener('click', async (e) => {
    if (busy) return;
    errorEl.textContent = '';
    const attempt = ++googleAttempt;
    setBusy(el, e.currentTarget, 'Waiting for Google…');
    try {
      await signInWithGoogle();
      if (attempt !== googleAttempt && !auth.currentUser) return;
      setBusy(el, null);
      const callback = onSuccess;
      close(el);
      if (callback) callback();
    } catch (err) {
      if (attempt !== googleAttempt) return; // already unlocked when the window closed
      setBusy(el, null);
      errorEl.textContent = friendlyError(err) || '';
    }
  });
}

// If already signed in, calls `callback` immediately. Otherwise opens the
// modal and calls it once sign-in succeeds. Never calls it at all if the
// user cancels.
export function requireAuth(callback) {
  if (auth.currentUser) {
    callback();
    return;
  }

  const el = modalEl || (modalEl = build());
  setMode(el, 'signin');
  onSuccess = callback;
  el.hidden = false;
  el.querySelector('#auth-modal-email').focus();
}

// For an explicit "Sign in" action with no pending task to resume — e.g.
// the profile menu's Sign in item, or the command palette. Same overlay,
// just no callback to chain afterward.
export function openSignIn() {
  requireAuth(() => {});
}
