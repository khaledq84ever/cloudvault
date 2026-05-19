// CloudVault — pro drive controller
const state = {
  view: 'my',
  folder: null,
  search: '',
  sort: 'name',
  order: 'asc',
  layout: localStorage.getItem('cv_layout') || 'list',
  files: [],
  folders: [],
  selected: new Set(), // "file:1", "folder:2"
  lastFocus: null,
  moveTarget: null,
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const ICONS = {
  folder: '📁',
  image: '🖼', video: '🎬', audio: '🎵', pdf: '📕',
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
  if (!b && b !== 0) return '—';
  if (b === 0) return '0 B';
  const u = ['B','KB','MB','GB','TB']; let i = 0;
  while (b >= 1024 && i < u.length-1) { b /= 1024; i++; }
  return b.toFixed(b < 10 ? 1 : 0) + ' ' + u[i];
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff/60) + ' min ago';
  if (diff < 86400) return Math.floor(diff/3600) + ' h ago';
  if (diff < 604800) return Math.floor(diff/86400) + ' d ago';
  return d.toLocaleDateString();
}

function toast(msg, type='') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + type;
  t.hidden = false;
  clearTimeout(window.__toastT);
  window.__toastT = setTimeout(() => t.hidden = true, 2400);
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
  $('#uname').textContent = me.name;
  $('#avatar').textContent = (me.name || me.email)[0].toUpperCase();
  const pct = Math.min(100, (me.used / me.quota) * 100);
  $('#barFill').style.width = pct + '%';
  $('#storageText').textContent = `${fmtSize(me.used)} / ${fmtSize(me.quota)}`;
  if (pct > 90 && !sessionStorage.getItem('quotaWarned')) {
    toast(`⚠️ Storage ${pct.toFixed(0)}% full`, 'error');
    sessionStorage.setItem('quotaWarned', '1');
  }
}

async function loadList() {
  const p = new URLSearchParams();
  p.set('view', state.view);
  p.set('sort', state.sort);
  p.set('order', state.order);
  if (state.folder) p.set('folder', state.folder);
  if (state.search) p.set('q', state.search);
  const data = await api('/api/files?' + p);
  state.files = data.files;
  state.folders = data.folders;
  state.selected.clear();
  renderBreadcrumb(data.breadcrumb || []);
  render();
  updateActionBar();
  $('#trashBanner').hidden = state.view !== 'trash' || (data.files.length + data.folders.length === 0);
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
    const header = document.createElement('div');
    header.className = 'list-head';
    header.innerHTML = `
      <span class="lh-check"><input type="checkbox" id="selAll"></span>
      <span class="lh-name">Name</span>
      <span class="lh-size">Size</span>
      <span class="lh-date">Modified</span>
      <span class="lh-act"></span>
    `;
    grid.appendChild(header);
  }

  for (const item of items) {
    const node = state.layout === 'grid' ? buildGridCard(item) : buildListRow(item);
    grid.appendChild(node);
  }

  if (state.layout === 'list') {
    const selAll = $('#selAll');
    if (selAll) selAll.onchange = (e) => {
      items.forEach(i => {
        const key = `${i._type}:${i.id}`;
        e.target.checked ? state.selected.add(key) : state.selected.delete(key);
      });
      render();
      updateActionBar();
    };
  }
}

function buildGridCard(item) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.id = item.id;
  card.dataset.type = item._type;
  const key = `${item._type}:${item.id}`;
  if (state.selected.has(key)) card.classList.add('selected');
  const ico = item._type === 'folder' ? ICONS.folder : ICONS[classify(item.name, item.mime)];
  const meta = item._type === 'folder' ? 'Folder' : fmtSize(item.size);
  const star = item.starred ? '<span class="star-flag">⭐</span>' : '';
  card.innerHTML = `
    <input type="checkbox" class="card-check" ${state.selected.has(key) ? 'checked' : ''}>
    ${star}
    <div class="card-ico">${ico}</div>
    <div class="card-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
    <div class="card-meta">${meta}</div>
  `;
  wireItem(card, item);
  return card;
}

