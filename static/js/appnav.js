/* CloudVault app nav — user-menu dropdown behavior */
(function () {
  'use strict';

  const btn = document.getElementById('appnavAvatarBtn');
  const menu = document.getElementById('appnavMenu');
  if (!btn || !menu) return;

  function open() {
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => menu.classList.add('shown'));
  }
  function close() {
    menu.classList.remove('shown');
    btn.setAttribute('aria-expanded', 'false');
    // Allow CSS transition to finish before fully hiding
    setTimeout(() => { menu.hidden = true; }, 150);
  }
  function isOpen() { return !menu.hidden; }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    isOpen() ? close() : open();
  });

  document.addEventListener('click', (e) => {
    if (isOpen() && !menu.contains(e.target) && e.target !== btn) close();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) { close(); btn.focus(); }
  });

  // Close after clicking a menu item (gives instant feedback even if nav is slow)
  menu.querySelectorAll('a').forEach((a) => a.addEventListener('click', close));
})();
