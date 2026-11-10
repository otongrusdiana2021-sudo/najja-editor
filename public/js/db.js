// IndexedDB persistence: media blobs + projects. Every call fails soft (private mode, blocked storage...).
const DB_NAME = 'najja-editor';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('media')) db.createObjectStore('media', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      const req = fn(s);
      t.oncomplete = () => resolve(req?.result);
      t.onerror = () => resolve(undefined);
      t.onabort = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

export const db = {
  putMedia: (rec) => tx('media', 'readwrite', (s) => s.put(rec)),
  getMedia: (id) => tx('media', 'readonly', (s) => s.get(id)),
  deleteMedia: (id) => tx('media', 'readwrite', (s) => s.delete(id)),
  putProject: (p) => tx('projects', 'readwrite', (s) => s.put(p)),
  getProject: (id) => tx('projects', 'readonly', (s) => s.get(id)),
  deleteProject: (id) => tx('projects', 'readwrite', (s) => s.delete(id)),
  listProjects: async () => (await tx('projects', 'readonly', (s) => s.getAll())) || [],
};

export const prefs = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(`najja:${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(`najja:${key}`, JSON.stringify(value)); } catch { /* ignore */ }
  },
};