function buildListRow(item) {
  const row = document.createElement('div');
  row.className = 'list-row';
  row.dataset.id = item.id;
  row.dataset.type = item._type;
  const key = `${item._type}:${item.id}`;
  if (state.selected.has(key)) row.classList.add('selected');
  const ico = item._type === 'folder' ? ICONS.folder : ICONS[classify(item.name, item.mime)];
  const meta = item._type === 'folder' ? '—' : fmtSize(item.size);
  const star = item.starred ? '<span class="star-mini">⭐</span>' : '';
  row.innerHTML = `
    <span class="lh-check"><input type="checkbox" class="card-check" ${state.selected.has(key) ? 'checked' : ''}></span>
    <span class="lh-name"><span class="row-ico">${ico}</span><span class="row-name">${escapeHtml(item.name)}</span>${star}</span>
    <span class="lh-size">${meta}</span>
    <span class="lh-date">${fmtDate(item.created_at)}</span>
    <span class="lh-act"><button class="icon-btn row-menu" title="More">⋯</button></span>
  `;
  wireItem(row, item);
  return row;
}

function wireItem(el, item) {
  const key = `${item._type}:${item.id}`;
  const check = el.querySelector('.card-check');
  if (check) {
    check.onclick = (e) => {
      e.stopPropagation();
      if (check.checked) state.selected.add(key); else state.selected.delete(key);
      el.classList.toggle('selected', check.checked);
      updateActionBar();
    };
  }
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
      el.classList.toggle('selected');
      updateActionBar();
    } else {
      pickItem(item);
      openDetails(item);
    }
  });
  el.addEventListener('dblclick', () => onOpen(item));
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    pickItem(item);
    openCtx(e.clientX, e.clientY);
  });

  // drag to move
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    if (!state.selected.has(key)) {
      state.selected.clear();
      state.selected.add(key);
    }
    e.dataTransfer.setData('text/plain', 'cv:items');
    e.dataTransfer.effectAllowed = 'move';
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));

  if (item._type === 'folder') {
    el.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('text/plain')) {
        e.preventDefault();
        el.classList.add('drag-into');
      }
    });
    el.addEventListener('dragleave', () => el.classList.remove('drag-into'));
    el.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('drag-into');
      if (e.dataTransfer.types.includes('Files') && e.dataTransfer.files.length) {
        await uploadFiles(e.dataTransfer.files, item.id);
        return;
      }
      await bulkMove(item.id);
    });
  }
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
    loadList();
  });
}

function onOpen(item) {
  if (item._type === 'folder') {
    state.folder = item.id;
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
  const fileIds = [];
  const folderIds = [];
  for (const key of state.selected) {
    const [t, id] = key.split(':');
    (t === 'file' ? fileIds : folderIds).push(parseInt(id));
  }
  if (action === 'download') {
    for (const id of fileIds) {
      window.open(`/api/files/${id}/download`, '_blank');
      await new Promise(r => setTimeout(r, 200));
    }
    return;
  }
  if (action === 'move') return openMoveDialog();
  if (action === 'delete' && !confirm(`Permanently delete ${fileIds.length + folderIds.length} item(s)?`)) return;
  await api('/api/bulk', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ action, file_ids: fileIds, folder_ids: folderIds })
  });
  toast(`Done`, 'success');
  loadList(); loadMe();
});
$('#clearSel').onclick = () => { state.selected.clear(); render(); updateActionBar(); };

// ---------- Sort / view toggle ----------
$('#sortSelect').onchange = (e) => {
  const [s, o] = e.target.value.split('|');
  state.sort = s; state.order = o;
  loadList();
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
    if (inTrash) {
      const a = b.dataset.action;
      b.style.display = (a === 'restore' || a === 'delete') ? 'flex' : 'none';
    } else {
      b.style.display = b.dataset.action === 'restore' ? 'none' : 'flex';
    }
  });
  m.hidden = false;
  m.style.left = Math.min(x, window.innerWidth - 220) + 'px';
  m.style.top = Math.min(y, window.innerHeight - 320) + 'px';
}
function closeCtx() { $('#ctxMenu').hidden = true; }
document.addEventListener('click', (e) => {
  if (!e.target.closest('#ctxMenu') && !e.target.closest('.row-menu')) closeCtx();
});

