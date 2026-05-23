// CloudVault — pro drive (chunked uploads, thumbs, tags, SSE, mobile)
const state = {
  view: 'my', folder: null, tagId: null,
  search: '', sort: 'date', order: 'desc',
  layout: localStorage.getItem('cv_layout') || 'list',
  files: [], folders: [], tags: [],
  selected: new Set(),
  lastFocus: null, moveTarget: null,
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const ICONS = {
  folder: '📁', image: '🖼', video: '🎬', audio: '🎵', pdf: '📕',
  doc: '📄', sheet: '📊', slide: '📽', archive: '🗜',
  code: '📝', exec: '⚙', generic: '📄'
};
function classify(name, mime) {
  if (mime?.startsWith('image/')) return 'image';
  if (mime?.startsWith('video/')) return 'video';
  if (mime?.startsWith('audio/')) return 'audio';
  if (mime?.includes('pdf')) return 'pdf';
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['doc','docx','rtf','odt'].includes(ext)) return 'doc';
  if (['xls','xlsx','csv','ods'].includes(ext)) return 'sheet';
  if (['ppt','pptx','odp'].includes(ext)) return 'slide';
  if (['zip','rar','7z','tar','gz','bz2'].includes(ext)) return 'archive';
  if (['js','ts','py','html','css','json','md','c','cpp','java','go','rs','sh','xml','yaml','yml'].includes(ext)) return 'code';
  if (['exe','dmg','apk','msi'].includes(ext)) return 'exec';
  return 'generic';
}
function fmtSize(b) {
  if (b == null) return '—'; if (b === 0) return '0 B';
  const u = ['B','KB','MB','GB','TB']; let i = 0;
  while (b >= 1024 && i < u.length-1) { b /= 1024; i++; }
  return b.toFixed(b < 10 ? 1 : 0) + ' ' + u[i];
}
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso), now = new Date(), diff = (now - d) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff/60) + ' min ago';
  if (diff < 86400) return Math.floor(diff/3600) + ' h ago';
  if (diff < 604800) return Math.floor(diff/86400) + ' d ago';
  return d.toLocaleDateString();
}
function daysSince(iso) {
  if (!iso) return 0;
  return Math.floor((new Date() - new Date(iso)) / 86400000);
}
// Inline SVGs for each toast variant. Kept here (not in HTML) so any
// existing toast(msg, type) call site benefits automatically.
const TOAST_ICONS = {
  success: '<svg class="toast-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  error: '<svg class="toast-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
  warn: '<svg class="toast-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  info: '<svg class="toast-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
};
const TOAST_CLOSE_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
function toast(msg, type='') {
  const t = $('#toast');
  const variant = type || 'info';
  t.className = 'toast ' + (type || '');
  t.innerHTML = `
    ${TOAST_ICONS[variant] || TOAST_ICONS.info}
    <span class="toast-msg"></span>
    <button type="button" class="toast-close" aria-label="Dismiss">${TOAST_CLOSE_SVG}</button>
  `;
  t.querySelector('.toast-msg').textContent = msg;
  t.querySelector('.toast-close').onclick = () => { t.hidden = true; };
  t.hidden = false;
  clearTimeout(window.__toastT);
  // Errors stick around longer — they're usually actionable.
  const dwell = (type === 'error') ? 4500 : 2600;
  window.__toastT = setTimeout(() => { t.hidden = true; }, dwell);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function api(url, opts={}) {
  const res = await fetch(url, { credentials: 'same-origin', ...opts });
  if (!res.ok) {
    const err = await res.json().catch(() => ({error: 'Request failed'}));
    throw new Error(err.error || res.statusText);
  }
  return res.status === 204 ? null : res.json();
}

// ---------- Data ----------
async function loadMe() {
  const me = await api('/api/me');
  // Cache used/quota so pre-upload quota checks don't need a round-trip.
  state.me = { used: me.used, quota: me.quota, max_file: me.max_file };
  $('#uname').textContent = me.name;
  const ue = $('#uemail'); if (ue) ue.textContent = me.email;
  $('#avatar').textContent = (me.name || me.email)[0].toUpperCase();
  const pct = Math.min(100, (me.used / me.quota) * 100);
  $('#barFill').style.width = pct + '%';
  $('#storageText').textContent = `${fmtSize(me.used)} / ${fmtSize(me.quota)} · ${pct.toFixed(0)}%`;
  // Topbar storage chip — visible on mobile where the sidebar is hidden.
  const chip = $('#storageChip');
  const chipFill = $('#storageChipFill');
  const chipText = $('#storageChipText');
  if (chip && chipFill && chipText) {
    chipFill.style.width = pct + '%';
    chipText.textContent = `${fmtSize(me.used)} / ${fmtSize(me.quota)}`;
    chip.classList.toggle('warn', pct >= 80 && pct < 95);
    chip.classList.toggle('danger', pct >= 95);
    chip.title = `Storage: ${pct.toFixed(0)}% used (${fmtSize(me.quota - me.used)} free)`;
  }
  const planEl = $('#ucPlan');
  if (planEl) {
    planEl.textContent = (me.plan_name || 'Free').toUpperCase();
    planEl.className = 'uc-plan ' + (me.plan || 'free');
  }
  const up = $('#ucUpgrade');
  if (up) up.style.display = me.plan === 'business' ? 'none' : '';
  if (pct > 90 && !sessionStorage.getItem('quotaWarned')) {
    toast(`⚠️ Storage ${pct.toFixed(0)}% full — upgrade for more`, 'error');
    sessionStorage.setItem('quotaWarned', '1');
  }
}

async function loadTags() {
  state.tags = await api('/api/tags');
  renderTagsSidebar();
}

function renderTagsSidebar() {
  const wrap = $('#tagsList');
  if (!wrap) return;
  wrap.innerHTML = state.tags.map(t => `
    <a class="side-link tag-link ${state.view==='tag' && state.tagId===t.id ? 'active':''}" data-tag="${t.id}">
      <span class="tag-dot" style="background:${t.color}"></span>${escapeHtml(t.name)}
    </a>
  `).join('') || '<div class="tag-empty">No tags yet</div>';
  $$('.tag-link').forEach(el => el.onclick = (e) => {
    e.preventDefault();
    state.view = 'tag'; state.tagId = parseInt(el.dataset.tag); state.folder = null;
    $$('.side-link').forEach(x => x.classList.remove('active'));
    el.classList.add('active');
    closeDetails();
    loadList();
  });
}

// Stale-while-revalidate cache for /api/files. Renders the cached
// snapshot instantly (no spinner on tab return) then refreshes in the
// background and re-renders only if the payload actually changed.
// localStorage rather than IndexedDB — the payload is small (KB) and
// localStorage is synchronous, so we skip the IDB ceremony.
const LIST_CACHE_PREFIX = 'cv_list_';
const LIST_CACHE_TTL = 1000 * 60 * 30; // 30 min; older than that, ignore.
function _loadListCache(key) {
  try {
    const raw = localStorage.getItem(LIST_CACHE_PREFIX + key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (Date.now() - obj.t > LIST_CACHE_TTL) return null;
    return obj.data;
  } catch { return null; }
}
function _saveListCache(key, data) {
  try { localStorage.setItem(LIST_CACHE_PREFIX + key, JSON.stringify({ t: Date.now(), data })); }
  catch { /* quota — silently ignore, perf optimization not correctness */ }
}
let _lastRenderedKey = '';
function _applyList(data) {
  state.files = data.files; state.folders = data.folders;
  state.selected.clear();
  renderBreadcrumb(data.breadcrumb || []);
  renderPageTitle(data.breadcrumb || []);
  render();
  updateActionBar();
  $('#trashBanner').hidden = state.view !== 'trash';
  // First paint: drop the skeleton placeholder.
  const skel = document.getElementById('gridSkel');
  if (skel) skel.classList.add('done');
}

async function loadList() {
  const p = new URLSearchParams();
  p.set('view', state.view);
  p.set('sort', state.sort);
  p.set('order', state.order);
  if (state.folder) p.set('folder', state.folder);
  if (state.search) p.set('q', state.search);
  if (state.view === 'tag' && state.tagId) p.set('tag', state.tagId);
  const key = p.toString();

  // 1) Render cached data instantly (if any) so the grid isn't blank.
  const cached = _loadListCache(key);
  if (cached) {
    _applyList(cached);
    _lastRenderedKey = JSON.stringify(cached);
  }

  // 2) Fetch fresh data. Only re-render if it differs from what we drew.
  const data = await api('/api/files?' + p);
  _saveListCache(key, data);
  const freshKey = JSON.stringify(data);
  if (freshKey !== _lastRenderedKey) {
    _applyList(data);
    _lastRenderedKey = freshKey;
  }
}

const VIEW_TITLES = {
  my: ['My Drive', 'Everything you own.'],
  recent: ['Recent', 'Files you opened or edited lately.'],
  starred: ['Starred', 'Items you marked for quick access.'],
  shared: ['Shared by me', 'Files you’ve given out via a link.'],
  trash: ['Trash', 'Items here are deleted after 30 days.'],
  tag: ['Tagged', 'Items matching the selected tag.'],
};
function renderPageTitle(crumb) {
  const titleEl = document.getElementById('pageTitle');
  const subEl = document.getElementById('pageSub');
  if (!titleEl) return;
  // Inside a folder: title becomes the folder name and the subtitle
  // becomes the path. At root: use the view-specific copy.
  if (state.folder && crumb.length) {
    const last = crumb[crumb.length - 1];
    titleEl.textContent = last.name || 'Folder';
    subEl.textContent = crumb.map(c => c.name).join(' / ');
  } else {
    const [t, s] = VIEW_TITLES[state.view] || VIEW_TITLES.my;
    titleEl.textContent = t;
    subEl.textContent = s;
  }
}

// ---------- Render ----------
function render() {
  const grid = $('#grid');
  grid.className = state.layout === 'grid' ? 'grid view-grid' : 'grid view-list';
  grid.innerHTML = '';
  const items = [
    ...state.folders.map(f => ({...f, _type: 'folder'})),
    ...state.files.map(f => ({...f, _type: 'file'}))
  ];
  $('#empty').hidden = items.length > 0;

  if (state.layout === 'list') {
    const head = document.createElement('div');
    head.className = 'list-head';
    head.innerHTML = `
      <span class="lh-check"><input type="checkbox" id="selAll"></span>
      <span class="lh-name">Name</span>
      <span class="lh-size">Size</span>
      <span class="lh-date">Modified</span>
      <span class="lh-act"></span>
    `;
    grid.appendChild(head);
  }
  for (const item of items) {
    const node = state.layout === 'grid' ? buildGridCard(item) : buildListRow(item);
    grid.appendChild(node);
  }
  const selAll = $('#selAll');
  if (selAll) selAll.onchange = (e) => {
    items.forEach(i => {
      const key = `${i._type}:${i.id}`;
      e.target.checked ? state.selected.add(key) : state.selected.delete(key);
    });
    render(); updateActionBar();
  };
}

function thumbImg(item, cls) {
  if (item._type !== 'file' || !item.has_thumb) return '';
  const icon = ICONS[classify(item.name, item.mime)] || ICONS.file;
  return `<img class="${cls}" loading="lazy" decoding="async"
    src="/api/files/${item.id}/thumb" alt=""
    data-fallback-icon="${escapeHtml(icon)}" data-fallback-cls="${cls}-fallback">`;
}

// One delegated handler swaps broken thumbnails for their text icon fallback.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement)) return;
  if (!img.dataset.fallbackIcon) return;
  const span = document.createElement('span');
  span.className = img.dataset.fallbackCls || 'thumb-fallback';
  span.textContent = img.dataset.fallbackIcon;
  img.replaceWith(span);
}, true);

