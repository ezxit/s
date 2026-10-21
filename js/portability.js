/* Portable backups and Supabase migration. No service-role key is needed or accepted. */
(() => {
  'use strict';
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const MAGIC = encoder.encode('SHORTLINK-BACKUP-1\n');
  const CHUNK = 4 * 1024 * 1024;
  const STORAGE_PART = 32 * 1024 * 1024;
  const MAX_FILE = 200 * 1024 * 1024;
  const BLOB_LIMIT = 512 * 1024 * 1024;
  const URL_FIELDS = { url: 'key', originalUrl: 'originalKey', thumbnailUrl: 'thumbnailKey', thumbUrl: 'thumbKey', previewUrl: 'previewKey' };
  const WRITABLE = ['id', 'text', 'images', 'files', 'description', 'namespace', 'created', 'created_at', 'updated_at', 'deleted_at', 'retired_assets'];
  const TOKEN = 'slbackup-asset:';
  const abort = signal => { if (signal?.aborted) throw new DOMException('操作已取消；已完成的迁移进度保留。', 'AbortError'); };
  const progress = (opts, phase, done, total, message) => opts.onProgress?.({ phase, done, total, message });
  const b64url = value => btoa(String.fromCharCode(...encoder.encode(JSON.stringify(value)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64url = value => JSON.parse(decoder.decode(Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))));
  const publicUrl = (config, key, bucket = 'files') => `${config.url}/storage/v1/object/public/${encodeURIComponent(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;

  function connection(value) {
    const url = new URL(value?.url || '');
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error('Supabase 地址应为完整 HTTPS 项目地址。');
    const key = String(value?.key || value?.anonKey || '').trim();
    if (!key || key.startsWith('sb_secret_')) throw new Error('请填写公开 anon / publishable Key。');
    if (key.split('.').length === 3) {
      try { if (unb64url(key.split('.')[1]).role === 'service_role') throw new Error('SERVICE_KEY'); }
      catch (error) { if (error.message === 'SERVICE_KEY') throw new Error('这里仅接受公开 anon / publishable Key。'); }
    }
    return { ...value, url: url.origin, key, bucket: value.bucket || 'files' };
  }
  function headers(config) {
    return { apikey: config.key, ...(!config.key.startsWith('sb_publishable_') ? { Authorization: `Bearer ${config.key}` } : {}) };
  }
  async function request(config, path, opts = {}) {
    abort(opts.signal);
    const res = await fetch(`${config.url}${path}`, { ...opts, headers: { ...headers(config), ...opts.headers } });
    if (!res.ok) {
      let detail = '';
      try { const data = await res.json(); detail = data.message || data.error || ''; } catch (_) {}
      if (res.status === 404 || /column|function|schema cache/i.test(detail)) throw new Error(`项目结构需要升级：请先在目标 Supabase 运行 migration.sql。${detail ? ` (${detail})` : ''}`);
      throw new Error(`Supabase 请求失败 (${res.status})${detail ? `：${detail}` : ''}`);
    }
    return res;
  }
  const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  async function digest(bytes) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(n => n.toString(16).padStart(2, '0')).join(''); }
  const jsonHash = value => digest(encoder.encode(canonical(value)));
  const routeName = config => `project-${new URL(config.url).host.replace(/[^a-z0-9.-]/gi, '-')}`;
  function validRegistry(raw) {
    if (!raw || raw.version !== 1 || !raw.routes || typeof raw.routes !== 'object') throw new Error('backend-config.json 格式错误。');
    const registry = { version: 1, default: raw.default || 'main', routes: {} };
    for (const [route, config] of Object.entries(raw.routes)) {
      if (!/^[a-zA-Z0-9._-]{1,160}$/.test(route)) throw new Error('后端路由名称格式错误。');
      const parsed = connection(config);
      registry.routes[route] = { url: parsed.url, key: parsed.key };
    }
    if (!registry.routes[registry.default]) throw new Error('后端配置缺少默认路由。');
    return registry;
  }

  async function resolve(defaults) {
    const base = connection(defaults);
    let registry = { version: 1, default: 'main', routes: { main: { url: base.url, key: base.key } } };
    let registryWarning = '';
    const cacheKey = `shortlink:registry:${location.origin}${location.pathname}`;
    try {
      const res = await fetch(new URL('backend-config.json', location.href), { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      registry = validRegistry(await res.json());
      try { localStorage.setItem(cacheKey, JSON.stringify(registry)); } catch (_) {}
    } catch (_) {
      try { const cached = localStorage.getItem(cacheKey); if (cached) registry = validRegistry(JSON.parse(cached)); } catch (_) {}
      registryWarning = '共享后端配置暂未刷新，当前使用已知配置。';
    }
    const params = new URLSearchParams(location.search);
    const explicit = params.get('store');
    const route = explicit || (params.has('s') ? 'main' : registry.default);
    let selected = registry.routes[route];
    let published = !!selected;
    // A published alias always wins over a fallback embedded in an older link.
    if (!selected) {
      const encoded = new URLSearchParams(location.hash.slice(1)).get('backend');
      if (encoded) selected = connection(unb64url(encoded));
      else throw new Error('此链接的后端路由尚未发布，请由网站维护者更新 backend-config.json。');
    }
    let activeRoute = route;
    if (!explicit && !params.has('s')) {
      const url = localStorage.getItem('sb_url');
      const key = localStorage.getItem('sb_anon_key');
      if (url && key) {
        const saved = connection({ url, key });
        activeRoute = Object.keys(registry.routes).find(name => registry.routes[name].url === saved.url && registry.routes[name].key === saved.key) || routeName(saved);
        published = !!registry.routes[activeRoute];
        selected = published ? registry.routes[activeRoute] : saved;
      }
    }
    return { ...connection(selected), route: activeRoute, published, registry, registryWarning };
  }
  function navigationUrl(params, config) {
    const parsed = connection(config);
    const url = new URL(location.pathname, location.origin);
    url.search = new URLSearchParams(Object.entries(params || {}).filter(([, value]) => value !== undefined && value !== null)).toString();
    const route = config.route || routeName(parsed);
    url.searchParams.set('store', route);
    if (!config.published) url.hash = `backend=${b64url({ url: parsed.url, key: parsed.key })}`;
    return url.href;
  }
  const shareUrl = (id, config) => navigationUrl({ s: id }, config);
  function routeRegistry(target, source) {
    const next = connection(target);
    const prior = source?.registry ? validRegistry(source.registry) : { version: 1, default: 'main', routes: {} };
    const routes = { ...prior.routes };
    const origin = source?.url ? new URL(source.url).origin : next.url;
    for (const name of Object.keys(routes)) if (routes[name].url === origin) routes[name] = { url: next.url, key: next.key };
    const alias = source?.route || 'main';
    routes[alias] = { url: next.url, key: next.key };
    if (source?.url) routes[routeName(source)] = { url: next.url, key: next.key };
    routes[target.route || routeName(next)] = { url: next.url, key: next.key };
    if (!routes[prior.default]) routes[prior.default] = { url: next.url, key: next.key };
    return { version: 1, default: prior.default, routes };
  }
  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  function downloadRegistry(registry) { download(new Blob([JSON.stringify(validRegistry(registry), null, 2) + '\n'], { type: 'application/json' }), 'backend-config.json'); }

  async function validateTarget(raw, { signal } = {}) {
    const config = connection(raw);
    const res = await request(config, '/rest/v1/rpc/shortlink_capabilities', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal });
    const capabilities = await res.json();
    if (Number(capabilities.schema) < 2) throw new Error('请先在目标 Supabase 运行新版 migration.sql，再进行迁移或恢复。');
    return capabilities;
  }
  async function readRows(config, opts) {
    const rows = [];
    let cursor = '';
    while (true) {
      const params = new URLSearchParams({ select: '*', order: 'id.asc', limit: '100' });
      if (cursor) params.set('id', `gt.${cursor}`);
      const page = await (await request(config, `/rest/v1/shortlinks?${params}`, { signal: opts.signal })).json();
      if (!Array.isArray(page)) throw new Error('数据响应格式错误。');
      if (!page.length) break;
      if (page.some(row => !row.id) || page[page.length - 1].id === cursor) throw new Error('读取数据分页失败。');
      rows.push(...page); cursor = page[page.length - 1].id;
      progress(opts, 'records', rows.length, null, `已读取 ${rows.length} 条记录（包含所有命名空间和回收站）`);
    }
    return rows;
  }
  function sourceAssetUrl(raw, config) {
    if (raw.startsWith('data:image/')) return raw;
    const url = new URL(raw);
    if (!['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) || url.username || url.password) throw new Error('附件地址格式错误。');
    return url.href;
  }
  async function prepare(rows, config) {
    const assets = [];
    const byUrl = new Map();
    async function collect(meta, index, kind) {
      if (typeof meta === 'string') {
        const subtype = /^data:image\/([a-z0-9.+-]+)[;,]/i.exec(meta)?.[1];
        const extension = subtype ? ({ jpeg: 'jpg', 'svg+xml': 'svg' }[subtype] || subtype) : '';
        meta = { url: meta, name: `图片-${index + 1}${extension ? `.${extension}` : ''}` };
      }
      if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('附件元数据格式错误。');
      meta = { ...meta };
      if (meta.segmented) {
        if (!Array.isArray(meta.parts) || !meta.parts.length) throw new Error('分片附件的清单缺失。');
        for (const part of meta.parts) sourceAssetUrl(part.url, config);
        const identity = `segmented:${canonical({ parts: meta.parts, size: meta.size })}`;
        let asset = byUrl.get(identity);
        if (!asset) {
          asset = { id: await digest(encoder.encode(identity)), metadata: { ...meta }, name: meta.name || `${kind}-${index + 1}`, type: meta.type || '', kind };
          byUrl.set(identity, asset); assets.push(asset);
        }
        // Archives store the reconstructed original once. Never leave the source
        // project's piece URLs in a supposedly portable row manifest.
        meta.url = TOKEN + asset.id;
        delete meta.segmented;
        delete meta.parts;
      }
      if (!meta.url && meta.key) meta.url = publicUrl(config, meta.key, meta.bucket || 'files');
      if (!meta.thumbnailUrl && meta.thumbnailKey) meta.thumbnailUrl = publicUrl(config, meta.thumbnailKey, meta.bucket || 'files');
      if (!meta.thumbUrl && meta.thumbKey) meta.thumbUrl = publicUrl(config, meta.thumbKey, meta.bucket || 'files');
      for (const [field] of Object.entries(URL_FIELDS)) {
        if (!meta[field]) continue;
        if (meta[field].startsWith(TOKEN)) continue;
        const url = sourceAssetUrl(meta[field], config);
        let asset = byUrl.get(url);
        if (!asset) {
          const id = await digest(encoder.encode(url));
          asset = { id, url, name: meta.name || `${kind}-${index + 1}`, type: meta.type || '', kind };
          byUrl.set(url, asset); assets.push(asset);
        }
        meta[field] = TOKEN + asset.id;
      }
      return meta;
    }
    const prepared = [];
    for (const row of rows) {
      const copy = { ...row };
      delete copy.search_text;
      for (const name of ['images', 'files', 'retired_assets']) {
        copy[name] = [];
        for (const [index, meta] of (row[name] || []).entries()) copy[name].push(await collect(meta, index, name));
      }
      prepared.push(copy);
    }
    return { rows: prepared, assets };
  }
  async function fetchAsset(asset, config, opts) {
    abort(opts.signal);
    if (asset.metadata?.segmented) {
      const readBlob = opts.readBlob || window.ShortlinkTransfers?.readBlob;
      if (!readBlob) throw new Error('分片文件读取组件尚未加载，请刷新页面后重试。');
      const blob = await readBlob(asset.metadata, { config, signal: opts.signal, onProgress: value => progress(opts, 'read-parts', value.loaded, value.total, `读取并校验 ${asset.name}`) });
      if (blob.size > MAX_FILE) throw new Error(`附件“${asset.name}”超过 200 MB。`);
      return blob;
    }
    const local = asset.url.startsWith('data:');
    const sameProject = !local && new URL(asset.url).origin === config.url;
    const res = await fetch(asset.url, { signal: opts.signal, headers: sameProject ? headers(config) : {} });
    if (!res.ok) throw new Error(`附件“${asset.name}”读取失败 (${res.status})。请确认源项目仍在线；先完成正在进行的永久删除再重试。`);
    const blob = await res.blob();
    if (blob.size > MAX_FILE) throw new Error(`附件“${asset.name}”超过 200 MB。`);
    return blob;
  }

  function frame(type, body) {
    const bytes = body instanceof Uint8Array ? body : encoder.encode(JSON.stringify(body));
    if (bytes.byteLength > (type === 3 ? CHUNK : 64 * 1024 * 1024)) throw new Error('备份清单超过当前格式的 64 MB 上限，请先减少内嵌图片或拆分数据。');
    const header = new Uint8Array(5);
    header[0] = type;
    new DataView(header.buffer).setUint32(1, bytes.byteLength);
    return [header, bytes];
  }
  async function exportBackup(raw, opts = {}) {
    const config = connection(raw);
    const filename = `shortlink-${new Date().toISOString().slice(0, 10)}.slbackup`;
    let writer;
    const chunks = [];
    let archiveSize = 0;
    // Open the save picker before the first network await to preserve user activation.
    if (opts.saveAs !== false && window.showSaveFilePicker) {
      const handle = await window.showSaveFilePicker({ suggestedName: filename, types: [{ description: 'Shortlink 完整备份', accept: { 'application/octet-stream': ['.slbackup'] } }] });
      writer = await handle.createWritable();
    }
    async function write(bytes) {
      abort(opts.signal); archiveSize += bytes.byteLength;
      if (writer) await writer.write(bytes);
      else {
        if (archiveSize > BLOB_LIMIT) throw new Error('本浏览器的备份回退方式限制为 512 MB；请用桌面 Chrome / Edge 选择直接保存到磁盘。');
        chunks.push(bytes);
      }
    }
    async function writeFrame(type, body) { for (const part of frame(type, body)) await write(part); }
    try {
      const snapshot = await prepare(await readRows(config, opts), config);
      const manifest = { version: 1, createdAt: new Date().toISOString(), source: { url: config.url, route: raw.route || 'main' }, rows: snapshot.rows, assetCount: snapshot.assets.length };
      await write(MAGIC); await writeFrame(1, manifest);
      let totalBytes = 0;
      for (const [index, asset] of snapshot.assets.entries()) {
        progress(opts, 'backup', index, snapshot.assets.length, `备份附件：${asset.name}`);
        const blob = await fetchAsset(asset, config, opts);
        const meta = { id: asset.id, name: asset.name, type: blob.type || asset.type, size: blob.size };
        await writeFrame(2, meta);
        const hashes = [];
        for (let start = 0; start < blob.size; start += CHUNK) {
          abort(opts.signal);
          const bytes = new Uint8Array(await blob.slice(start, start + CHUNK).arrayBuffer());
          hashes.push(await digest(bytes)); await writeFrame(3, bytes);
          progress(opts, 'backup-bytes', Math.min(start + CHUNK, blob.size), blob.size, `写入 ${asset.name}`);
        }
        await writeFrame(4, { size: blob.size, hashes, metaHash: await jsonHash(meta) });
        totalBytes += blob.size;
      }
      await writeFrame(5, { assetCount: snapshot.assets.length, totalBytes, manifestHash: await jsonHash(manifest) });
      if (writer) await writer.close();
      const blob = writer ? null : new Blob(chunks, { type: 'application/octet-stream' });
      if (blob && opts.saveAs !== false) download(blob, filename);
      progress(opts, 'complete', snapshot.rows.length, snapshot.rows.length, '完整备份已生成；请妥善保留 .slbackup 文件。');
      return { rows: snapshot.rows.length, assets: snapshot.assets.length, bytes: totalBytes, archiveBytes: archiveSize, filename, saved: opts.saveAs !== false, blob };
    } catch (error) { if (writer) await writer.abort().catch(() => {}); throw error; }
  }

  async function parseBackup(file, opts) {
    if (!file?.slice || file.size < MAGIC.length + 5) throw new Error('请选择完整的 .slbackup 备份文件。');
    const magic = new Uint8Array(await file.slice(0, MAGIC.length).arrayBuffer());
    if (magic.some((value, i) => value !== MAGIC[i])) throw new Error('备份文件格式不匹配。');
    let offset = MAGIC.length, manifest, current, footer;
    const assets = new Map();
    let totalBytes = 0;
    while (offset < file.size) {
      abort(opts.signal);
      if (offset + 5 > file.size) throw new Error('备份文件尾部不完整。');
      const bytes = await file.slice(offset, offset + 5).arrayBuffer();
      const view = new DataView(bytes), type = view.getUint8(0), size = view.getUint32(1);
      offset += 5;
      if (offset + size > file.size || size > (type === 3 ? CHUNK : 64 * 1024 * 1024)) throw new Error('备份文件数据段损坏或过大。');
      const part = file.slice(offset, offset + size);
      offset += size;
      if (type === 3) {
        if (!current || !size || current.size + size > MAX_FILE || (current.parts.length && current.lastSize !== CHUNK)) throw new Error('备份附件的数据段顺序错误。');
        current.parts.push(part); current.hashes.push(await digest(await part.arrayBuffer())); current.size += size; current.lastSize = size;
      } else {
        let value;
        try { value = JSON.parse(decoder.decode(await part.arrayBuffer())); } catch (_) { throw new Error('备份文件清单损坏。'); }
        if (type === 1) {
          if (manifest || current || value.version !== 1 || !Array.isArray(value.rows)) throw new Error('备份清单格式错误。');
          manifest = value;
        } else if (type === 2) {
          if (!manifest || current || footer || !/^[a-f0-9]{64}$/.test(value.id) || assets.has(value.id) || value.size < 0 || value.size > MAX_FILE) throw new Error('备份附件清单错误。');
          current = { meta: value, parts: [], hashes: [], size: 0 };
        } else if (type === 4) {
          if (!current || current.size !== value.size || current.meta.size !== value.size || canonical(current.hashes) !== canonical(value.hashes) || await jsonHash(current.meta) !== value.metaHash) throw new Error('备份附件校验失败，文件可能损坏；尚未写入目标项目。');
          assets.set(current.meta.id, { ...current.meta, blob: new Blob(current.parts, { type: current.meta.type || 'application/octet-stream' }), hashes: current.hashes });
          totalBytes += current.size; current = null;
        } else if (type === 5) {
          if (!manifest || current || footer || offset !== file.size) throw new Error('备份文件结束标记错误。');
          footer = value;
        } else throw new Error('备份文件包含未知数据段。');
      }
      progress(opts, 'verify-backup', offset, file.size, '验证备份完整性');
    }
    if (!manifest || !footer || current || footer.assetCount !== assets.size || manifest.assetCount !== assets.size || footer.totalBytes !== totalBytes || footer.manifestHash !== await jsonHash(manifest)) throw new Error('备份文件不完整或清单校验失败。');
    try { sourceAssetUrl(manifest.source.url); } catch (_) { throw new Error('备份源项目信息格式错误。'); }
    const ids = new Set();
    for (const row of manifest.rows) {
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(row.id || '') || ids.has(row.id)) throw new Error('备份存在重复或错误的记录 ID。');
      ids.add(row.id);
      for (const field of ['text', 'description', 'namespace']) if (row[field] != null && typeof row[field] !== 'string') throw new Error('备份记录内容格式错误。');
      for (const field of ['created', 'created_at', 'updated_at', 'deleted_at']) if (row[field] != null && !Number.isFinite(Date.parse(row[field]))) throw new Error('备份记录日期格式错误。');
      for (const field of ['images', 'files', 'retired_assets']) {
        if (!Array.isArray(row[field] || [])) throw new Error('备份附件元数据错误。');
        for (const meta of row[field] || []) {
          if (!meta || typeof meta !== 'object' || typeof meta.url !== 'string') throw new Error('备份附件元数据错误。');
          for (const name of Object.keys(URL_FIELDS)) {
            const value = meta[name];
            if (value && (typeof value !== 'string' || !value.startsWith(TOKEN) || !assets.has(value.slice(TOKEN.length)))) throw new Error('备份缺少记录所引用的附件。');
          }
        }
      }
    }
    return { manifest, assets };
  }

  let database;
  function db() {
    if (!database) database = new Promise((resolve, reject) => {
      const open = indexedDB.open('shortlink-portability-v1', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('jobs');
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(new Error('迁移进度存储未开启，请允许此网站使用浏览器本地存储。'));
    });
    return database;
  }
  async function checkpoint(key, value) {
    const database = await db();
    return new Promise((resolve, reject) => {
      const tx = database.transaction('jobs', value ? 'readwrite' : 'readonly');
      const req = value ? tx.objectStore('jobs').put(value, key) : tx.objectStore('jobs').get(key);
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(new Error('保存迁移进度失败；请释放浏览器存储后重试。'));
      tx.onabort = tx.onerror;
    });
  }
  function writable(row) {
    const copy = { text: '', images: [], files: [], description: '', namespace: 'default', deleted_at: null, retired_assets: [], ...Object.fromEntries(WRITABLE.filter(key => row[key] !== undefined).map(key => [key, row[key]])) };
    for (const date of ['created', 'created_at', 'deleted_at']) if (copy[date]) copy[date] = new Date(copy[date]).toISOString();
    return copy;
  }
  async function rowHash(row) { const copy = writable(row); delete copy.updated_at; return jsonHash(copy); }
  async function existingRows(target, ids, opts) {
    const result = new Map();
    for (let i = 0; i < ids.length; i += 50) {
      const query = new URLSearchParams({ select: '*', id: `in.(${ids.slice(i, i + 50).join(',')})` });
      const rows = await (await request(target, `/rest/v1/shortlinks?${query}`, { signal: opts.signal })).json();
      for (const row of rows) result.set(row.id, row);
    }
    return result;
  }
  async function blobHashes(blob, signal) {
    const hashes = [];
    for (let i = 0; i < blob.size; i += CHUNK) { abort(signal); hashes.push(await digest(await blob.slice(i, i + CHUNK).arrayBuffer())); }
    return hashes;
  }
  async function uploadBlob(blob, asset, target, job, id, opts) {
    const prior = job.assets[asset.id];
    const key = prior?.key || `migration/${id.slice(0, 24)}/${asset.id}`;
    const type = blob.type || asset.type || 'application/octet-stream';
    // The transfer fingerprint includes lastModified. A stable timestamp keeps
    // a migration's resumable upload valid after reopening the same backup.
    const file = new File([blob], asset.name || '附件', { type, lastModified: 0 });
    const expected = asset.hashes || await blobHashes(blob, opts.signal);
    if (!prior) { job.assets[asset.id] = { key, status: 'pending' }; await checkpoint(id, job); }
    const entry = job.assets[asset.id];
    async function probeNormal() {
      const res = await fetch(publicUrl(target, key), { signal: opts.signal, headers: headers(target), cache: 'no-store' });
      if (!res.ok) {
        let error;
        try { error = await res.json(); } catch (_) {}
        if (res.status === 404 || (res.status === 400 && (String(error?.statusCode) === '404' || error?.error === 'not_found'))) return false;
        throw new Error(`目标附件“${file.name}”读取失败 (${res.status})，请检查目标项目连接与 Storage 读取权限后重试。`);
      }
      const actual = await res.blob();
      if (actual.size !== blob.size || canonical(await blobHashes(actual, opts.signal)) !== canonical(expected)) throw new Error(`目标附件“${file.name}”内容校验不一致；已保留目标对象，请检查后重试。`);
      return true;
    }
    async function verifyMetadata(metadata) {
      const readBlob = opts.readBlob || window.ShortlinkTransfers?.readBlob;
      if (!readBlob) {
        if (metadata.segmented) throw new Error('分片文件校验组件尚未加载，请刷新页面后重试。');
        if (!(await probeNormal())) throw new Error(`目标附件“${file.name}”尚未读到，请稍后重试。`);
        return;
      }
      const actual = await readBlob(metadata, { config: target, signal: opts.signal, onProgress: value => progress(opts, 'verify-parts', value.loaded, value.total, `校验目标附件 ${file.name}`) });
      if (actual.size !== blob.size || canonical(await blobHashes(actual, opts.signal)) !== canonical(expected)) throw new Error(`目标附件“${file.name}”内容校验不一致；已保留目标对象，请检查后重试。`);
    }
    if (entry.metadata) {
      await verifyMetadata(entry.metadata);
      job.assets[asset.id] = { key, status: 'verified', metadata: entry.metadata }; await checkpoint(id, job); return entry.metadata;
    }
    // Recover a small object's upload-completed/checkpoint-not-yet-written window.
    // Segmented uploads have no object at their base key; their transfer checkpoint
    // resumes the individual pieces instead.
    if (blob.size <= STORAGE_PART && await probeNormal()) {
      const metadata = { name: file.name, type, size: blob.size, key, url: publicUrl(target, key) };
      job.assets[asset.id] = { key, status: 'verified', metadata }; await checkpoint(id, job); return metadata;
    }
    if (entry.status === 'verified') throw new Error(`已迁移附件“${file.name}”的目标内容发生变化；请检查目标项目后重试。`);
    const upload = opts.upload || window.ShortlinkTransfers?.upload;
    let metadata;
    if (upload) metadata = await upload(file, { key, config: target, signal: opts.signal, checkpoint: entry.transfer, onProgress: value => progress(opts, 'upload-bytes', value.loaded, value.total, `迁移 ${file.name}`), onCheckpoint: async value => { entry.transfer = value; await checkpoint(id, job); } });
    else {
      if (file.size > STORAGE_PART) throw new Error('大文件分片上传组件尚未加载，请刷新页面后重试。');
      await request(target, `/storage/v1/object/files/${key.split('/').map(encodeURIComponent).join('/')}`, { method: 'POST', headers: { 'Content-Type': type, 'x-upsert': 'false' }, body: blob, signal: opts.signal });
      metadata = { name: file.name, type, size: blob.size, key, url: publicUrl(target, key) };
    }
    entry.metadata = metadata; entry.status = 'uploaded'; await checkpoint(id, job);
    await verifyMetadata(metadata);
    job.assets[asset.id] = { key, status: 'verified', metadata }; await checkpoint(id, job);
    return metadata;
  }
  function replaceAssets(row, mapping) {
    const copy = writable(row);
    for (const field of ['images', 'files', 'retired_assets']) copy[field] = (copy[field] || []).map(meta => {
      const result = { ...meta };
      for (const [name, keyName] of Object.entries(URL_FIELDS)) if (result[name]?.startsWith(TOKEN)) {
        const mapped = mapping.get(result[name].slice(TOKEN.length));
        if (!mapped) throw new Error('迁移附件映射缺失。');
        result[name] = mapped.url; result[keyName] = mapped.key;
        if (name === 'url') {
          result.size = mapped.size; result.type = mapped.type; if (!result.name) result.name = mapped.name;
          if (mapped.segmented) { result.segmented = true; result.parts = mapped.parts; }
          else { delete result.segmented; delete result.parts; }
        }
      }
      if (result.bucket) result.bucket = 'files';
      return result;
    });
    return copy;
  }
  async function copySnapshot(snapshot, source, targetRaw, opts) {
    const target = connection(targetRaw);
    await validateTarget(target, opts);
    const identity = await jsonHash({ source: source.url, target: target.url, rows: snapshot.rows });
    const job = await checkpoint(identity) || { version: 1, source: source.url, target: target.url, assets: {}, rows: {}, createdAt: new Date().toISOString() };
    await checkpoint(identity, job);
    const existing = await existingRows(target, snapshot.rows.map(row => row.id), opts);
    for (const [id, row] of existing) {
      if (!job.rows[id] || job.rows[id].hash !== await rowHash(row)) throw new Error(`目标项目已有同 ID 记录 ${id}，迁移已暂停以保留目标数据。请使用空项目，或恢复同一次迁移的本地进度。`);
    }
    const mapping = new Map();
    let bytes = 0;
    for (const [index, asset] of snapshot.assets.entries()) {
      abort(opts.signal); progress(opts, 'migrate-assets', index, snapshot.assets.length, `迁移并校验附件：${asset.name}`);
      const blob = asset.blob || await fetchAsset(asset, source, opts);
      mapping.set(asset.id, await uploadBlob(blob, asset, target, job, identity, opts)); bytes += blob.size;
    }
    let completed = 0;
    for (const row of snapshot.rows) {
      abort(opts.signal);
      const output = replaceAssets(row, mapping);
      const hash = await rowHash(output);
      if (!existing.has(row.id)) {
        job.rows[row.id] = { hash, status: 'pending' }; await checkpoint(identity, job);
        const res = await request(target, '/rest/v1/shortlinks', { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify(output), signal: opts.signal });
        const inserted = await res.json();
        if (!inserted[0] || await rowHash(inserted[0]) !== hash) throw new Error(`记录 ${row.id} 写入后校验失败，迁移进度已保留。`);
      }
      job.rows[row.id] = { hash, status: 'verified' }; await checkpoint(identity, job);
      progress(opts, 'migrate-records', ++completed, snapshot.rows.length, `已写入并校验 ${completed} / ${snapshot.rows.length} 条记录`);
    }
    const verified = await existingRows(target, snapshot.rows.map(row => row.id), opts);
    for (const row of snapshot.rows) if (!verified.has(row.id) || await rowHash(verified.get(row.id)) !== job.rows[row.id].hash) throw new Error('最终记录校验未通过，进度已保留，请重试。');
    job.completedAt = new Date().toISOString(); await checkpoint(identity, job);
    return { rows: snapshot.rows.length, assets: snapshot.assets.length, bytes, verified: true, configPending: true, registry: routeRegistry(targetRaw, source), checkpointId: identity };
  }
  async function migrate(sourceRaw, target, opts = {}) {
    const source = connection(sourceRaw);
    if (source.url === connection(target).url) throw new Error('源项目与目标项目相同，请选择另一个 Supabase 项目。');
    const rawRows = await readRows(source, opts);
    const snapshot = await prepare(rawRows, source);
    const report = await copySnapshot(snapshot, { ...source, ...sourceRaw }, target, opts);
    const latest = await readRows(source, opts);
    report.sourceChanged = await jsonHash(latest) !== await jsonHash(rawRows);
    report.verified = !report.sourceChanged;
    progress(opts, 'complete', report.rows, report.rows, report.sourceChanged ? '迁移期间源数据发生变化，请停止编辑后重新迁移到空目标。' : '数据复制和完整性校验完成；发布 backend-config.json 后旧分享链接才会切换。');
    return report;
  }
  async function importBackup(file, target, opts = {}) {
    const parsed = await parseBackup(file, opts);
    const source = { ...parsed.manifest.source, registry: opts.registry };
    // Backups intentionally contain no API key. Copying from file does not contact the source.
    const report = await copySnapshot({ rows: parsed.manifest.rows, assets: [...parsed.assets.values()] }, source, target, opts);
    progress(opts, 'complete', report.rows, report.rows, '备份已恢复并校验；发布共享后端配置后完成链接切换。');
    return report;
  }
  window.ShortlinkPortability = { resolve, shareUrl, navigationUrl, connection, validateTarget, exportBackup, importBackup, migrate, routeRegistry, downloadRegistry, parseBackup };
})();