$('#ctxMenu').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  closeCtx();
  const item = state.lastFocus;
  if (!item) return;
  const id = item.id;
  const type = item._type;
  const act = btn.dataset.action;

  if (act === 'open') onOpen(item);
  else if (act === 'download' && type === 'file') window.location = `/api/files/${id}/download`;
  else if (act === 'share' && type === 'file') openShare(id);
  else if (act === 'star' && type === 'file') {
    await api(`/api/files/${id}`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ starred: !item.starred }) });
    toast(item.starred ? 'Unstarred' : 'Starred', 'success');
    loadList();
  } else if (act === 'rename') {
    const name = prompt('New name:', item.name);
    if (name && name !== item.name) {
      const url = type === 'file' ? `/api/files/${id}` : `/api/folders/${id}`;
      await api(url, { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name }) });
      toast('Renamed', 'success');
      loadList();
    }
  } else if (act === 'move') {
    state.selected.clear();
    state.selected.add(`${type}:${id}`);
    openMoveDialog();
  } else if (act === 'restore') {
    const url = type === 'file' ? `/api/files/${id}/restore` : `/api/folders/${id}/restore`;
    await api(url, { method:'POST' });
    toast('Restored', 'success');
    loadList(); loadMe();
  } else if (act === 'delete') {
    if (state.view === 'trash') {
      if (!confirm('Delete permanently?')) return;
      const url = type === 'file' ? `/api/files/${id}?permanent=1` : `/api/folders/${id}?permanent=1`;
      await api(url, { method:'DELETE' });
    } else {
      const url = type === 'file' ? `/api/files/${id}` : `/api/folders/${id}`;
      await api(url, { method:'DELETE' });
    }
    toast(state.view === 'trash' ? 'Deleted' : 'Moved to trash', 'success');
    closeDetails();
    loadList(); loadMe();
  }
});

// ---------- Details panel ----------
function openDetails(item) {
  const p = $('#detailsPanel');
  p.hidden = false;
  document.body.classList.add('with-details');
  $('#dpIco').textContent = item._type === 'folder' ? ICONS.folder : ICONS[classify(item.name, item.mime)];
  $('#dpName').textContent = item.name;
  $('#dpMeta').textContent = item._type === 'folder' ? 'Folder' : (item.mime || 'File');
  $('#dpType').textContent = item._type === 'folder' ? 'Folder' : (item.mime || '—');
  $('#dpSize').textContent = item._type === 'folder' ? '—' : fmtSize(item.size);
  $('#dpDate').textContent = fmtDate(item.created_at);
  $('#dpPreview').onclick = () => onOpen(item);
  $('#dpDownload').onclick = () => { if (item._type === 'file') window.location = `/api/files/${item.id}/download`; };
  $('#dpShare').onclick = () => { if (item._type === 'file') openShare(item.id); };
  $('#dpRename').onclick = () => {
    const name = prompt('New name:', item.name);
    if (!name || name === item.name) return;
    const url = item._type === 'file' ? `/api/files/${item.id}` : `/api/folders/${item.id}`;
    api(url, { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name }) }).then(() => { toast('Renamed', 'success'); loadList(); });
  };
  $('#dpMove').onclick = () => {
    state.selected.clear();
    state.selected.add(`${item._type}:${item.id}`);
    openMoveDialog();
  };
  $('#dpDelete').onclick = () => {
    const url = item._type === 'file' ? `/api/files/${item.id}` : `/api/folders/${item.id}`;
    api(url, { method:'DELETE' }).then(() => { toast('Moved to trash', 'success'); closeDetails(); loadList(); loadMe(); });
  };
}
function closeDetails() { $('#detailsPanel').hidden = true; document.body.classList.remove('with-details'); }
$('#dpClose').onclick = closeDetails;

// ---------- Move dialog ----------
async function openMoveDialog() {
  const tree = await api('/api/folders/tree');
  const wrap = $('#folderTree');
  wrap.innerHTML = `<div class="tree-node" data-id=""><span>📁 My Drive (root)</span></div>` +
    tree.map(f => `<div class="tree-node" data-id="${f.id}"><span>📁 ${escapeHtml(f.path)}</span></div>`).join('');
  state.moveTarget = null;
  $('#moveConfirm').disabled = true;
  $$('#folderTree .tree-node').forEach(n => n.onclick = () => {
    $$('#folderTree .tree-node').forEach(x => x.classList.remove('active'));
    n.classList.add('active');
    state.moveTarget = n.dataset.id || null;
    $('#moveConfirm').disabled = false;
  });
  $('#moveModal').hidden = false;
}
$('#moveCancel').onclick = () => $('#moveModal').hidden = true;
$('#moveConfirm').onclick = async () => {
  $('#moveModal').hidden = true;
  await bulkMove(state.moveTarget);
};
async function bulkMove(targetFolder) {
  const fileIds = [], folderIds = [];
  for (const key of state.selected) {
    const [t, id] = key.split(':');
    (t === 'file' ? fileIds : folderIds).push(parseInt(id));
  }
  await api('/api/bulk', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ action: 'move', file_ids: fileIds, folder_ids: folderIds, target_folder: targetFolder })
  });
  toast('Moved', 'success');
  loadList();
}

