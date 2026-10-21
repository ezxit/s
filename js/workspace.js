// Editors, library and recycle bin. Drafts and upload checkpoints share one durable record.
let activeEditor = null;
let workspaceRevision = 0;
const draftPrefix = () => `draft:${SUPABASE_URL}:${namespace}:`;
const navUrl = params => ShortlinkPortability.navigationUrl(params, connection);
const sharedUrl = id => ShortlinkPortability.shareUrl(id, connection);
const canonicalContent = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key,item[key]])) : item);
const matchesPayload = (row,payload) => row && !row.deleted_at && Object.keys(payload).every(key => canonicalContent(row[key]) === canonicalContent(payload[key]));
const safeMediaUrl = value => {
  if (!value || typeof value !== 'string') return '';
  try {
    const url = new URL(value, location.href);
    return /^(https?:|blob:)$/.test(url.protocol) || /^data:image\//i.test(value) ? url.href : '';
  } catch { return ''; }
};
function imageInfo(value, index = 0) {
  if (typeof value === 'string') {
    const ext = value.match(/^data:image\/([^;,]+)/)?.[1]?.replace('jpeg', 'jpg') || 'png';
    return { url: safeMediaUrl(value), name: `图片-${index + 1}.${ext}` };
  }
  return { ...value, url: safeMediaUrl(value?.url || ''), name: value?.name || `图片-${index + 1}` };
}
function storageKey(file, ns = namespace) {
  const folder = Array.from(new TextEncoder().encode(ns), b => b.toString(16).padStart(2, '0')).join('');
  return `ns-${folder}/${crypto.randomUUID()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80) || 'file'}`;
}
function notice(message, action, callback, host = app) {
  host.querySelector('.action-notice')?.remove();
  const node = document.createElement('div');
  node.className = 'action-notice';
  node.setAttribute('role', 'status');
  const span = document.createElement('span');
  span.textContent = message;
  node.append(span);
  if (action) {
    const button = document.createElement('button');
    button.className = 'btn-sm'; button.textContent = action;
    button.onclick = async () => {
      button.disabled = true;
      try { await callback(); node.remove(); }
      catch (error) { span.textContent = error.message; button.disabled = false; }
    };
    node.append(button);
  }
  host.prepend(node);
  return node;
}
function upgradeMessage() {
  return '<div class="upgrade-note">数据库需要升级才能使用回收站。请在 Supabase SQL Editor 运行 <a href="migration.sql" download>migration.sql</a>，然后刷新。已有内容仍可查看与搜索。</div>';
}
async function originalThumbnail(file) {
  if (!file.type.startsWith('image/') || file.size > 32 * 1024 * 1024) return {};
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 480 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return { width: bitmap.width, height: bitmap.height, thumbnail: canvas.toDataURL('image/webp', .76) };
  } catch { return {}; }
  finally { bitmap?.close(); }
}

async function renderHome() {
  return renderEditor(null);
}

