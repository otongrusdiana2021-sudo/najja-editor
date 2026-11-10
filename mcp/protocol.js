// Minimal, dependency-free MCP (Model Context Protocol) JSON-RPC handler.
// Shared by the Streamable HTTP endpoint (server.js) and the stdio entry (mcp-stdio.js).
import { TOOLS } from './tools.js';

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export const INSTRUCTIONS = `Najja Editor is a CapCut-style, browser-based video editor. These tools drive the editor tab that is open in the user's browser, and every change shows up there live.

Workflow tips:
- Call get_project first to see the canvas size, tracks, clip ids and media ids. Call it again after edits to confirm timing.
- Bring in footage with import_media (an http(s) URL or an absolute local file path). It returns a media_id for add_media_clip.
- The "main" track is magnetic: clips are packed back to back with no gaps. Put titles, stickers and overlays on their own tracks; the add_* tools pick a track for you.
- Times are in seconds. Positions x/y are fractions of the canvas measured from its center (x -0.5..0.5, y -0.5..0.5, positive y is down). Font sizes are canvas pixels on a canvas whose short side is 1080.
- Call list_assets to get the exact ids of filters, effects, transitions, animations, text presets, templates and fonts.
- Check your result with get_frame, which returns an image of the preview at any time.
- export_video renders in real time inside the browser and returns immediately. Poll get_export_status until it is done; the file is saved on the server.`;

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message, data) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } });

/** Convert the editor's tool payload ({data, text, image, isError}) into an MCP CallToolResult. */
export function formatToolResult(payload) {
  if (payload && Array.isArray(payload.content)) return payload; // already formatted
  const content = [];
  if (payload?.text) content.push({ type: 'text', text: String(payload.text) });
  if (payload?.data !== undefined) {
    content.push({ type: 'text', text: typeof payload.data === 'string' ? payload.data : JSON.stringify(payload.data, null, 2) });
  }
  if (payload?.image?.data) content.push({ type: 'image', data: payload.image.data, mimeType: payload.image.mimeType || 'image/png' });
  if (!content.length) content.push({ type: 'text', text: 'OK' });
  return { content, isError: !!payload?.isError };
}

export function createMcpHandler({ name, version, callTool, onInitialize }) {
  return async function handle(msg) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
      return fail(msg?.id ?? null, -32600, 'Invalid Request');
    }
    // Responses from the client (we never send requests) are ignored.
    if (typeof msg.method !== 'string') return null;
    const isNotification = msg.id === undefined || msg.id === null;
    const params = msg.params || {};

    switch (msg.method) {
      case 'initialize': {
        const requested = params.protocolVersion;
        const protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
        try { onInitialize?.(params.clientInfo || {}, protocolVersion); } catch { /* ignore */ }
        return ok(msg.id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name, title: 'Najja Editor', version },
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return isNotification ? null : ok(msg.id, {});
      case 'tools/list':
        return ok(msg.id, { tools: TOOLS });
      case 'tools/call': {
        const toolName = params.name;
        const tool = TOOLS.find((t) => t.name === toolName);
        if (!tool) return fail(msg.id, -32602, `Unknown tool: ${toolName}`);
        try {
          const result = await callTool(toolName, params.arguments || {});
          return ok(msg.id, formatToolResult(result));
        } catch (err) {
          return ok(msg.id, { content: [{ type: 'text', text: `Error: ${err?.message || err}` }], isError: true });
        }
      }
      case 'resources/list':
        return ok(msg.id, { resources: [] });
      case 'resources/templates/list':
        return ok(msg.id, { resourceTemplates: [] });
      case 'prompts/list':
        return ok(msg.id, { prompts: [] });
      default:
        if (isNotification) return null; // notifications/initialized, notifications/cancelled, ...
        return fail(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  };
}
