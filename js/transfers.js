/* Supabase TUS uploads and streamed browser downloads, without an SDK dependency.
 * Protocol: https://supabase.com/docs/guides/storage/uploads/resumable-uploads
 * Downloads: https://supabase.com/docs/guides/storage/serving/downloads
 */
(function (global) {
  'use strict';
  const CHUNK_SIZE = 6 * 1024 * 1024;
  const MAX_SIZE = 200 * 1024 * 1024;
  const PART_SIZE = 32 * 1024 * 1024;
  const RETRY_DELAYS = [750, 1500, 3000];
  const SMALL_DOWNLOAD_LIMIT = 24 * 1024 * 1024;
  let configured;

  // Mobile Chrome can expose the File System Access API, but opening its
  // picker makes a normal download feel like a folder-selection workflow.
  // Keep the picker for desktop large-file streaming only; mobile should use
  // the browser's regular download manager.
  function isMobileBrowser() {
    const nav = typeof navigator === 'object' ? navigator : {};
    const userAgent = nav.userAgent || '';
    const platform = nav.userAgentData?.platform || nav.platform || '';
    const touchPoints = Number(nav.maxTouchPoints) || 0;
    const coarsePointer = typeof global.matchMedia === 'function' && (
      global.matchMedia('(pointer: coarse)').matches || global.matchMedia('(hover: none)').matches
    );
    const touchSurface = touchPoints > 0 || coarsePointer || ('ontouchstart' in global);
    // Chrome's "Desktop site" mode can report Windows/macOS while retaining
    // the phone's touch surface. A narrow touch viewport is the final fallback
    // for browsers that hide both UA and pointer hints.
    const viewportWidth = Number(global.innerWidth || global.screen?.width || 0);
    const narrowTouchViewport = touchSurface && viewportWidth > 0 && viewportWidth <= 900;
    return nav.userAgentData?.mobile === true || /Android|iPhone|iPad|iPod|Mobile/i.test(`${userAgent} ${platform}`) || (/Macintosh/i.test(userAgent) && touchPoints > 1) || narrowTouchViewport;
  }
  function canUseSavePicker(options = {}) { return options.useSavePicker !== false && !isMobileBrowser() && typeof global.showSaveFilePicker === 'function'; }

  function abortError() { return new DOMException('传输已暂停，已上传部分可继续使用。', 'AbortError'); }
  function checkAbort(signal) { if (signal?.aborted) throw abortError(); }
  function configuration(override) {
    const source = override || configured;
    if (!source?.url || !source?.key) throw new Error('请先设置 Supabase 连接。');
    const url = new URL(source.url);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Supabase 地址格式有误。');
    return { url: url.href.replace(/\/+$/, ''), key: source.key, bucket: source.bucket || 'files' };
  }
  function headers(config) {
    const result = { apikey: config.key };
    if (!config.key.startsWith('sb_publishable_')) result.Authorization = `Bearer ${config.key}`;
    return result;
  }
  function objectKey(key) {
    if (typeof key !== 'string' || !key || key.startsWith('/') || key.split('/').some(part => !part || part === '..' || part === '.')) {
      throw new Error('存储文件路径格式有误。');
    }
    return key;
  }
  function objectPath(config, key) {
    return `${encodeURIComponent(config.bucket)}/${objectKey(key).split('/').map(encodeURIComponent).join('/')}`;
  }
  function publicUrl(key, override) {
    const config = configuration(override);
    return `${config.url}/storage/v1/object/public/${objectPath(config, key)}`;
  }
  function endpoint(config) {
    // Keep custom domains and self-hosted Supabase working. Cloud uploads use
    // the dedicated storage hostname recommended by Supabase.
    const url = new URL(config.url);
    if (/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname)) url.hostname = url.hostname.replace('.supabase.co', '.storage.supabase.co');
    return `${url.href.replace(/\/+$/, '')}/storage/v1/upload/resumable`;
  }
  function validSession(value, config) {
    if (!value) return null;
    try {
      const url = new URL(value, endpoint(config));
      const origins = [new URL(config.url).origin, new URL(endpoint(config)).origin];
      if (!origins.includes(url.origin) || !url.pathname.startsWith('/storage/v1/upload/resumable/') || url.username || url.password) return null;
      return url.href;
    } catch { return null; }
  }
  function base64(value) {
    return btoa(Array.from(new TextEncoder().encode(String(value)), byte => String.fromCharCode(byte)).join(''));
  }
  function errorFor(status, body = '') {
    let message = '';
    try { const json = JSON.parse(body); message = json.message || json.error || ''; } catch {}
    if (status === 401 || status === 403) message = '存储权限不足，请检查公开 API Key，并运行 migration.sql 更新存储规则。';
    else if (status === 413) message = '文件分片超过存储桶限制，请确认 files 存储桶允许至少 32 MB。';
    else if (/bucket.*not found/i.test(message)) message = '缺少 files 存储桶，请运行 migration.sql。';
    else if (!message) message = status ? `传输请求失败 (${status})` : '网络连接中断，请重试继续上传。';
    const error = new Error(message);
    error.status = status;
    error.retryable = !status || [408, 409, 423, 425, 429].includes(status) || status >= 500;
    return error;
  }
  async function delay(milliseconds, signal) {
    checkAbort(signal);
    return new Promise((resolve, reject) => {
      const done = () => { signal?.removeEventListener('abort', cancel); resolve(); };
      const timer = setTimeout(done, milliseconds);
      const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(abortError()); };
      signal?.addEventListener('abort', cancel, { once: true });
    });
  }
  async function request(url, init, signal) {
    checkAbort(signal);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, 120000);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal, credentials: 'omit', redirect: 'error' });
      if (!response.ok) throw errorFor(response.status, await response.text());
      return response;
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (!('retryable' in error)) { error.retryable = true; error.status = 0; }
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  }
  async function retried(task, signal) {
    for (let attempt = 0; ; attempt += 1) {
      try { return await task(); }
      catch (error) {
        if (error.name === 'AbortError' || !error.retryable || attempt >= RETRY_DELAYS.length) throw error;
        await delay(RETRY_DELAYS[attempt], signal);
      }
    }
  }
  function sendChunk(url, body, offset, config, signal, onProgress) {
    checkAbort(signal);
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', cancel);
        if (error) reject(error); else resolve(value);
      };
      const cancel = () => { xhr.abort(); finish(abortError()); };
      xhr.open('PATCH', url);
      xhr.timeout = 120000;
      const allHeaders = { ...headers(config), 'Tus-Resumable': '1.0.0', 'Upload-Offset': String(offset), 'Content-Type': 'application/offset+octet-stream' };
      Object.entries(allHeaders).forEach(([key, value]) => xhr.setRequestHeader(key, value));
      xhr.upload.onprogress = event => {
        try { onProgress(Math.min(body.size, event.loaded)); }
        catch (error) { finish(error); xhr.abort(); }
      };
      xhr.onload = () => {
        if (xhr.status < 200 || xhr.status >= 300) { finish(errorFor(xhr.status, xhr.responseText)); return; }
        const value = xhr.getResponseHeader('Upload-Offset');
        const nextOffset = value === null ? NaN : Number(value);
        if (!Number.isSafeInteger(nextOffset) || nextOffset < offset || nextOffset > offset + body.size) {
          const error = errorFor(0); error.message = '上传进度校验失败，正在重新确认服务器进度。'; finish(error); return;
        }
        finish(null, nextOffset);
      };
      xhr.onerror = () => finish(errorFor(0));
      xhr.ontimeout = () => finish(errorFor(408));
      xhr.onabort = () => finish(abortError());
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      xhr.send(body);
    });
  }

  async function uploadObject(file, options = {}) {
    if (!(file instanceof Blob)) throw new TypeError('请选择文件后上传。');
    if (file.size > MAX_SIZE) throw new Error(`${file.name || '文件'} 超过 200 MB 限制。`);
    const config = configuration(options.config);
    const key = objectKey(options.key);
    const signal = options.signal;
    const fingerprint = JSON.stringify([file.name || '', file.size, file.type || '', file.lastModified || 0]);
    const result = { name: file.name || 'file', size: file.size, type: file.type || 'application/octet-stream', key, url: publicUrl(key, config) };
    const saved = options.checkpoint;
    let sessionUrl = saved?.configUrl === config.url && saved?.bucket === config.bucket && saved?.key === key && saved?.fingerprint === fingerprint
      ? validSession(saved.sessionUrl, config) : null;
    let offset = 0;
    let createdAt = sessionUrl ? saved.createdAt : Date.now();
    let recreated = false;
    const progress = (loaded, phase = 'uploading') => options.onProgress?.({ loaded, total: file.size, percent: file.size ? Math.round(loaded * 100 / file.size) : (phase === 'complete' ? 100 : 0), phase });
    const checkpoint = async done => {
      if (options.onCheckpoint) await options.onCheckpoint({ version: 1, configUrl: config.url, bucket: config.bucket, key, fingerprint, sessionUrl, offset, size: file.size, createdAt, complete: !!done });
    };
    const completedObject = async () => {
      try {
        const response = await request(result.url, { method: 'HEAD', headers: headers(config), cache: 'no-store' }, signal);
        const length = response.headers.get('Content-Length');
        return length !== null && Number(length) === file.size;
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        if (error.status === 404 || error.status === 400) return false;
        throw error;
      }
    };
    const getOffset = async () => {
      const response = await retried(() => request(sessionUrl, { method: 'HEAD', headers: { ...headers(config), 'Tus-Resumable': '1.0.0' }, cache: 'no-store' }, signal), signal);
      const value = response.headers.get('Upload-Offset');
      const total = response.headers.get('Upload-Length');
      const remoteOffset = value === null ? NaN : Number(value);
      if (!Number.isSafeInteger(remoteOffset) || remoteOffset < 0 || remoteOffset > file.size || (total !== null && Number(total) !== file.size)) {
        throw new Error('服务器上传进度与文件不一致，请重新选择文件。');
      }
      return remoteOffset;
    };
    const createSession = async () => {
      const metadata = { bucketName: config.bucket, objectName: key, contentType: result.type, cacheControl: '3600', metadata: JSON.stringify({ originalName: result.name }) };
      const response = await retried(() => request(endpoint(config), {
        method: 'POST',
        headers: { ...headers(config), 'Tus-Resumable': '1.0.0', 'Upload-Length': String(file.size), 'Upload-Metadata': Object.entries(metadata).map(([name, value]) => `${name} ${base64(value)}`).join(','), 'x-upsert': 'false' },
      }, signal), signal);
      sessionUrl = validSession(response.headers.get('Location'), config);
      if (!sessionUrl) throw new Error('上传服务返回了无效的会话地址。');
      createdAt = Date.now();
      offset = 0;
      await checkpoint(false);
    };
    checkAbort(signal);
    progress(0, sessionUrl ? 'resuming' : 'preparing');
    if (sessionUrl) {
      try { offset = await getOffset(); }
      catch (error) {
        if (![404, 410].includes(error.status)) throw error;
        // Supabase may retire a completed TUS session. Check the stable object
        // before starting again, including when the final PATCH response was lost.
        if (await completedObject()) offset = file.size;
        else { sessionUrl = null; recreated = true; }
      }
    }
    if (!sessionUrl) await createSession();
    await checkpoint(false);
    progress(offset);
    let attempts = 0;
    while (offset < file.size) {
      checkAbort(signal);
      const chunk = file.slice(offset, Math.min(offset + CHUNK_SIZE, file.size));
      try {
        const next = await sendChunk(sessionUrl, chunk, offset, config, signal, loaded => progress(offset + loaded));
        if (next === offset) throw errorFor(409);
        offset = next;
        attempts = 0;
        await checkpoint(false);
        progress(offset);
      } catch (error) {
        if (error.name === 'AbortError' || (!error.retryable && ![404, 410].includes(error.status)) || attempts >= RETRY_DELAYS.length) throw error;
        progress(offset, 'retrying');
        await delay(RETRY_DELAYS[attempts++], signal);
        try { offset = await getOffset(); }
        catch (headError) {
          if (![404, 410].includes(headError.status)) throw headError;
          if (await completedObject()) { offset = file.size; break; }
          if (recreated) throw headError;
          recreated = true;
          await createSession();
        }
        await checkpoint(false);
      }
    }
    await checkpoint(true);
    progress(file.size, 'complete');
    return result;
  }

  const fingerprintFor = file => JSON.stringify([file.name || '', file.size, file.type || '', file.lastModified || 0]);
  const partKey = (key, index) => `${objectKey(key)}.part-${String(index).padStart(4, '0')}`;
  async function sha256(blob, signal) {
    checkAbort(signal);
    if (!global.crypto?.subtle) throw new Error('此浏览器尚未启用文件校验，请使用 HTTPS 或 localhost 打开网页。');
    // At most one 32 MiB part is materialized for Web Crypto at a time.
    const hash = await global.crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    checkAbort(signal);
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  async function upload(file, options = {}) {
    if (!(file instanceof Blob)) throw new TypeError('请选择文件后上传。');
    if (file.size > MAX_SIZE) throw new Error(`${file.name || '文件'} 超过 200 MB 限制。`);
    if (file.size <= PART_SIZE) return uploadObject(file, options);
    const config = configuration(options.config), key = objectKey(options.key), signal = options.signal;
    const fingerprint = fingerprintFor(file), count = Math.ceil(file.size / PART_SIZE);
    const saved = options.checkpoint;
    const validSaved = saved?.mode === 'segmented' && saved.configUrl === config.url && saved.bucket === config.bucket && saved.key === key && saved.fingerprint === fingerprint;
    const completed = [];
    let current = validSaved ? saved.current : null;
    if (validSaved && Array.isArray(saved.parts)) {
      for (let index = 0; index < Math.min(count, saved.parts.length); index++) {
        const part = saved.parts[index], size = Math.min(PART_SIZE, file.size - index * PART_SIZE);
        if (part?.key !== partKey(key, index) || part.size !== size || !/^[a-f0-9]{64}$/.test(part.sha256 || '')) break;
        completed.push({ ...part, url: publicUrl(part.key, config) });
      }
    }
    const notify = (loaded, phase = 'uploading', index = completed.length) => options.onProgress?.({ loaded, total: file.size, percent: Math.round(loaded * 100 / file.size), phase, part: Math.min(index + 1, count), parts: count });
    const checkpoint = async complete => {
      if (options.onCheckpoint) await options.onCheckpoint({ version: 2, mode: 'segmented', configUrl: config.url, bucket: config.bucket, key, fingerprint, size: file.size, partSize: PART_SIZE, parts: completed.map(part => ({ ...part })), current: current ? { ...current } : null, offset: completed.reduce((sum, part) => sum + part.size, 0) + (current?.checkpoint?.offset || 0), complete: !!complete });
    };
    checkAbort(signal);
    notify(completed.reduce((sum, part) => sum + part.size, 0), completed.length ? 'resuming' : 'preparing');
    for (let index = 0; index < count; index++) {
      const start = index * PART_SIZE;
      const piece = file.slice(start, Math.min(file.size, start + PART_SIZE));
      const digest = await sha256(piece, signal);
      if (completed[index]) {
        if (completed[index].sha256 !== digest) throw new Error('待上传文件与已保存分片不同，请重新选择文件。');
        continue;
      }
      const segment = new File([piece], `part-${String(index).padStart(4, '0')}.bin`, { type: 'application/octet-stream', lastModified: file.lastModified || 0 });
      const previous = current?.index === index && current?.sha256 === digest ? current.checkpoint : null;
      const part = await uploadObject(segment, {
        ...options, config, key: partKey(key, index), checkpoint: previous,
        onProgress: value => notify(start + value.loaded, value.phase === 'complete' ? 'uploading' : value.phase, index),
        onCheckpoint: async value => { current = { index, sha256: digest, checkpoint: value }; await checkpoint(false); },
      });
      completed.push({ key: part.key, url: part.url, size: part.size, type: 'application/octet-stream', sha256: digest });
      current = null;
      await checkpoint(false);
      checkAbort(signal);
    }
    await checkpoint(true);
    notify(file.size, 'complete', count - 1);
    return { name: file.name || 'file', size: file.size, type: file.type || 'application/octet-stream', key, url: '', segmented: true, parts: completed };
  }

  function validatedParts(file) {
    if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_SIZE || !Array.isArray(file.parts) || file.parts.length !== Math.ceil(file.size / PART_SIZE)) throw new Error('文件分片信息有误，请重新导入或上传。');
    const keys = new Set();
    let size = 0;
    for (const [index, part] of file.parts.entries()) {
      objectKey(part?.key);
      if (keys.has(part.key) || part.size !== Math.min(PART_SIZE, file.size - index * PART_SIZE) || !/^[a-f0-9]{64}$/i.test(part.sha256 || '')) throw new Error('文件分片校验信息有误，请重新导入或上传。');
      keys.add(part.key); size += part.size;
    }
    if (size !== file.size) throw new Error('文件分片大小与原文件不一致。');
    return file.parts;
  }
  async function fetchBlob(url, { signal, limit = MAX_SIZE, expectedSize, type, onProgress } = {}) {
    const parsed = new URL(url, location.href);
    if (!['http:', 'https:', 'blob:', 'data:'].includes(parsed.protocol)) throw new Error('文件地址格式有误。');
    const response = await request(parsed.href, {}, signal);
    const declared = response.headers.get('Content-Length');
    const encoded = response.headers.get('Content-Encoding');
    if ((!encoded || encoded === 'identity') && declared !== null && (Number(declared) > limit || (expectedSize != null && Number(declared) !== expectedSize))) {
      await response.body?.cancel();
      throw new Error('下载文件大小与保存的信息不一致。');
    }
    const reader = response.body.getReader(), chunks = [];
    let loaded = 0;
    const cancel = () => { reader.cancel().catch(() => {}); };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      for (;;) {
        checkAbort(signal);
        const { done, value } = await reader.read();
        checkAbort(signal);
        if (done) break;
        loaded += value.byteLength;
        if (loaded > limit || (expectedSize != null && loaded > expectedSize)) throw new Error('下载文件大小超过保存的信息。');
        chunks.push(value);
        onProgress?.(loaded);
      }
      if (expectedSize != null && loaded !== expectedSize) throw new Error('文件下载不完整，请重试。');
      return new Blob(chunks, { type: type || response.headers.get('Content-Type') || 'application/octet-stream' });
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally { signal?.removeEventListener('abort', cancel); }
  }
  async function readParts(file, options, consume) {
    const parts = validatedParts(file);
    let loaded = 0;
    const progress = (bytes, phase, index) => options.onProgress?.({ loaded: bytes, total: file.size, percent: file.size ? Math.round(bytes * 100 / file.size) : 100, phase, part: index + 1, parts: parts.length });
    for (let index = 0; index < parts.length; index++) {
      checkAbort(options.signal);
      const part = parts[index];
      const blob = await fetchBlob(part.url || publicUrl(part.key, options.config), { signal: options.signal, expectedSize: part.size, limit: PART_SIZE, type: 'application/octet-stream', onProgress: bytes => progress(loaded + bytes, 'downloading', index) });
      progress(loaded + part.size, 'verifying', index);
      if (await sha256(blob, options.signal) !== part.sha256.toLowerCase()) throw new Error(`第 ${index + 1} 个文件分片校验失败，请重试或从备份恢复。`);
      await consume(blob, index);
      loaded += part.size;
    }
    return loaded;
  }
  async function readBlob(file, options = {}) {
    checkAbort(options.signal);
    if (file.segmented) {
      const pieces = [];
      await readParts(file, options, blob => { pieces.push(blob); });
      return new Blob(pieces, { type: file.type || 'application/octet-stream' });
    }
    const size = Number.isSafeInteger(file.size) && file.size >= 0 ? file.size : undefined;
    return fetchBlob(file.url || publicUrl(file.key, options.config), { signal: options.signal, expectedSize: size, limit: MAX_SIZE, type: file.type, onProgress: loaded => options.onProgress?.({ loaded, total: size || 0, percent: size ? Math.round(loaded * 100 / size) : 0, phase: 'downloading' }) });
  }

  async function deleteUpload(file, options = {}) {
    if (typeof file === 'string') return deleteObject(file, options);
    const entry = file?.entry || file;
    const checkpoint = file?.checkpoint || entry?.checkpoint;
    const key = file?.key || entry?.key || checkpoint?.key;
    const size = file?.file?.size ?? entry?.size ?? checkpoint?.size;
    objectKey(key);
    const keys = new Set();
    for (const part of [...(entry?.parts || []), ...(checkpoint?.parts || [])]) if (part?.key) keys.add(objectKey(part.key));
    if (entry?.segmented || checkpoint?.mode === 'segmented' || size > PART_SIZE) {
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_SIZE) throw new Error('待清理文件的大小信息有误。');
      for (let index = 0; index < Math.ceil(size / PART_SIZE); index++) keys.add(partKey(key, index));
    }
    // The logical base key may belong to a legacy, unsegmented upload. Deleting
    // a missing base object is idempotent and keeps upgrade cleanup complete.
    keys.add(key);
    for (const candidate of keys) { checkAbort(options.signal); await deleteObject(candidate, options); }
  }

  async function deleteObject(key, options = {}) {
    const config = configuration(options.config);
    objectKey(key);
    await retried(() => request(`${config.url}/storage/v1/object/${encodeURIComponent(config.bucket)}`, {
      method: 'DELETE', headers: { ...headers(config), 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: [key] }),
    }, options.signal), options.signal);
  }
  function downloadName(file) {
    let name = file.name;
    if (!name) { try { name = decodeURIComponent(new URL(file.url, location.href).pathname.split('/').pop()); } catch {} }
    return String(name || 'download').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
  }
  function clickDownload(url, name) {
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.rel = 'noopener';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }
  async function download(file, controlOrOptions = {}) {
    const options = controlOrOptions?.nodeType === 1 ? { control: controlOrOptions } : controlOrOptions || {};
    const control = options.control;
    if (control?.dataset.downloading === 'true') return;
    const status = (phase, message, extras = {}) => options.onStatus?.({ phase, message, ...extras });
    const name = downloadName(file);
    const url = new URL(file.url, location.href);
    const config = options.config || configured;
    const knownStorage = /^https?:$/.test(url.protocol) && url.pathname.startsWith('/storage/v1/object/') && (
      /^[a-z0-9-]+(?:\.storage)?\.supabase\.co$/.test(url.hostname) || (config?.url && url.origin === new URL(config.url).origin)
    );
    checkAbort(options.signal);
    if (control) { control.dataset.downloading = 'true'; control.setAttribute('aria-busy', 'true'); }
    try {
      if (file.segmented) {
        validatedParts(file);
        // Call the picker while user activation is still available. Verified
        // parts are written sequentially; browsers without this API get one
        // correctly named Blob, never a concatenated 200 MiB ArrayBuffer.
        const handle = canUseSavePicker(options) ? await global.showSaveFilePicker({ suggestedName: name }) : null;
        checkAbort(options.signal);
        const writer = handle ? await handle.createWritable() : null;
        const pieces = [];
        try {
          status('downloading', '正在下载并合并文件…', { loaded: 0, total: file.size });
          const loaded = await readParts(file, { ...options, onProgress: value => { options.onProgress?.(value); status(value.phase, value.phase === 'verifying' ? '正在校验文件分片…' : '正在下载并合并文件…', value); } }, async blob => { if (writer) await writer.write(blob); else pieces.push(blob); });
          checkAbort(options.signal);
          if (writer) await writer.close();
          else {
            const objectUrl = URL.createObjectURL(new Blob(pieces, { type: file.type || 'application/octet-stream' }));
            clickDownload(objectUrl, name);
            setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
          }
          status('complete', '文件已合并，下载完成。', { loaded, total: file.size, percent: 100 });
          return { delegated: false, name, segmented: true };
        } catch (error) { if (writer) await writer.abort().catch(() => {}); throw error; }
      }
      if (knownStorage) {
        url.searchParams.set('download', name);
        clickDownload(url.href, name);
        status('delegated', '已交给浏览器下载；进度、暂停、取消和重试请在浏览器下载列表查看。');
        return { delegated: true, url: url.href, name };
      }
      if (['blob:', 'data:'].includes(url.protocol)) {
        clickDownload(url.href, name);
        status('delegated', '已开始下载。');
        return { delegated: true, name };
      }
      if (!['https:', 'http:'].includes(url.protocol)) throw new Error('下载地址格式有误。');
      // Legacy external links can use the browser's streaming file writer. The
      // picker runs immediately in the click gesture, before any network awaits.
      const writerHandle = file.size > SMALL_DOWNLOAD_LIMIT && canUseSavePicker(options)
        ? await global.showSaveFilePicker({ suggestedName: name }) : null;
      if (file.size > SMALL_DOWNLOAD_LIMIT && !writerHandle) {
        clickDownload(url.href, name);
        status('delegated', '已交给浏览器下载，文件名由原下载服务器提供。');
        return { delegated: true, name };
      }
      status('downloading', '正在下载…', { loaded: 0, total: file.size || 0 });
      const response = await request(url.href, {}, options.signal);
      const total = Number(response.headers.get('Content-Length')) || file.size || 0;
      if (!writerHandle && total > SMALL_DOWNLOAD_LIMIT) {
        await response.body?.cancel();
        clickDownload(url.href, name);
        status('delegated', '已交给浏览器下载，文件名由原下载服务器提供。');
        return { delegated: true, name };
      }
      const writer = writerHandle ? await writerHandle.createWritable() : null;
      const reader = response.body.getReader();
      const parts = [];
      let loaded = 0;
      const cancel = () => { reader.cancel().catch(() => {}); };
      options.signal?.addEventListener('abort', cancel, { once: true });
      try {
        for (;;) {
          checkAbort(options.signal);
          const { done, value } = await reader.read();
          checkAbort(options.signal);
          if (done) break;
          loaded += value.byteLength;
          if (!writer && loaded > SMALL_DOWNLOAD_LIMIT) throw new Error('该旧链接文件较大，请在新标签页使用浏览器下载。');
          if (writer) await writer.write(value); else parts.push(value);
          status('downloading', '正在下载…', { loaded, total });
        }
        if (writer) await writer.close();
        else {
          const objectUrl = URL.createObjectURL(new Blob(parts, { type: response.headers.get('Content-Type') || file.type || 'application/octet-stream' }));
          clickDownload(objectUrl, name);
          setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
        }
        status('complete', '下载完成。', { loaded, total });
        return { delegated: false, name };
      } catch (error) {
        await reader.cancel().catch(() => {});
        if (writer) await writer.abort().catch(() => {});
        throw error;
      } finally { options.signal?.removeEventListener('abort', cancel); }
    } finally {
      if (control) { delete control.dataset.downloading; control.removeAttribute('aria-busy'); }
    }
  }

  global.ShortlinkTransfers = Object.freeze({
    configure(value) { configured = configuration(value); return { ...configured }; },
    upload, download, readBlob, deleteObject, deleteUpload, publicUrl, downloadName,
    MAX_SIZE, CHUNK_SIZE, PART_SIZE,
  });
})(window);