async function renderEditor(record) {
  const token = ++workspaceRevision;
  if (activeEditor) await activeEditor.close();
  const ns = record?.namespace || namespace;
  const draftKey = `draft:${SUPABASE_URL}:${ns}:${record?.id || 'new'}`;
  const recoveryKey = `${draftKey}:text`;
  const publishedKey = `${draftKey}:published`;
  let state = {
    text: record?.text || '', images: [], attachments: [],
    existingImages: record?.images || [], existingFiles: record?.files || [],
    retired: record?.retired_assets || [], removedUploads: [],
    recordId: record?.id || crypto.randomUUID(), baseUpdatedAt: record?.updated_at || null,
    modified: false, savedAt: 0
  };
  let pending = false, saveError = false, timer, busy = false, controller, committed = false, writeVersion = 0;
  let draftWrites = Promise.resolve();
  const urls = new Map();
  app.innerHTML = '<div class="card"><p role="status">正在恢复编辑区…</p></div>';
  let restoreMessage = '';
  try {
    const saved = await ShortlinkDrafts.get(draftKey);
    const published = JSON.parse(localStorage.getItem(publishedKey) || 'null');
    if (saved && !(saved.committed || (published?.id === saved.recordId && published.at >= saved.savedAt))) { state = saved; restoreMessage = '已恢复本机草稿，包含所选文件和上传进度。'; }
    else if (saved) await ShortlinkDrafts.remove(draftKey);
  } catch { restoreMessage = '本地草稿存储暂不可用；离开前请完成保存。'; saveError = true; }
  try {
    const textFallback = JSON.parse(localStorage.getItem(recoveryKey) || 'null');
    if (textFallback && textFallback.savedAt > state.savedAt) {
      state.text = textFallback.text; state.modified = true;
      restoreMessage = saveError ? '已恢复最近文字；文件草稿读取失败，请保持页面开启。' : '已恢复最近输入的文字。';
    }
  } catch {}
  if (token !== workspaceRevision) return;
  const isEdit = !!record;
  app.innerHTML = `${!isEdit ? `<div class="home-layout"><section class="home-intro fade-in"><p class="eyebrow">A LITTLE SPACE FOR EVERYTHING</p><h1>小小链接，<br>装下<span>此刻。</span></h1><p class="intro-copy">一段文字，几张原图，或一份文件。<br>自动记下草稿，慢慢准备也没关系。</p><div class="intro-rule"></div><div class="quick-appearance"><p class="eyebrow">换一种心情</p><div class="quick-theme-list">${['daylight', 'linen', 'sepia', 'lavender', 'peach', 'cobalt', 'graphite'].map(t => `<button type="button" class="quick-theme" data-theme-choice="${t}" data-preview-theme="${t}" aria-label="切换到${THEME_PREVIEWS[t].label}" aria-pressed="${getTheme() === t}"><span></span></button>`).join('')}<a class="all-themes" href="${esc(navUrl({page:'settings'}))}">全部 ${Icons.externalLink}</a></div></div></section>` : ''}
    <div class="card composer-card fade-in" id="editor-card">
      <div class="composer-heading"><div><span class="eyebrow">${isEdit ? 'EDIT SHORTLINK' : 'NEW SHORTLINK'}</span><h2>${isEdit ? '继续编辑' : '创建一份分享'}</h2></div><span class="composer-index">01 /</span></div>
      <div class="draft-bar"><span id="draft-status" role="status">${esc(restoreMessage || '草稿自动保存在这台设备')}</span><button class="btn-sm" type="button" id="discard-draft">丢弃草稿</button></div>
      <div id="editor-fields"><div class="composer-grid">
        <section class="compose-content"><label class="input-label" for="text-input">内容</label><textarea id="text-input" placeholder="从一句想分享的话开始…"></textarea>
          <div class="flex spacer-sm"><button type="button" class="file-label" id="choose-images">${Icons.image} 添加原图</button><span class="dim">保留尺寸、格式和动图</span></div><input type="file" id="file-input" accept="image/*" multiple hidden><div class="previews" id="previews"></div>
        </section>
        <section class="compose-attachments"><div class="attachment-heading"><span class="input-label">文件附件</span><span class="dim">单个最大 200 MB</span></div><button type="button" class="attachment-drop-zone" id="upload-drop-zone"><span class="drop-symbol">${Icons.upload}</span><span class="drop-title">把文件拖到这里</span><span class="drop-hint">或点击选择文件 · 支持多个文件</span></button><input type="file" id="upload-file-input" multiple hidden><div class="upload-previews" id="upload-previews"></div></section>
      </div></div>
      <section class="transfer-panel" id="transfer-panel" hidden aria-label="上传进度"><div class="flex"><span id="transfer-status" role="status"></span><button class="btn-sm" type="button" id="pause-upload">暂停上传</button></div><div id="transfer-files"></div></section>
      <p id="editor-error" class="form-error" role="alert"></p>
      <div class="composer-bottom"><span class="compose-footnote">${isEdit ? '移除的旧文件保留到此链接被彻底删除。' : '原图上传 · 文件断点续传'}</span><div class="flex">${isEdit ? '<button class="btn-sm" id="cancel-edit-btn">返回，保留草稿</button>' : ''}<button class="btn btn-primary" id="create-btn">${isEdit ? '保存修改' : '创建短链接'} ↗</button></div></div>
      <div class="result spacer" id="result" style="display:none"><div class="success-text">${Icons.check} 创建成功</div><a class="result-url" id="result-url" target="_blank" rel="noopener"></a><div class="flex spacer-sm"><button class="btn-sm" id="copy-btn">${Icons.copy} 复制</button><button class="btn-sm" id="new-btn">${Icons.plus} 再创建一个</button></div></div>
    </div>${!isEdit ? '</div>' : ''}`;
  const card = $('#editor-card');
  const textInput = $('#text-input');
  const status = $('#draft-status');
  const errorBox = $('#editor-error');
  const submit = $('#create-btn');
  const items = () => [...state.images, ...state.attachments];
  const blobUrl = item => {
    if (!urls.has(item.id)) urls.set(item.id, URL.createObjectURL(item.file));
    return urls.get(item.id);
  };
  const flush = () => {
    clearTimeout(timer);
    if (committed || !state.modified) return draftWrites;
    state.text = textInput.value; state.savedAt = Date.now(); pending = true;
    const version = ++writeVersion;
    const snapshot = structuredClone(state);
    try { localStorage.setItem(recoveryKey, JSON.stringify({text:state.text,savedAt:state.savedAt})); } catch {}
    draftWrites = draftWrites.catch(() => {}).then(() => ShortlinkDrafts.put(draftKey, snapshot)).then(() => {
      if (version === writeVersion) { pending = false; saveError = false; }
      if (card.isConnected && !busy && version === writeVersion) status.textContent = '草稿已保存到这台设备';
    }).catch(error => {
      if (version === writeVersion) pending = false;
      saveError = true;
      if (card.isConnected) status.textContent = `草稿保存失败：${error.message}。请保持页面开启。`;
      throw error;
    });
    return draftWrites;
  };
  const changed = () => {
    ++writeVersion;
    state.modified = true; pending = true; state.text = textInput.value;
    status.textContent = '正在保存草稿…';
    try { localStorage.setItem(recoveryKey, JSON.stringify({text:state.text,savedAt:Date.now()})); } catch {}
    clearTimeout(timer); timer = setTimeout(() => flush().catch(() => {}), 200);
  };
  activeEditor = {
    get unsafe() { return busy || pending || (saveError && state.modified); },
    flush,
    async close() { if (state.modified && !committed) await flush(); urls.forEach(url => URL.revokeObjectURL(url)); activeEditor = null; }
  };
  textInput.value = state.text;
  textInput.oninput = changed;

  function renderQueues() {
    const preview = $('#previews'), attachments = $('#upload-previews');
    preview.replaceChildren(); attachments.replaceChildren();
    const addImage = (info, remove) => {
      const wrap = document.createElement('div'); wrap.className = 'wrap';
      const button = document.createElement('button'); button.className = 'preview-open'; button.type = 'button';
      button.setAttribute('aria-label', `预览 ${info.name}`);
      if (info.thumbnail || info.url) {
        const img = document.createElement('img'); img.src = safeMediaUrl(info.thumbnail || info.url); img.alt = info.name;
        button.append(img);
      } else {
        const placeholder=document.createElement('span');placeholder.className='original-placeholder';placeholder.textContent='查看原图';button.append(placeholder);
      }
      button.onclick = () => openImageViewer([info], 0);
      const del = document.createElement('button'); del.className = 'del'; del.type = 'button'; del.innerHTML = Icons.close;
      del.setAttribute('aria-label', `移除 ${info.name}`); del.onclick = () => { remove(); renderQueues(); changed(); };
      wrap.append(button, del); preview.append(wrap);
    };
    const retire = value => { if (value && typeof value === 'object' && value.key) state.retired.push(value); };
    state.existingImages.forEach((value, i) => addImage(imageInfo(value, i), () => { retire(value); state.existingImages.splice(i, 1); }));
    state.images.forEach((item, i) => addImage({url:blobUrl(item), name:item.file.name}, () => { state.removedUploads.push(item); state.images.splice(i, 1); }));
    const addFile = (file, remove) => {
      const row = document.createElement('div'); row.className = 'upload-item';
      row.innerHTML = `<div class="upload-item-icon">${Icons.upload}</div><div class="upload-item-info"><span class="upload-item-name">${esc(file.name || '文件')}</span><span class="upload-item-size">${formatSize(file.size)}</span></div><button class="upload-item-del" type="button" aria-label="移除 ${esc(file.name || '文件')}">${Icons.close}</button>`;
      row.querySelector('button').onclick = () => { remove(); renderQueues(); changed(); }; attachments.append(row);
    };
    state.existingFiles.forEach((file, i) => addFile(file, () => { retire(file); state.existingFiles.splice(i, 1); }));
    state.attachments.forEach((item, i) => addFile(item.file, () => { state.removedUploads.push(item); state.attachments.splice(i, 1); }));
  }
  function addFiles(selected, kind) {
    const rejected = [];
    for (const file of selected) {
      if (file.size > MAX_ATTACHMENT_SIZE) { rejected.push(file.name); continue; }
      if (kind === 'images' && !file.type.startsWith('image/')) { rejected.push(file.name); continue; }
      state[kind].push({id:crypto.randomUUID(),file,key:storageKey(file, ns),checkpoint:null,entry:null});
    }
    if (rejected.length) errorBox.textContent = `已跳过格式不符或超过 200 MB 的文件：${rejected.join('、')}`;
    renderQueues(); changed();
    navigator.storage?.persist?.().catch(() => {});
  }
  const imageInput = $('#file-input'), fileInput = $('#upload-file-input');
  $('#choose-images').onclick = () => imageInput.click();
  imageInput.onchange = () => { addFiles(imageInput.files, 'images'); imageInput.value = ''; };
  $('#upload-drop-zone').onclick = () => fileInput.click();
  fileInput.onchange = () => { addFiles(fileInput.files, 'attachments'); fileInput.value = ''; };
  bindAttachmentDropZone($('#upload-drop-zone'), fileInput, selected => addFiles(selected, 'attachments'));
  enableWindowFileDropGuard();
  $$('[data-theme-choice]').forEach(button => { button.onclick = () => setTheme(button.dataset.themeChoice); });
  renderQueues();
  const setBusy = value => {
    busy = value; $('#editor-fields').inert = value;
    imageInput.disabled = fileInput.disabled = submit.disabled = $('#discard-draft').disabled = value;
    if ($('#cancel-edit-btn')) $('#cancel-edit-btn').disabled = value;
    $('#pause-upload').hidden = !value;
  };
  $('#pause-upload').onclick = () => { controller?.abort(); $('#transfer-status').textContent = '正在暂停，已传分块会保留…'; };
  $('#discard-draft').onclick = async () => {
    if (!confirm('丢弃本机草稿和待上传文件？已经发布的内容会保留。')) return;
    setBusy(true);
    try {
      await draftWrites.catch(() => {});
      const staged = [...items(), ...state.removedUploads].filter(item => item.entry || item.checkpoint);
      const [publishedRow] = staged.length ? await sb(`shortlinks?id=eq.${state.recordId}&limit=1`,'GET') || [] : [];
      const referenced = new Set([...(publishedRow?.images || []),...(publishedRow?.files || []),...(publishedRow?.retired_assets || [])].map(asset=>asset?.key).filter(Boolean));
      for (const item of staged) {
        if (!referenced.has(item.key)) await ShortlinkTransfers.deleteUpload(item);
      }
      committed = true; clearTimeout(timer);
      await ShortlinkDrafts.remove(draftKey); localStorage.removeItem(recoveryKey);
      await activeEditor.close();
      if (record) renderView(record.id); else renderHome();
    } catch (error) { errorBox.textContent = `草稿仍保留：${error.message}，可重试清理。`; setBusy(false); }
  };
  if (isEdit) $('#cancel-edit-btn').onclick = async () => { try { await activeEditor.close(); renderView(record.id); } catch(error) { errorBox.textContent=`草稿尚未保存，请保持编辑页开启：${error.message}`; } };
  if (record && state.baseUpdatedAt && record.updated_at !== state.baseUpdatedAt) {
    errorBox.textContent = '这份内容在草稿保存后有过更新。草稿已保留，保存时会检查版本，避免覆盖新内容。';
  }
  submit.onclick = async () => {
    errorBox.textContent = '';
    if (!textInput.value.trim() && !items().length && !state.existingImages.length && !state.existingFiles.length) {
      errorBox.textContent = '至少写点文字、传张图片或上传文件'; return;
    }
    setBusy(true); state.modified = true; controller = new AbortController();
    const panel = $('#transfer-panel'), progressList = $('#transfer-files');
    panel.hidden = false; progressList.replaceChildren();
    try {
      await flush();
      const modern = await ShortlinkData.checkSchema();
      if (!modern && state.retired.length) throw new Error('移除旧附件前，请先在 Supabase 运行新版 migration.sql');
      const pendingItems = items();
      for (let index = 0; index < pendingItems.length; index++) {
        const item = pendingItems[index];
        if (controller.signal.aborted) throw new DOMException('已暂停', 'AbortError');
        const row = document.createElement('div'); row.className = 'transfer-row';
        row.innerHTML = `<span>${esc(item.file.name)}</span><progress max="100" value="${item.entry ? 100 : 0}"></progress><small role="status"></small>`;
        progressList.append(row);
        $('#transfer-status').textContent = `上传 ${index + 1} / ${pendingItems.length}`;
        const report = progress => { row.querySelector('progress').value = progress.percent; row.querySelector('small').textContent = `${formatSize(progress.loaded)} / ${formatSize(progress.total)} · ${Math.floor(progress.percent)}%`; };
        if (!item.entry) {
          item.entry = await ShortlinkTransfers.upload(item.file, {
            key:item.key, checkpoint:item.checkpoint, signal:controller.signal, onProgress:report,
            onCheckpoint:async checkpoint => { item.checkpoint = checkpoint; await flush(); }
          });
          if (state.images.includes(item)) Object.assign(item.entry, await originalThumbnail(item.file));
          await flush();
        }
        if (controller.signal.aborted) throw new DOMException('已暂停','AbortError');
        report({loaded:item.file.size,total:item.file.size,percent:100});
      }
      // Removed staged objects remain reachable for cleanup even after a successful edit/create.
      for (const item of state.removedUploads) {
        if (item.entry) state.retired.push(item.entry);
        else if (item.checkpoint) await ShortlinkTransfers.deleteUpload(item);
      }
      state.removedUploads = [];
      if (!modern && state.retired.length) {
        for (const entry of state.retired) await ShortlinkTransfers.deleteUpload(entry);
        state.retired = [];
      }
      const text = textInput.value.trim();
      const images = [...state.existingImages, ...state.images.map(item => item.entry)];
      const attachments = [...state.existingFiles, ...state.attachments.map(item => item.entry)];
      const payload = {text, images, files:attachments, description:text ? text.slice(0, 100).replace(/\n/g, ' ') : (images.length ? `${images.length} 张图片` : `${attachments.length} 个文件`), namespace:ns};
      if (modern) payload.retired_assets = state.retired;
      await flush();
      if (controller.signal.aborted) throw new DOMException('已暂停','AbortError');
      $('#transfer-status').textContent = '文件就绪，正在保存内容…';
      $('#pause-upload').hidden = true;
      if (isEdit) {
        const versionFilter = state.baseUpdatedAt ? `&updated_at=eq.${encodeURIComponent(state.baseUpdatedAt)}` : '';
        let rows, writeError;
        try { rows = await sb(`shortlinks?id=eq.${encodeURIComponent(record.id)}&namespace=eq.${encodeURIComponent(ns)}${modern ? '&deleted_at=is.null' : ''}${versionFilter}`, 'PATCH', payload); }
        catch(error) { writeError=error; }
        if (!rows?.length) {
          const [current] = await sb(`shortlinks?id=eq.${record.id}&limit=1`,'GET') || [];
          if (!matchesPayload(current,payload)) throw writeError || new Error('内容已被更新或移至回收站。草稿已保留，请复制当前文字，重新打开最新内容再合并。');
        }
      } else {
        const existing = await sb(`shortlinks?id=eq.${state.recordId}&limit=1`, 'GET');
        if (existing?.length) {
          const row = existing[0];
          if (!matchesPayload(row,payload)) {
            throw new Error('此前创建已提交。请先打开我的短链接检查，草稿仍保留。');
          }
        } else {
          const now = new Date().toISOString();
          const rows = await sb('shortlinks', 'POST', {...payload,id:state.recordId,created:now,created_at:now});
          if (!rows?.[0]?.id) throw new Error('保存尚未确认，请重试；已传文件会复用');
        }
      }
      committed = true; clearTimeout(timer); pending = false;
      await draftWrites.catch(() => {});
      try { localStorage.setItem(publishedKey,JSON.stringify({id:state.recordId,at:Date.now()})); } catch {}
      let draftCleared=true;
      try { await ShortlinkDrafts.put(draftKey,{committed:true,recordId:state.recordId}); await ShortlinkDrafts.remove(draftKey); } catch { draftCleared=false; }
      localStorage.removeItem(recoveryKey);
      state.modified = false; status.textContent = draftCleared ? '已发布，草稿已清空' : '已发布。本机草稿清理稍后重试，已发布文件会保留。';
      if (isEdit) { setBusy(false); await activeEditor.close(); renderView(record.id); return; }
      const url = sharedUrl(state.recordId);
      $('#result-url').href = url; $('#result-url').textContent = url;
      $('#result').style.display = 'block'; panel.hidden = true;
      $('#copy-btn').onclick = () => navigator.clipboard.writeText(url).then(() => toast('已复制', Icons.check));
      $('#new-btn').onclick = () => renderHome();
      busy = false; submit.textContent = '已创建';
    } catch (error) {
      const paused = error.name === 'AbortError';
      errorBox.textContent = paused ? '已暂停。草稿和已上传的分块已保留，点击继续即可恢复。' : `${error.message}。草稿与已完成的文件已保留。`;
      $('#transfer-status').textContent = paused ? '上传已暂停' : '等待重试';
      submit.textContent = paused ? '继续上传并保存' : '重试保存';
      await flush().catch(() => {}); setBusy(false);
    }
  };
}

