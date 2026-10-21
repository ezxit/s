// Run with: node --test tests/portability.test.cjs (Node 20+; no packages).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { File } = require('node:buffer');

const code = fs.readFileSync(path.join(__dirname, '../js/portability.js'), 'utf8');
const SOURCE = { url: 'https://source.supabase.co', key: 'sb_publishable_source', route: 'main', published: true };
const TARGET = { url: 'https://target.supabase.co', key: 'sb_publishable_target' };
const FILE_URL = `${SOURCE.url}/storage/v1/object/public/files/original`;
const ID = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const PART_BYTES = 32 * 1024 * 1024;
const sha256 = async blob => Buffer.from(await webcrypto.subtle.digest('SHA-256', await blob.arrayBuffer())).toString('hex');
function record(changes = {}) {
  return { id: ID, text: '完整中文正文', description: '中文短链接', namespace: 'default', created: '2026-01-01T00:00:00+00:00', created_at: '2026-01-01T00:00:00+00:00', deleted_at: null, images: [], files: [], retired_assets: [], ...changes };
}

function mockIndexedDB() {
  const records = new Map();
  const database = {
    transaction() {
      const tx = {
        objectStore() {
          return {
            get(key) {
              const request = {};
              queueMicrotask(() => { request.result = structuredClone(records.get(key)); tx.oncomplete?.(); });
              return request;
            },
            put(value, key) {
              const request = {};
              queueMicrotask(() => { records.set(key, structuredClone(value)); request.result = key; tx.oncomplete?.(); });
              return request;
            }
          };
        }
      };
      return tx;
    }
  };
  return { open() { const request = {}; queueMicrotask(() => { request.result = database; request.onsuccess?.(); }); return request; } };
}

function harness(rows = [record()]) {
  const state = {
    rows, destinations: new Map(), sourceFiles: new Map([[FILE_URL, new Blob(['中文原始附件字节'], { type: 'text/plain' })]]),
    objects: new Map(), local: new Map(), uploads: [], writes: 0, failNextUpload: false, targetReadStatus: 0, missingStatus: 404,
    registry: { version: 1, default: 'main', routes: { main: { url: SOURCE.url, key: SOURCE.key } } }
  };
  const location = { href: 'https://short.example/s/', origin: 'https://short.example', pathname: '/s/', search: '', hash: '' };
  const context = {
    TextEncoder, TextDecoder, URL, URLSearchParams, Uint8Array, DataView, Blob, File, DOMException, crypto: webcrypto,
    btoa, atob, AbortController, structuredClone, queueMicrotask, setTimeout, clearTimeout, location, window: { crypto: webcrypto },
    indexedDB: mockIndexedDB(), localStorage: { getItem: key => state.local.get(key) || null, setItem: (key, value) => state.local.set(key, value) },
    fetch: async (input, options = {}) => {
      if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const url = new URL(String(input));
      if (url.protocol === 'data:') return fetch(input, options);
      if (url.pathname.endsWith('/backend-config.json')) return Response.json(state.registry);
      if (url.pathname.endsWith('/rpc/shortlink_capabilities')) return Response.json({ schema: 2 });
      if (url.pathname === '/rest/v1/shortlinks') {
        if (url.origin === SOURCE.url) {
          const filter = url.searchParams.get('id');
          return Response.json(state.rows.filter(row => !filter || row.id > filter.slice(3)).slice(0, 100));
        }
        if (options.method === 'POST') {
          const value = JSON.parse(options.body);
          state.writes++;
          state.destinations.set(value.id, value);
          state.afterInsert?.(value);
          return Response.json([value]);
        }
        const filter = url.searchParams.get('id');
        return Response.json([...state.destinations.values()].filter(row => !filter || filter.includes(row.id)));
      }
      if (state.sourceFiles.has(url.href)) return new Response(state.sourceFiles.get(url.href));
      if (url.origin === TARGET.url && url.pathname.includes('/storage/v1/object/public/files/')) {
        if (state.targetReadStatus) return Response.json({ error: 'permission denied' }, { status: state.targetReadStatus });
        if (state.objects.has(url.href)) return new Response(state.objects.get(url.href));
        return Response.json({ statusCode: '404', error: 'not_found' }, { status: state.missingStatus });
      }
      throw new Error(`Unexpected mock request: ${url}`);
    }
  };
  context.window.ShortlinkTransfers = {
    async readBlob(metadata, options = {}) {
      if (metadata.segmented) {
        let size = 0;
        const blobs = [];
        for (const part of metadata.parts) {
          const response = await context.fetch(part.url, options);
          if (!response.ok) throw new Error(`Storage read failed (${response.status})`);
          const blob = await response.blob();
          assert.equal(blob.size, part.size);
          assert.equal(await sha256(blob), part.sha256);
          blobs.push(blob); size += blob.size;
        }
        assert.equal(size, metadata.size);
        return new Blob(blobs, { type: metadata.type });
      }
      const response = await context.fetch(metadata.url, options);
      if (!response.ok) throw new Error(`Storage read failed (${response.status})`);
      return response.blob();
    },
    async upload(file, options) {
      state.uploads.push({ name: file.name, key: options.key, lastModified: file.lastModified, checkpoint: structuredClone(options.checkpoint) });
      await options.onCheckpoint?.({ offset: Math.min(2, file.size), location: 'same-mock-upload' });
      if (state.failNextUpload) { state.failNextUpload = false; throw new Error('Simulated interrupted upload'); }
      if (file.size > PART_BYTES) {
        const parts = [];
        for (let offset = 0, index = 0; offset < file.size; offset += PART_BYTES, index++) {
          const piece = file.slice(offset, offset + PART_BYTES, 'application/octet-stream');
          const key = `${options.key}.part-${String(index).padStart(4, '0')}`;
          const url = `${TARGET.url}/storage/v1/object/public/files/${key}`;
          state.objects.set(url, piece);
          parts.push({ key, url, size: piece.size, type: piece.type, sha256: await sha256(piece) });
        }
        return { name: file.name, key: options.key, url: '', size: file.size, type: file.type, segmented: true, parts };
      }
      const url = `${TARGET.url}/storage/v1/object/public/files/${options.key}`;
      state.objects.set(url, file);
      return { name: file.name, url, key: options.key, size: file.size, type: file.type };
    }
  };
  vm.createContext(context);
  vm.runInContext(code, context, { filename: 'portability.js' });
  return { state, context, api: context.window.ShortlinkPortability, source: { ...SOURCE, registry: state.registry } };
}

