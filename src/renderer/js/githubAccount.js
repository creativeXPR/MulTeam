// GitHub account in the app (collaboration stage 2.3): the connect dialog
// (device flow — approve MulTeam on github.com with a short code) and the
// Settings → Accounts row. The login itself stays in the main process.
export function initGitHubAccount({ toast, escapeHtml }) {
  const gh = window.electronAPI.github;
  let state = { connected: false };
  const listeners = new Set();
  const emit = () => { renderRow(); listeners.forEach((fn) => fn(state)); };

  document.body.insertAdjacentHTML('beforeend', `
    <div class="modal-overlay" id="gh-modal" hidden>
      <div class="modal-card gh-card" role="dialog" aria-labelledby="gh-title">
        <h2 id="gh-title">Connect GitHub</h2>
        <p class="modal-sub" id="gh-why">MulTeam uses your GitHub login to clone, pull and push repositories you have access to.</p>
        <div class="gh-steps" id="gh-steps" hidden>
          <p class="gh-step">1. Copy this code</p>
          <div class="gh-code" id="gh-code">····-····</div>
          <p class="gh-step">2. Paste it on GitHub and approve MulTeam</p>
          <button type="button" class="primary" id="gh-open">Copy code &amp; open GitHub</button>
          <p class="gh-wait"><span class="btn-spinner" aria-hidden="true"></span> Waiting for you to approve on GitHub…</p>
        </div>
        <p class="error-text" id="gh-error"></p>
        <div class="modal-actions">
          <button type="button" class="secondary" id="gh-cancel">Cancel</button>
          <button type="button" class="primary" id="gh-start">Continue</button>
        </div>
        <p class="field-hint gh-note">Your GitHub login is stored encrypted on this computer only, never in the cloud. Disconnect any time in Settings, or revoke it on GitHub → Settings → Applications.</p>
      </div>
    </div>`);
  const $ = (id) => document.getElementById(id);
  const modal = $('gh-modal');
  let flow = null;
  let resolveConnect = null;

  function close(result) {
    if (flow) gh.cancel();
    flow = null;
    modal.hidden = true;
    const r = resolveConnect;
    resolveConnect = null;
    r?.(result);
  }

  async function begin() {
    $('gh-error').textContent = '';
    $('gh-start').hidden = true;
    try {
      flow = await gh.start();
      $('gh-code').textContent = flow.userCode;
      $('gh-steps').hidden = false;
      const current = flow;
      const res = await gh.finish(flow.flowId);
      if (flow !== current) return;
      flow = null;
      state = res;
      emit();
      toast(`GitHub connected as @${res.login}`);
      close(true);
    } catch (err) {
      if (!resolveConnect) return; // cancelled
      flow = null;
      $('gh-steps').hidden = true;
      $('gh-start').hidden = false;
      $('gh-start').textContent = 'Try again';
      $('gh-error').textContent = String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    }
  }

  // Opens the dialog; resolves true once connected, false if cancelled.
  function connect(reason) {
    if (resolveConnect) return Promise.resolve(false);
    $('gh-why').textContent = reason || 'MulTeam uses your GitHub login to clone, pull and push repositories you have access to.';
    $('gh-steps').hidden = true;
    $('gh-start').hidden = false;
    $('gh-start').textContent = 'Continue';
    $('gh-error').textContent = '';
    modal.hidden = false;
    return new Promise((resolve) => { resolveConnect = resolve; });
  }

  $('gh-start').addEventListener('click', begin);
  $('gh-cancel').addEventListener('click', () => close(false));
  $('gh-open').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('gh-code').textContent); } catch { /* still open GitHub */ }
    gh.openVerify();
  });

  // ---- Settings → Accounts ----
  const row = document.getElementById('githubAccountRow');
  function renderRow() {
    if (!row) return;
    const ctl = row.querySelector('.set-row__ctl');
    const txt = row.querySelector('.set-row__txt span');
    if (state.connected) {
      txt.innerHTML = `Connected as <b>@${escapeHtml(state.login)}</b>`;
      ctl.innerHTML = `${state.avatar ? `<img class="gh-avatar" src="${escapeHtml(state.avatar)}" alt="" />` : ''}<button type="button" class="secondary sm" data-gh="disconnect">Disconnect</button>`;
    } else {
      txt.textContent = 'Clone, pull and push your repositories';
      ctl.innerHTML = '<button type="button" class="primary sm" data-gh="connect">Connect GitHub</button>';
    }
  }
  row?.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-gh]');
    if (!b) return;
    if (b.dataset.gh === 'connect') connect();
    if (b.dataset.gh === 'disconnect') {
      await gh.disconnect();
      state = { connected: false };
      emit();
      toast('GitHub disconnected. To fully revoke it, remove MulTeam under GitHub → Settings → Applications.');
    }
  });

  gh.status().then((s) => { state = s; emit(); }).catch(() => {});

  return {
    connect,
    status: () => state,
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); }
  };
}
