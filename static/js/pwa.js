/* CloudVault PWA bootstrap — SW registration + install prompt + connection toasts */
(function () {
  'use strict';

  // Register service worker (only over HTTPS or localhost)
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function (err) {
        console.warn('[pwa] sw register failed', err);
      });
    });
  }

  // Capture install prompt (Android/Chrome)
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    const btn = document.querySelector('[data-install-app]');
    if (btn) {
      btn.hidden = false;
      btn.addEventListener('click', async function () {
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        await deferredPrompt.userChoice;
        deferredPrompt = null;
        btn.hidden = true;
      }, { once: true });
    }
  });

  window.addEventListener('appinstalled', function () {
    const btn = document.querySelector('[data-install-app]');
    if (btn) btn.hidden = true;
    deferredPrompt = null;
  });

  // Online/offline toasts
  function toast(text, kind) {
    let el = document.getElementById('cv-net-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'cv-net-toast';
      el.className = 'cv-net-toast';
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.dataset.kind = kind || 'info';
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove('show'); }, 3000);
  }
  window.addEventListener('offline', function () { toast('You\'re offline — changes will resume when reconnected', 'warn'); });
  window.addEventListener('online', function () { toast('Back online', 'ok'); });
})();
