// CloudVault — drive UI controller
const state = {
  view: 'my',
  folder: null,
  search: '',
  files: [],
  folders: [],
  selectedId: null,
  selectedType: null,
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ---------- Icons by mime ----------
function iconFor(name, mime) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (mime?.startsWith('image/')) return '🖼';
  if (mime?.startsWith('video/')) return '🎬';
  if (mime?.startsWith('audio/')) return '🎵';
  if (mime?.includes('pdf')) return '📕';
  if (['doc','docx'].includes(ext)) return '📄';
  if (['xls','xlsx','csv'].includes(ext)) return '📊';
  if (['ppt','pptx'].includes(ext)) return '📽';
  if (['zip','rar','7z','tar','gz'].includes(ext)) return '🗜';
  if (['js','ts','py','html','css','json','md','c','cpp','java','go','rs'].includes(ext)) return '📝';
  if (['exe','dmg','apk'].includes(ext)) return '⚙';
  return '📄';
}

function fmtSize(b) {
  if (!b) return '0 B';
  const u = ['B','KB','MB','GB','TB']; let i = 0;
  while (b >= 1024 && i < u.length-1) { b /= 1024; i++; }
  return b.toFixed(b < 10 ? 1 : 0) + ' ' + u[i];
}

function toast(msg, type='') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + type;
  t.hidden = false;
  clearTimeout(window.__toastT);
  window.__toastT = setTimeout(() => t.hidden = true, 2400);
}

// ---------- API ----------
async function api(url, opts={}) {
  const res = await fetch(url, { credentials: 'same-origin', ...opts });
  if (!res.ok) {
    const err = await res.json().catch(() => ({error: 'Request failed'}));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

async function loadMe() {
  const me = await api('/api/me');
  $('#uname').textContent = me.name;
  $('#avatar').textContent = (me.name || me.email)[0].toUpperCase();
  const pct = Math.min(100, (me.used / me.quota) * 100);
  $('#barFill').style.width = pct + '%';
  $('#storageText').textContent = `${fmtSize(me.used)} / ${fmtSize(me.quota)}`;
}

async function loadList() {
  const params = new URLSearchParams();
  params.set('view', state.view);
  if (state.folder) params.set('folder', state.folder);
  if (state.search) params.set('q', state.search);
  const data = await api('/api/files?' + params);
  state.files = data.files;
  state.folders = data.folders;
  renderBreadcrumb(data.breadcrumb || []);
  render();
}

// ---------- Render ----------
function render() {
  const grid = $('#grid');
  grid.innerHTML = '';
  const items = [
    ...state.folders.map(f => ({...f, type: 'folder'})),
    ...state.files.map(f => ({...f, type: 'file'}))
  ];
  $('#empty').hidden = items.length > 0;
  for (const item of items) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.id = item.id;
    card.dataset.type = item.type;
    const ico = item.type === 'folder' ? '📁' : iconFor(item.name, item.mime);
    const meta = item.type === 'folder' ? 'Folder' : fmtSize(item.size);
    const star = item.starred ? '<span class="star-flag">⭐</span>' : '';
    card.innerHTML = `
      ${star}
      <div class="card-ico">${ico}</div>
      <div class="card-name">${escapeHtml(item.name)}</div>
      <div class="card-meta">${meta}</div>
    `;
    card.addEventListener('click', (e) => onCardClick(e, item));
    card.addEventListener('dblclick', () => onCardOpen(item));
    card.addEventListener('contextmenu', (e) => { e.preventDefault(); selectCard(card, item); openCtx(e.clientX, e.clientY); });
    grid.appendChild(card);
  }
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function selectCard(card, item) {
  $$('.card').forEach(c => c.classList.remove('selected'));
  card.classList.add('selected');
  state.selectedId = item.id;
  state.selectedType = item.type;
}

function onCardClick(e, item) {
  const card = e.currentTarget;
  selectCard(card, item);
}

function onCardOpen(item) {
  if (item.type === 'folder') {
    state.folder = item.id;
    loadList();
  } else {
    openPreview(item);
  }
}

// ---------- Context menu ----------
function openCtx(x, y) {
  const m = $('#ctxMenu');
  m.hidden = false;
  m.style.left = Math.min(x, window.innerWidth - 220) + 'px';
  m.style.top = Math.min(y, window.innerHeight - 280) + 'px';
}
function closeCtx() { $('#ctxMenu').hidden = true; }
document.addEventListener('click', (e) => {
  if (!e.target.closest('#ctxMenu')) closeCtx();
});

$('#ctxMenu').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const id = state.selectedId;
  const type = state.selectedType;
  closeCtx();
  if (!id) return;
  const act = btn.dataset.action;
  if (act === 'download' && type === 'file') {
    window.location = `/api/files/${id}/download`;
  } else if (act === 'open') {
    const item = state.files.find(f => f.id === id) || state.folders.find(f => f.id === id);
    if (item) onCardOpen({ ...item, type });
  } else if (act === 'share' && type === 'file') {
    openShare(id);
  } else if (act === 'star' && type === 'file') {
    const item = state.files.find(f => f.id === id);
    await api(`/api/files/${id}`, { method: 'PATCH', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ starred: !item.starred }) });
    toast(item.starred ? 'Unstarred' : 'Starred', 'success');
    loadList();
  } else if (act === 'rename') {
    const item = (type === 'file' ? state.files : state.folders).find(f => f.id === id);
    const name = prompt('New name:', item.name);
    if (name && name !== item.name) {
      if (type === 'file') {
        await api(`/api/files/${id}`, { method: 'PATCH', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ name }) });
        toast('Renamed', 'success');
        loadList();
      } else {
        toast('Folder rename coming soon');
      }
    }
  } else if (act === 'delete') {
    if (state.view === 'trash') {
      if (!confirm('Delete permanently? This cannot be undone.')) return;
      await api(`/api/files/${id}?permanent=1`, { method: 'DELETE' });
    } else {
      const url = type === 'file' ? `/api/files/${id}` : `/api/folders/${id}`;
      await api(url, { method: 'DELETE' });
    }
    toast('Moved to trash', 'success');
    loadList(); loadMe();
  }
});