test('published aliases redirect old shares and stale local connections; fallback is only for unpublished routes', async () => {
  const { api, state, context, source } = harness();
  state.registry = api.routeRegistry(TARGET, source);
  state.local.set('sb_url', SOURCE.url); state.local.set('sb_anon_key', SOURCE.key);
  const homepage = await api.resolve(SOURCE);
  assert.equal(homepage.url, TARGET.url);
  assert.equal(homepage.published, true);
  context.location.search = `?s=${ID}`;
  assert.equal((await api.resolve(SOURCE)).url, TARGET.url);
  context.location.search = `?s=${ID}&store=project-source.supabase.co`;
  context.location.hash = `#backend=${Buffer.from(JSON.stringify(SOURCE)).toString('base64url')}`;
  assert.equal((await api.resolve(SOURCE)).url, TARGET.url);
  context.location.search = `?s=${ID}&store=unpublished`;
  const unpublished = await api.resolve(SOURCE);
  assert.equal(unpublished.url, SOURCE.url);
  assert.ok(api.shareUrl(ID, unpublished).includes('#backend='));
  context.location.hash = '';
  await assert.rejects(api.resolve(SOURCE), /路由尚未发布/);
});

test('binary backups cross chunk boundaries, preserve legacy images and Chinese filenames, and reject corruption before writes', async () => {
  const { api, state, source } = harness([record({
    images: ['data:image/png;base64,aGVsbG8='],
    files: [{ name: '中文附件.bin', key: 'original', url: FILE_URL, type: 'application/octet-stream' }]
  })]);
  const content = new Uint8Array(4 * 1024 * 1024 + 31).fill(47);
  state.sourceFiles.set(FILE_URL, new Blob([content], { type: 'application/octet-stream' }));
  const backup = await api.exportBackup(source, { saveAs: false });
  assert.equal(backup.assets, 2);
  assert.ok(backup.blob.size < content.length + 10000, 'binary archive has no Base64 expansion');
  const parsed = await api.parseBackup(backup.blob, {});
  assert.equal(parsed.assets.size, 2);
  assert.equal(parsed.manifest.rows[0].images[0].name, '图片-1.png');
  const bytes = new Uint8Array(await backup.blob.arrayBuffer());
  bytes[Math.floor(bytes.length / 2)] ^= 1;
  await assert.rejects(api.importBackup(new Blob([bytes]), TARGET), /校验失败/);
  assert.equal(state.writes, 0);
  assert.equal(state.uploads.length, 0);
  const report = await api.importBackup(backup.blob, TARGET, { registry: state.registry });
  assert.equal(report.verified, true);
  assert.equal(report.bytes, content.length + 5);
  assert.equal(report.registry.routes.main.url, TARGET.url);
  assert.equal(state.destinations.get(ID).files[0].name, '中文附件.bin');
  assert.ok(state.destinations.get(ID).files[0].url.startsWith(TARGET.url));
  await api.importBackup(backup.blob, TARGET, { registry: state.registry });
  assert.equal(state.writes, 1, 'reopening the same archive resumes without duplicate rows');
});