function buildGridCard(item) {
  const card = document.createElement('div');
  card.className = 'card';
  if (item._type === 'file' && item.has_thumb) card.classList.add('has-thumb');
  card.dataset.id = item.id; card.dataset.type = item._type;
  const key = `${item._type}:${item.id}`;
  if (state.selected.has(key)) card.classList.add('selected');
  const ico = item._type === 'folder' ? ICONS.folder : ICONS[classify(item.name, item.mime)];
  const meta = item._type === 'folder' ? 'Folder' : fmtSize(item.size);
  const star = item.starred ? '<span class="star-flag">⭐</span>' : '';
  const trashDays = item.trashed_at ? `<span class="days-left">${30 - daysSince(item.trashed_at)} d</span>` : '';
  const thumb = (item._type === 'file' && item.has_thumb)
    ? `<div class="card-thumb">${thumbImg(item, 'card-thumb-img')}</div>`
    : `<div class="card-ico">${ico}</div>`;
  const cardShare = (item._type === 'file' && item.share_url)
    ? `<button class="copy-link-btn card-copy" data-share-url="${escapeHtml(item.share_url)}" title="Copy public link" aria-label="Copy public link">
         <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 1 0-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.5-1.5"/></svg>
       </button>`
    : '';
  card.innerHTML = `
    <input type="checkbox" class="card-check" ${state.selected.has(key) ? 'checked' : ''}>
    ${star}${trashDays}${cardShare}
    ${thumb}
    <div class="card-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
    <div class="card-meta">${meta}</div>
  `;
  wireItem(card, item);
  return card;
}

function buildListRow(item) {
  const row = document.createElement('div');
  row.className = 'list-row';
  row.dataset.id = item.id; row.dataset.type = item._type;
  const key = `${item._type}:${item.id}`;
  if (state.selected.has(key)) row.classList.add('selected');
  const ico = item._type === 'folder' ? ICONS.folder : ICONS[classify(item.name, item.mime)];
  const meta = item._type === 'folder' ? '—' : fmtSize(item.size);
  const star = item.starred ? '<span class="star-mini">⭐</span>' : '';
  const trashDays = item.trashed_at ? `<span class="days-left-row">${30 - daysSince(item.trashed_at)} d left</span>` : '';
  const tagDots = (item.tags || []).slice(0, 3).map(t =>
    `<span class="tag-chip-mini" style="background:${t.color}" title="${escapeHtml(t.name)}"></span>`
  ).join('');
  const thumbCell = (item._type === 'file' && item.has_thumb)
    ? `<span class="row-thumb">${thumbImg(item, 'row-thumb-img')}</span>`
    : `<span class="row-ico">${ico}</span>`;
  const rowShare = (item._type === 'file' && item.share_url)
    ? `<button class="icon-btn copy-link-btn" data-share-url="${escapeHtml(item.share_url)}" title="Copy public link" aria-label="Copy public link">
         <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 1 0-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.5-1.5"/></svg>
       </button>`
    : '';
  row.innerHTML = `
    <span class="lh-check"><input type="checkbox" class="card-check" ${state.selected.has(key) ? 'checked' : ''}></span>
    <span class="lh-name">${thumbCell}<span class="row-name">${escapeHtml(item.name)}</span>${star}${tagDots}${trashDays}</span>
    <span class="lh-size">${meta}</span>
    <span class="lh-date">${fmtDate(item.created_at)}</span>
    <span class="lh-act">${rowShare}<button class="icon-btn row-menu" title="More">⋯</button></span>
  `;
  wireItem(row, item);
  return row;
}

