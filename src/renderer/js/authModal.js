// A login form rendered as a modal overlay, injected into whichever page
// needs it on first use. This exists so a cloud action (toggling a project
// to cloud sync, etc.) can ask for sign-in without a full page navigation to
// login.html — a navigation would lose in-progress modal state (typed
// project name, chosen folder, toggle position).
import { auth, signIn, signUp, signInWithGoogle } from './firebase.js';

let modalEl = null;
let mode = 'signin';
let onSuccess = null;

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
      <div class="modal-actions">
        <button type="button" class="secondary" id="auth-modal-cancel">Cancel</button>
        <button type="submit" class="primary" id="auth-modal-submit">Sign in</button>
      </div>
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
  el.hidden = true;
  el.querySelector('#auth-modal-error').textContent = '';
  el.querySelector('form').reset();
  onSuccess = null;
}

function wire(el) {
  const form = el.querySelector('form');
  const errorEl = el.querySelector('#auth-modal-error');
  const submitBtn = el.querySelector('#auth-modal-submit');

  el.querySelector('#auth-modal-cancel').addEventListener('click', () => close(el));
  el.addEventListener('click', (e) => {
    if (e.target === el) close(el);
  });

  el.querySelector('#auth-modal-toggle').addEventListener('click', () => {
    setMode(el, mode === 'signin' ? 'signup' : 'signin');
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';
    submitBtn.disabled = true;

    try {
      const email = el.querySelector('#auth-modal-email').value;
      const password = el.querySelector('#auth-modal-password').value;
      if (mode === 'signin') {
        await signIn(email, password);
      } else {
        await signUp(email, password, el.querySelector('#auth-modal-name').value);
      }
      const callback = onSuccess;
      close(el);
      if (callback) callback();
    } catch (err) {
      errorEl.textContent = err.message;
    } finally {
      submitBtn.disabled = false;
    }
  });

  el.querySelector('#auth-modal-google').addEventListener('click', async () => {
    errorEl.textContent = '';
    try {
      await signInWithGoogle();
      const callback = onSuccess;
      close(el);
      if (callback) callback();
    } catch (err) {
      errorEl.textContent = err.message;
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