// ---------- Share ----------
let currentShareFileId = null;
async function openShare(fileId) {
  currentShareFileId = fileId;
  $('#shareExpiry').value = '';
  const data = await api(`/api/share/${fileId}`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({}) });
  $('#shareUrl').value = data.url;
  $('#shareModal').hidden = false;
}
$('#shareClose').onclick = () => $('#shareModal').hidden = true;
$('#copyBtn').onclick = () => {
  $('#shareUrl').select();
  navigator.clipboard.writeText($('#shareUrl').value);
  toast('Link copied', 'success');
};
$('#shareExpiry').onchange = async (e) => {
  if (!currentShareFileId) return;
  const hours = e.target.value;
  const data = await api(`/api/share/${currentShareFileId}`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ expires_hours: hours || null })
  });
  $('#shareUrl').value = data.url;
  toast('New link generated', 'success');
};

// ---------- Preview ----------
let previewIndex = -1;
let previewable = [];
function openPreview(file) {
  previewable = state.files.filter(f => f.mime?.startsWith('image/') || f.mime?.startsWith('video/') || f.mime?.startsWith('audio/') || f.mime?.includes('pdf'));
  previewIndex = previewable.findIndex(f => f.id === file.id);
  if (previewIndex < 0) previewable = [file], previewIndex = 0;
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

// ---------- Upload ----------
function pickFiles() { $('#fileInput').click(); }
$('#btnUpload').onclick = pickFiles;
$('#bnUpload').onclick = pickFiles;
$('#fileInput').onchange = (e) => uploadFiles(e.target.files);

async function uploadFiles(files, folderId=null) {
  if (!files.length) return;
  const target = folderId !== null ? folderId : state.folder;
  let done = 0;
  $('#uploadBar').hidden = false;
  for (const f of files) {
    $('#uploadText').textContent = `Uploading ${f.name} (${done+1}/${files.length})`;
    const fd = new FormData();
    fd.append('file', f);
    if (target) fd.append('folder_id', target);
    await new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload');
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable) $('#uploadFill').style.width = ((ev.loaded / ev.total) * 100) + '%';
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) done++;
        else { try { toast(JSON.parse(xhr.responseText).error || 'Upload failed', 'error'); } catch { toast('Upload failed', 'error'); } }
        resolve();
      };
      xhr.onerror = () => { toast('Upload failed', 'error'); resolve(); };
      xhr.send(fd);
    });
  }
  $('#uploadBar').hidden = true;
  $('#uploadFill').style.width = '0';
  $('#fileInput').value = '';
  toast(`Uploaded ${done} file${done > 1 ? 's' : ''}`, 'success');
  loadList(); loadMe();
}

// Drag & drop globally on drop-zone
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

// ---------- Sidebar / views ----------
$$('.side-link, .bn-link').forEach(el => {
  if (!el.dataset.view) return;
  el.onclick = (e) => {
    e.preventDefault();
    state.view = el.dataset.view;
    state.folder = null;
    state.search = '';
    $('#search').value = '';
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
  toast('Trash emptied', 'success');
  loadList(); loadMe();
};

// ---------- Search ----------
let searchTimer = null;
$('#search').oninput = (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.search = e.target.value.trim();
    loadList();
  }, 250);
};

// ---------- Keyboard shortcuts ----------
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
    closeDetails();
    closeCtx();
    $('#previewModal').hidden = true;
    $('#shareModal').hidden = true;
    $('#moveModal').hidden = true;
    render(); updateActionBar();
  } else if (e.key === 'ArrowLeft' && !$('#previewModal').hidden) $('#prevBtn').click();
  else if (e.key === 'ArrowRight' && !$('#previewModal').hidden) $('#nextBtn').click();
});

// ---------- Init ----------
loadMe();
loadList();
setLayout(state.layout);
$('#sortSelect').value = `${state.sort}|${state.order}`;