function wireItem(el, item) {
  const key = `${item._type}:${item.id}`;
  const check = el.querySelector('.card-check');
  if (check) check.onclick = (e) => {
    e.stopPropagation();
    check.checked ? state.selected.add(key) : state.selected.delete(key);
    el.classList.toggle('selected', check.checked);
    updateActionBar();
  };
  const menu = el.querySelector('.row-menu');
  if (menu) menu.onclick = (e) => {
    e.stopPropagation();
    pickItem(item);
    const r = menu.getBoundingClientRect();
    openCtx(r.left - 180, r.bottom + 4);
  };
  el.addEventListener('click', (e) => {
    if (e.target.closest('input,button')) return;
    if (e.ctrlKey || e.metaKey) {
      state.selected.has(key) ? state.selected.delete(key) : state.selected.add(key);
      el.classList.toggle('selected'); updateActionBar();
    } else {
      pickItem(item); openDetails(item);
    }
  });
  el.addEventListener('dblclick', () => onOpen(item));
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault(); pickItem(item); openCtx(e.clientX, e.clientY);
  });

  // Long-press for mobile multi-select
  let pressTimer = null;
  el.addEventListener('touchstart', (e) => {
    pressTimer = setTimeout(() => {
      state.selected.add(key); el.classList.add('selected');
      const c = el.querySelector('.card-check'); if (c) c.checked = true;
      updateActionBar();
      if (navigator.vibrate) navigator.vibrate(30);
    }, 500);
  }, {passive: true});
  el.addEventListener('touchend', () => { clearTimeout(pressTimer); pressTimer = null; });
  el.addEventListener('touchmove', () => { clearTimeout(pressTimer); pressTimer = null; });

  // Swipe-left to reveal actions (mobile)
  if (state.layout === 'list') wireSwipe(el, item);

  // Drag to move (hold Ctrl/Alt to copy)
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    if (!state.selected.has(key)) { state.selected.clear(); state.selected.add(key); }
    e.dataTransfer.setData('text/plain', 'cv:items');
    e.dataTransfer.effectAllowed = 'copyMove';
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));

  if (item._type === 'folder') {
    el.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('text/plain') || e.dataTransfer.types.includes('Files')) {
        e.preventDefault();
        const wantCopy = e.ctrlKey || e.metaKey || e.altKey;
        e.dataTransfer.dropEffect = wantCopy ? 'copy' : 'move';
        el.classList.add('drag-into');
        el.classList.toggle('drag-copy', wantCopy);
      }
    });
    el.addEventListener('dragleave', () => {
      el.classList.remove('drag-into');
      el.classList.remove('drag-copy');
    });
    el.addEventListener('drop', async (e) => {
      e.preventDefault(); e.stopPropagation();
      const wantCopy = e.ctrlKey || e.metaKey || e.altKey;
      el.classList.remove('drag-into'); el.classList.remove('drag-copy');
      if (e.dataTransfer.files.length) return uploadFiles(e.dataTransfer.files, item.id);
      if (wantCopy) await bulkCopy(item.id);
      else await bulkMove(item.id);
    });
  }
}

function wireSwipe(row, item) {
  let startX = 0, dx = 0, swiping = false;
  row.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    startX = e.touches[0].clientX; dx = 0; swiping = true;
  }, {passive: true});
  row.addEventListener('touchmove', (e) => {
    if (!swiping) return;
    dx = e.touches[0].clientX - startX;
    if (dx < 0 && dx > -120) row.style.transform = `translateX(${dx}px)`;
  }, {passive: true});
  row.addEventListener('touchend', () => {
    swiping = false;
    if (dx < -80) {
      row.style.transform = 'translateX(-100px)';
      row.classList.add('swiped');
      setTimeout(() => {
        if (row.classList.contains('swiped') && confirm('Move to trash?')) {
          api(`/api/${item._type === 'file' ? 'files' : 'folders'}/${item.id}`, { method:'DELETE' })
            .then(() => { toast('Moved to trash', 'success'); loadList(); loadMe(); });
        }
        row.style.transform = ''; row.classList.remove('swiped');
      }, 1500);
    } else {
      row.style.transform = '';
    }
  });
}

function pickItem(item) {
  state.selected.clear();
  state.selected.add(`${item._type}:${item.id}`);
  $$('.card, .list-row').forEach(c => c.classList.remove('selected'));
  const el = document.querySelector(`[data-id="${item.id}"][data-type="${item._type}"]`);
  if (el) el.classList.add('selected');
  state.lastFocus = item;
  updateActionBar();
}

function renderBreadcrumb(crumbs) {
  const wrap = $('#breadcrumb');
  wrap.innerHTML = `<span class="crumb root" data-folder="">My Drive</span>`;
  for (const c of crumbs) {
    wrap.insertAdjacentHTML('beforeend', `<span class="crumb-sep">›</span><span class="crumb" data-folder="${c.id}">${escapeHtml(c.name)}</span>`);
  }
  $$('.crumb').forEach(el => el.onclick = () => {
    state.folder = el.dataset.folder ? parseInt(el.dataset.folder) : null;
    state.view = 'my';
    $$('.side-link').forEach(x => x.classList.remove('active'));
    $$('[data-view="my"]').forEach(x => x.classList.add('active'));
    loadList();
  });
}

function onOpen(item) {
  if (item._type === 'folder') {
    state.folder = item.id; state.view = 'my';
    $$('.side-link').forEach(x => x.classList.remove('active'));
    $$('[data-view="my"]').forEach(x => x.classList.add('active'));
    loadList();
  } else {
    openPreview(item);
  }
}

// ---------- Action bar ----------
function updateActionBar() {
  const bar = $('#actionBar');
  const n = state.selected.size;
  bar.hidden = n === 0;
  $('#selCount').textContent = `${n} selected`;
  $('#bulkRestore').hidden = state.view !== 'trash';
  $('#bulkDelete').hidden = state.view !== 'trash';
}

$('#actionBar').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-bulk]');
  if (!btn) return;
  const action = btn.dataset.bulk;
  const fileIds = [], folderIds = [];
  for (const key of state.selected) {
    const [t, id] = key.split(':');
    (t === 'file' ? fileIds : folderIds).push(parseInt(id));
  }
  if (action === 'download') {
    if (fileIds.length === 1 && folderIds.length === 0) {
      window.location = `/api/files/${fileIds[0]}/download`;
    } else {
      // Zip multi-select
      const resp = await fetch('/api/bulk', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ action:'zip', file_ids: fileIds, folder_ids: folderIds })
      });
      const blob = await resp.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'cloudvault.zip'; a.click();
    }
    return;
  }
  if (action === 'move') return openMoveDialog('move');
  if (action === 'copy') return openMoveDialog('copy');
  if (action === 'delete' && !confirm(`Delete ${fileIds.length + folderIds.length} item(s) forever?`)) return;
  await api('/api/bulk', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action, file_ids: fileIds, folder_ids: folderIds })
  });
  toast('Done', 'success');
  loadList(); loadMe();
});
$('#clearSel').onclick = () => { state.selected.clear(); render(); updateActionBar(); };

