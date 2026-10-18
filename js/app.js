// --- config ---
const APP_VERSION = '1.4.4';
const SUPABASE_URL = (localStorage.getItem('sb_url') || 'https://vhifkvzmujbhcdwjixdj.supabase.co').replace(/\/+$/, '');
const SUPABASE_ANON_KEY = localStorage.getItem('sb_anon_key') || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZoaWZrdnptdWpiaGNkd2ppeGRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE0ODgzOTYsImV4cCI6MjA5NzA2NDM5Nn0.nZ7zBk3p_Fh5Q88makO5OmHJFCJ2uG_0inIZ8kmq-zc';
const configured = !!(SUPABASE_URL && SUPABASE_ANON_KEY);

async function sb(path, method, body) {
  const headers = supabaseHeaders();
  if (body) headers['Content-Type'] = 'application/json';
  if (method === 'POST') headers['Prefer'] = 'return=representation';
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, opts);
  if (!res.ok) {
    const text = await res.text();
    let msg;
    try { msg = JSON.parse(text).message || `请求失败 (${res.status})`; }
    catch { msg = `请求失败 (${res.status})`; }
    if (/column.*does not exist|could not find.*column/i.test(msg)) msg = '数据表缺少字段，请在 Supabase SQL Editor 运行 migration.sql';
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// --- state ---
let namespace = localStorage.getItem('sb_namespace') || 'default';
let files = [];

// --- view counter (localStorage-based link visit tracking) ---
const VIEWS_KEY = 'link_views';

function getViews() {
  try { return JSON.parse(localStorage.getItem(VIEWS_KEY) || '{}'); }
  catch { return {}; }
}
function incrementView(gistId) {
  const v = getViews();
  v[gistId] = (v[gistId] || 0) + 1;
  localStorage.setItem(VIEWS_KEY, JSON.stringify(v));
}
function getViewCount(gistId) {
  return getViews()[gistId] || 0;
}

// --- optimistic cache (bridges eventual-consistency gaps after mutations) ---
const OPTI_CREATES_KEY = `opti_creates:${SUPABASE_URL}:${namespace}`;
const OPTI_DELETES_KEY = `opti_deletes:${SUPABASE_URL}:${namespace}`;
const OPTI_MAX_AGE_MS = 10 * 60 * 1000;

function loadOptiCreates() {
  try { return JSON.parse(sessionStorage.getItem(OPTI_CREATES_KEY) || '[]'); }
  catch { return []; }
}
function saveOptiCreates(items) { sessionStorage.setItem(OPTI_CREATES_KEY, JSON.stringify(items)); }
function loadOptiDeletes() {
  try { return JSON.parse(sessionStorage.getItem(OPTI_DELETES_KEY) || '[]'); }
  catch { return []; }
}
function saveOptiDeletes(ids) { sessionStorage.setItem(OPTI_DELETES_KEY, JSON.stringify(ids)); }

function addOptiCreate(id, desc, date) {
  const items = loadOptiCreates();
  items.unshift({ id, desc, date, ts: Date.now() });
  saveOptiCreates(items);
}
function addOptiDelete(id) {
  const ids = loadOptiDeletes();
  if (!ids.includes(id)) ids.push(id);
  saveOptiDeletes(ids);
}
function cleanOptiState(apiIds) {
  const now = Date.now();
  let creates = loadOptiCreates();
  creates = creates.filter(c => !apiIds.has(c.id) && (now - c.ts) < OPTI_MAX_AGE_MS);
  saveOptiCreates(creates);
  let deletes = loadOptiDeletes();
  deletes = deletes.filter(id => apiIds.has(id));
  saveOptiDeletes(deletes);
}

const THEMES = ['auto', 'daylight', 'midnight', 'sepia', 'ocean', 'cherry'];

function getTheme() {
  const t = localStorage.getItem('theme') || 'auto';
  return THEMES.includes(t) ? t : 'auto';
}

function resolveAuto() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'midnight' : 'daylight';
}

function setTheme(name) {
  localStorage.setItem('theme', name);
  applyTheme(name);
}

function applyTheme(name) {
  const effective = name === 'auto' ? resolveAuto() : name;
  document.documentElement.setAttribute('data-theme', effective);
}

// --- helpers ---
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const esc = s => s.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);

// --- SVG icons (Lucide-style, stroke-based) ---
const Icons = {
  eye: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`,
  eyeOff: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20C5 20 1 12 1 12a21.77 21.77 0 0 1 5.06-5.94M9.9 4.24A10.86 10.86 0 0 1 12 4c7 0 11 8 11 8a21.8 21.8 0 0 1-3.17 4.19M14.12 14.12a3 3 0 0 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`,
  link: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
  plus: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
  image: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`,
  check: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  copy: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
  list: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`,
  settings: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  trash: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
  externalLink: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`,
  arrowLeft: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>`,
  folder: `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`,
  file: `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>`,
  shield: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
  key: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>`,
  alert: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
  database: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>`,
  upload: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
  download: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
  close: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
};

// --- format file size ---
function formatSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return size.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

// --- Supabase Storage helpers ---
const STORAGE_BUCKET = 'files';
const MAX_ATTACHMENT_SIZE = 200 * 1024 * 1024;
const MAX_ATTACHMENT_SIZE_LABEL = '200 MB';

function addAttachmentFiles(selectedFiles, target, render, input) {
  const oversized = [];
  for (const file of selectedFiles) {
    if (file.size > MAX_ATTACHMENT_SIZE) oversized.push(file.name);
    else target.push(file);
  }
  if (input) input.value = '';
  if (oversized.length) {
    toast(`${oversized.join(', ')} 超过 ${MAX_ATTACHMENT_SIZE_LABEL} 限制，已跳过`, Icons.alert);
  }
  render();
}

function bindAttachmentDropZone(zone, input, target, render) {
  if (!zone) return;
  let dragDepth = 0;
  const setActive = active => zone.classList.toggle('drag-over', active);
  zone.addEventListener('dragenter', event => {
    event.preventDefault();
    dragDepth += 1;
    setActive(true);
  });
  zone.addEventListener('dragover', event => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setActive(true);
  });
  zone.addEventListener('dragleave', event => {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) setActive(false);
  });
  zone.addEventListener('drop', event => {
    event.preventDefault();
    dragDepth = 0;
    setActive(false);
    addAttachmentFiles(event.dataTransfer.files, target, render, input);
  });
}

function preventWindowFileDrop(event) {
  if (event.dataTransfer?.types?.includes('Files')) event.preventDefault();
}

