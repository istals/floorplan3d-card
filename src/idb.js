// Tiny IndexedDB wrapper for the card's local caches (model blobs). Every call resolves
// (null / [] / false) instead of throwing: private windows, blocked storage or no IndexedDB at all.
const DB = 'floorplan3d';
const STORES = ['snapshots', 'models'];
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') { resolve(null); return; }
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s, { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch (e) {
      resolve(null);
    }
  });
  return dbPromise;
}

async function run(store, mode, fn, fallback) {
  const db = await open();
  if (!db) return fallback;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req ? req.result ?? fallback : true);
      tx.onerror = () => resolve(fallback);
      tx.onabort = () => resolve(fallback);
    } catch (e) {
      resolve(fallback);
    }
  });
}

export const idbGet = (store, key) => run(store, 'readonly', (s) => s.get(key), null);
export const idbAll = (store) => run(store, 'readonly', (s) => s.getAll(), []);
export const idbPut = (store, value) => run(store, 'readwrite', (s) => { s.put(value); return null; }, false);
export const idbDelete = (store, keys) => run(store, 'readwrite', (s) => { for (const k of keys) s.delete(k); return null; }, false);