// ---------- Sort / view toggle ----------
$('#sortSelect').onchange = (e) => {
  const [s, o] = e.target.value.split('|');
  state.sort = s; state.order = o; loadList();
};
$('#viewGrid').onclick = () => setLayout('grid');
$('#viewList').onclick = () => setLayout('list');
function setLayout(l) {
  state.layout = l;
  localStorage.setItem('cv_layout', l);
  $('#viewGrid').classList.toggle('active', l === 'grid');
  $('#viewList').classList.toggle('active', l === 'list');
  render();
}

// ---------- Context menu ----------
function openCtx(x, y) {
  const m = $('#ctxMenu');
  const inTrash = state.view === 'trash';
  m.querySelectorAll('button').forEach(b => {
    const a = b.dataset.action;
    if (inTrash) b.style.display = (a === 'restore' || a === 'delete') ? 'flex' : 'none';
    else b.style.display = a === 'restore' ? 'none' : 'flex';
  });
  m.hidden = false;
  m.style.left = Math.min(x, window.innerWidth - 220) + 'px';
  m.style.top = Math.min(y, window.innerHeight - 360) + 'px';
}
function closeCtx() { $('#ctxMenu').hidden = true; }
document.addEventListener('click', (e) => {
  if (!e.target.closest('#ctxMenu') && !e.target.closest('.row-menu')) closeCtx();
});

$('#ctxMenu').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  closeCtx();
  const item = state.lastFocus; if (!item) return;
  const id = item.id, type = item._type, act = btn.dataset.action;

  if (act === 'open') onOpen(item);
  else if (act === 'download') {
    if (type === 'file') window.location = `/api/files/${id}/download`;
    else window.location = `/api/folders/${id}/download`;
  } else if (act === 'share') openShare(id, type);
  else if (act === 'star' && type === 'file') {
    await api(`/api/files/${id}`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ starred: !item.starred }) });
    toast(item.starred ? 'Unstarred' : 'Starred', 'success'); loadList();
  } else if (act === 'rename') {
    const name = prompt('New name:', item.name);
    if (name && name !== item.name) {
      const url = type === 'file' ? `/api/files/${id}` : `/api/folders/${id}`;
      await api(url, { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name }) });
      toast('Renamed', 'success'); loadList();
    }
  } else if (act === 'move') {
    state.selected.clear(); state.selected.add(`${type}:${id}`); openMoveDialog('move');
  } else if (act === 'copy') {
    state.selected.clear(); state.selected.add(`${type}:${id}`); openMoveDialog('copy');
  } else if (act === 'restore') {
    const url = type === 'file' ? `/api/files/${id}/restore` : `/api/folders/${id}/restore`;
    await api(url, { method:'POST' });
    toast('Restored', 'success'); loadList(); loadMe();
  } else if (act === 'delete') {
    if (state.view === 'trash') {
      if (!confirm('Delete forever?')) return;
      const url = type === 'file' ? `/api/files/${id}?permanent=1` : `/api/folders/${id}?permanent=1`;
      await api(url, { method:'DELETE' });
    } else {
      const url = type === 'file' ? `/api/files/${id}` : `/api/folders/${id}`;
      await api(url, { method:'DELETE' });
    }
    toast(state.view === 'trash' ? 'Deleted' : 'Moved to trash', 'success');
    closeDetails(); loadList(); loadMe();
  }
});

// ---------- Details panel ----------
function openDetails(item) {
  const p = $('#detailsPanel');
  p.hidden = false;
  document.body.classList.add('with-details');
  const iconNode = (item._type === 'file' && item.has_thumb)
    ? `<div class="dp-thumb">${thumbImg(item, 'dp-thumb-img')}</div>`
    : `<div class="dp-ico">${item._type === 'folder' ? ICONS.folder : ICONS[classify(item.name, item.mime)]}</div>`;
  $('#dpThumbWrap').innerHTML = iconNode;
  $('#dpName').textContent = item.name;
  $('#dpMeta').textContent = item._type === 'folder' ? 'Folder' : (item.mime || 'File');
  $('#dpType').textContent = item._type === 'folder' ? 'Folder' : (item.mime || '—');
  $('#dpSize').textContent = item._type === 'folder' ? '—' : fmtSize(item.size);
  $('#dpDate').textContent = fmtDate(item.created_at);
  $('#dpPreview').onclick = () => onOpen(item);
  $('#dpDownload').onclick = () => {
    if (item._type === 'file') window.location = `/api/files/${item.id}/download`;
    else window.location = `/api/folders/${item.id}/download`;
  };
  $('#dpShare').onclick = () => openShare(item.id, item._type);
  $('#dpShare').style.display = 'flex';
  // Auto-share public link section
  const linkWrap = $('#dpPublicLink');
  if (item._type === 'file' && item.share_url) {
    linkWrap.hidden = false;
    $('#dpLinkInput').value = item.share_url;
    $('#dpCopyLink').dataset.shareUrl = item.share_url;
    if (item.download_url) {
      $('#dpDownloadInput').value = item.download_url;
      $('#dpCopyDownload').dataset.shareUrl = item.download_url;
    }
    const exp = item.share_expires_at ? new Date(item.share_expires_at) : null;
    if (exp) {
      const days = Math.max(0, Math.ceil((exp - Date.now()) / 86400000));
      $('#dpLinkExpiry').textContent = `· expires in ${days} day${days === 1 ? '' : 's'}`;
    } else {
      $('#dpLinkExpiry').textContent = '';
    }
  } else {
    linkWrap.hidden = true;
  }
  $('#dpRename').onclick = () => {
    const name = prompt('New name:', item.name);
    if (!name || name === item.name) return;
    const url = item._type === 'file' ? `/api/files/${item.id}` : `/api/folders/${item.id}`;
    api(url, { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name }) }).then(() => { toast('Renamed', 'success'); loadList(); });
  };
  $('#dpMove').onclick = () => {
    state.selected.clear(); state.selected.add(`${item._type}:${item.id}`); openMoveDialog();
  };
  $('#dpDelete').onclick = () => {
    const url = item._type === 'file' ? `/api/files/${item.id}` : `/api/folders/${item.id}`;
    api(url, { method:'DELETE' }).then(() => { toast('Moved to trash', 'success'); closeDetails(); loadList(); loadMe(); });
  };
  renderTagsForFile(item);
}

function renderTagsForFile(item) {
  const wrap = $('#dpTags');
  if (item._type !== 'file') { wrap.innerHTML = ''; return; }
  const chips = (item.tags || []).map(t =>
    `<span class="tag-chip" style="background:${t.color}">${escapeHtml(t.name)}<button data-del="${t.id}" data-file="${item.id}">×</button></span>`
  ).join('');
  wrap.innerHTML = `
    <div class="dp-tags-label">Tags</div>
    <div class="dp-tags-list">${chips}<button class="add-tag-btn" id="addTagBtn">+ Add tag</button></div>
  `;
  $('#addTagBtn').onclick = () => openAddTag(item);
  wrap.querySelectorAll('[data-del]').forEach(btn => btn.onclick = async () => {
    await api(`/api/files/${btn.dataset.file}/tags/${btn.dataset.del}`, { method:'DELETE' });
    toast('Tag removed', 'success');
    loadList();
  });
}