function enableWindowFileDropGuard() {
  if (window.__shortlinkDropGuard) return;
  window.addEventListener('dragover', preventWindowFileDrop);
  window.addEventListener('drop', preventWindowFileDrop);
  window.__shortlinkDropGuard = true;
}

function supabaseHeaders(key = SUPABASE_ANON_KEY) {
  const headers = { apikey: key };
  if (!key.startsWith('sb_publishable_')) headers.Authorization = `Bearer ${key}`;
  return headers;
}

function storageObjectPath(path) {
  return `${STORAGE_BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

function newStoragePath(file) {
  const folder = Array.from(new TextEncoder().encode(namespace), byte => byte.toString(16).padStart(2, '0')).join('');
  const name = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100) || 'file';
  return `ns-${folder}/${crypto.randomUUID()}_${name}`;
}

async function sbStorageUpload(file, path) {
  const res = await fetch(
    `${SUPABASE_URL}/storage/v1/object/${storageObjectPath(path)}`,
    {
      method: 'POST',
      headers: {
        ...supabaseHeaders(),
        'Content-Type': file.type || 'application/octet-stream',
      },
      body: file,
    }
  );
  if (!res.ok) {
    const text = await res.text();
    let msg;
    try { const error = JSON.parse(text); msg = error.message || error.error || text; } catch { msg = text; }
    if (/bucket.*not found/i.test(msg)) msg = '缺少 files 存储桶，请在 Supabase SQL Editor 运行 migration.sql';
    else if (/row.level security|permission denied|unauthorized/i.test(msg) || res.status === 403) msg = '存储权限不足，请在 Supabase SQL Editor 运行 migration.sql';
    else if (res.status === 413) msg = '文件超出 Supabase 存储桶的大小限制';
    throw new Error(`上传失败: ${msg}`);
  }
  return res.json();
}

async function sbStorageDelete(path) {
  const res = await fetch(
    `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}`,
    {
      method: 'DELETE',
      headers: { ...supabaseHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: [path] }),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    let msg;
    try { msg = JSON.parse(text).message || text; } catch { msg = text; }
    console.warn('删除存储文件失败:', msg);
  }
}

function sbStoragePublicUrl(path) {
  return `${SUPABASE_URL}/storage/v1/object/public/${storageObjectPath(path)}`;
}

async function cleanUploadedFiles(entries) {
  await Promise.allSettled(entries.filter(f => f.key).map(f => sbStorageDelete(f.key)));
}

async function uploadAttachments(selectedFiles, onProgress) {
  const oversized = selectedFiles.filter(file => file.size > MAX_ATTACHMENT_SIZE);
  if (oversized.length) {
    throw new Error(`${oversized.map(file => file.name).join(', ')} 超过 ${MAX_ATTACHMENT_SIZE_LABEL} 限制`);
  }
  const entries = [];
  try {
    onProgress(0, selectedFiles.length);
    for (const file of selectedFiles) {
      const path = newStoragePath(file);
      try { await sbStorageUpload(file, path); }
      catch (error) { throw new Error(`${file.name}: ${error.message}`); }
      entries.push({ name: file.name, size: file.size, type: file.type, key: path, url: sbStoragePublicUrl(path) });
      onProgress(entries.length, selectedFiles.length);
    }
    return entries;
  } catch (error) {
    await cleanUploadedFiles(entries);
    throw error;
  }
}

function myLinksUrl(ns = namespace) {
  return `?user=${encodeURIComponent(ns)}`;
}

function setEditorBusy(editor, busy) {
  editor.inert = busy;
  editor.setAttribute('aria-busy', String(busy));
  editor.querySelectorAll('input, textarea, button').forEach(control => { control.disabled = busy; });
}

function openImageViewer(images, startIndex) {
  const dialog = document.createElement('dialog');
  dialog.className = 'image-viewer';
  dialog.setAttribute('aria-label', '图片预览');
  dialog.innerHTML = `
    <div class="image-viewer-toolbar">
      <span class="image-viewer-counter" aria-live="polite"></span>
      <button type="button" class="btn-sm" data-prev title="上一张" aria-label="上一张">${Icons.arrowLeft}</button>
      <button type="button" class="btn-sm image-next" data-next title="下一张" aria-label="下一张">${Icons.arrowLeft}</button>
      <a class="btn-sm" data-download download title="下载图片" aria-label="下载图片">${Icons.download}</a>
      <button type="button" class="btn-sm" data-close title="关闭" aria-label="关闭图片预览">${Icons.close}</button>
    </div>
    <img class="image-viewer-full" alt="">
  `;
  let index = startIndex;
  const update = () => {
    const image = dialog.querySelector('img');
    image.src = images[index];
    image.alt = `图片 ${index + 1}`;
    dialog.querySelector('.image-viewer-counter').textContent = `${index + 1} / ${images.length}`;
    dialog.querySelector('[data-download]').href = images[index];
    dialog.querySelector('[data-download]').download = `image-${index + 1}`;
    dialog.querySelector('[data-prev]').disabled = index === 0;
    dialog.querySelector('[data-next]').disabled = index === images.length - 1;
  };
  const move = delta => { index = Math.max(0, Math.min(images.length - 1, index + delta)); update(); };
  dialog.querySelector('[data-prev]').onclick = () => move(-1);
  dialog.querySelector('[data-next]').onclick = () => move(1);
  dialog.querySelector('[data-close]').onclick = () => dialog.close();
  dialog.onclick = event => { if (event.target === dialog) dialog.close(); };
  dialog.addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      move(event.key === 'ArrowLeft' ? -1 : 1);
    }
    if (event.key === 'Escape') event.stopPropagation();
  });
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.appendChild(dialog);
  update();
  dialog.showModal();
}

function toast(msg, icon) {
  let t = $('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  const iconHtml = icon ? `<span style="display:inline-flex;vertical-align:middle;margin-right:6px">${icon}</span>` : '';
  t.innerHTML = iconHtml + esc(msg);
  t.classList.add('show');
  clearTimeout(t._tid);
  t._tid = setTimeout(() => t.classList.remove('show'), 3000);
}

// --- image compression ---
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`${file.name}: 图片读取失败`));
    reader.onload = e => {
      const img = new Image();
      img.onerror = () => reject(new Error(`${file.name}: 图片格式有误或暂不支持`));
      img.onload = () => {
        try {
          const MAX = 1600;
          let { width, height } = img;
          if (width > MAX || height > MAX) {
            const ratio = Math.min(MAX / width, MAX / height);
            width = Math.round(width * ratio);
            height = Math.round(height * ratio);
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          canvas.getContext('2d').drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', 0.8));
        } catch (error) { reject(error); }
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// --- render ---
function render() {
  const params = new URLSearchParams(location.search);
  const sid = params.get('s');
  const user = params.get('user');
  const page = params.get('page');

  if (page === 'settings') return renderSettings();
  if (!configured) return renderSetup();
  if (sid) return renderView(sid);
  if (user) return renderList(user);
  return renderHome();
}

// -- setup page --
function renderSetup() {
  app.innerHTML = `
    <div class="card setup fade-in">
      <div class="logo">${Icons.link}<span>shortlink</span></div>
      <h2>配置 Supabase</h2>
      <p>去 <a class="link" href="https://app.supabase.com" target="_blank" rel="noopener">Supabase Dashboard ${Icons.externalLink}</a> 创建项目，<br>然后在 SQL Editor 运行 <code>migration.sql</code>，<br>再把 Project URL 和 Anon Key 粘贴到下面。</p>
      <label class="input-label" for="sb-url-input">Project URL</label>
      <input id="sb-url-input" type="text" placeholder="https://xxxxxxxxxxxx.supabase.co" autocomplete="off">
      <label class="input-label spacer-sm" for="sb-key-input">Anon Key</label>
      <input id="sb-key-input" type="password" placeholder="eyJhbGciOiJIUzI1NiIs..." autocomplete="off">
      <label class="input-label spacer-sm" for="sb-ns-input">Namespace（你的用户名，用于管理短链接）</label>
      <input id="sb-ns-input" type="text" placeholder="my-space" autocomplete="off" value="${esc(namespace)}">
      <p class="dim spacer-sm" style="display:flex;align-items:center;gap:6px">${Icons.shield} 配置只存在你浏览器里，不会上传到任何地方。</p>
      <button class="btn btn-primary spacer" id="save-config" style="width:100%">
        ${Icons.key} 保存配置
      </button>
    </div>
  `;
  $('#save-config').onclick = saveConnection;
}

// -- home page --
let uploadFiles = [];

function renderHome() {
  app.innerHTML = `
    <div class="logo">${Icons.link}<span>shortlink</span></div>
    <div class="card fade-in">
      <label class="input-label" for="text-input">内容</label>
      <textarea id="text-input" placeholder="写点什么..."></textarea>
      <div class="flex spacer-sm">
        <label class="file-label" for="file-input" tabindex="0" aria-label="添加图片">
          ${Icons.image} 添加图片
        </label>
        <input type="file" id="file-input" accept="image/*" multiple hidden>
        <span class="muted" id="img-count"></span>
      </div>
      <div class="previews" id="previews"></div>

      <hr class="divider">
      <label class="input-label">文件附件（单个最大 200 MB）</label>
      <div class="flex attachment-drop-zone" id="upload-drop-zone">
        <label class="file-label" for="upload-file-input" tabindex="0" aria-label="上传文件">
          ${Icons.upload} 选择文件
        </label>
        <input type="file" id="upload-file-input" multiple hidden>
        <span class="muted" id="upload-file-count"></span>
        <span class="drop-hint">或将文件拖到这里</span>
      </div>
      <div class="upload-previews" id="upload-previews"></div>

      <button class="btn btn-primary spacer" id="create-btn" style="width:100%">
        ${Icons.link} 创建短链接
      </button>
      <div class="result spacer" id="result">
        <div class="success-text">${Icons.check} 创建成功</div>
        <a class="result-url" id="result-url" href="" target="_blank" rel="noopener"></a>
        <div class="flex spacer-sm">
          <button class="btn-sm" id="copy-btn" aria-label="复制链接">${Icons.copy} 复制</button>
          <button class="btn-sm" id="new-btn">${Icons.plus} 再创建一个</button>
        </div>
      </div>
    </div>
    <div class="bg-actions">
      <button class="btn btn-ghost" id="list-btn">
        ${Icons.list} 我的短链接
      </button>
      <a class="btn btn-ghost" href="?page=settings" style="text-decoration:none" aria-label="设置">
        ${Icons.settings} 设置
      </a>
    </div>
  `;
  files = [];
  uploadFiles = [];
  renderPreviews();
  renderUploadPreviews();
  bindHomeEvents();
}

function renderUploadPreviews() {
  const container = $('#upload-previews');
  if (!container) return;
  container.innerHTML = '';
  const count = $('#upload-file-count');
  if (count) count.textContent = uploadFiles.length ? `${uploadFiles.length} 个文件` : '';

  uploadFiles.forEach((f, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'upload-item fade-in';
    wrap.innerHTML = `
      <div class="upload-item-icon">${Icons.upload}</div>
      <div class="upload-item-info">
        <span class="upload-item-name">${esc(f.name)}</span>
        <span class="upload-item-size">${formatSize(f.size)}</span>
      </div>
      <button class="upload-item-del" data-idx="${i}" aria-label="移除文件">${Icons.close}</button>
    `;
    wrap.querySelector('.upload-item-del').onclick = () => {
      uploadFiles.splice(i, 1);
      renderUploadPreviews();
    };
    container.appendChild(wrap);
  });
}

function bindHomeEvents() {
  const fi = $('#file-input');
  fi.onchange = () => {
    files.push(...fi.files);
    fi.value = '';
    renderPreviews();
  };

  const ufi = $('#upload-file-input');
  ufi.onchange = () => {
    addAttachmentFiles(ufi.files, uploadFiles, renderUploadPreviews, ufi);
  };
  bindAttachmentDropZone($('#upload-drop-zone'), ufi, uploadFiles, renderUploadPreviews);
  enableWindowFileDropGuard();

  $('#create-btn').onclick = createShortlink;
  $('#list-btn').onclick = () => {
    location.search = '?user=' + encodeURIComponent(namespace);
  };
}

function renderPreviews() {
  const container = $('#previews');
  if (!container) return;
  container.innerHTML = '';
  const imgCount = $('#img-count');
  if (imgCount) imgCount.textContent = files.length ? `${files.length} 张` : '';

  files.forEach((f, i) => {
    const r = new FileReader();
    r.onload = e => {
      const wrap = document.createElement('div');
      wrap.className = 'wrap';
      wrap.setAttribute('tabindex', '0');
      wrap.setAttribute('aria-label', `图片 ${i + 1}，点击删除`);
      wrap.innerHTML = `<img src="${e.target.result}" alt="预览图片 ${i + 1}"><button class="del" aria-label="删除图片">&times;</button>`;
      wrap.querySelector('.del').onclick = ev => {
        ev.stopPropagation();
        files.splice(i, 1);
        renderPreviews();
      };
      wrap.onclick = () => {
        files.splice(i, 1);
        renderPreviews();
      };
      container.appendChild(wrap);
    };
    r.readAsDataURL(f);
  });
}

async function createShortlink() {
  const btn = $('#create-btn');
  const editor = btn.closest('.card');
  const origHTML = btn.innerHTML;
  let uploadedEntries = [];
  setEditorBusy(editor, true);
  btn.innerHTML = `<span class="spinner"></span> 创建中...`;
  $('#result').style.display = 'none';

  try {
    const text = $('#text-input').value.trim();
    if (!text && !files.length && !uploadFiles.length) {
      throw new Error('至少写点文字、传张图片或上传文件');
    }
    const images = await Promise.all(files.map(compressImage));

    // Upload files to Supabase Storage
    const fileEntries = await uploadAttachments([...uploadFiles], (done, total) => {
      if (total) btn.innerHTML = `<span class="spinner"></span> 上传文件中 (${done}/${total})...`;
    });
    uploadedEntries = fileEntries;

    const preview = text ? text.slice(0, 60).replace(/\n/g, ' ') :
      (images.length ? `[${images.length} images]` :
        (fileEntries.length ? `[${fileEntries.length} files]` : ''));
    const created = new Date().toISOString();

    const rows = await sb('shortlinks', 'POST', {
      text,
      images,
      files: fileEntries,
      description: preview,
      namespace,
      created,
      created_at: created
    });

    if (!rows?.[0]?.id) throw new Error('创建失败');
    uploadedEntries = [];

    addOptiCreate(rows[0].id, preview, created);

    const url = `${location.origin}${location.pathname}?s=${rows[0].id}`;
    $('#result-url').href = url;
    $('#result-url').textContent = url;
    $('#result').style.display = 'block';
    $('#text-input').value = '';
    files = [];
    uploadFiles = [];
    renderPreviews();
    renderUploadPreviews();

    $('#copy-btn').onclick = () => { navigator.clipboard.writeText(url); toast('已复制', Icons.check); };
    $('#new-btn').onclick = () => { $('#result').style.display = 'none'; };
  } catch (err) {
    await cleanUploadedFiles(uploadedEntries);
    toast(err.message, Icons.alert);
    console.error(err);
  }
  setEditorBusy(editor, false);
  btn.innerHTML = origHTML;
}

// -- view page --
function skeletonView() {
  return `
    <div class="card fade-in">
      <div class="skeleton skeleton-text" style="width:50%;height:14px"></div>
      <div class="skeleton skeleton-text" style="width:30%;height:14px;margin-bottom:16px"></div>
      <div class="skeleton skeleton-block"></div>
    </div>
  `;
}

async function renderView(linkId) {
  app.innerHTML = skeletonView();
  const returnUrl = myLinksUrl(new URLSearchParams(location.search).get('user') || namespace);

  try {
    const rows = await sb(`shortlinks?id=eq.${encodeURIComponent(linkId)}&limit=1`, 'GET');
    const data = rows?.[0];

    if (!data) {
      return (app.innerHTML = `
        <div class="card fade-in">
          <div class="empty-state">
            ${Icons.file}
            <p>内容不存在</p>
            <a class="btn btn-secondary" href="${esc(returnUrl)}">${Icons.arrowLeft} 返回我的短链接</a>
          </div>
        </div>`);
    }

    incrementView(linkId);
    const date = data.created ? data.created.slice(0, 16).replace('T', ' ') : '';
    let editFiles = [];
    let editImages = [];
    let editUploadFiles = [];
    let newEditUploadFiles = [];
    let removedExistingKeys;

    function renderViewMode() {
      let html = `
        <div class="card fade-in">
        <div class="view-meta">
          ${Icons.link}
          <span>s/</span><span class="gist-id">${esc(linkId)}</span>
          <span>&middot;</span>
          <span>${esc(date)}</span>
        </div>
      `;

      if (data.text) html += `<div class="view-text">${esc(data.text)}</div>`;
      if (data.images?.length) {
        html += `<div class="view-images">`;
        data.images.forEach((img, i) => {
          html += `<button type="button" class="view-image" data-image-index="${i}" aria-label="查看原图 ${i + 1}"><img src="${esc(img)}" alt="图片 ${i + 1}" loading="lazy"></button>`;
        });
        html += `</div>`;
      }
      if (data.files?.length) {
        html += `<div class="view-files">`;
        data.files.forEach((f, i) => {
          const iconSvg = f.type?.startsWith('image/') ? Icons.image : Icons.download;
          html += `
            <a class="file-attachment" href="${esc(f.url)}" target="_blank" rel="noopener" download>
              <span class="file-attach-icon">${iconSvg}</span>
              <span class="file-attach-info">
                <span class="file-attach-name">${esc(f.name)}</span>
                <span class="file-attach-size">${formatSize(f.size)}</span>
              </span>
              ${Icons.download}
            </a>
          `;
        });
        html += `</div>`;
      }
      if (!data.text && !data.images?.length && !data.files?.length) {
        html += `<div class="empty-state"><p class="muted">没有内容</p></div>`;
      }

      html += `<div class="spacer view-actions">`;
      html += `<a class="btn btn-secondary btn-sm" href="${esc(returnUrl)}">${Icons.arrowLeft} 返回我的短链接</a>`;
      html += `<button class="btn btn-ghost btn-sm" id="edit-btn">${Icons.settings} 编辑</button>`;
      html += `<button class="btn btn-danger btn-sm" id="delete-link" aria-label="删除此短链接">${Icons.trash} 删除</button>`;
      html += `</div></div>`;
      app.innerHTML = html;
      bindViewActions();
    }

    function renderEditUploadPreviews() {
      const c = $('#edit-upload-previews');
      if (!c) return;
      c.innerHTML = '';
      const count = $('#edit-upload-count');
      if (count) count.textContent = newEditUploadFiles.length ? `${newEditUploadFiles.length} 个新文件` : '';

      // Show existing files still kept
      editUploadFiles.forEach((f, i) => {
        if (removedExistingKeys.has(f.key)) return;
        const wrap = document.createElement('div');
        wrap.className = 'upload-item fade-in';
        wrap.innerHTML = `
          <div class="upload-item-icon">${Icons.download}</div>
          <div class="upload-item-info">
            <span class="upload-item-name">${esc(f.name)}</span>
            <span class="upload-item-size">${formatSize(f.size)}</span>
          </div>
          <button class="upload-item-del" aria-label="移除文件">${Icons.close}</button>
        `;
        wrap.querySelector('.upload-item-del').onclick = () => {
          removedExistingKeys.add(f.key);
          renderEditUploadPreviews();
        };
        c.appendChild(wrap);
      });

      // Show newly added files
      newEditUploadFiles.forEach((f, i) => {
        const wrap = document.createElement('div');
        wrap.className = 'upload-item fade-in';
        wrap.innerHTML = `
          <div class="upload-item-icon">${Icons.upload}</div>
          <div class="upload-item-info">
            <span class="upload-item-name">${esc(f.name)}</span>
            <span class="upload-item-size">${formatSize(f.size)}</span>
            <span class="upload-item-new">新文件</span>
          </div>
          <button class="upload-item-del" aria-label="移除文件">${Icons.close}</button>
        `;
        wrap.querySelector('.upload-item-del').onclick = () => {
          newEditUploadFiles.splice(i, 1);
          renderEditUploadPreviews();
        };
        c.appendChild(wrap);
      });
    }

    function renderEditMode() {
      editFiles = [];
      editImages = [...(data.images || [])];
      editUploadFiles = data.files ? [...data.files] : [];
      newEditUploadFiles = [];
      removedExistingKeys = new Set();

      let html = `
        <div class="card fade-in">
        <div class="view-meta">
          ${Icons.settings}
          <span>编辑</span>
          <span>&middot;</span>
          <span class="gist-id">s/${esc(linkId).slice(0, 8)}</span>
        </div>
        <label class="input-label" for="edit-text">文字内容</label>
        <textarea id="edit-text" placeholder="写点什么...">${esc(data.text || '')}</textarea>
        <div class="flex spacer-sm">
          <label class="file-label" for="edit-file-input" tabindex="0" aria-label="添加新图片">
            ${Icons.image} 添加图片
          </label>
          <input type="file" id="edit-file-input" accept="image/*" multiple hidden>
          <span class="muted" id="edit-img-count"></span>
        </div>
        <div class="previews" id="edit-previews"></div>

        <hr class="divider">
        <label class="input-label">文件附件（单个最大 200 MB）</label>
        <div class="flex attachment-drop-zone" id="edit-upload-drop-zone">
          <label class="file-label" for="edit-upload-file-input" tabindex="0" aria-label="上传新文件">
            ${Icons.upload} 添加文件
          </label>
          <input type="file" id="edit-upload-file-input" multiple hidden>
          <span class="muted" id="edit-upload-count"></span>
          <span class="drop-hint">或将文件拖到这里</span>
        </div>
        <div class="upload-previews" id="edit-upload-previews"></div>
      `;

      if (data.images?.length) {
        html += `<p class="dim spacer-sm">已有图片（点击删除）</p>`;
        html += `<div class="previews" id="existing-previews">`;
        data.images.forEach((img, i) => {
          html += `
            <div class="wrap edit-wrap" tabindex="0" data-idx="${i}" aria-label="删除已有图片 ${i + 1}">
              <img src="${img}" alt="已有图片 ${i + 1}">
              <button class="del" aria-label="删除图片">&times;</button>
            </div>`;
        });
        html += `</div>`;
      }

      html += `<div class="flex spacer" style="gap:8px">`;
      html += `<button class="btn btn-primary btn-sm" id="save-edit-btn">${Icons.check} 保存修改</button>`;
      html += `<button class="btn btn-secondary btn-sm" id="cancel-edit-btn">取消</button>`;
      html += `</div></div>`;
      app.innerHTML = html;
      bindEditActions();
      renderEditUploadPreviews();
    }

    function renderEditPreviews() {
      const c = $('#edit-previews');
      if (!c) return;
      c.innerHTML = '';
      const count = $('#edit-img-count');
      if (count) count.textContent = editFiles.length ? `${editFiles.length} 张新图片` : '';
      editFiles.forEach((f, i) => {
        const r = new FileReader();
        r.onload = e => {
          const wrap = document.createElement('div');
          wrap.className = 'wrap';
          wrap.setAttribute('tabindex', '0');
          wrap.setAttribute('aria-label', `新图片 ${i + 1}，点击删除`);
          wrap.innerHTML = `<img src="${e.target.result}" alt="新图片 ${i + 1}"><button class="del" aria-label="删除图片">&times;</button>`;
          wrap.querySelector('.del').onclick = ev => { ev.stopPropagation(); editFiles.splice(i, 1); renderEditPreviews(); };
          wrap.onclick = () => { editFiles.splice(i, 1); renderEditPreviews(); };
          c.appendChild(wrap);
        };
        r.readAsDataURL(f);
      });
    }

    function bindEditActions() {
      const efi = $('#edit-file-input');
      if (efi) {
        efi.onchange = () => {
          editFiles.push(...efi.files);
          efi.value = '';
          renderEditPreviews();
        };
      }

      const eufi = $('#edit-upload-file-input');
      if (eufi) {
        eufi.onchange = () => {
          addAttachmentFiles(eufi.files, newEditUploadFiles, renderEditUploadPreviews, eufi);
        };
        bindAttachmentDropZone($('#edit-upload-drop-zone'), eufi, newEditUploadFiles, renderEditUploadPreviews);
        enableWindowFileDropGuard();
      }

      $$('#existing-previews .edit-wrap').forEach(wrap => {
        wrap.onclick = () => {
          const idx = parseInt(wrap.dataset.idx);
          editImages.splice(idx, 1);
          wrap.remove();
          $$('#existing-previews .edit-wrap').forEach((item, index) => { item.dataset.idx = index; });
        };
      });

      $('#save-edit-btn').onclick = async () => {
        const btn = $('#save-edit-btn');
        const editor = btn.closest('.card');
        let uploadedEntries = [];
        setEditorBusy(editor, true);
        btn.innerHTML = `<span class="spinner"></span> 保存中...`;

        try {
          const textVal = $('#edit-text').value.trim();
          if (!textVal && !editImages.length && !editFiles.length && !newEditUploadFiles.length && editUploadFiles.filter(f => !removedExistingKeys.has(f.key)).length === 0) {
            throw new Error('至少需要文字、图片或文件');
          }

          const newImages = editFiles.length ? await Promise.all(editFiles.map(compressImage)) : [];
          const newText = textVal;
          const newImagesArr = [...editImages, ...newImages];

          // Upload new files
          const newFileEntries = await uploadAttachments([...newEditUploadFiles], (done, total) => {
            if (total) btn.innerHTML = `<span class="spinner"></span> 上传文件 (${done}/${total})...`;
          });
          uploadedEntries = newFileEntries;

          // Build final files array: keep existing not removed + new uploads
          const keptFiles = editUploadFiles.filter(f => !removedExistingKeys.has(f.key));
          const finalFiles = [...keptFiles, ...newFileEntries];

          const desc = newText ? newText.slice(0, 60).replace(/\n/g, ' ') :
            (newImagesArr.length ? `[${newImagesArr.length} images]` :
              (finalFiles.length ? `[${finalFiles.length} files]` : ''));

          await sb(`shortlinks?id=eq.${encodeURIComponent(linkId)}`, 'PATCH', {
            text: newText,
            images: newImagesArr,
            files: finalFiles,
            description: desc
          });
          uploadedEntries = [];
          cleanUploadedFiles(editUploadFiles.filter(f => removedExistingKeys.has(f.key)));

          toast('已保存', Icons.check);
          data.text = newText;
          data.images = newImagesArr;
          data.files = finalFiles;
          renderViewMode();
        } catch (err) {
          await cleanUploadedFiles(uploadedEntries);
          toast(err.message, Icons.alert);
        }
        setEditorBusy(editor, false);
        btn.innerHTML = `${Icons.check} 保存修改`;
      };

      $('#cancel-edit-btn').onclick = () => renderViewMode();
    }

    function bindViewActions() {
      $$('.view-image').forEach(button => {
        button.onclick = () => openImageViewer(data.images, Number(button.dataset.imageIndex));
      });
      $('#edit-btn').onclick = () => renderEditMode();
      const del = $('#delete-link');
      if (del) {
        let deleteConfirming = false;
        del.onclick = async e => {
          e.preventDefault();
          if (!deleteConfirming) {
            deleteConfirming = true;
            del.classList.add('btn-danger-solid');
            del.innerHTML = `${Icons.alert} 确认删除`;
            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'btn btn-ghost btn-sm';
            cancelBtn.id = 'delete-cancel-btn';
            cancelBtn.innerHTML = '取消';
            cancelBtn.onclick = ev => {
              ev.preventDefault();
              ev.stopPropagation();
              deleteConfirming = false;
              del.classList.remove('btn-danger-solid');
              del.innerHTML = `${Icons.trash} 删除`;
              cancelBtn.remove();
            };
            del.parentNode.insertBefore(cancelBtn, del.nextSibling);
            return;
          }
          try {
            await sb(`shortlinks?id=eq.${encodeURIComponent(linkId)}`, 'DELETE');
            cleanUploadedFiles(data.files || []);

            addOptiDelete(linkId);
            app.innerHTML = `
              <div class="card fade-in">
                <div class="empty-state">
                  ${Icons.check}
                  <p style="font-weight:600;color:var(--color-text)">已删除</p>
                  <p class="muted">s/${esc(linkId).slice(0, 12)} 已被永久删除</p>
                  <div class="flex" style="justify-content:center;flex-wrap:wrap">
                    <a class="btn btn-secondary btn-sm" href="${esc(returnUrl)}">${Icons.arrowLeft} 返回我的短链接</a>
                  </div>
                </div>
              </div>
            `;
          } catch (err) { toast(err.message, Icons.alert); }
        };
      }
    }

    renderViewMode();
  } catch (err) {
    app.innerHTML = `
      <div class="card fade-in">
        <div class="empty-state">
          ${Icons.alert}
          <p>${esc(err.message)}</p>
          <a class="btn btn-secondary" href="${esc(returnUrl)}">${Icons.arrowLeft} 返回我的短链接</a>
        </div>
      </div>`;
  }
}

// -- list page --
function skeletonList() {
  return `
    <div class="card fade-in" style="padding-top:20px">
      ${Array.from({length: 5}, () => `
        <div style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--color-border)">
          <div class="skeleton" style="width:80px;height:12px;border-radius:4px"></div>
          <div class="skeleton" style="flex:1;height:12px;border-radius:4px"></div>
          <div class="skeleton" style="width:48px;height:12px;border-radius:4px"></div>
        </div>
      `).join('')}
    </div>
  `;
}

async function renderList(ns) {
  app.innerHTML = `
    <div class="logo">${Icons.link}<span>${esc(ns)} 的短链接</span></div>
    ${skeletonList()}
  `;

  try {
    const PER_PAGE = 20;
    let allApiItems = [];
    let allApiIds = new Set();
    let currentPage = 0;
    let hasMore = true;
    let merged = [];

    let selected = new Set();
    let batchConfirming = false;

    const searchIcon = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;

    function rebuildMerged() {
      const optiDeletes = new Set(loadOptiDeletes());
      const optiCreates = loadOptiCreates().filter(c => !allApiIds.has(c.id));
      merged = [...optiCreates.map(c => ({ id: c.id, desc: c.desc, date: c.date.slice(0, 10) })),
                ...allApiItems.filter(d => !optiDeletes.has(d.id))];
      cleanOptiState(allApiIds);
    }

    function renderListItems(filterText) {
      const q = (filterText || '').toLowerCase();
      const filtered = q ? merged.filter(d => d.desc.toLowerCase().includes(q)) : merged;
      if (!filtered.length) {
        return `<div class="empty-state" style="padding:24px 4px"><p>没有匹配 "${esc(q)}" 的短链接</p></div>`;
      }
      let h = `<ul class="shortlist">`;
      filtered.forEach(g => {
        const preview = g.desc || '(空)';
        const vc = getViewCount(g.id);
        const vBadge = vc ? `<span class="view-badge" title="访问 ${vc} 次">👁 ${vc}</span>` : '';
        h += `
          <li>
            <label class="list-check" data-id="${esc(g.id)}">
              <input type="checkbox" data-id="${esc(g.id)}" ${selected.has(g.id) ? 'checked' : ''}>
              <span class="checkmark"></span>
            </label>
            <span class="code">${esc(g.id).slice(0, 8)}</span>
            <div class="shortlist-info">
              <span class="preview-text">${esc(preview)}</span>
              <span class="date">${vBadge}${esc(g.date)}</span>
            </div>
            <a class="btn-sm" href="?s=${esc(g.id)}&amp;user=${encodeURIComponent(ns)}" style="text-decoration:none;flex-shrink:0">查看 ${Icons.externalLink}</a>
          </li>`;
      });
      h += `</ul>`;
      h += `<p class="dim spacer-sm">${filtered.length} / ${merged.length} 条</p>`;
      return h;
    }

    function updateBatchBar() {
      const bar = $('#batch-bar');
      if (!bar) return;
      const delBtn = $('#batch-delete-btn');
      const confBtn = $('#batch-confirm-btn');
      const cancBtn = $('#batch-cancel-btn');
      const count = $('#batch-count');
      if (batchConfirming && selected.size) {
        bar.style.display = 'flex';
        count.textContent = `确认删除 ${selected.size} 项？`;
        delBtn.style.display = 'none';
        confBtn.style.display = '';
        cancBtn.style.display = '';
      } else if (selected.size) {
        bar.style.display = 'flex';
        count.textContent = `已选 ${selected.size} 项`;
        delBtn.style.display = '';
        confBtn.style.display = 'none';
        cancBtn.style.display = 'none';
      } else {
        bar.style.display = 'none';
        batchConfirming = false;
      }
    }

    function buildHtml() {
      let html = `
        <div class="logo">${Icons.link}<span>${esc(ns)} 的短链接</span></div>
        <div class="card fade-in">
          <div class="search-bar">
            ${searchIcon}
            <input type="search" id="list-search" class="search-input" placeholder="搜索 ${merged.length} 条短链接..." autocomplete="off">
          </div>
          <div class="batch-bar" id="batch-bar" style="display:none">
            <span class="batch-count" id="batch-count"></span>
            <button class="btn-sm" id="batch-delete-btn" style="color:var(--color-danger)">${Icons.trash} 批量删除</button>
            <button class="btn-sm btn-danger-solid" id="batch-confirm-btn" style="display:none">确认删除</button>
            <button class="btn-sm" id="batch-cancel-btn" style="display:none">取消</button>
          </div>
          <div id="list-items">${renderListItems('')}</div>
          ${hasMore ? `<div class="spacer" style="text-align:center"><button class="btn btn-secondary" id="load-more-btn" style="width:100%">加载更多 (${merged.length} / ?)</button></div>` : `<p class="dim spacer" style="text-align:center">共 ${merged.length} 条</p>`}
        </div>
        <div class="spacer"><a class="link" href=".">${Icons.arrowLeft} 创建新的</a></div>`;
      return html;
    }

    function bindEvents() {
      updateBatchBar();

      $('#list-items').addEventListener('change', e => {
        if (e.target.type === 'checkbox' && e.target.dataset.id) {
          if (e.target.checked) selected.add(e.target.dataset.id);
          else selected.delete(e.target.dataset.id);
          updateBatchBar();
        }
      });

      $('#batch-delete-btn').onclick = () => { batchConfirming = true; updateBatchBar(); };
      $('#batch-cancel-btn').onclick = () => { batchConfirming = false; updateBatchBar(); };

      $('#batch-confirm-btn').onclick = async () => {
        const ids = [...selected];
        const total = ids.length;
        let deleted = 0;
        for (const id of ids) {
          try {
            await sb(`shortlinks?id=eq.${encodeURIComponent(id)}`, 'DELETE');
            addOptiDelete(id);
            deleted++;
          } catch (err) {
            toast(`删除 ${id.slice(0, 8)} 失败`, Icons.alert);
          }
        }
        if (deleted) toast(`已删除 ${deleted} / ${total} 项`, Icons.check);
        selected.clear();
        batchConfirming = false;
        renderList(ns);
      };

      $('#list-search').oninput = function() {
        $('#list-items').innerHTML = renderListItems(this.value);
      };

      const loadMore = $('#load-more-btn');
      if (loadMore) loadMore.onclick = () => loadNextPage();
    }

    async function loadNextPage() {
      const btn = $('#load-more-btn');
      if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> 加载中...`; }

      currentPage++;
      const from = (currentPage - 1) * PER_PAGE;
      const to = from + PER_PAGE - 1;

      const items = await sb(`shortlinks?select=*&namespace=eq.${encodeURIComponent(ns)}&order=created_at.desc&limit=${PER_PAGE}&offset=${from}`, 'GET');

      hasMore = (items || []).length === PER_PAGE;

      for (const item of (items || [])) {
        allApiIds.add(item.id);
        allApiItems.push({
          id: item.id,
          desc: item.description || '',
          date: item.created_at ? item.created_at.slice(0, 10) : ''
        });
      }
      rebuildMerged();

      if (!merged.length && currentPage === 1) {
        app.innerHTML = `
          <div class="logo">${Icons.link}<span>${esc(ns)} 的短链接</span></div>
          <div class="card fade-in">
            <div class="empty-state">
              ${Icons.folder}
              <p>还没有创建过短链接</p>
              <a class="btn btn-secondary" href=".">${Icons.arrowLeft} 创建新的</a>
            </div>
          </div>`;
        return;
      }

      app.innerHTML = buildHtml();
      bindEvents();
    }

    await loadNextPage();
  } catch (err) {
    app.innerHTML = `
      <div class="card fade-in">
        <div class="empty-state">
          ${Icons.alert}
          <p>${esc(err.message)}</p>
          <a class="btn btn-secondary" href=".">${Icons.arrowLeft} 返回</a>
        </div>
      </div>`;
  }
}

