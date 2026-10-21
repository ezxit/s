async page => {
  // Run with playwright-cli run-code --filename=tests/drafts-browser.js.
  // Uses the actual browser's IndexedDB, without loading app.js or any backend.
  await page.route('**/drafts-qa', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8"><title>Draft tests</title>' }));
  await page.goto('http://127.0.0.1:4176/drafts-qa');
  await page.addScriptTag({ url: '/js/drafts.js' });
  const beforeReload = await page.evaluate(async () => {
    const api = window.ShortlinkDrafts;
    const prefix = 'test:drafts:';
    for (const row of await api.list(prefix)) await api.remove(row.key);
    const original = { text: '刚刚输入', files: [new File(['原图文件字节'], '长截图.png', { type: 'image/png', lastModified: 123 })], checkpoint: { offset: 6291456 } };
    const first = api.put(`${prefix}original`, original);
    original.text = '后来的修改';
    original.files.length = 0;
    await first;
    const restored = await api.get(`${prefix}original`);
    if (restored.text !== '刚刚输入' || restored.files.length !== 1) throw new Error('put must snapshot immediately');
    const a = api.put(`${prefix}ordered`, { text: '旧文字' });
    const b = api.put(`${prefix}ordered`, { text: '最新文字' });
    await Promise.all([a, b]);
    if ((await api.get(`${prefix}ordered`)).text !== '最新文字') throw new Error('queued saves reordered');
    const pending = api.put(`${prefix}removed`, { text: '待移除' });
    const removed = api.remove(`${prefix}removed`);
    await Promise.all([pending, removed]);
    if (await api.get(`${prefix}removed`) !== null) throw new Error('late save resurrected discarded draft');
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function () { throw new DOMException('Storage full', 'QuotaExceededError'); };
    let quotaReported = false;
    try { await api.put(`${prefix}full`, { text: '文字' }); }
    catch (error) { quotaReported = error.name === 'QuotaExceededError' && error.message.includes('空间不足'); }
    finally { IDBObjectStore.prototype.put = originalPut; }
    if (!quotaReported) throw new Error('quota failure not signaled');
    await api.put(`${prefix}after-error`, { text: '错误后再次保存' });
    if (!(await api.get(`${prefix}after-error`))) throw new Error('save queue poisoned by prior error');
    return { snapshot: true, ordered: true, discardOrdering: true, quotaReported, queueRecovery: true };
  });
  await page.reload();
  await page.addScriptTag({ url: '/js/drafts.js' });
  const afterReload = await page.evaluate(async () => {
    const api = window.ShortlinkDrafts;
    const saved = await api.get('test:drafts:original');
    const file = saved.files[0];
    if (!(file instanceof File) || file.name !== '长截图.png' || file.type !== 'image/png' || await file.text() !== '原图文件字节') throw new Error('original File lost across reload');
    if (saved.checkpoint.offset !== 6291456) throw new Error('upload resume checkpoint lost');
    const rows = await api.list('test:drafts:');
    if (rows.length !== 3 || rows.some(row => !row.key.startsWith('test:drafts:') || !row.updatedAt)) throw new Error('draft list contract broken');
    for (const row of rows) await api.remove(row.key);
    return { fileRestoredAfterReload: true, checkpointRestored: true, listPrefix: true };
  });
  await page.evaluate(results => { window.__draftResults = results; }, { ...beforeReload, ...afterReload });
}