function openAddTag(item) {
  const existing = state.tags.filter(t => !(item.tags || []).some(it => it.id === t.id));
  const name = prompt(`Add tag (existing: ${existing.map(t => t.name).join(', ') || 'none'}):`);
  if (!name) return;
  api('/api/tags', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name: name.trim() }) })
    .then(tag => api(`/api/files/${item.id}/tags`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ tag_id: tag.id }) }))
    .then(() => { toast('Tag added', 'success'); loadTags(); loadList(); });
}

function closeDetails() { $('#detailsPanel').hidden = true; document.body.classList.remove('with-details'); }
$('#dpClose').onclick = closeDetails;

// ---------- Move / copy dialog ----------
// `mode` is 'move' or 'copy'. The dialog body is identical, only the
// title/CTA text and the eventual bulk action differ.
async function openMoveDialog(mode='move') {
  state.moveMode = mode;
  const titleEl = document.getElementById('moveModalTitle');
  const ctaEl = $('#moveConfirm');
  if (titleEl) titleEl.textContent = mode === 'copy' ? 'Copy to…' : 'Move to…';
  if (ctaEl) ctaEl.textContent = mode === 'copy' ? 'Copy here' : 'Move here';
  const tree = await api('/api/folders/tree');
  const wrap = $('#folderTree');
  wrap.innerHTML = `<div class="tree-node" data-id=""><span>📁 My Drive (root)</span></div>` +
    tree.map(f => `<div class="tree-node" data-id="${f.id}"><span>📁 ${escapeHtml(f.path)}</span></div>`).join('');
  state.moveTarget = null;
  ctaEl.disabled = true;
  $$('#folderTree .tree-node').forEach(n => n.onclick = () => {
    $$('#folderTree .tree-node').forEach(x => x.classList.remove('active'));
    n.classList.add('active');
    state.moveTarget = n.dataset.id || null;
    ctaEl.disabled = false;
  });
  $('#moveModal').hidden = false;
}
$('#moveCancel').onclick = () => $('#moveModal').hidden = true;
$('#moveConfirm').onclick = async () => {
  $('#moveModal').hidden = true;
  if (state.moveMode === 'copy') await bulkCopy(state.moveTarget);
  else await bulkMove(state.moveTarget);
};
function _selectedIds() {
  const fileIds = [], folderIds = [];
  for (const key of state.selected) {
    const [t, id] = key.split(':');
    (t === 'file' ? fileIds : folderIds).push(parseInt(id));
  }
  return { fileIds, folderIds };
}
async function bulkMove(targetFolder) {
  const { fileIds, folderIds } = _selectedIds();
  await api('/api/bulk', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'move', file_ids: fileIds, folder_ids: folderIds, target_folder: targetFolder })
  });
  toast('Moved', 'success'); loadList();
}
async function bulkCopy(targetFolder) {
  const { fileIds, folderIds } = _selectedIds();
  try {
    const res = await api('/api/bulk', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'copy', file_ids: fileIds, folder_ids: folderIds, target_folder: targetFolder })
    });
    toast(`Copied ${res.count} item${res.count === 1 ? '' : 's'}`, 'success');
    loadList(); loadMe();
  } catch (err) {
    // 413 from the server means quota would be exceeded — say so plainly.
    toast(err.message || 'Copy failed', 'error');
  }
}

// ---------- Share ----------
let currentShareId = null;       // file_id or folder_id
let currentShareKind = 'file';   // 'file' | 'folder'
let currentShareToken = null;
async function openShare(id, kind='file') {
  currentShareId = id;
  currentShareKind = kind;
  currentShareToken = null;
  $('#shareExpiry').value = '';
  $('#sharePassword').value = '';
  $('#shareAllowDownload').checked = true;
  $('#shareAlias').value = '';
  const titleEl = document.getElementById('shareModalTitle');
  const subEl = document.getElementById('shareModalSubtitle');
  if (titleEl) titleEl.textContent = kind === 'folder' ? 'Share folder' : 'Share link';
  if (subEl) subEl.textContent = kind === 'folder'
    ? 'Anyone with this link can browse and download the folder'
    : 'Configure who can access this file';
  setAliasHint('Lowercase letters, digits, hyphens. 4–60 chars.', '');
  await regenShare();
  $('#shareModal').hidden = false;
}
async function regenShare() {
  if (!currentShareId) return;
  const endpoint = currentShareKind === 'folder'
    ? `/api/share/folder/${currentShareId}`
    : `/api/share/${currentShareId}`;
  const data = await api(endpoint, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      expires_hours: $('#shareExpiry').value || null,
      password: $('#sharePassword').value || null,
      allow_download: $('#shareAllowDownload').checked,
    })
  });
  currentShareToken = data.token;
  $('#shareUrl').value = data.url;
  const qrEl = document.getElementById('shareQr');
  if (qrEl && data.qr_url) {
    qrEl.src = data.qr_url + '?t=' + Date.now();
  }
}
function setAliasHint(text, kind) {
  const el = document.getElementById('aliasHint');
  if (!el) return;
  el.textContent = text;
  el.className = 'alias-hint' + (kind ? ' ' + kind : '');
}
async function saveAlias() {
  if (!currentShareToken) return;
  const alias = ($('#shareAlias').value || '').trim().toLowerCase();
  if (!alias) {
    setAliasHint('Enter an alias first.', 'error');
    return;
  }
  if (!/^[a-z0-9][a-z0-9-]{2,58}[a-z0-9]$/.test(alias)) {
    setAliasHint('4–60 chars, lowercase a–z 0–9 and hyphens, no leading/trailing hyphen.', 'error');
    return;
  }
  try {
    const r = await api(`/api/share/${currentShareToken}/alias`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ alias })
    });
    $('#shareUrl').value = r.url;
    setAliasHint(`Saved — link is now ${r.url}`, 'success');
    toast('Pretty link saved', 'success');
    // Refresh QR for the new alias.
    const qrEl = document.getElementById('shareQr');
    if (qrEl) qrEl.src = `/s/${encodeURIComponent(alias)}/qr.png?t=` + Date.now();
    loadList(); // file_to_dict will now return the alias URL
  } catch (e) {
    setAliasHint(e.message || 'Could not save alias', 'error');
  }
}
$('#shareClose').onclick = () => $('#shareModal').hidden = true;
$('#copyBtn').onclick = () => {
  $('#shareUrl').select();
  navigator.clipboard.writeText($('#shareUrl').value);
  toast('Link copied', 'success');
};
$('#shareExpiry').onchange = regenShare;
$('#shareAllowDownload').onchange = regenShare;
$('#sharePassword').addEventListener('change', regenShare);
const _aliasSaveBtn = document.getElementById('aliasSave');
if (_aliasSaveBtn) _aliasSaveBtn.onclick = saveAlias;
const _aliasInput = document.getElementById('shareAlias');
if (_aliasInput) _aliasInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); saveAlias(); }
});

