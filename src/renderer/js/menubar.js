// VS Code-style menu bar in the title bar (File, Edit, Selection, …).
// Menus are data: shell.js passes a definition whose items point at real
// app actions — nothing is listed until the feature behind it exists.
//
// item: { label, kbd?, run(), enabled?() => bool, danger? }  |  '-' (divider)
// Behaviour mirrors desktop menu bars: click opens, hovering another title
// while one is open switches to it, ←/→ move between menus, ↑/↓/Enter/Esc
// work inside a menu.
export function initMenubar(host, menus) {
  let openIndex = -1;
  let cursor = -1;
  let dropdown = null;

  host.innerHTML = menus.map((m, i) => `<button type="button" class="menubar__title" data-menu="${i}" aria-haspopup="true">${m.label}</button>`).join('');
  const titles = [...host.querySelectorAll('.menubar__title')];

  function items(i) { return menus[i].items; }
  function isEnabled(it) { return it !== '-' && (!it.enabled || it.enabled()); }

  function close() {
    if (dropdown) dropdown.remove();
    dropdown = null;
    titles.forEach((t) => t.classList.remove('is-open'));
    openIndex = -1;
    cursor = -1;
  }

  function paint() {
    if (!dropdown) return;
    dropdown.querySelectorAll('.menubar__item').forEach((el) => el.classList.toggle('is-cursor', Number(el.dataset.i) === cursor));
  }

  function open(i) {
    close();
    openIndex = i;
    titles[i].classList.add('is-open');

    dropdown = document.createElement('div');
    dropdown.className = 'menubar__menu';
    dropdown.setAttribute('role', 'menu');
    dropdown.innerHTML = items(i).map((it, idx) => {
      if (it === '-') return '<div class="menu-divider"></div>';
      const on = isEnabled(it);
      return `<button type="button" role="menuitem" class="menubar__item ${it.danger ? 'danger' : ''}" data-i="${idx}" ${on ? '' : 'disabled'}>
        <span class="menubar__label"></span>${it.kbd ? `<span class="menubar__kbd">${it.kbd}</span>` : ''}
      </button>`;
    }).join('');
    // labels via textContent (never HTML)
    dropdown.querySelectorAll('.menubar__item').forEach((el) => { el.querySelector('.menubar__label').textContent = items(i)[Number(el.dataset.i)].label; });

    const r = titles[i].getBoundingClientRect();
    dropdown.style.left = `${r.left}px`;
    dropdown.style.top = `${r.bottom + 4}px`;
    document.body.appendChild(dropdown);
    const overflow = dropdown.getBoundingClientRect().right - (window.innerWidth - 8);
    if (overflow > 0) dropdown.style.left = `${r.left - overflow}px`;

    dropdown.addEventListener('click', (e) => {
      const el = e.target.closest('.menubar__item');
      if (!el || el.disabled) return;
      run(Number(el.dataset.i));
    });
    dropdown.addEventListener('pointermove', (e) => {
      const el = e.target.closest('.menubar__item');
      if (el && !el.disabled) { cursor = Number(el.dataset.i); paint(); }
    });
  }

  function run(idx) {
    const it = items(openIndex)[idx];
    close();
    // let the menu disappear (and focus return) before the action runs —
    // editor actions need the editor focused, not the menu button
    setTimeout(() => it.run(), 0);
  }

  function step(dir) {
    const list = items(openIndex);
    let i = cursor;
    for (let n = 0; n < list.length; n++) {
      i = (i + dir + list.length) % list.length;
      if (isEnabled(list[i])) { cursor = i; paint(); return; }
    }
  }

  titles.forEach((t, i) => {
    t.addEventListener('click', (e) => { e.stopPropagation(); openIndex === i ? close() : open(i); });
    t.addEventListener('pointerenter', () => { if (openIndex !== -1 && openIndex !== i) open(i); });
  });

  document.addEventListener('pointerdown', (e) => {
    if (openIndex === -1) return;
    if (dropdown?.contains(e.target) || host.contains(e.target)) return;
    close();
  }, true);

  document.addEventListener('keydown', (e) => {
    if (openIndex === -1) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); const t = titles[openIndex]; close(); t.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); open((openIndex + 1) % menus.length); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); open((openIndex - 1 + menus.length) % menus.length); }
    else if (e.key === 'Enter' && cursor !== -1) { e.preventDefault(); run(cursor); }
  }, true);

  window.addEventListener('resize', close);
  window.addEventListener('blur', close);

  return { close, isOpen: () => openIndex !== -1 };
}