async function renderView(id) {
  const token = ++workspaceRevision;
  if (activeEditor) await activeEditor.close();
  app.innerHTML = '<div class="card"><p role="status">正在读取内容…</p></div>';
  try {
    const [row] = await sb(`shortlinks?id=eq.${encodeURIComponent(id)}&limit=1`, 'GET') || [];
    if (token !== workspaceRevision) return;
    const returnUrl = myLinksUrl(row?.namespace || new URLSearchParams(location.search).get('user') || namespace);
    if (!row) { app.innerHTML = `<div class="card empty-state"><p>内容不存在</p><a class="btn-sm" href="${esc(returnUrl)}">返回我的短链接</a></div>`; return; }
    if (row.deleted_at) {
      app.innerHTML = `<div class="card empty-state"><h2>${row.cleanup_started_at ? '正在彻底清理' : '这份内容已移至回收站'}</h2><p>在回收站中管理这份内容。</p><a class="btn-sm" href="${esc(navUrl({user:row.namespace,trash:'1'}))}">打开回收站</a>${!row.cleanup_started_at ? '<button class="btn-sm" id="restore-link">恢复内容</button>' : ''}</div>`;
      if ($('#restore-link')) $('#restore-link').onclick = async () => { try { await ShortlinkData.restore([id],row.namespace); renderView(id); } catch (error) { toast(error.message,Icons.alert); } };
      return;
    }
    incrementView(id);
    app.innerHTML = `<div class="card fade-in"><div class="view-meta">${Icons.link}<span>${esc((row.created_at || row.created || '').slice(0,16).replace('T',' '))}</span></div>${row.text ? `<div class="view-text">${esc(row.text)}</div>` : ''}<div class="view-images">${(row.images || []).map((value,i) => { const img=imageInfo(value,i); return `<button type="button" class="view-image" data-image-index="${i}" aria-label="查看原图 ${esc(img.name)}">${img.thumbnail || img.url ? `<img src="${esc(safeMediaUrl(img.thumbnail || img.url))}" alt="${esc(img.name)}" loading="lazy">` : `<span class="original-placeholder">${Icons.image} 查看完整原图</span>`}<span class="image-caption">${esc(img.name)}${img.width ? ` · ${img.width} × ${img.height}` : ''}</span></button>`; }).join('')}</div><div class="view-files">${(row.files || []).map((file,i) => `<a class="file-attachment" href="${esc(safeMediaUrl(file.url))}" data-file-index="${i}" download="${esc(attachmentDownloadName(file))}"><span class="file-attach-icon">${Icons.download}</span><span class="file-attach-info"><span class="file-attach-name">${esc(file.name || '文件')}</span><span class="file-attach-size">${formatSize(file.size)}</span></span>${Icons.download}</a>`).join('')}</div><div class="spacer view-actions"><a class="btn btn-secondary btn-sm" href="${esc(returnUrl)}">${Icons.arrowLeft} 返回我的短链接</a><button class="btn-sm" id="edit-btn">${Icons.settings} 编辑</button><button class="btn-sm" id="copy-link">${Icons.copy} 复制链接</button><button class="btn btn-danger btn-sm" id="delete-link">${Icons.trash} 移至回收站</button></div></div>`;
    $$('[data-image-index]').forEach(button => { button.onclick = () => openImageViewer(row.images,Number(button.dataset.imageIndex)); });
    $$('[data-file-index]').forEach(button => { button.onclick = event => { event.preventDefault(); downloadAttachment(row.files[Number(button.dataset.fileIndex)],button); }; });
    $('#edit-btn').onclick = () => renderEditor(row);
    $('#copy-link').onclick = () => navigator.clipboard.writeText(sharedUrl(id)).then(() => toast('已复制',Icons.check));
    $('#delete-link').onclick = async () => {
      const button = $('#delete-link'); button.disabled = true;
      try {
        await ShortlinkData.softDelete([id],row.namespace);
        await renderView(id);
        notice('已移至回收站，原图和附件仍保留。','撤销',async () => { await ShortlinkData.restore([id],row.namespace); await renderView(id); });
      } catch (error) { toast(error.message,Icons.alert); if (error.needsUpgrade) notice('请先运行新版 migration.sql，启用可撤销删除。'); button.disabled=false; }
    };
  } catch (error) { if (token === workspaceRevision) app.innerHTML = `<div class="card empty-state"><p>${esc(error.message)}</p><a class="btn-sm" href="${esc(myLinksUrl())}">返回我的短链接</a></div>`; }
}

