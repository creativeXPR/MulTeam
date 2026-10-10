// App-styled replacement for native <select> popups (which render in the OS
// style). The real <select> stays in the DOM, hidden, as the source of truth:
// existing code keeps reading .value and listening for 'change'. A pill
// button shows the current choice; the menu is a floating list that flips
// upward when there's no room below.
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 13 4 4L19 7"/></svg>';
const CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';

let openMenu = null; // { close } of the menu currently showing

function enhance(select) {
  if (select.dataset.enhanced) return;
  select.dataset.enhanced = '1';
  select.classList.add('cselect__native');

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `cselect ${select.classList.contains('sm') ? 'sm' : ''}`;
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.title = select.title || '';
  btn.innerHTML = `<span class="cselect__label"></span><span class="cselect__chev">${CHEVRON}</span>`;
  select.insertAdjacentElement('afterend', btn);
  const labelEl = btn.querySelector('.cselect__label');

  function refresh() {
    const opt = select.options[select.selectedIndex];
    labelEl.textContent = opt ? opt.textContent : '';
    btn.disabled = select.options.length === 0;
  }

  function choose(index) {
    if (index !== select.selectedIndex) {
      select.selectedIndex = index;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    refresh();
  }

  function open() {
    if (openMenu) openMenu.close();
    refresh();

    const menu = document.createElement('div');
    menu.className = 'cselect__menu';
    menu.setAttribute('role', 'listbox');
    menu.innerHTML = [...select.options].map((o, i) => `
      <button type="button" role="option" class="cselect__opt ${i === select.selectedIndex ? 'is-sel' : ''}" data-i="${i}" aria-selected="${i === select.selectedIndex}">
        <span class="cselect__check">${i === select.selectedIndex ? CHECK : ''}</span><span></span>
      </button>`).join('');
    [...select.options].forEach((o, i) => { menu.children[i].lastElementChild.textContent = o.textContent; });
    document.body.appendChild(menu);

    // position: below the button, or above it when there isn't room
    const r = btn.getBoundingClientRect();
    const mh = menu.offsetHeight;
    const below = window.innerHeight - r.bottom;
    menu.style.minWidth = `${Math.max(r.width, 150)}px`;
    menu.style.left = `${Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)}px`;
    if (below < mh + 12 && r.top > below) {
      menu.style.top = `${r.top - mh - 4}px`;
      menu.classList.add('up');
    } else {
      menu.style.top = `${r.bottom + 4}px`;
    }

    let cursor = Math.max(0, select.selectedIndex);
    const opts = [...menu.querySelectorAll('.cselect__opt')];
    const paint = () => opts.forEach((o, i) => o.classList.toggle('is-cursor', i === cursor));
    paint();

    const onKey = (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); cursor = Math.min(opts.length - 1, cursor + 1); paint(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); cursor = Math.max(0, cursor - 1); paint(); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(cursor); close(); }
      else if (e.key === 'Escape' || e.key === 'Tab') { e.stopPropagation(); close(); }
    };
    const onDown = (e) => { if (!menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) close(); };
    const onScroll = (e) => { if (!menu.contains(e.target)) close(); };

    function close() {
      menu.remove();
      btn.classList.remove('is-open');
      btn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('resize', close);
      document.removeEventListener('scroll', onScroll, true);
      if (openMenu && openMenu.close === close) openMenu = null;
    }

    menu.addEventListener('click', (e) => {
      const o = e.target.closest('.cselect__opt');
      if (!o) return;
      choose(Number(o.dataset.i));
      close();
      btn.focus();
    });
    menu.addEventListener('pointermove', (e) => {
      const o = e.target.closest('.cselect__opt');
      if (o) { cursor = Number(o.dataset.i); paint(); }
    });
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('resize', close);
    document.addEventListener('scroll', onScroll, true);

    btn.classList.add('is-open');
    btn.setAttribute('aria-expanded', 'true');
    openMenu = { close };
  }

  btn.addEventListener('click', () => (btn.classList.contains('is-open') ? openMenu?.close() : open()));
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); }
  });

  // options added later (e.g. the shell list loads async) or value set in code
  new MutationObserver(refresh).observe(select, { childList: true, subtree: true, attributes: true });
  select.addEventListener('change', refresh);
  select.refreshCustom = refresh;
  refresh();
}

export function enhanceSelects(root = document) {
  root.querySelectorAll('select.pill').forEach(enhance);
}