test('migration retains all namespaces, trash and retired file bytes, but resets purge internals', async () => {
  const { api, state, source } = harness([
    record({ namespace: 'one' }),
    record({ id: ID2, namespace: 'two', deleted_at: '2026-01-02T00:00:00Z', retired_assets: [{ name: '旧附件.txt', key: 'original' }], cleanup_keys: ['original'], cleanup_started_at: '2026-01-03T00:00:00Z', search_text: 'generated' })
  ]);
  state.missingStatus = 400; // Supabase may use HTTP 400 with a storage 404 body.
  const report = await api.migrate(source, TARGET);
  assert.equal(report.verified, true);
  assert.equal(report.sourceChanged, false);
  assert.equal(report.configPending, true);
  assert.equal(report.rows, 2);
  assert.equal(report.assets, 1);
  const trashed = state.destinations.get(ID2);
  assert.equal(trashed.namespace, 'two');
  assert.equal(trashed.deleted_at, '2026-01-02T00:00:00.000Z');
  assert.equal(trashed.cleanup_keys, undefined);
  assert.equal(trashed.cleanup_started_at, undefined);
  assert.equal(trashed.search_text, undefined);
  assert.equal(await state.objects.get(trashed.retired_assets[0].url).text(), '中文原始附件字节');
  await api.migrate(source, TARGET);
  assert.equal(state.writes, 2);
  assert.equal(state.rows.length, 2, 'source is retained');
});

test('interrupted migration reuses a stable file fingerprint, storage key and transfer checkpoint', async () => {
  const { api, state, source } = harness([record({ files: [{ name: '可续传.txt', key: 'original', url: FILE_URL }] })]);
  state.failNextUpload = true;
  await assert.rejects(api.migrate(source, TARGET), /interrupted/);
  assert.equal(state.writes, 0);
  assert.equal((await api.migrate(source, TARGET)).verified, true);
  assert.equal(state.uploads.length, 2);
  assert.equal(state.uploads[0].key, state.uploads[1].key);
  assert.equal(state.uploads[0].lastModified, 0);
  assert.equal(state.uploads[1].lastModified, 0);
  assert.equal(state.uploads[1].checkpoint.location, 'same-mock-upload');
});

test('target ID conflicts are detected before uploads and independently edited migrated rows stay intact', async () => {
  const { api, state, source } = harness([record({ files: [{ name: '附件.txt', url: FILE_URL, key: 'original' }] })]);
  state.destinations.set(ID, record({ text: '目标已有独立内容' }));
  await assert.rejects(api.migrate(source, TARGET), /同 ID/);
  assert.equal(state.uploads.length, 0);
  assert.equal(state.destinations.get(ID).text, '目标已有独立内容');
  state.destinations.clear();
  await api.migrate(source, TARGET);
  state.destinations.get(ID).text = '迁移后独立修改';
  await assert.rejects(api.migrate(source, TARGET), /同 ID/);
  assert.equal(state.destinations.get(ID).text, '迁移后独立修改');
});

test('source edits invalidate completion and restarting against the occupied target does not overwrite the older snapshot', async () => {
  const { api, state, source } = harness();
  state.afterInsert = () => { state.rows[0].text = '复制时源端出现新版本'; };
  const report = await api.migrate(source, TARGET);
  assert.equal(report.sourceChanged, true);
  assert.equal(report.verified, false);
  assert.equal(state.destinations.get(ID).text, '完整中文正文');
  await assert.rejects(api.migrate(source, TARGET), /同 ID/);
  assert.equal(state.writes, 1, 'changed source needs a fresh empty target, not an overwrite');
});

test('target read authorization errors are surfaced before uploading', async () => {
  const { api, state, source } = harness([record({ files: [{ name: '附件.txt', url: FILE_URL, key: 'original' }] })]);
  state.targetReadStatus = 403;
  await assert.rejects(api.migrate(source, TARGET), /读取失败 \(403\)/);
  assert.equal(state.uploads.length, 0);
});

