/* Durable editor drafts, including File/Blob objects and upload checkpoints. */
(function (global) {
  'use strict';
  const DB_NAME = 'shortlink-drafts';
  const STORE = 'drafts';
  let opening;
  let queue = Promise.resolve();

  function failure(error) {
    const quota = error?.name === 'QuotaExceededError';
    const message = quota
      ? '本机存储空间不足，草稿尚未保存。请保留页面并清理空间，或减少待上传文件。'
      : '草稿保存遇到问题，请保留页面并检查浏览器存储权限。';
    const result = new Error(message, { cause: error });
    result.name = quota ? 'QuotaExceededError' : 'DraftStorageError';
    return result;
  }

  function open() {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      if (!global.indexedDB) { reject(failure(new Error('IndexedDB unavailable'))); return; }
      const request = global.indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) {
          request.result.createObjectStore(STORE, { keyPath: 'key' });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); opening = null; };
        resolve(db);
      };
      request.onerror = () => { opening = null; reject(failure(request.error)); };
      request.onblocked = () => { opening = null; reject(failure(new Error('Close older tabs to update draft storage'))); };
    });
    return opening;
  }

  // Reads join the same queue as writes, so navigation never restores a stale draft.
  function serial(task) {
    const pending = queue.then(task);
    queue = pending.catch(() => {});
    return pending;
  }

  async function transaction(mode, operation) {
    const db = await open();
    return new Promise((resolve, reject) => {
      let tx;
      try {
        try { tx = db.transaction(STORE, mode, { durability: 'strict' }); }
        catch (error) {
          if (error instanceof TypeError) tx = db.transaction(STORE, mode);
          else throw error;
        }
        const request = operation(tx.objectStore(STORE));
        // Resolve only on transaction completion, after the browser commits blobs.
        tx.oncomplete = () => resolve(request.result);
        tx.onabort = () => reject(failure(tx.error || request.error));
        tx.onerror = () => {}; // onabort reports the final failure exactly once.
      } catch (error) {
        if (tx) { try { tx.abort(); } catch {} }
        reject(failure(error));
      }
    });
  }

  function assertKey(key) {
    if (typeof key !== 'string' || !key) throw new TypeError('Draft key must be a non-empty string');
    return key;
  }

  global.ShortlinkDrafts = Object.freeze({
    async get(key) {
      assertKey(key);
      const record = await serial(() => transaction('readonly', store => store.get(key)));
      return record ? record.value : null;
    },
    put(key, value) {
      assertKey(key);
      // Snapshot at invocation, before earlier queued writes finish. Otherwise a
      // later edit to a shared array could silently change this save's content.
      let snapshot;
      try { snapshot = global.structuredClone(value); }
      catch (error) { return Promise.reject(failure(error)); }
      return serial(() => transaction('readwrite', store => store.put({ key, value: snapshot, updatedAt: Date.now() })));
    },
    remove(key) {
      assertKey(key);
      return serial(() => transaction('readwrite', store => store.delete(key)));
    },
    async list(prefix = '') {
      const rows = await serial(() => transaction('readonly', store => store.getAll()));
      return rows.filter(row => row.key.startsWith(prefix)).sort((a, b) => b.updatedAt - a.updatedAt);
    },
    flush() { return queue; },
    async requestPersistence() {
      // An optional browser preference; denied requests leave ordinary drafts working.
      return global.navigator?.storage?.persist ? global.navigator.storage.persist() : false;
    },
  });
})(window);