// ---------- Preview ----------
let previewIndex = -1, previewable = [];
function openPreview(file) {
  previewable = state.files.filter(f =>
    f.mime?.startsWith('image/') || f.mime?.startsWith('video/') ||
    f.mime?.startsWith('audio/') || f.mime?.includes('pdf')
  );
  previewIndex = previewable.findIndex(f => f.id === file.id);
  if (previewIndex < 0) { previewable = [file]; previewIndex = 0; }
  renderPreview();
  $('#previewModal').hidden = false;
}
function renderPreview() {
  const file = previewable[previewIndex];
  if (!file) return;
  const body = $('#previewBody');
  body.innerHTML = '';
  const url = `/api/files/${file.id}/preview`;
  if (file.mime?.startsWith('image/')) body.innerHTML = `<img src="${url}" alt="">`;
  else if (file.mime?.startsWith('video/')) body.innerHTML = `<video src="${url}" controls autoplay></video>`;
  else if (file.mime?.startsWith('audio/')) body.innerHTML = `<audio src="${url}" controls autoplay></audio>`;
  else if (file.mime?.includes('pdf')) body.innerHTML = `<iframe src="${url}"></iframe>`;
  else if (file.mime?.startsWith('text/') || /\.(txt|md|json|js|ts|py|html|css|csv)$/i.test(file.name)) {
    fetch(url).then(r => r.text()).then(t => body.innerHTML = `<pre>${escapeHtml(t.slice(0, 50000))}</pre>`);
  } else {
    body.innerHTML = `<div style="color:white;text-align:center;padding:40px;">Preview not available.<br><br><a href="/api/files/${file.id}/download" class="btn btn-primary">⬇ Download</a></div>`;
  }
  $('#previewFoot').textContent = `${file.name} · ${fmtSize(file.size)} (${previewIndex+1}/${previewable.length})`;
  $('#prevBtn').style.display = previewable.length > 1 ? 'flex' : 'none';
  $('#nextBtn').style.display = previewable.length > 1 ? 'flex' : 'none';
}
$('#previewClose').onclick = () => $('#previewModal').hidden = true;
$('#prevBtn').onclick = () => { previewIndex = (previewIndex - 1 + previewable.length) % previewable.length; renderPreview(); };
$('#nextBtn').onclick = () => { previewIndex = (previewIndex + 1) % previewable.length; renderPreview(); };

// ---------- Chunked upload ----------
function pickFiles() { $('#fileInput').click(); }
function pickPhoto() {
  const cam = $('#cameraInput');
  if (cam) cam.click(); else pickFiles();
}
function openActionSheet() {
  const s = document.getElementById('actionSheet');
  if (!s) { pickFiles(); return; }
  s.hidden = false;
}
function closeActionSheet() {
  const s = document.getElementById('actionSheet');
  if (s) s.hidden = true;
}
$('#btnUpload').onclick = pickFiles;
$('#bnUpload').onclick = openActionSheet;
const _emptyBtn = document.getElementById('empty');
if (_emptyBtn) _emptyBtn.onclick = pickFiles;
const _camBtn = document.getElementById('btnCamera');
if (_camBtn) _camBtn.onclick = pickPhoto;
$('#fileInput').onchange = (e) => uploadFiles(e.target.files);
const _camInput = document.getElementById('cameraInput');
if (_camInput) _camInput.onchange = (e) => uploadFiles(e.target.files);
// Action sheet wiring
const _asBackdrop = document.getElementById('actionSheetBackdrop');
if (_asBackdrop) _asBackdrop.onclick = closeActionSheet;
const _asCancel = document.getElementById('asCancel');
if (_asCancel) _asCancel.onclick = closeActionSheet;
const _asUpload = document.getElementById('asUpload');
if (_asUpload) _asUpload.onclick = () => { closeActionSheet(); pickFiles(); };
const _asCamera = document.getElementById('asCamera');
if (_asCamera) _asCamera.onclick = () => { closeActionSheet(); pickPhoto(); };
const _asNewFolder = document.getElementById('asNewFolder');
if (_asNewFolder) _asNewFolder.onclick = () => { closeActionSheet(); newFolder(); };
const _asShared = document.getElementById('asShared');
if (_asShared) _asShared.onclick = (e) => {
  e.preventDefault();
  closeActionSheet();
  // Drive the same view-switch the sidebar links use.
  state.view = 'shared'; state.folder = null;
  document.querySelectorAll('.side-link, .bn-link').forEach(el => el.classList.remove('active'));
  loadList();
};
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const sheet = document.getElementById('actionSheet');
    if (sheet && !sheet.hidden) closeActionSheet();
  }
});

