const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { webcrypto, createHash } = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '../js/transfers.js'), 'utf8');
const MB = 1024 * 1024;
const config = { url: 'https://project.supabase.co', key: 'sb_publishable_test', bucket: 'files' };
function fixture(options = {}) {
  const state = { offset: 0, size: 0, calls: [], patches: [], links: [], lost: false, sessions: new Map(), objects: new Map(), createdBlobs: [], writes: [], closed: false, aborted: false };
  const reply = (status, headers = {}) => new Response(null, { status, headers });
  const fetch = async (url, init) => {
    state.calls.push({ url, ...init });
    if (init.method === 'DELETE') { for (const key of JSON.parse(init.body).prefixes) state.objects.delete(key); return reply(options.deleteStatus || 200); }
    if (init.method === 'POST') {
      state.size = Number(init.headers['Upload-Length']);
      const metadata = Object.fromEntries(init.headers['Upload-Metadata'].split(',').map(pair => { const [key, value] = pair.split(' '); return [key, Buffer.from(value, 'base64').toString()]; }));
      const session = `https://project.storage.supabase.co/storage/v1/upload/resumable/session${state.sessions.size + 1}`;
      state.sessions.set(session, { offset: 0, size: state.size, key: metadata.objectName, chunks: [] });
      return reply(201, { Location: session });
    }
    if (url.includes('/upload/resumable/')) {
      const session = state.sessions.get(url);
      if (!session || session.lost) return reply(404);
      return reply(200, { 'Upload-Offset': session.offset, 'Upload-Length': session.size });
    }
    const key = decodeURIComponent(new URL(url).pathname.split('/public/files/')[1] || '');
    const blob = state.objects.get(key);
    if (!blob) return reply(404);
    return new Response(init.method === 'HEAD' ? null : blob, { status: 200, headers: { 'Content-Length': blob.size } });
  };
  class XHR {
    constructor() { this.upload = {}; }
    open(method, url) { this.method = method; this.url = url; this.headers = {}; }
    setRequestHeader(key, value) { this.headers[key] = value; }
    getResponseHeader(name) { return name === 'Upload-Offset' ? String(state.sessions.get(this.url).offset) : null; }
    abort() { this.onabort?.(); }
    send(body) {
      state.patches.push({ offset: Number(this.headers['Upload-Offset']), size: body.size, type: body.type, headers: this.headers, url: this.url });
      queueMicrotask(() => {
        const session = state.sessions.get(this.url);
        session.chunks.push(body); session.offset += body.size; state.offset = session.offset;
        if (session.offset === session.size) state.objects.set(session.key, new Blob(session.chunks));
        this.upload.onprogress?.({ loaded: body.size, lengthComputable: true });
        if (options.loseFinalResponse && session.offset === session.size && !state.lost) { state.lost = true; session.lost = true; this.onerror(); return; }
        this.status = 204;
        this.onload();
      });
    }
  }
  class TestURL extends URL {
    static createObjectURL(blob) { state.createdBlobs.push(blob); return URL.createObjectURL(blob); }
  }
  const context = vm.createContext({
    Blob, File, URL: TestURL, DOMException, AbortController, TextEncoder, btoa, fetch, crypto: webcrypto,
    XMLHttpRequest: XHR, location: { href: 'https://shortlink.example/' },
    setTimeout: callback => { queueMicrotask(callback); return 1; }, clearTimeout() {},
    navigator: options.navigator || (options.mobile ? { userAgent: 'Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36', userAgentData: { mobile: true }, maxTouchPoints: 5 } : { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36', userAgentData: { mobile: false }, maxTouchPoints: 0 }),
    innerWidth: options.innerWidth || 1280,
    screen: { width: options.screenWidth || options.innerWidth || 1280 },
    matchMedia: query => ({ matches: options.coarsePointer === true && (query === '(pointer: coarse)' || query === '(hover: none)') }),
    document: { body: { appendChild() {} }, createElement() { return { style: {}, click() { state.links.push({ href: this.href, download: this.download }); }, remove() {} }; } },
  });
  if (options.fileWriter) context.showSaveFilePicker = async ({ suggestedName }) => {
    state.suggestedName = suggestedName;
    return { createWritable: async () => ({ write: async blob => { state.writes.push(blob); }, close: async () => { state.closed = true; }, abort: async () => { state.aborted = true; } }) };
  };
  context.window = context;
  vm.runInContext(source, context);
  context.ShortlinkTransfers.configure(config);
  return { api: context.ShortlinkTransfers, state };
}

test('TUS resumes the original file from server offset after a pause', async () => {
  const { api, state } = fixture();
  const file = new File([new Uint8Array(8 * MB)], '长截图透明.png', { type: 'image/png', lastModified: 10 });
  const abort = new AbortController();
  let checkpoint;
  await assert.rejects(api.upload(file, { key: 'ns/abc.png', signal: abort.signal, onCheckpoint(value) { checkpoint = value; if (value.offset === 6 * MB) abort.abort(); } }), { name: 'AbortError' });
  assert.equal(checkpoint.offset, 6 * MB);
  const result = await api.upload(file, { key: 'ns/abc.png', checkpoint });
  assert.equal(result.name, file.name);
  assert.equal(result.type, 'image/png');
  assert.equal(result.size, 8 * MB);
  assert.deepEqual(state.patches.map(p => [p.offset, p.size]), [[0, 6 * MB], [6 * MB, 2 * MB]]);
  assert.equal(state.calls.filter(c => c.method === 'POST').length, 1);
  assert.ok(state.calls.some(c => c.method === 'HEAD'));
});

test('lost final response is recovered without sending the original again', async () => {
  const { api, state } = fixture({ loseFinalResponse: true });
  const result = await api.upload(new File(['original bytes'], '原文.txt'), { key: 'ns/original.txt' });
  assert.equal(result.size, 14);
  assert.equal(state.patches.length, 1);
  assert.equal(state.calls.filter(c => c.method === 'POST').length, 1);
  assert.ok(state.calls.some(c => c.method === 'HEAD' && c.url.includes('/object/public/')));
});

test('foreign upload checkpoint never receives the configured API key', async () => {
  const { api, state } = fixture();
  const file = new File(['abc'], 'abc.txt', { lastModified: 2 });
  await api.upload(file, { key: 'ns/a.txt', checkpoint: { configUrl: config.url, bucket: 'files', key: 'ns/a.txt', fingerprint: JSON.stringify([file.name, file.size, file.type, file.lastModified]), sessionUrl: 'https://other.example/storage/v1/upload/resumable/steal' } });
  assert.ok(state.calls.every(call => !call.url.includes('other.example')));
  assert.equal(state.calls.filter(c => c.method === 'POST').length, 1);
  assert.equal(state.calls[0].headers.Authorization, undefined);
});

test('checkpoint persistence failure stops before bytes are uploaded', async () => {
  const { api, state } = fixture();
  await assert.rejects(api.upload(new File(['abc'], 'a'), { key: 'ns/a', onCheckpoint() { throw new Error('Disk full'); } }), /Disk full/);
  assert.equal(state.patches.length, 0);
});

test('200 MiB boundary is inclusive, oversized files issue no request', async () => {
  const { api, state } = fixture();
  class LargeFile extends Blob {
    constructor(size) { super([]); this.logicalSize = size; this.name = '200 MB.bin'; }
    get size() { return this.logicalSize; }
    slice(start, end) { return new Blob([new Uint8Array(end - start)]); }
  }
  await assert.rejects(api.upload(new LargeFile(200 * MB + 1), { key: 'ns/oversized' }), /200 MB/);
  assert.equal(state.calls.length, 0);
  const result = await api.upload(new LargeFile(200 * MB), { key: 'ns/exact' });
  assert.equal(result.size, 200 * MB);
  assert.equal(result.segmented, true);
  assert.equal(result.parts.length, 7);
  assert.equal(result.url, '');
  assert.equal(state.patches.length, 38);
  assert.equal(state.patches.at(-1).size, 2 * MB);
  assert.ok(state.calls.filter(call => call.method === 'POST').every(call => Number(call.headers['Upload-Length']) <= 32 * MB));
});

test('empty files complete on creation', async () => {
  const { api, state } = fixture();
  const result = await api.upload(new File([], '空文件.txt'), { key: 'ns/empty' });
  assert.equal(result.size, 0);
  assert.equal(state.patches.length, 0);
});

test('storage deletion failures reach caller for reliable cleanup retries', async () => {
  const { api } = fixture({ deleteStatus: 403 });
  await assert.rejects(api.deleteObject('ns/old.png'), error => error.status === 403);
});

test('large Supabase downloads use server filename and browser streaming, with no fetch', async () => {
  const { api, state } = fixture();
  let status;
  const result = await api.download({ name: '中文 长文件.zip', url: `${config.url}/storage/v1/object/public/files/ns/hash.zip`, size: 200 * MB }, { onStatus(value) { status = value; } });
  assert.equal(result.delegated, true);
  assert.equal(state.calls.length, 0);
  assert.equal(state.links.length, 1);
  assert.equal(new URL(state.links[0].href).searchParams.get('download'), '中文 长文件.zip');
  assert.equal(status.phase, 'delegated');
});

test('large upload pauses inside a part and resumes without repeating completed parts', async () => {
  const { api, state } = fixture();
  const file = new File([new Uint8Array(39 * MB).fill(17)], '中文大附件.bin', { type: 'application/octet-stream', lastModified: 42 });
  const controller = new AbortController();
  let checkpoint;
  await assert.rejects(api.upload(file, { key: 'ns/segmented', signal: controller.signal, onCheckpoint(value) {
    checkpoint = structuredClone(value);
    if (value.current?.index === 1 && value.current.checkpoint.offset === 6 * MB) controller.abort();
  } }), { name: 'AbortError' });
  assert.equal(checkpoint.mode, 'segmented');
  assert.equal(checkpoint.parts.length, 1);
  assert.equal(checkpoint.current.index, 1);
  assert.equal(checkpoint.offset, 38 * MB);
  const createdSessions = state.sessions.size;
  const result = await api.upload(file, { key: 'ns/segmented', checkpoint });
  assert.equal(state.sessions.size, createdSessions);
  assert.equal(result.parts.length, 2);
  assert.equal(state.patches.reduce((sum, part) => sum + part.size, 0), 39 * MB);
  const blob = await api.readBlob(result);
  assert.equal(blob.size, file.size);
  assert.equal(blob.type, file.type);
  assert.equal(createHash('sha256').update(Buffer.from(await blob.arrayBuffer())).digest('hex'), createHash('sha256').update(Buffer.from(await file.arrayBuffer())).digest('hex'));
});

test('32 MiB uploads remain single storage objects', async () => {
  const { api, state } = fixture();
  const result = await api.upload(new File([new Uint8Array(32 * MB)], '边界.bin'), { key: 'ns/small' });
  assert.equal(result.segmented, undefined);
  assert.equal(state.sessions.size, 1);
  assert.ok(result.url.endsWith('/ns/small'));
});

function installManifest(state, size = 33 * MB) {
  const parts = [];
  for (let start = 0, index = 0; start < size; start += 32 * MB, index++) {
    const bytes = new Uint8Array(Math.min(32 * MB, size - start)).fill(index + 7);
    const key = `ns/download.part-${String(index).padStart(4, '0')}`;
    const blob = new Blob([bytes]);
    state.objects.set(key, blob);
    parts.push({ key, url: `${config.url}/storage/v1/object/public/files/${key}`, size: bytes.byteLength, type: 'application/octet-stream', sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return { key: 'ns/download', name: '中文分片文件.zip', size, type: 'application/zip', url: '', segmented: true, parts };
}

test('segmented download writes verified pieces sequentially to a named file', async () => {
  const { api, state } = fixture({ fileWriter: true });
  const file = installManifest(state);
  const statuses = [];
  const result = await api.download(file, { onStatus: value => statuses.push(value) });
  assert.equal(result.segmented, true);
  assert.equal(state.suggestedName, file.name);
  assert.equal(state.writes.length, 2);
  assert.equal(state.writes.reduce((sum, blob) => sum + blob.size, 0), file.size);
  assert.equal(state.closed, true);
  assert.equal(state.createdBlobs.length, 0);
  assert.equal(statuses.at(-1).phase, 'complete');
});

test('segmented download fallback creates a single Chinese-named original Blob', async () => {
  const { api, state } = fixture();
  const file = installManifest(state);
  await api.download(file);
  assert.equal(state.createdBlobs.length, 1);
  assert.equal(state.createdBlobs[0].size, file.size);
  assert.equal(state.createdBlobs[0].type, 'application/zip');
  assert.equal(state.links[0].download, file.name);
});

test('mobile segmented downloads skip the save picker and use the browser download manager', async () => {
  const { api, state } = fixture({
    fileWriter: true,
    navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36' },
  });
  const file = installManifest(state, 5);
  file.name = '手机原图.png';
  file.type = 'image/png';
  await api.download(file);
  assert.equal(state.suggestedName, undefined);
  assert.equal(state.writes.length, 0);
  assert.equal(state.links.length, 1);
  assert.equal(state.links[0].download, file.name);
});

test('desktop-site touch devices skip the save picker too', async () => {
  const { api, state } = fixture({
    fileWriter: true,
    innerWidth: 412,
    navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36', maxTouchPoints: 5 },
    coarsePointer: true,
  });
  const file = installManifest(state, 5);
  file.name = '桌面版网站手机原图.png';
  file.type = 'image/png';
  await api.download(file);
  assert.equal(state.suggestedName, undefined);
  assert.equal(state.writes.length, 0);
  assert.equal(state.links.length, 1);
  assert.equal(state.links[0].download, file.name);
});

test('app downloads can force the browser manager even when a save picker exists', async () => {
  const { api, state } = fixture({ fileWriter: true });
  const file = installManifest(state, 5);
  file.name = '强制浏览器下载.apk';
  await api.download(file, { useSavePicker: false });
  assert.equal(state.suggestedName, undefined);
  assert.equal(state.writes.length, 0);
  assert.equal(state.links[0].download, file.name);
});

test('corrupted or missing download parts stop reconstruction and abort partial disk file', async () => {
  const { api, state } = fixture({ fileWriter: true });
  const file = installManifest(state);
  state.objects.set(file.parts[1].key, new Blob([new Uint8Array(file.parts[1].size).fill(123)]));
  await assert.rejects(api.download(file), /校验失败/);
  assert.equal(state.aborted, true);
  assert.equal(state.closed, false);
  assert.equal(state.writes.length, 1);
  state.objects.delete(file.parts[0].key);
  await assert.rejects(api.readBlob(file), error => error.status === 404);
});

test('segmented download cancellation aborts writer and skips remaining parts', async () => {
  const { api, state } = fixture({ fileWriter: true });
  const file = installManifest(state);
  const controller = new AbortController();
  await assert.rejects(api.download(file, { signal: controller.signal, onStatus(value) { if (value.loaded > 0) controller.abort(); } }), { name: 'AbortError' });
  assert.equal(state.aborted, true);
  assert.equal(state.closed, false);
  assert.ok(!state.calls.some(call => call.url.endsWith('part-0001')));
});

test('discard cleans deterministic keys for every uploaded or incomplete segment', async () => {
  const { api, state } = fixture();
  await api.deleteUpload({ key: 'ns/incomplete', file: { size: 70 * MB }, checkpoint: { mode: 'segmented', size: 70 * MB, parts: [{ key: 'ns/incomplete.part-0000' }], current: { index: 1, checkpoint: { offset: 6 * MB } } } });
  const deleted = state.calls.filter(call => call.method === 'DELETE').flatMap(call => JSON.parse(call.body).prefixes).sort();
  assert.deepEqual(deleted, ['ns/incomplete', 'ns/incomplete.part-0000', 'ns/incomplete.part-0001', 'ns/incomplete.part-0002']);
});

test('manifest rejects mismatched size, duplicate keys, and missing checksum before downloading', async () => {
  const { api, state } = fixture();
  const file = installManifest(state);
  await assert.rejects(api.readBlob({ ...file, size: file.size - 1 }), /信息|大小/);
  await assert.rejects(api.readBlob({ ...file, parts: [file.parts[0], { ...file.parts[1], key: file.parts[0].key }] }), /信息/);
  await assert.rejects(api.readBlob({ ...file, parts: [file.parts[0], { ...file.parts[1], sha256: undefined }] }), /信息/);
  assert.equal(state.calls.length, 0);
});