// -- settings page --
function connectionValues() {
  const rawUrl = $('#sb-url-input').value.trim();
  const key = $('#sb-key-input').value.trim();
  const ns = $('#sb-ns-input').value.trim();
  if (!rawUrl || !key || !ns) throw new Error('请填写 Project URL、公开 API Key 和 Namespace');
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error('请输入完整的 Supabase Project URL'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Project URL 应为 http 或 https 项目地址');
  }
  let role;
  try { role = JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role; } catch {}
  if (key.startsWith('sb_secret_') || role === 'service_role') throw new Error('请使用 anon 或 publishable 公开 Key');
  return { url: url.href.replace(/\/+$/, ''), key, ns };
}

function saveConnection() {
  try {
    const config = connectionValues();
    localStorage.setItem('sb_url', config.url);
    localStorage.setItem('sb_anon_key', config.key);
    localStorage.setItem('sb_namespace', config.ns);
    location.reload();
  } catch (error) { toast(error.message, Icons.alert); }
}

const THEME_PREVIEWS = {
  auto:     { label: '自动' },
  daylight: { label: '日白' },
  midnight: { label: '墨夜' },
  sepia:    { label: '苔青' },
  ocean:    { label: '雾蓝' },
  cherry:   { label: '胭脂' },
};

function renderSettings() {
  const current = getTheme();

  app.innerHTML = `
    <div class="logo">${Icons.settings}<span>设置</span></div>
    <div class="card fade-in">

      <div class="settings-section">
        <h3>主题</h3>
        <div class="theme-grid" id="theme-grid">
          ${THEMES.map(t => `
            <button type="button" class="theme-card ${t === current ? 'active' : ''}" data-theme="${t}" aria-label="${THEME_PREVIEWS[t].label} 主题" aria-pressed="${t === current}">
              <span class="theme-preview" data-preview-theme="${t === 'auto' ? 'daylight' : t}" aria-hidden="true">
                <span class="theme-preview-sheet">
                  <span class="theme-preview-type">Aa</span>
                  <span class="theme-preview-lines"><i></i><i></i><i></i></span>
                </span>
              </span>
              <span class="swatch-label"><span class="swatch-name">${THEME_PREVIEWS[t].label}</span><span class="theme-selected" aria-hidden="true">${Icons.check}</span></span>
            </button>
          `).join('')}
        </div>
      </div>

      <hr class="divider">

      <div class="settings-section">
        <h3>Supabase 连接</h3>
        <form id="connection-form">
          <label class="input-label" for="sb-url-input">Project URL</label>
          <input id="sb-url-input" type="url" required value="${esc(SUPABASE_URL)}" placeholder="https://your-project.supabase.co" autocomplete="off">
          <label class="input-label spacer-sm" for="sb-key-input">公开 API Key（anon / publishable）</label>
          <div class="key-input-field">
            <input id="sb-key-input" type="password" required value="${esc(SUPABASE_ANON_KEY)}" autocomplete="off" spellcheck="false">
            <button type="button" class="key-visibility-toggle" id="toggle-api-key" aria-controls="sb-key-input" aria-label="显示 API Key" aria-pressed="false" title="显示 API Key">${Icons.eye}</button>
          </div>
          <label class="input-label spacer-sm" for="sb-ns-input">Namespace</label>
          <input id="sb-ns-input" type="text" required value="${esc(namespace)}" autocomplete="off">
          <div class="flex spacer-sm connection-actions">
            <button type="button" class="btn btn-secondary btn-sm" id="test-connection">${Icons.database} 测试连接</button>
            <button type="submit" class="btn btn-primary btn-sm">${Icons.check} 保存连接</button>
          </div>
          <p id="connection-status" class="muted spacer-sm" role="status"></p>
          <p class="dim spacer-sm">配置保存在当前浏览器。切换项目后，原有短链接内容需要单独迁移。</p>
          <a class="link spacer-sm migration-download" href="migration.sql" download>${Icons.download} 下载初始化 SQL</a>
        </form>
      </div>

      <hr class="divider">

      <div class="settings-section">
        <h3>数据</h3>
        <button class="btn-sm" id="clear-data-btn" style="color:var(--color-danger)">
          ${Icons.alert} 清除全部本地数据
        </button>
      </div>

      <hr class="divider">

      <div class="settings-section">
        <h3>关于</h3>
        <p class="muted">shortlink v${APP_VERSION} · 轻量短链接工具</p>
      </div>

    </div>

    <div class="settings-back">
      <a class="btn btn-secondary" href=".">${Icons.arrowLeft} 返回首页</a>
    </div>
  `;

  $('#connection-form').onsubmit = event => { event.preventDefault(); saveConnection(); };
  $('#toggle-api-key').onclick = () => {
    const input = $('#sb-key-input');
    const button = $('#toggle-api-key');
    const visible = input.type === 'password';
    input.type = visible ? 'text' : 'password';
    button.innerHTML = visible ? Icons.eyeOff : Icons.eye;
    button.setAttribute('aria-pressed', String(visible));
    button.setAttribute('aria-label', visible ? '隐藏 API Key' : '显示 API Key');
    button.title = visible ? '隐藏 API Key' : '显示 API Key';
  };
  $('#test-connection').onclick = async () => {
    const button = $('#test-connection');
    const status = $('#connection-status');
    try {
      const config = connectionValues();
      button.disabled = true;
      status.textContent = '正在测试...';
      const response = await fetch(`${config.url}/rest/v1/shortlinks?select=id,files,created,created_at&limit=0`, {
        headers: supabaseHeaders(config.key), signal: AbortSignal.timeout(10000)
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        const message = error.message || `连接失败 (${response.status})`;
        if (/column.*does not exist|could not find.*column|could not find.*table|relation.*does not exist/i.test(message)) {
          throw new Error('数据表尚未初始化，请在 Supabase SQL Editor 运行 migration.sql');
        }
        throw new Error(message);
      }
      const storage = await fetch(`${config.url}/storage/v1/object/public/${STORAGE_BUCKET}/__shortlink_readonly_probe__`, {
        headers: supabaseHeaders(config.key), signal: AbortSignal.timeout(10000)
      });
      if (!storage.ok) {
        const error = await storage.json().catch(() => ({}));
        const message = error.message || error.error || '';
        if (/bucket.*not found/i.test(message)) throw new Error('缺少公开 files 存储桶，请在 Supabase SQL Editor 运行 migration.sql');
        if (!/object not found|not_found/i.test(message)) throw new Error(message || `存储检查失败 (${storage.status})`);
      }
      status.textContent = '连接正常，数据表和公开 files 存储桶可访问';
    } catch (error) {
      status.textContent = error.name === 'TimeoutError' ? '连接超时，请检查项目地址' : `连接失败：${error.message}`;
    } finally { button.disabled = false; }
  };

  // theme switch
  $$('.theme-card').forEach(card => {
    card.onclick = () => {
      const t = card.dataset.theme;
      setTheme(t);
      $$('.theme-card').forEach(option => {
        const active = option.dataset.theme === t;
        option.classList.toggle('active', active);
        option.setAttribute('aria-pressed', String(active));
      });
    };
  });

  // clear all data
  $('#clear-data-btn').onclick = () => {
    const btn = $('#clear-data-btn');
    if (btn._confirming) {
      localStorage.clear();
      location.reload();
      return;
    }
    btn._confirming = true;
    btn.classList.add('btn-danger-solid');
    btn.innerHTML = `${Icons.alert} 确认清除`;
    const cancel = document.createElement('button');
    cancel.className = 'btn-sm';
    cancel.id = 'clear-data-cancel';
    cancel.innerHTML = '取消';
    cancel.onclick = ev => {
      ev.stopPropagation();
      btn._confirming = false;
      btn.classList.remove('btn-danger-solid');
      btn.innerHTML = `${Icons.alert} 清除全部本地数据`;
      cancel.remove();
    };
    btn.parentNode.insertBefore(cancel, btn.nextSibling);
  };
}

function maskToken(t) {
  if (t.length <= 8) return t;
  return t.slice(0, 4) + '…'.repeat(8) + t.slice(-4);
}

// --- init ---
applyTheme(getTheme());
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (getTheme() === 'auto') applyTheme('auto');
});
render();

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const result = $('#result');
  if (result && result.style.display !== 'none') {
    result.style.display = 'none';
    return;
  }
  const cancelBtn = $('#cancel-edit-btn');
  if (cancelBtn) {
    cancelBtn.click();
    return;
  }
});