async function uploadFiles(files, folderId=null) {
  if (!files.length) return;
  // Pre-flight quota + max-file checks. Catching it client-side gives a
  // single clear error before any bytes hit the wire, and avoids a long
  // upload that ends in a 413.
  if (state.me && state.me.quota) {
    const total = Array.from(files).reduce((s, f) => s + (f.size || 0), 0);
    const free = state.me.quota - state.me.used;
    if (state.me.max_file) {
      const over = Array.from(files).find(f => f.size > state.me.max_file);
      if (over) {
        toast(`"${over.name}" is ${fmtSize(over.size)} — limit per file is ${fmtSize(state.me.max_file)}.`, 'error');
        return;
      }
    }
    if (total > free) {
      toast(`Not enough space: need ${fmtSize(total)} but only ${fmtSize(Math.max(0, free))} free.`, 'error');
      return;
    }
    const projected = (state.me.used + total) / state.me.quota * 100;
    if (projected >= 90 && projected < 100) {
      toast(`⚠ Storage will be ${projected.toFixed(0)}% full after this upload.`, '');
    }
  }
  const target = folderId !== null ? folderId : state.folder;
  let done = 0;
  const results = [];
  $('#uploadBar').hidden = false;
  const pendingList = loadPending();
  for (const f of files) {
    $('#uploadText').textContent = `Uploading ${f.name} (${done+1}/${files.length})`;
    $('#uploadFill').style.width = '0';
    resetUploadStats();
    try {
      // If this file matches an in-flight upload (after a refresh or
      // explicit Resume click), pick up from where we left off.
      const match = pendingList.find(e => e.filename === f.name && e.size === f.size);
      let res;
      if (match) {
        const status = await api(`/api/upload/${match.upload_id}`).catch(() => null);
        if (status && status.received < f.size) {
          $('#uploadText').textContent = `Resuming ${f.name} (${(status.received/f.size*100).toFixed(0)}%)`;
          res = await uploadChunked(f, match.folder_id, match.upload_id, status.received);
        } else {
          // Server lost the session — restart cleanly.
          dropPending(match.upload_id);
          res = f.size > 8 * 1024 * 1024 ? await uploadChunked(f, target) : await uploadSingle(f, target);
        }
      } else if (f.size > 8 * 1024 * 1024) {
        res = await uploadChunked(f, target);
      } else {
        res = await uploadSingle(f, target);
      }
      if (res) results.push(res);
      done++;
    } catch (err) {
      toast(`Failed: ${f.name} — ${err.message}`, 'error');
    }
  }
  // Clear the resume target marker + refresh the banner state.
  delete window.__resumeTarget;
  renderResumeBanner();
  $('#uploadBar').hidden = true;
  $('#uploadFill').style.width = '0';
  resetUploadStats();
  $('#fileInput').value = '';
  if (results.length >= 1) showPostUploadBanner(results);
  else toast(`Upload finished (${done})`, 'success');
  // Force "newest first" after every upload so the new file is unmissable,
  // even if the user (or stale cache) had a different sort selected.
  state.sort = 'date'; state.order = 'desc';
  const sortSel = document.getElementById('sortSelect');
  if (sortSel) sortSel.value = 'date|desc';
  await loadList();
  loadMe();
  // Scroll the file list into view so the freshly uploaded file is right
  // under the toolbar on mobile (it's a fixed banner so user might miss it).
  const mainEl = document.querySelector('.main') || document.scrollingElement || document.documentElement;
  if (mainEl && mainEl.scrollTo) mainEl.scrollTo({ top: 0, behavior: 'smooth' });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showPostUploadBanner(files) {
  const wrap = $('#postUploadBanner');
  if (!wrap) { toast(`Uploaded ${files.length} file${files.length > 1 ? 's' : ''}`, 'success'); return; }
  const first = files[0];
  const title = files.length === 1
    ? `Uploaded ${first.name}`
    : `Uploaded ${files.length} files (showing first)`;
  $('#pubTitle').textContent = title;
  $('#pubShareInput').value = first.share_url || '';
  $('#pubDownloadInput').value = first.download_url || '';
  $('#pubCopyShare').dataset.shareUrl = first.share_url || '';
  $('#pubCopyDownload').dataset.shareUrl = first.download_url || '';
  wrap.hidden = false;
  clearTimeout(window.__pubT);
  window.__pubT = setTimeout(() => { wrap.hidden = true; }, 12000);
}

// Rolling window of {t, bytes} samples used to estimate upload speed.
// Reset before each file so transient slow-starts don't poison later ETAs.
let _uploadSamples = [];
function resetUploadStats() {
  _uploadSamples = [];
  $('#uploadSpeed').textContent = '';
  $('#uploadEta').textContent = '';
  $('#uploadPct').textContent = '';
}
function fmtDuration(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 1) return '<1s left';
  if (seconds < 60) return `${Math.ceil(seconds)}s left`;
  const m = Math.floor(seconds / 60);
  const s = Math.ceil(seconds % 60);
  if (m < 60) return `${m}m ${s}s left`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m left`;
}
function fmtSpeed(bytesPerSec) {
  if (!isFinite(bytesPerSec) || bytesPerSec <= 0) return '';
  return `${fmtSize(bytesPerSec)}/s`;
}
function updateUploadProgress(loaded, total) {
  const pct = total > 0 ? Math.min(100, (loaded / total) * 100) : 0;
  $('#uploadFill').style.width = pct + '%';
  $('#uploadPct').textContent = pct.toFixed(0) + '%';
  const now = performance.now();
  _uploadSamples.push({ t: now, bytes: loaded });
  // Keep only the last ~3 seconds of samples for a responsive but stable rate.
  const cutoff = now - 3000;
  while (_uploadSamples.length > 2 && _uploadSamples[0].t < cutoff) _uploadSamples.shift();
  if (_uploadSamples.length >= 2) {
    const first = _uploadSamples[0];
    const last = _uploadSamples[_uploadSamples.length - 1];
    const dt = (last.t - first.t) / 1000;
    const db = last.bytes - first.bytes;
    if (dt > 0.1 && db > 0) {
      const bps = db / dt;
      $('#uploadSpeed').textContent = fmtSpeed(bps);
      const remaining = total - loaded;
      $('#uploadEta').textContent = remaining > 0 ? fmtDuration(remaining / bps) : '';
    }
  }
}

async function uploadSingle(file, folderId) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('file', file);
    if (folderId) fd.append('folder_id', folderId);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) updateUploadProgress(ev.loaded, ev.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); } catch { resolve(null); }
      } else {
        let msg = `Upload failed (HTTP ${xhr.status})`;
        try {
          const body = JSON.parse(xhr.responseText);
          if (body && body.error) msg = body.error;
        } catch {}
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error('Network error — check your connection and try again'));
    xhr.ontimeout = () => reject(new Error('Upload timed out'));
    xhr.send(fd);
  });
}

// ---------- Resumable chunked uploads ----------
// Pending uploads are tracked in localStorage so a tab refresh / crash
// doesn't waste already-uploaded bytes. After a refresh we can't reach
// back into the user's filesystem (browser sandbox) — we surface a banner
// asking them to re-pick the file, then resume from the saved offset.
const PENDING_KEY = 'cv_pending_uploads';

function loadPending() {
  try { return JSON.parse(localStorage.getItem(PENDING_KEY) || '[]'); }
  catch { return []; }
}
function savePending(list) {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(list)); }
  catch {}
}
function recordPending(entry) {
  const list = loadPending().filter(e => e.upload_id !== entry.upload_id);
  list.push(entry);
  savePending(list);
}
function updatePendingOffset(upload_id, offset) {
  const list = loadPending();
  const e = list.find(x => x.upload_id === upload_id);
  if (e) { e.offset = offset; savePending(list); }
}
function dropPending(upload_id) {
  savePending(loadPending().filter(e => e.upload_id !== upload_id));
}

async function uploadChunked(file, folderId, existingUploadId=null, startOffset=0) {
  let uploadId = existingUploadId;
  let chunkSize = 5 * 1024 * 1024;
  if (!uploadId) {
    const init = await api('/api/upload/init', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ filename: file.name, size: file.size, mime: file.type, folder_id: folderId })
    });
    uploadId = init.upload_id;
    chunkSize = init.chunk_size || chunkSize;
    recordPending({
      upload_id: uploadId,
      filename: file.name,
      size: file.size,
      mime: file.type || '',
      folder_id: folderId || null,
      offset: 0,
      started_at: Date.now(),
    });
  }
  try {
    for (let offset = startOffset; offset < file.size; offset += chunkSize) {
      const chunk = file.slice(offset, Math.min(offset + chunkSize, file.size));
      const res = await fetch(`/api/upload/${uploadId}?offset=${offset}`, {
        method:'PATCH', body: chunk, credentials: 'same-origin'
      });
      if (!res.ok) {
        let msg = `Upload failed (HTTP ${res.status})`;
        try { const body = await res.json(); if (body.error) msg = body.error; } catch {}
        throw new Error(msg);
      }
      const done = Math.min(offset + chunkSize, file.size);
      updatePendingOffset(uploadId, done);
      updateUploadProgress(done, file.size);
    }
    const result = await api(`/api/upload/${uploadId}/complete`, { method:'POST' });
    dropPending(uploadId);
    return result;
  } catch (err) {
    // Keep the localStorage entry so the user can resume after fixing
    // the issue (network blip, refresh, etc).
    throw err;
  }
}

async function resumeUpload(entry, file) {
  // Validate: filename + size must match so we don't write the wrong
  // bytes into the staging file.
  if (file.name !== entry.filename || file.size !== entry.size) {
    toast(`Wrong file: pick "${entry.filename}" (${(entry.size/1024/1024).toFixed(1)} MB)`, 'error');
    return;
  }
  // Confirm with the server that the upload still exists + how many
  // bytes are actually persisted (may differ from localStorage if a
  // chunk was dropped after we updated state).
  let status;
  try {
    status = await api(`/api/upload/${entry.upload_id}`);
  } catch (e) {
    // 404 = server dropped it (or it's expired). Start fresh.
    toast('Upload session expired — restarting from the beginning', 'info');
    dropPending(entry.upload_id);
    return uploadFiles([file], entry.folder_id);
  }
  $('#uploadBar').hidden = false;
  $('#uploadText').textContent = `Resuming ${file.name} (${(status.received/file.size*100).toFixed(0)}%)`;
  $('#uploadFill').style.width = (status.received / file.size * 100) + '%';
  try {
    const result = await uploadChunked(file, entry.folder_id, entry.upload_id, status.received);
    $('#uploadBar').hidden = true;
    $('#uploadFill').style.width = '0';
    showPostUploadBanner([result]);
    state.sort = 'date'; state.order = 'desc';
    const sortSel = document.getElementById('sortSelect');
    if (sortSel) sortSel.value = 'date|desc';
    await loadList();
    loadMe();
  } catch (err) {
    $('#uploadBar').hidden = true;
    toast(`Resume failed: ${err.message}`, 'error');
  }
}

async function cancelPending(upload_id) {
  try { await fetch(`/api/upload/${upload_id}`, { method:'DELETE', credentials: 'same-origin' }); } catch {}
  dropPending(upload_id);
  renderResumeBanner();
}

function renderResumeBanner() {
  let banner = document.getElementById('resumeBanner');
  const pending = loadPending();
  if (pending.length === 0) {
    if (banner) banner.remove();
    return;
  }
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'resumeBanner';
    banner.className = 'resume-banner';
    document.body.appendChild(banner);
  }
  banner.innerHTML = pending.map(e => {
    const pct = ((e.offset || 0) / e.size * 100).toFixed(0);
    const mb = (e.size / 1024 / 1024).toFixed(1);
    return `
      <div class="resume-row" data-id="${e.upload_id}">
        <div class="resume-info">
          <strong>Upload paused</strong>
          <span>${escapeHtml(e.filename)} · ${mb} MB · ${pct}% done</span>
        </div>
        <div class="resume-actions">
          <button class="btn btn-primary resume-btn" data-id="${e.upload_id}">Resume</button>
          <button class="btn btn-ghost cancel-btn" data-id="${e.upload_id}">Cancel</button>
        </div>
      </div>
    `;
  }).join('');
  banner.querySelectorAll('.resume-btn').forEach(b => {
    b.onclick = () => {
      const id = b.dataset.id;
      const entry = loadPending().find(x => x.upload_id === id);
      if (!entry) return;
      // Open file picker so user can re-select the file. uploadFiles
      // checks for matching pending entries by name+size and resumes.
      window.__resumeTarget = entry;
      pickFiles();
    };
  });
  banner.querySelectorAll('.cancel-btn').forEach(b => {
    b.onclick = () => cancelPending(b.dataset.id);
  });
}

// Render any pending uploads on page load.
renderResumeBanner();

// Drag & drop globally
const dz = $('#dropZone');
['dragenter','dragover'].forEach(ev => dz.addEventListener(ev, (e) => {
  if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); dz.classList.add('drag'); }
}));
['dragleave','drop'].forEach(ev => dz.addEventListener(ev, (e) => {
  if (ev === 'drop' || e.target === dz) dz.classList.remove('drag');
}));
dz.addEventListener('drop', (e) => {
  if (e.dataTransfer.files.length) { e.preventDefault(); uploadFiles(e.dataTransfer.files); }
});

// ---------- Sidebar ----------
$$('.side-link, .bn-link').forEach(el => {
  if (!el.dataset.view) return;
  el.onclick = (e) => {
    e.preventDefault();
    state.view = el.dataset.view; state.folder = null; state.tagId = null;
    state.search = '';
    $$('.side-link, .bn-link').forEach(x => x.classList.remove('active'));
    $$(`[data-view="${state.view}"]`).forEach(x => x.classList.add('active'));
    closeDetails();
    loadList();
  };
});

// ---------- New folder ----------
async function newFolder() {
  const name = prompt('Folder name:');
  if (!name) return;
  await api('/api/folders', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name, parent_id: state.folder }) });
  toast('Folder created', 'success');
  loadList();
}
$('#btnNewFolder').onclick = newFolder;
$('#btnNew').onclick = () => {
  if (confirm('Create new folder? (Cancel for upload)')) newFolder(); else pickFiles();
};

// ---------- Empty trash ----------
$('#emptyTrash').onclick = async () => {
  if (!confirm('Permanently delete everything in trash?')) return;
  await api('/api/trash/empty', { method:'POST' });
  toast('Trash emptied', 'success'); loadList(); loadMe();
};

// ---------- Search ----------
// Toggle .scrolled on the topbar so it frosts in once content scrolls
// behind it. rAF-throttled so we don't churn on every scroll event.
let _topbarTicking = false;
function _updateTopbarScrolled() {
  const tb = document.querySelector('.topbar');
  if (!tb) return;
  const past = window.scrollY > 8;
  tb.classList.toggle('scrolled', past);
  const fab = document.getElementById('scrollTopBtn');
  if (fab) fab.classList.toggle('visible', window.scrollY > 400);
  _topbarTicking = false;
}
window.addEventListener('scroll', () => {
  if (!_topbarTicking) {
    _topbarTicking = true;
    requestAnimationFrame(_updateTopbarScrolled);
  }
}, { passive: true });
const _scrollTopBtn = document.getElementById('scrollTopBtn');
if (_scrollTopBtn) _scrollTopBtn.onclick = () => {
  // Honour OS-level reduce-motion — instant jump for those users.
  const prefersReduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({ top: 0, behavior: prefersReduce ? 'auto' : 'smooth' });
};

// ---------- Keyboard ----------
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) return;
  if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
    e.preventDefault();
    [...state.files, ...state.folders].forEach(i => {
      const t = state.files.includes(i) ? 'file' : 'folder';
      state.selected.add(`${t}:${i.id}`);
    });
    render(); updateActionBar();
  } else if (e.key === 'Delete' && state.selected.size) {
    $('#actionBar [data-bulk="trash"]').click();
  } else if (e.key === 'Escape') {
    state.selected.clear();
    closeDetails(); closeCtx();
    $('#previewModal').hidden = true; $('#shareModal').hidden = true; $('#moveModal').hidden = true;
    render(); updateActionBar();
  } else if (e.key === 'ArrowLeft' && !$('#previewModal').hidden) $('#prevBtn').click();
  else if (e.key === 'ArrowRight' && !$('#previewModal').hidden) $('#nextBtn').click();
});

// ---------- SSE ----------
function startEventStream() {
  if (typeof EventSource === 'undefined') return;
  try {
    const es = new EventSource('/api/events');
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (['file_created','file_updated','file_deleted','folder_created','folder_updated','folder_deleted','bulk_updated','trash_emptied'].includes(msg.type)) {
          loadList(); loadMe();
        }
      } catch {}
    };
    es.onerror = () => { es.close(); setTimeout(startEventStream, 5000); };
  } catch {}
}

// ---------- Copy share link (delegated) ----------
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.copy-link-btn');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  const url = btn.dataset.shareUrl;
  if (!url) return;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(url);
    } else {
      const ta = document.createElement('textarea');
      ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 1200);
    toast('Public link copied — anyone with the link can view for 7 days', 'success');
  } catch (err) {
    toast('Failed to copy link', 'error');
  }
});

// ---------- Init ----------
loadMe();
loadList();
loadTags();
setLayout(state.layout);
$('#sortSelect').value = `${state.sort}|${state.order}`;
startEventStream();
