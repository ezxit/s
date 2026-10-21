// Real-browser editor failure cases. All Supabase requests are mocked.
// Run with playwright-cli run-code --filename=tests/workspace-edge-browser.js.
async page => {
  const source = 'https://edgeqa.supabase.co';
  const checks = [], errors = [], requests = [];
  const rows = [], objects = new Map(), sessions = new Map();
  let nextSession = 0, losePost = false;
  const check = (value, label) => { if (!value) throw new Error(label); checks.push(label); };
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/backend-config.json', route => route.fulfill({ json: { version: 1, default: 'main', routes: { main: { url: source, key: 'sb_publishable_test' } } } }));
  await page.route('**/rest/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== source) throw new Error(`Unexpected backend ${url.origin}`);
    const body = request.postDataJSON();
    requests.push({ path: url.pathname, method, body });
    if (url.pathname.endsWith('/shortlink_capabilities')) return route.fulfill({ json: { schema: 2 } });
    if (url.pathname.endsWith('/shortlinks')) {
      const id = url.searchParams.get('id')?.replace(/^eq\./, '');
      if (method === 'GET') return route.fulfill({ json: id ? rows.filter(row => row.id === id) : rows });
      if (method === 'POST') {
        rows.push({ ...body, updated_at: new Date().toISOString(), deleted_at: null });
        if (losePost) { losePost = false; return route.abort('failed'); }
        return route.fulfill({ json: [rows.at(-1)] });
      }
      if (method === 'PATCH') {
        const row = rows.find(item => item.id === id);
        Object.assign(row, body, { updated_at: new Date().toISOString() });
        return route.fulfill({ json: [row] });
      }
    }
    return route.fulfill({ status: 500, json: { message: `Unhandled fixture ${url.pathname}` } });
  });
  await page.route('https://edgeqa.storage.supabase.co/**', async route => {
    const request = route.request(), url = new URL(request.url()), headers = request.headers();
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Location,Upload-Offset,Upload-Length' };
    if (request.method() === 'POST') {
      const metadata = Object.fromEntries(headers['upload-metadata'].split(',').map(pair => { const [key, value] = pair.split(' '); return [key, Buffer.from(value, 'base64').toString()]; }));
      const id = String(++nextSession);
      sessions.set(id, { key: metadata.objectName, size: Number(headers['upload-length']), offset: 0, parts: [], type: metadata.contentType });
      return route.fulfill({ status: 201, headers: { ...cors, Location: `https://edgeqa.storage.supabase.co/storage/v1/upload/resumable/${id}` } });
    }
    const session = sessions.get(url.pathname.split('/').pop());
    if (request.method() === 'HEAD') return route.fulfill({ status: 200, headers: { ...cors, 'Upload-Offset': String(session.offset), 'Upload-Length': String(session.size) } });
    if (request.method() === 'PATCH') {
      const part = request.postDataBuffer(); session.parts.push(part); session.offset += part.length;
      if (session.offset === session.size) objects.set(session.key, { bytes: Buffer.concat(session.parts), type: session.type });
      return route.fulfill({ status: 204, headers: { ...cors, 'Upload-Offset': String(session.offset) } });
    }
    return route.fulfill({ status: 500 });
  });
  await page.route(source + '/storage/**', async route => {
    const request = route.request(), url = new URL(request.url());
    requests.push({ path: url.pathname, method: request.method(), body: request.postDataJSON() });
    if (request.method() === 'DELETE') {
      for (const key of request.postDataJSON().prefixes) objects.delete(key);
      return route.fulfill({ json: [] });
    }
    const key = decodeURIComponent(url.pathname.split('/public/files/')[1] || '');
    const item = objects.get(key);
    if (!item) return route.fulfill({ status: 404, json: { message: 'Object not found' } });
    return route.fulfill({ status: 200, body: request.method() === 'HEAD' ? '' : item.bytes, headers: { 'Content-Type': item.type, 'Content-Length': String(item.bytes.length) } });
  });
  await page.goto('http://127.0.0.1:4176/');
  await page.waitForFunction(() => typeof ShortlinkDrafts !== 'undefined');
  await page.evaluate(async () => { localStorage.clear(); for (const row of await ShortlinkDrafts.list()) await ShortlinkDrafts.remove(row.key); });
  await page.reload();
  await page.locator('#text-input').waitFor();

  // A lost POST response leaves a draft containing files already referenced by
  // the published row. Discard must preserve those actual storage objects.
  await page.locator('#text-input').fill('response lost but row committed');
  await page.locator('#upload-file-input').setInputFiles({ name: '已发布附件.txt', mimeType: 'text/plain', buffer: Buffer.from('keep this published file') });
  losePost = true;
  await page.locator('#create-btn').click();
  await page.waitForFunction(() => document.querySelector('#create-btn')?.textContent === '重试保存');
  const lostRow = rows.find(row => row.text === 'response lost but row committed');
  check(!!lostRow && objects.has(lostRow.files[0].key), 'lost POST still created row and original');
  await page.locator('#discard-draft').click();
  await page.waitForFunction(() => document.querySelector('#text-input')?.value === '' && document.querySelector('#upload-previews')?.textContent === '');
  check(objects.has(lostRow.files[0].key), 'discard after lost POST preserves published file');
  check(!requests.some(request => request.method === 'DELETE' && request.body?.prefixes?.includes(lostRow.files[0].key)), 'discard never sent delete for referenced object');

  // Force both marker-write and removal failures after publishing. The separate
  // localStorage marker must prevent resurrection when opening a new composer.
  await page.evaluate(() => {
    window.__realDrafts = ShortlinkDrafts;
    window.__draftFailures = { afterPublish: true };
    window.ShortlinkDrafts = {
      ...ShortlinkDrafts,
      put(key, value) { if (__draftFailures.afterPublish && value.committed) throw new DOMException('full marker store', 'QuotaExceededError'); return __realDrafts.put(key, value); },
      remove(key) { if (__draftFailures.afterPublish) throw new DOMException('remove failed', 'UnknownError'); return __realDrafts.remove(key); },
    };
  });
  await page.locator('#text-input').fill('published cleanup failure');
  await page.locator('#upload-file-input').setInputFiles({ name: '清理失败仍保留.txt', mimeType: 'text/plain', buffer: Buffer.from('retained after marker failure') });
  await page.locator('#create-btn').click();
  await page.locator('#result').waitFor({ state: 'visible' });
  const cleanupRow = rows.find(row => row.text === 'published cleanup failure');
  check((await page.locator('#draft-status').innerText()).includes('稍后重试'), 'publish reports local cleanup failure');
  await page.locator('#new-btn').click();
  await page.waitForFunction(() => document.querySelector('#text-input')?.value === '');
  check(await page.locator('#upload-previews .upload-item').count() === 0, 'failed published draft cleanup does not restore attachments');
  check(objects.has(cleanupRow.files[0].key), 'published files survive failed draft cleanup');
  await page.evaluate(() => { __draftFailures.afterPublish = false; window.ShortlinkDrafts = __realDrafts; });
  await page.reload();
  await page.locator('#text-input').waitFor();
  check(await page.locator('#text-input').inputValue() === '', 'published marker protects composer after real reload');

  // A quota failure must not silently leave the editor and lose selected blobs.
  await page.goto(`http://127.0.0.1:4176/?s=${lostRow.id}`);
  await page.locator('#edit-btn').click();
  await page.evaluate(() => {
    window.__realDrafts = ShortlinkDrafts;
    window.ShortlinkDrafts = { ...ShortlinkDrafts, put() { return Promise.reject(new DOMException('simulated quota full', 'QuotaExceededError')); } };
  });
  await page.locator('#text-input').fill('stay in editor after quota error');
  await page.locator('#upload-file-input').setInputFiles({ name: '仍在编辑区.txt', mimeType: 'text/plain', buffer: Buffer.from('unsaved file survives failed cancel') });
  await page.locator('#cancel-edit-btn').click();
  await page.waitForFunction(() => document.querySelector('#editor-error')?.textContent.includes('草稿尚未保存'));
  check(await page.locator('#text-input').inputValue() === 'stay in editor after quota error', 'cancel after quota error retains editor text');
  check((await page.locator('#upload-previews').innerText()).includes('仍在编辑区.txt'), 'cancel after quota error retains selected File');
  check(await page.evaluate(() => activeEditor.unsafe), 'quota error leaves unload protection enabled');
  await page.evaluate(async () => { window.ShortlinkDrafts = __realDrafts; await activeEditor.flush(); });
  await page.locator('#cancel-edit-btn').click();
  await page.locator('#edit-btn').waitFor();

  // Old save completion must not clear unsafe while a newer save is queued.
  await page.goto('http://127.0.0.1:4176/');
  await page.locator('#text-input').waitFor();
  await page.evaluate(() => {
    window.__realDrafts = ShortlinkDrafts;
    window.__heldPuts = [];
    window.ShortlinkDrafts = {
      ...ShortlinkDrafts,
      put(key, value) { return new Promise((resolve, reject) => __heldPuts.push({ value, release: () => __realDrafts.put(key, value).then(resolve, reject) })); },
    };
    const input = document.querySelector('#text-input');
    input.value = 'save A'; input.dispatchEvent(new Event('input'));
    window.__saveA = activeEditor.flush();
  });
  await page.waitForFunction(() => __heldPuts.length === 1);
  await page.evaluate(() => {
    const input = document.querySelector('#text-input');
    input.value = 'save B'; input.dispatchEvent(new Event('input'));
    window.__saveB = activeEditor.flush();
    __heldPuts[0].release();
  });
  await page.waitForFunction(() => __heldPuts.length === 2);
  check(await page.evaluate(() => activeEditor.unsafe), 'newer queued save remains unsafe after older save completes');
  check(!(await page.locator('#draft-status').innerText()).includes('草稿已保存'), 'older save does not claim newest input was saved');
  await page.evaluate(async () => { await __heldPuts[1].release(); await __saveB; window.ShortlinkDrafts = __realDrafts; });
  check(!(await page.evaluate(() => activeEditor.unsafe)), 'latest save completion clears unsafe');
  await page.locator('#discard-draft').click();
  await page.waitForFunction(() => document.querySelector('#text-input')?.value === '');

  // Pause precisely after the final upload, while thumbnail generation awaits.
  await page.evaluate(() => {
    window.__originalThumbnail = originalThumbnail;
    originalThumbnail = () => new Promise(resolve => { window.__finishThumbnail = () => resolve({}); });
  });
  const png = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 20; canvas.height = 200; canvas.getContext('2d').fillRect(0, 0, 20, 200); return canvas.toDataURL('image/png').split(',')[1]; });
  await page.locator('#text-input').fill('pause in thumbnail');
  await page.locator('#file-input').setInputFiles({ name: '暂停最后一张.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  const postCount = requests.filter(request => request.method === 'POST' && request.path.endsWith('/shortlinks')).length;
  await page.locator('#create-btn').click();
  await page.waitForFunction(() => typeof __finishThumbnail === 'function');
  await page.locator('#pause-upload').click();
  await page.evaluate(() => { __finishThumbnail(); originalThumbnail = __originalThumbnail; });
  await page.waitForFunction(() => document.querySelector('#editor-error')?.textContent.includes('已暂停。'));
  check(!rows.some(row => row.text === 'pause in thumbnail'), 'pause during final thumbnail prevents publishing');
  check(requests.filter(request => request.method === 'POST' && request.path.endsWith('/shortlinks')).length === postCount, 'pause during final thumbnail sends no row mutation');
  const sessionCount = nextSession;
  await page.locator('#create-btn').click();
  await page.locator('#result').waitFor({ state: 'visible' });
  check(nextSession === sessionCount, 'resume after thumbnail pause reuses completed original upload');
  check(rows.some(row => row.text === 'pause in thumbnail'), 'resume after thumbnail pause publishes successfully');
  check(!errors.length, 'failure cases produce no uncaught browser errors');
  await page.evaluate(result => { window.__workspaceEdgeQA = result; }, { checks, errors });
}
