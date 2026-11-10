// Browser side of the MCP bridge: receives tool calls from the Najja server (SSE) and returns results.
const listeners = new Set();
const clientId = (() => {
  try {
    let id = sessionStorage.getItem('najja:client');
    if (!id) { id = `ed_${Math.random().toString(36).slice(2, 10)}`; sessionStorage.setItem('najja:client', id); }
    return id;
  } catch {
    return `ed_${Math.random().toString(36).slice(2, 10)}`;
  }
})();

export const bridge = {
  state: { available: null, connected: false, status: null, clients: [], log: [], activeAt: 0 },
  handlers: null,
  on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  emit() { for (const fn of listeners) { try { fn(this.state); } catch (e) { console.error(e); } } },

  async start(handlers) {
    this.handlers = handlers;
    if (location.protocol === 'file:') { this.state.available = false; this.emit(); return; }
    try {
      const r = await fetch('/api/status', { cache: 'no-store' });
      if (!r.ok) throw new Error('no server');
      this.state.status = await r.json();
      this.state.clients = this.state.status.mcpClients || [];
      this.state.available = true;
    } catch {
      this.state.available = false;
      this.emit();
      return;
    }
    this.connect();
    const focus = () => fetch('/bridge/focus', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client: clientId }) }).catch(() => {});
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) focus(); });
  },

  connect() {
    const es = new EventSource(`/bridge/events?client=${encodeURIComponent(clientId)}`);
    es.addEventListener('hello', (e) => {
      const d = JSON.parse(e.data);
      this.state.connected = true;
      if (d.mcpClients) this.state.clients = d.mcpClients;
      this.emit();
    });
    es.addEventListener('mcp-client', (e) => {
      const c = JSON.parse(e.data);
      this.state.clients = [c, ...this.state.clients.filter((x) => !(x.name === c.name && x.transport === c.transport))];
      this.handlers?.onClient?.(c);
      this.emit();
    });
    es.addEventListener('command', (e) => this.run(JSON.parse(e.data)));
    es.onerror = () => {
      if (this.state.connected) { this.state.connected = false; this.emit(); }
    };
    es.onopen = () => { this.state.connected = true; this.emit(); };
    this.es = es;
  },

  async run(cmd) {
    const entry = { id: cmd.id, tool: cmd.tool, state: 'run', at: Date.now(), ms: 0 };
    this.state.log.unshift(entry);
    if (this.state.log.length > 200) this.state.log.length = 200;
    this.state.activeAt = Date.now();
    this.emit();
    const t0 = performance.now();
    let body;
    try {
      const fn = this.handlers?.tools?.[cmd.tool];
      if (!fn) throw new Error(`Tool not supported by this editor version: ${cmd.tool}`);
      const result = await fn(cmd.args || {});
      entry.state = 'ok';
      body = { id: cmd.id, result };
      this.handlers?.onDone?.(cmd.tool, cmd.args, result);
    } catch (err) {
      entry.state = 'error';
      entry.error = err?.message || String(err);
      body = { id: cmd.id, error: entry.error };
    }
    entry.ms = Math.round(performance.now() - t0);
    this.emit();
    try {
      await fetch('/bridge/result', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch { /* server gone */ }
  },
};
