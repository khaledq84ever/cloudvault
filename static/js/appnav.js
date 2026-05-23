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

// ---------- Route prefetch on hover ----------
// Fetch the next page's HTML when the user hovers/focuses a same-origin
// link. The browser caches the response, so the actual click resolves
// from cache and feels instant. Idempotent: each URL is fetched at most
// once per session.
(function initRoutePrefetch() {
  if (!('IntersectionObserver' in window)) return;
  const prefetched = new Set();
  // Skip on cellular / data-saver / very slow connections.
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (conn && (conn.saveData || /(2|slow-2|3)g/.test(conn.effectiveType || ''))) return;
  function prefetch(url) {
    if (prefetched.has(url)) return;
    prefetched.add(url);
    // Use a <link rel=prefetch> so the browser handles cache + priority.
    const l = document.createElement('link');
    l.rel = 'prefetch'; l.href = url; l.as = 'document';
    document.head.appendChild(l);
  }
  function maybe(e) {
    const a = e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href');
    // Same-origin, non-hash, non-mailto, non-download.
    if (!href || href.startsWith('#') || href.startsWith('mailto:')) return;
    if (a.hasAttribute('download') || a.target === '_blank') return;
    try {
      const url = new URL(href, location.href);
      if (url.origin !== location.origin) return;
      // Skip API + share endpoints (rendering them isn't useful pre-click).
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/s/')) return;
      prefetch(url.pathname + url.search);
    } catch {}
  }
  document.addEventListener('mouseover', maybe, { passive: true });
  document.addEventListener('focusin', maybe, { passive: true });
  document.addEventListener('touchstart', maybe, { passive: true });
})();
