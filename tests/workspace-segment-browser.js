// Real XHR/IndexedDB integration with mocked Supabase. No live storage writes.
async page => {
  const source = 'https://segmentqa.supabase.co', MB = 1024 * 1024;
  const checks = [], errors = [], rows = [], deletes = [];
  const objects = new Map(), sessions = new Map();
  let nextSession = 0, holdSecond = true, holdDownload = false;
  const check = (value, label) => { if (!value) throw new Error(label); checks.push(label); };
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept().catch(() => {}));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/backend-config.json', route => route.fulfill({ json: { version: 1, default: 'main', routes: { main: { url: source, key: 'sb_publishable_test' } } } }));
  await page.route('**/rest/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== source) throw new Error('Unexpected backend');
    if (url.pathname.endsWith('/shortlink_capabilities')) return route.fulfill({ json: { schema: 2 } });
    if (url.pathname.endsWith('/shortlinks')) {
      const id = url.searchParams.get('id')?.replace(/^eq\./, '');
      if (method === 'GET') return route.fulfill({ json: id ? rows.filter(row => row.id === id) : rows });
      if (method === 'POST') { rows.push({ ...request.postDataJSON(), updated_at: new Date().toISOString(), deleted_at: null }); return route.fulfill({ json: [rows.at(-1)] }); }
    }
    return route.fulfill({ status: 500, json: { message: 'Unhandled fixture route' } });
  });
  await page.route('https://segmentqa.storage.supabase.co/**', async route => {
    const request = route.request(), url = new URL(request.url()), headers = request.headers();
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Location,Upload-Offset,Upload-Length' };
    if (request.method() === 'POST') {
      const metadata = Object.fromEntries(headers['upload-metadata'].split(',').map(pair => { const [key, value] = pair.split(' '); return [key, Buffer.from(value, 'base64').toString()]; }));
      const size = Number(headers['upload-length']);
      if (size > 50 * MB) return route.fulfill({ status: 413 });
      const id = String(++nextSession); sessions.set(id, { key: metadata.objectName, size, offset: 0, chunks: [], type: metadata.contentType });
      return route.fulfill({ status: 201, headers: { ...cors, Location: `https://segmentqa.storage.supabase.co/storage/v1/upload/resumable/${id}` } });
    }
    const session = sessions.get(url.pathname.split('/').pop());
    if (request.method() === 'HEAD') return route.fulfill({ status: 200, headers: { ...cors, 'Upload-Offset': String(session.offset), 'Upload-Length': String(session.size) } });
    if (request.method() === 'PATCH') {
      if (holdSecond && session.key.endsWith('.part-0001')) {
        await page.evaluate(() => { window.__holdingSegmentUpload = true; });
        await new Promise(resolve => setTimeout(resolve, 1000));
        return route.abort('failed').catch(() => {});
      }
      const bytes = request.postDataBuffer(); session.chunks.push(bytes); session.offset += bytes.length;
      if (session.offset === session.size) objects.set(session.key, { bytes: Buffer.concat(session.chunks), type: session.type });
      return route.fulfill({ status: 204, headers: { ...cors, 'Upload-Offset': String(session.offset) } });
    }
    return route.fulfill({ status: 500 });
  });
  await page.route(source + '/storage/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() === 'DELETE') {
      for (const key of request.postDataJSON().prefixes) { deletes.push(key); objects.delete(key); }
      return route.fulfill({ json: [] });
    }
    if (holdDownload && request.method() !== 'HEAD') {
      await page.evaluate(() => { window.__holdingSegmentDownload = true; });
      await new Promise(resolve => setTimeout(resolve, 1000));
      return route.abort('failed').catch(() => {});
    }
    const key = decodeURIComponent(url.pathname.split('/public/files/')[1] || ''), item = objects.get(key);
    if (!item) return route.fulfill({ status: 404, json: { message: 'Object not found' } });
    return route.fulfill({ status: 200, body: request.method() === 'HEAD' ? '' : item.bytes, headers: { 'Content-Type': item.type, 'Content-Length': String(item.bytes.length) } });
  });
  await page.goto('http://127.0.0.1:4176/');
  await page.waitForFunction(() => typeof ShortlinkDrafts !== 'undefined');
  await page.evaluate(async () => { localStorage.clear(); for (const row of await ShortlinkDrafts.list()) await ShortlinkDrafts.remove(row.key); });
  await page.reload(); await page.locator('#text-input').waitFor();
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(65 * 1024 * 1024).fill(90)], '65MB中文原文件.bin', { type: 'application/octet-stream' }));
    const input = document.querySelector('#upload-file-input'); input.files = transfer.files; input.dispatchEvent(new Event('change'));
  });
  await page.locator('#create-btn').click();
  await page.waitForFunction(() => window.__holdingSegmentUpload, { timeout: 30000 });
  await page.locator('#pause-upload').click();
  await page.waitForFunction(() => document.querySelector('#editor-error')?.textContent.includes('已暂停。'));
  const paused = await page.evaluate(async () => (await ShortlinkDrafts.list('draft:'))[0].value.attachments[0].checkpoint);
  check(paused.mode === 'segmented' && paused.parts.length === 1 && paused.parts[0].size === 32 * MB, 'first completed part survives in durable draft checkpoint');
  check(rows.length === 0, 'paused multipart upload does not publish row');
  const firstKey = paused.parts[0].key;
  check(objects.has(firstKey), 'first original segment stored intact');
  const beforeReloadSessions = nextSession;
  await page.reload(); await page.locator('#text-input').waitFor();
  check((await page.locator('#upload-previews').innerText()).includes('65MB中文原文件.bin'), 'reload restores original 65 MiB File from IndexedDB');
  holdSecond = false;
  await page.locator('#create-btn').click();
  await page.locator('#result').waitFor({ state: 'visible', timeout: 30000 });
  const file = rows[0].files[0];
  check(file.segmented && file.parts.length === 3 && file.url === '', '65 MiB upload publishes three-part manifest');
  check(nextSession === beforeReloadSessions + 1, 'resume reuses first and pending second segment sessions');
  check(Array.from(sessions.values()).every(session => session.size <= 32 * MB), 'every real XHR object stays below free 50 MiB cap');
  check(file.parts.map(part => part.size).join(',') === [32 * MB, 32 * MB, MB].join(','), 'segments preserve 32/32/1 MiB boundaries');
  check(Buffer.concat(file.parts.map(part => objects.get(part.key).bytes)).equals(Buffer.alloc(65 * MB, 90)), 'all stored segments reconstruct exact original bytes');
  const link = await page.locator('#result-url').getAttribute('href');
  await page.goto(link); await page.locator('[data-file-index]').waitFor();
  const installWriter = () => page.evaluate(() => {
    window.__downloadPieces = []; window.__downloadClosed = false; window.__downloadAborted = false;
    window.showSaveFilePicker = async ({ suggestedName }) => {
      window.__downloadName = suggestedName;
      return { createWritable: async () => ({ write: async blob => { __downloadPieces.push(blob); }, close: async () => { __downloadClosed = true; }, abort: async () => { __downloadAborted = true; } }) };
    };
  });
  await installWriter();
  await page.locator('[data-file-index]').click();
  await page.waitForFunction(() => window.__downloadClosed, { timeout: 30000 });
  const downloaded = await page.evaluate(async () => ({ name: __downloadName, count: __downloadPieces.length, size: __downloadPieces.reduce((sum, blob) => sum + blob.size, 0), sha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await new Blob(__downloadPieces).arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('') }));
  check(downloaded.name === file.name && downloaded.count === 3 && downloaded.size === 65 * MB, 'download panel writes three pieces with original Chinese filename');
  check(downloaded.sha256 === '24451023e1d072a6b82363763a0acc3839b994a22de776f84ed4c314fb514f31', 'assembled browser download SHA256 equals original 65 MiB file');
  check((await page.locator('.download-progress').innerText()).includes('文件已合并'), 'download panel reports successful assembly');
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await installWriter(); holdDownload = true;
  await page.locator('[data-file-index]').click();
  await page.waitForFunction(() => window.__holdingSegmentDownload);
  await page.getByRole('button', { name: '取消下载', exact: true }).click();
  await page.waitForFunction(() => window.__downloadAborted);
  check((await page.locator('.download-progress').innerText()).includes('下载已取消'), 'cancel download aborts partial file and updates progress panel');
  check(file.parts.every(part => objects.has(part.key)), 'cancel download leaves every original segment intact');
  holdDownload = false;
  await page.goto('http://127.0.0.1:4176/'); await page.locator('#text-input').waitFor();
  holdSecond = true;
  await page.locator('#upload-file-input').setInputFiles({ name: '33MB待丢弃.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(33 * MB, 11) });
  await page.locator('#create-btn').click();
  await page.waitForFunction(() => window.__holdingSegmentUpload);
  await page.locator('#pause-upload').click();
  await page.waitForFunction(() => document.querySelector('#editor-error')?.textContent.includes('已暂停。'));
  const discarded = await page.evaluate(async () => (await ShortlinkDrafts.list('draft:'))[0].value.attachments[0]);
  await page.locator('#discard-draft').click();
  await page.waitForFunction(() => !document.querySelector('#upload-previews')?.textContent);
  check(!objects.has(discarded.key + '.part-0000'), 'discard removes completed segment');
  check(deletes.includes(discarded.key + '.part-0001'), 'discard cleans pending segment deterministic key');
  check(file.parts.every(part => objects.has(part.key)), 'discard separate draft preserves previously published segments');
  check(!errors.length, 'segmented editor/browser workflows have no uncaught errors');
  await page.evaluate(result => { window.__workspaceSegmentQA = result; }, { checks, errors });
}
