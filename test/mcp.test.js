// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpHandler, formatToolResult } from '../mcp/protocol.js';
import { TOOLS } from '../mcp/tools.js';

process.env.NAJJA_NO_OPEN = '1';
process.env.NAJJA_EDITOR_WAIT_MS = '200';
const { createNajjaServer } = await import('../server.js');

test('tool definitions are well-formed', () => {
  const names = new Set();
  for (const t of TOOLS) {
    assert.match(t.name, /^[a-z_]+$/);
    assert.ok(!names.has(t.name), `duplicate tool ${t.name}`);
    names.add(t.name);
    assert.ok(t.description.length > 20, `${t.name} needs a description`);
    assert.equal(t.inputSchema.type, 'object');
    for (const r of t.inputSchema.required || []) assert.ok(r in t.inputSchema.properties, `${t.name}: required ${r} missing`);
  }
  assert.ok(TOOLS.length >= 20);
});

test('protocol: initialize, list, call, errors', async () => {
  const handle = createMcpHandler({ name: 'najja-editor', version: '1.0.0', callTool: async (n) => ({ data: { tool: n } }) });
  const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 't' } } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.ok(init.result.capabilities.tools);
  const future = await handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } });
  assert.equal(future.result.protocolVersion, '2025-11-25');
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const list = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  assert.equal(list.result.tools.length, TOOLS.length);
  const call = await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_project', arguments: {} } });
  assert.equal(JSON.parse(call.result.content[0].text).tool, 'get_project');
  const unknown = await handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope' } });
  assert.equal(unknown.error.code, -32602);
  const missing = await handle({ jsonrpc: '2.0', id: 6, method: 'does/not/exist' });
  assert.equal(missing.error.code, -32601);
});

test('formatToolResult converts images and errors', () => {
  const r = formatToolResult({ data: { a: 1 }, image: { data: 'AAAA', mimeType: 'image/png' } });
  assert.equal(r.content.length, 2);
  assert.equal(r.content[1].type, 'image');
  assert.equal(formatToolResult({ isError: true, text: 'x' }).isError, true);
});

test('HTTP server: status, MCP endpoint, origin check, no-editor error', async () => {
  const port = 39000 + Math.floor(Math.random() * 500);
  const app = createNajjaServer({ port, host: '127.0.0.1' });
  await app.listen();
  try {
    const base = `http://127.0.0.1:${port}`;
    const status = await (await fetch(`${base}/api/status`)).json();
    assert.equal(status.name, 'najja-editor');
    const rpc = (body, headers = {}) => fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) });
    const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'test' } } });
    assert.equal(init.status, 200);
    assert.ok(init.headers.get('mcp-session-id'));
    const note = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(note.status, 202);
    const evil = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { origin: 'https://evil.example' });
    assert.equal(evil.status, 403);
    const call = await (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_project', arguments: {} } })).json();
    assert.equal(call.result.isError, true);
    assert.match(call.result.content[0].text, /not open in a browser/);
    const index = await fetch(`${base}/`);
    assert.match(await index.text(), /Najja Editor/);
  } finally {
    await app.close();
  }
});
