/* Database access for full-library search and the recoverable recycle bin. */
(() => {
  'use strict';
  let connection = null;
  let schema = null;
  let schemaRequest = null;
  const MAX_PAGE = 100;

  function configure({url, key}) {
    connection = {url: String(url || '').replace(/\/+$/, ''), key: String(key || '')};
    schema = null;
    schemaRequest = null;
  }

  function assertConnection(expected) {
    if (expected !== connection) throw new Error('Supabase 连接已切换，请重新执行操作');
  }
  async function request(path, {method = 'GET', body, signal, headers = {}, expectedConnection = connection} = {}) {
    if (!connection) throw new Error('请先配置 Supabase 连接');
    assertConnection(expectedConnection);
    const config = connection;
    const auth = {apikey: config.key, ...headers};
    if (!config.key.startsWith('sb_publishable_')) auth.Authorization = `Bearer ${config.key}`;
    if (body !== undefined) auth['Content-Type'] = 'application/json';
    const response = await fetch(`${config.url}/rest/v1/${path}`, {
      method, headers: auth, body: body === undefined ? undefined : JSON.stringify(body), signal
    });
    const raw = await response.text();
    let result;
    try { result = raw ? JSON.parse(raw) : null; } catch (_) { result = raw; }
    if (!response.ok) {
      const error = new Error(result?.message || result?.error || `数据库请求失败 (${response.status})`);
      error.status = response.status;
      error.code = result?.code;
      error.details = result?.details;
      throw error;
    }
    return result;
  }

  const rpc = (name, body, options = {}) => request(`rpc/${name}`, {method: 'POST', body, ...options});
  function missingSchema(error) {
    return error.code === 'PGRST202' || error.code === 'PGRST204' || error.code === '42883' || error.code === '42703';
  }
  async function checkSchema() {
    if (schema !== null) return schema;
    if (schemaRequest) return schemaRequest;
    const config = connection;
    const pending = rpc('shortlink_capabilities', {}).then(result => {
      const value = Number(result?.schema) >= 2;
      if (config === connection) schema = value;
      return value;
    }).catch(error => {
      if (!missingSchema(error)) throw error;
      if (config === connection) schema = false;
      return false;
    }).finally(() => { if (schemaRequest === pending) schemaRequest = null; });
    schemaRequest = pending;
    return pending;
  }
  function upgradeError() {
    const error = new Error('请先在当前 Supabase 的 SQL Editor 执行 migration.sql，启用回收站与可靠清理。');
    error.needsUpgrade = true;
    return error;
  }
  async function requireSchema(expected = connection) {
    if (!await checkSchema()) throw upgradeError();
    assertConnection(expected);
  }
  const idsOf = ids => [...new Set((ids || []).map(String))];
  const namespaceFilter = namespace => `namespace=eq.${encodeURIComponent(String(namespace))}`;

  async function legacySearch(namespace, {query, trash, limit, offset, signal, expectedConnection}) {
    if (trash) return {items: [], total: 0, needsUpgrade: true};
    const found = [];
    const needle = query.toLocaleLowerCase();
    // Old tables have no search RPC: scan all pages, never retrieve base64 images.
    const pageSize = 100;
    let cursor = 0;
    for (;;) {
      const rows = await request(`shortlinks?select=id,text,description,files,created_at,namespace&${namespaceFilter(namespace)}&order=created_at.desc,id.desc&limit=${pageSize}&offset=${cursor}`, {signal, expectedConnection});
      if (!Array.isArray(rows)) throw new Error('数据库返回的列表格式有误');
      for (const row of rows) {
        const filenames = (Array.isArray(row.files) ? row.files : []).map(file => file?.name || '').join('\n');
        if (needle && !`${row.text || ''}\n${row.description || ''}\n${filenames}`.toLocaleLowerCase().includes(needle)) continue;
        found.push({id: row.id, namespace: row.namespace, description: row.description || '',
          preview: String(row.text || '').slice(0, 180), created_at: row.created_at,
          file_count: Array.isArray(row.files) ? row.files.length : 0, image_count: null,
          deleted_at: null, cleanup_started_at: null});
      }
      cursor += rows.length;
      // A project may configure an API cap below pageSize. Continue until an
      // empty page instead of mistaking that server cap for the final page.
      if (!rows.length) break;
    }
    return {items: found.slice(offset, offset + limit), total: found.length, needsUpgrade: true};
  }

  async function search(namespace, options = {}) {
    const expectedConnection = connection;
    const query = String(options.query || '').trim();
    const limit = Math.min(MAX_PAGE, Math.max(1, Math.floor(Number(options.limit) || 20)));
    const offset = Math.max(0, Math.floor(Number(options.offset) || 0));
    const trash = !!options.trash;
    const signal = options.signal;
    if (!await checkSchema()) return legacySearch(namespace, {query, trash, limit, offset, signal, expectedConnection});
    const result = await rpc('search_shortlinks', {p_namespace: String(namespace), p_query: query, p_trash: trash, p_limit: limit, p_offset: offset}, {signal, expectedConnection});
    return {items: result?.items || [], total: Number(result?.total) || 0, needsUpgrade: false};
  }

  async function mutate(name, ids, namespace) {
    const expectedConnection = connection;
    const selected = idsOf(ids);
    if (!selected.length) return {ids: [], count: 0};
    await requireSchema(expectedConnection);
    const result = await rpc(name, {p_ids: selected, p_namespace: String(namespace)}, {expectedConnection});
    const returned = idsOf(result?.ids);
    if (returned.length !== selected.length || selected.some(id => !returned.includes(id))) {
      throw new Error('部分短链接已变化，请刷新列表后重试');
    }
    return {ids: returned, count: returned.length};
  }

  async function purge(ids, namespace, deleteObject) {
    const expectedConnection = connection;
    await requireSchema(expectedConnection);
    if (typeof deleteObject !== 'function') throw new Error('缺少文件清理方法');
    const completed = [];
    const failed = [];
    for (const id of idsOf(ids)) {
      try {
        const plan = await rpc('begin_purge', {p_id: id, p_namespace: String(namespace)}, {expectedConnection});
        // Retries reuse the persisted plan. A missing Storage object is success.
        const keys = plan?.keys;
        if (!Array.isArray(keys) || plan.id !== id) throw new Error('清理计划格式有误');
        for (const object of keys) {
          assertConnection(expectedConnection);
          await deleteObject(object);
        }
        const result = await rpc('finish_purge', {p_id: id, p_namespace: String(namespace), p_completed_keys: keys}, {expectedConnection});
        if (result?.id !== id) throw new Error('清理状态未确认，请刷新并重试');
        completed.push(id);
      } catch (error) { failed.push({id, error}); }
    }
    return {ids: completed, count: completed.length, failed};
  }

  window.ShortlinkData = Object.freeze({configure, checkSchema, search,
    softDelete: (ids, namespace) => mutate('soft_delete_shortlinks', ids, namespace),
    restore: (ids, namespace) => mutate('restore_shortlinks', ids, namespace), purge});
})();
