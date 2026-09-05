import { watchAuthState, signIn, signUp, signInWithGoogle } from './firebase.js';
import { backArrowIconSvg } from './icons.js';

document.getElementById('back-to-dashboard-icon').innerHTML = backArrowIconSvg();
document.getElementById('back-to-dashboard-btn').addEventListener('click', () => {
  window.location.href = 'dashboard.html';
});

const form = document.getElementById('login-form');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');
const nameInput = document.getElementById('display-name');
const errorEl = document.getElementById('error');
const submitBtn = document.getElementById('submit-btn');
const googleBtn = document.getElementById('google-btn');
const toggleModeBtn = document.getElementById('toggle-mode');
const title = document.getElementById('title');

let mode = 'signin'; // or 'signup'

// Already-authenticated users shouldn't see the login form at all.
watchAuthState((user) => {
  if (user) window.location.href = 'dashboard.html';
});

toggleModeBtn.addEventListener('click', () => {
  mode = mode === 'signin' ? 'signup' : 'signin';
  title.textContent = mode === 'signin' ? 'Sign in to MulTeam' : 'Create your MulTeam account';
  submitBtn.textContent = mode === 'signin' ? 'Sign in' : 'Sign up';
  toggleModeBtn.textContent = mode === 'signin' ? "Don't have an account? Sign up" : 'Have an account? Sign in';
  nameInput.parentElement.hidden = mode !== 'signup';
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorEl.textContent = '';
  submitBtn.disabled = true;

  try {
    if (mode === 'signin') {
      await signIn(emailInput.value, passwordInput.value);
    } else {
      await signUp(emailInput.value, passwordInput.value, nameInput.value);
    }
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    submitBtn.disabled = false;
  }
});

googleBtn.addEventListener('click', async () => {
  errorEl.textContent = '';
  try {
    await signInWithGoogle();
  } catch (err) {
    errorEl.textContent = err.message;
  }
});