// ---------- Share ----------
let currentShareFileId = null;
async function openShare(fileId) {
  currentShareFileId = fileId;
  const data = await api(`/api/share/${fileId}`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({}) });
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
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ expires_hours: hours || null })
  });
  $('#shareUrl').value = data.url;
  toast('New link generated', 'success');
};

// ---------- Preview ----------
function openPreview(file) {
  const body = $('#previewBody');
  body.innerHTML = '';
  const url = `/api/files/${file.id}/preview`;
  if (file.mime?.startsWith('image/')) {
    body.innerHTML = `<img src="${url}" alt="">`;
  } else if (file.mime?.startsWith('video/')) {
    body.innerHTML = `<video src="${url}" controls autoplay></video>`;
  } else if (file.mime?.startsWith('audio/')) {
    body.innerHTML = `<audio src="${url}" controls autoplay></audio>`;
  } else if (file.mime?.includes('pdf')) {
    body.innerHTML = `<iframe src="${url}"></iframe>`;
  } else if (file.mime?.startsWith('text/') || /\.(txt|md|json|js|ts|py|html|css|csv)$/i.test(file.name)) {
    fetch(url).then(r => r.text()).then(t => body.innerHTML = `<pre>${escapeHtml(t.slice(0, 50000))}</pre>`);
  } else {
    body.innerHTML = `<div style="color:white;text-align:center;padding:40px;">Preview not available.<br><br><a href="/api/files/${file.id}/download" class="btn btn-primary">⬇ Download</a></div>`;
  }
  $('#previewModal').hidden = false;
}
$('#previewClose').onclick = () => $('#previewModal').hidden = true;

// ---------- Upload ----------
function pickFiles() { $('#fileInput').click(); }
$('#btnUpload').onclick = pickFiles;
$('#bnUpload').onclick = pickFiles;
$('#fileInput').onchange = (e) => uploadFiles(e.target.files);

async function uploadFiles(files) {
  if (!files.length) return;
  let done = 0;
  $('#uploadBar').hidden = false;
  for (const f of files) {
    $('#uploadText').textContent = `Uploading ${f.name} (${done+1}/${files.length})`;
    const fd = new FormData();
    fd.append('file', f);
    if (state.folder) fd.append('folder_id', state.folder);
    await new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload');
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable) {
          $('#uploadFill').style.width = ((ev.loaded / ev.total) * 100) + '%';
        }
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          done++;
        } else {
          try { toast(JSON.parse(xhr.responseText).error || 'Upload failed', 'error'); }
          catch { toast('Upload failed', 'error'); }
        }
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

// Drag & drop
const dz = $('#dropZone');
['dragenter','dragover'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
['dragleave','drop'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || e.target === dz) dz.classList.remove('drag'); }));
dz.addEventListener('drop', (e) => {
  e.preventDefault();
  dz.classList.remove('drag');
  if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
});

// ---------- Sidebar ----------
$$('.side-link, .bn-link').forEach(el => {
  if (!el.dataset.view) return;
  el.onclick = () => {
    state.view = el.dataset.view;
    state.folder = null;
    $$('.side-link, .bn-link').forEach(x => x.classList.remove('active'));
    $$(`[data-view="${state.view}"]`).forEach(x => x.classList.add('active'));
    loadList();
  };
});

// ---------- New folder ----------
async function newFolder() {
  const name = prompt('Folder name:');
  if (!name) return;
  await api('/api/folders', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ name, parent_id: state.folder }) });
  toast('Folder created', 'success');
  loadList();
}
$('#btnNewFolder').onclick = newFolder;
$('#btnNew').onclick = () => {
  // simple "new" menu — choose folder or upload
  if (confirm('Create new folder? (Cancel for upload)')) newFolder(); else pickFiles();
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

// ---------- Init ----------
loadMe();
loadList();