test('segmented originals remain portable as one archived asset and restore into new target pieces', async () => {
  const { api, state, context, source } = harness();
  const first = new Blob([new Uint8Array(PART_BYTES).fill(67)], { type: 'application/octet-stream' });
  const second = new Blob(['中文分片文件最后的字节'], { type: 'application/octet-stream' });
  const parts = [];
  for (const [index, blob] of [first, second].entries()) {
    const key = `large.part-${String(index).padStart(4, '0')}`;
    const url = `${SOURCE.url}/storage/v1/object/public/files/${key}`;
    state.sourceFiles.set(url, blob);
    parts.push({ key, url, size: blob.size, type: blob.type, sha256: await sha256(blob) });
  }
  state.rows[0].files = [{ name: '完整分片原文件.bin', type: 'application/octet-stream', key: 'large', url: '', segmented: true, size: first.size + second.size, parts }];
  const backup = await api.exportBackup(source, { saveAs: false });
  assert.equal(backup.assets, 1, 'all pieces represent one original asset in the archive');
  const parsed = await api.parseBackup(backup.blob, {});
  const manifestFile = parsed.manifest.rows[0].files[0];
  assert.equal(manifestFile.segmented, undefined);
  assert.equal(manifestFile.parts, undefined, 'archive rows retain no source piece URLs');
  assert.ok(manifestFile.url.startsWith('slbackup-asset:'));
  const report = await api.importBackup(backup.blob, TARGET, { registry: state.registry });
  assert.equal(report.verified, true);
  assert.equal(report.assets, 1);
  const restored = state.destinations.get(ID).files[0];
  assert.equal(restored.segmented, true);
  assert.equal(restored.url, '');
  assert.equal(restored.name, '完整分片原文件.bin');
  assert.equal(restored.parts.length, 2);
  assert.ok(restored.parts.every(part => part.url.startsWith(TARGET.url)));
  assert.ok(!state.objects.has(`${TARGET.url}/storage/v1/object/public/files/${restored.key}`), 'no whole-file object at the base key');
  const restoredBlob = await context.window.ShortlinkTransfers.readBlob(restored);
  assert.equal(restoredBlob.size, first.size + second.size);
  assert.equal(await restoredBlob.slice(first.size).text(), await second.text());
  // Exercise the actual transfer reader against the same mocked HTTP bodies.
  // This checks the shared metadata contract, beyond a matching local stub.
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/transfers.js'), 'utf8'), context, { filename: 'transfers.js' });
  const integratedBlob = await context.window.ShortlinkTransfers.readBlob(restored, { config: TARGET });
  assert.equal(integratedBlob.size, restoredBlob.size);
  assert.equal(await integratedBlob.slice(first.size).text(), await second.text());
  await api.importBackup(backup.blob, TARGET, { registry: state.registry });
  assert.equal(state.writes, 1);
  assert.equal(state.uploads.length, 1, 'verified segmented metadata is reused on retry');
});

test('large ordinary source objects migrate into segmented targets and resume without probing a nonexistent base object', async () => {
  const { api, state, source } = harness([record({ files: [{ name: '原始大对象.bin', key: 'original', url: FILE_URL }] })]);
  state.sourceFiles.set(FILE_URL, new Blob([new Uint8Array(PART_BYTES + 19).fill(73)], { type: 'application/octet-stream' }));
  state.failNextUpload = true;
  await assert.rejects(api.migrate(source, TARGET), /interrupted/);
  const report = await api.migrate(source, TARGET);
  assert.equal(report.verified, true);
  assert.equal(state.destinations.get(ID).files[0].segmented, true);
  assert.equal(state.destinations.get(ID).files[0].parts.length, 2);
  assert.equal(state.uploads[1].checkpoint.location, 'same-mock-upload');
  await api.migrate(source, TARGET);
  assert.equal(state.uploads.length, 2);
  assert.equal(state.writes, 1);
});

test('an actual 200 MiB attachment streams to the selected disk writer without an archive Blob', async () => {
  const { api, state, context, source } = harness([record({ files: [{ name: '200MB.bin', url: FILE_URL, key: 'original' }] })]);
  const block = new Uint8Array(1024 * 1024).fill(43);
  state.sourceFiles.set(FILE_URL, new Blob(Array(200).fill(block), { type: 'application/octet-stream' }));
  let bytesWritten = 0, closed = false, aborted = false, pickerCalled = false;
  context.window.showSaveFilePicker = () => {
    pickerCalled = true;
    return Promise.resolve({ createWritable: async () => ({ write: async bytes => { bytesWritten += bytes.byteLength; }, close: async () => { closed = true; }, abort: async () => { aborted = true; } }) });
  };
  const pending = api.exportBackup(source);
  assert.equal(pickerCalled, true, 'picker is invoked during the click before network awaits');
  const report = await pending;
  assert.equal(report.bytes, 209715200);
  assert.equal(report.blob, null);
  assert.equal(report.archiveBytes, bytesWritten);
  assert.equal(closed, true);
  assert.equal(aborted, false);
});

test('cancelling a backup aborts its disk writer instead of reporting a complete archive', async () => {
  const { api, context, source } = harness();
  const controller = new AbortController();
  let aborted = false, closed = false;
  context.window.showSaveFilePicker = async () => ({ createWritable: async () => ({ write: async () => { controller.abort(); }, close: async () => { closed = true; }, abort: async () => { aborted = true; } }) });
  await assert.rejects(api.exportBackup(source, { signal: controller.signal }), error => error.name === 'AbortError');
  assert.equal(aborted, true);
  assert.equal(closed, false);
});
