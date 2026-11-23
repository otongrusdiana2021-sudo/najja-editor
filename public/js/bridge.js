// Browser side of the MCP bridge: receives tool calls from the Najja server (SSE) and returns results.
import { createQueue, PURE_READS } from './cmdqueue.js';

const listeners = new Set();
// (v1.13.2) Tools run one at a time in this tab (AI commands and pasted JSON alike); pure reads skip the line.
const queue = createQueue();
// Allowance for the trip from the server to this tab: a command is dropped a little before the server gives up on it.
const DEADLINE_SLACK_MS = 250;
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

  /**
   * (v1.12.3) Run a tool here, without an AI client: commands pasted as JSON in the AI · MCP panel. Logged like the
   * AI's own commands; returns the result or throws.
   */
  async runLocal(tool, args = {}) {
    const entry = { id: `local_${Date.now()}`, tool, state: 'wait', at: Date.now(), ms: 0, local: true };
    this.state.log.unshift(entry);
    if (this.state.log.length > 200) this.state.log.length = 200;
    this.emit();
    let t0 = performance.now();
    try {
      const fn = this.handlers?.tools?.[tool];
      if (!fn) throw new Error(`Tool "${tool}" tidak ada di editor ini`);
      const result = await this.schedule(tool, () => fn(args), () => { t0 = performance.now(); entry.state = 'run'; this.emit(); });
      entry.state = 'ok';
      this.handlers?.onDone?.(tool, args, result);
      return result;
    } catch (err) {
      entry.state = 'error';
      entry.error = err?.message || String(err);
      throw err;
    } finally {
      entry.ms = Math.round(performance.now() - t0);
      this.emit();
    }
  },
  /** The tool names this editor runs. */
  toolNames() { return Object.keys(this.handlers?.tools || {}); },

  /**
   * (v1.13.2) Run a tool in turn: after the tools before it have finished, unless it only reads (PURE_READS).
   * onStart runs when the tool really starts. deadline: a Date.now() time after which a waiting tool is dropped.
   * handlers.blocked(tool) (P0-2) is asked when the tool's turn comes: a reason refuses it (an export started while
   * it waited, say) with code 'BUSY'; the editor is not changed.
   */
  schedule(tool, task, onStart, deadline = null) {
    if (PURE_READS.has(tool)) { onStart?.(); return task(); }
    return queue.run(() => {
      const why = this.handlers?.blocked?.(tool);
      if (why) throw Object.assign(new Error(why), { code: 'BUSY' });
      return task();
    }, { deadline, onStart });
  },

  async run(cmd) {
    const entry = { id: cmd.id, tool: cmd.tool, state: 'wait', at: Date.now(), ms: 0 };
    this.state.log.unshift(entry);
    if (this.state.log.length > 200) this.state.log.length = 200;
    this.state.activeAt = Date.now();
    this.emit();
    // The server stops waiting after timeout_ms (sent since v1.13.2): a command still in the queue by then is not run.
    const deadline = cmd.timeout_ms > 0 ? Date.now() + cmd.timeout_ms - DEADLINE_SLACK_MS : null;
    let t0 = performance.now();
    let body;
    try {
      const fn = this.handlers?.tools?.[cmd.tool];
      if (!fn) throw new Error(`Tool not supported by this editor version: ${cmd.tool}`);
      const result = await this.schedule(cmd.tool, () => fn(cmd.args || {}), () => { t0 = performance.now(); entry.state = 'run'; this.emit(); }, deadline);
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
