// Storage facade: projects live on the Najja server (VPS) when it is available,
// otherwise in this browser (IndexedDB) — e.g. when the page is opened without the server.
import { db } from './db.js';
import { remote } from './remote.js';

export const storage = {
  mode: 'browser',
  status: null,

  async init() {
    if (location.protocol === 'file:') return this.mode;
    try {
      const r = await fetch('/api/status', { cache: 'no-store', credentials: 'same-origin' });
      if (r.ok) {
        this.status = await r.json();
        if (this.status.storage === 'server') { this.mode = 'server'; remote.enabled = true; }
      }
    } catch { /* offline / static hosting */ }
    return this.mode;
  },
  get server() { return this.mode === 'server'; },

  listProjects() { return this.server ? remote.listProjects() : db.listProjects(); },
  getProject(id) { return this.server ? remote.getProject(id).catch(() => null) : db.getProject(id); },
  putProject(rec) { return this.server ? remote.putProject(rec) : db.putProject(rec); },
  deleteProject(id) { return this.server ? remote.deleteProject(id) : db.deleteProject(id); },
};