async function renderList(ns) {
  const token = ++workspaceRevision;
  if (activeEditor) await activeEditor.close();
  const params = new URLSearchParams(location.search);
  let query = params.get('q') || '', trash = params.get('trash') === '1', offset = 0, total = 0, rows = [], request = 0, abort, debounce;
  const selected = new Set();
  app.innerHTML = `<div class="page-heading"><div><p class="eyebrow">YOUR LIBRARY</p><h1>${esc(ns)} 的短链接</h1></div><a class="btn-sm" href="${esc(navUrl({}))}">${Icons.plus} 创建</a></div><div class="card library-card"><div class="library-tabs"><button class="btn-sm" id="active-tab" aria-pressed="${!trash}">全部内容</button><button class="btn-sm" id="trash-tab" aria-pressed="${trash}">回收站</button></div><label class="input-label" for="search-input">搜索整个空间</label><input id="search-input" type="search" placeholder="正文、描述、图片名或文件名" value="${esc(query)}"><p class="dim spacer-sm" id="search-status" role="status"></p><div id="library-upgrade"></div><div class="library-actions"><label><input type="checkbox" id="select-all"> 选择本页</label><button class="btn-sm" id="batch-delete">移至回收站</button><button class="btn-sm" id="batch-restore" hidden>恢复所选</button><button class="btn-sm btn-danger" id="batch-purge" hidden>彻底删除所选</button></div><div id="library-results"></div><div class="library-pagination"><button class="btn-sm" id="prev-page">上一页</button><span id="page-status"></span><button class="btn-sm" id="next-page">下一页</button></div></div>`;
  const list = $('#library-results'), feedback = $('#search-status');
  const updateActions = () => {
    $('#batch-delete').hidden = trash; $('#batch-restore').hidden = $('#batch-purge').hidden = !trash;
    ['batch-delete','batch-restore','batch-purge'].forEach(id => { $('#'+id).disabled = !selected.size; });
    $('#select-all').checked = !!rows.length && rows.every(row => selected.has(row.id));
  };
  const updateLocation = () => { const next={user:ns}; if (query) next.q=query; if (trash) next.trash='1'; history.replaceState(null,'',navUrl(next)); };
  async function load() {
    const current = ++request; abort?.abort(); abort = new AbortController();
    selected.clear(); updateActions(); list.setAttribute('aria-busy','true'); feedback.textContent='搜索中…';
    try {
      const result = await ShortlinkData.search(ns,{query,trash,limit:20,offset,signal:abort.signal});
      if (current !== request || token !== workspaceRevision) return;
      rows=result.items; total=result.total;
      if (!rows.length && offset && total) { offset=Math.max(0,Math.floor((total-1)/20)*20); return load(); }
      $('#library-upgrade').innerHTML = result.needsUpgrade ? upgradeMessage() : '';
      feedback.textContent = `${query ? '搜索结果' : (trash ? '回收站' : '整个空间')}：${total} 条${result.needsUpgrade ? ' · 兼容模式，全库扫描' : ''}${trash ? ' · 保留至你主动彻底删除' : ''}`;
      list.innerHTML = rows.length ? rows.map(row => `<article class="library-row"><input type="checkbox" data-select="${esc(row.id)}" aria-label="选择 ${esc(row.description || '这份内容')}"><div class="library-item"><a href="${esc(navUrl({s:row.id,user:ns}))}" class="library-title">${esc(row.description || row.preview || '未命名内容')}</a><p class="library-preview">${esc(row.preview || '')}</p><span class="dim">${esc((row.created_at || '').slice(0,10))}${row.image_count != null ? ` · ${row.image_count} 张图片 · ${row.file_count} 个文件` : ''}${row.cleanup_started_at ? ' · 清理待重试（恢复已锁定）' : ''}</span></div><button class="btn-sm" data-row-action="${esc(row.id)}">${trash ? (row.cleanup_started_at ? '继续清理' : '恢复') : '复制'}</button></article>`).join('') : '<div class="empty-state"><p>没有符合条件的内容</p></div>';
      $$('[data-select]').forEach(input => { input.onchange=()=>{ input.checked ? selected.add(input.dataset.select) : selected.delete(input.dataset.select); updateActions(); }; });
      $$('[data-row-action]').forEach(button => { button.onclick=async()=>{const row=rows.find(r=>r.id===button.dataset.rowAction); if (!trash) return navigator.clipboard.writeText(sharedUrl(row.id)).then(()=>toast('已复制',Icons.check)); selected.clear(); selected.add(row.id); await mutate(row.cleanup_started_at ? 'purge' : 'restore');}; });
      $('#page-status').textContent = `${total ? Math.floor(offset/20)+1 : 0} / ${Math.ceil(total/20)}`;
      $('#prev-page').disabled = offset===0; $('#next-page').disabled=offset+rows.length>=total;
      updateActions();
    } catch (error) { if (current===request && error.name!=='AbortError') { feedback.textContent=error.message; list.innerHTML='<p class="form-error">读取失败，请调整搜索或刷新重试。</p>'; } }
    finally { if(current===request) list.removeAttribute('aria-busy'); }
  }
  async function mutate(action) {
    const ids=[...selected]; if (!ids.length) return;
    if (action==='purge' && !confirm(`彻底删除 ${ids.length} 条内容及其原图、附件？此操作完成后不再支持撤销。`)) return;
    const controls=app.querySelectorAll('.library-actions button,[data-row-action]'); controls.forEach(b=>b.disabled=true);
    try {
      if(action==='purge') {
        const result=await ShortlinkData.purge(ids,ns,asset=>ShortlinkTransfers.deleteObject(asset.key,{config:{...connection,bucket:asset.bucket}}));
        await load();
        if(result.failed?.length) notice(`已清理 ${result.count} 条；${result.failed.length} 条待重试：${result.failed[0].error.message || result.failed[0].error}`);
        else notice(`已彻底删除 ${result.count} 条内容及关联文件。`);
      } else {
        const result=await ShortlinkData[action==='restore'?'restore':'softDelete'](ids,ns);
        await load();
        if(action==='restore') notice(`已恢复 ${result.count} 条内容。`);
        else notice(`已将 ${result.count} 条内容移至回收站。`,'撤销',async()=>{await ShortlinkData.restore(result.ids,ns);await load();});
      }
    } catch(error) { notice(error.message); }
    finally { controls.forEach(b=>b.disabled=false); updateActions(); }
  }
  $('#search-input').oninput=event=>{query=event.target.value;offset=0;clearTimeout(debounce);updateLocation();abort?.abort();++request;debounce=setTimeout(load,250);};
  $('#active-tab').onclick=()=>switchTab(false); $('#trash-tab').onclick=()=>switchTab(true);
  function switchTab(value) {trash=value;offset=0;$('#active-tab').setAttribute('aria-pressed',String(!trash));$('#trash-tab').setAttribute('aria-pressed',String(trash));updateLocation();load();}
  $('#prev-page').onclick=()=>{offset=Math.max(0,offset-20);load();}; $('#next-page').onclick=()=>{offset+=20;load();};
  $('#select-all').onchange=event=>{$$('[data-select]').forEach(input=>{input.checked=event.target.checked;input.checked?selected.add(input.dataset.select):selected.delete(input.dataset.select);});updateActions();};
  $('#batch-delete').onclick=()=>mutate('delete');$('#batch-restore').onclick=()=>mutate('restore');$('#batch-purge').onclick=()=>mutate('purge');
  await load();
}

window.addEventListener('beforeunload', event => {
  if (activeEditor?.unsafe || activeDownloadControllers.size) { activeEditor?.flush().catch(()=>{}); event.preventDefault(); event.returnValue=''; }
});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')activeEditor?.flush().catch(()=>{});});
