#!/usr/bin/env node
// Najja Editor — MCP server over stdio (for Claude Desktop, Cursor, etc.).
// If the Najja web server is not running yet, it is started in this process automatically,
// and the editor is opened in your browser the first time a tool needs it.
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpHandler } from './mcp/protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
const PORT = Number(process.env.PORT || process.env.NAJJA_PORT || 3333);
const REMOTE = !!process.env.NAJJA_URL; // explicit server (e.g. a VPS): never start a local one
const BASE = (process.env.NAJJA_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const AUTH = process.env.NAJJA_TOKEN ? { authorization: `Bearer ${process.env.NAJJA_TOKEN}` } : {};
const log = (...a) => console.error('[najja-mcp]', ...a);

let local = null; // in-process server, when we had to start one
let clientInfo = null;
let protocolVersion = null;

async function remoteAlive() {
  try {
    const r = await fetch(`${BASE}/api/status`, { headers: AUTH, signal: AbortSignal.timeout(REMOTE ? 8000 : 1500) });
    if (r.status === 401) throw new Error(`Najja server at ${BASE} rejected the token. Set NAJJA_TOKEN to the server's token.`);
    return r.ok;
  } catch (err) {
    if (/rejected the token/.test(err.message)) throw err;
    return false;
  }
}

async function ensureServer() {
  if (local) return;
  if (await remoteAlive()) return;
  if (REMOTE) throw new Error(`Cannot reach the Najja server at ${BASE}. Check NAJJA_URL and that the server is running.`);
  const { createNajjaServer } = await import('./server.js');
  const app = createNajjaServer({ port: PORT });
  try {
    await app.listen();
    local = app;
    if (clientInfo) local.bridge.noteMcpClient(clientInfo, protocolVersion, 'stdio');
    log(`Najja server started at ${app.publicUrl}`);
  } catch (err) {
    if (err.code === 'EADDRINUSE' && (await remoteAlive())) return; // raced with another instance
    throw err;
  }
}

async function callTool(name, args) {
  await ensureServer();
  if (local) return local.callTool(name, args);
  const r = await fetch(`${BASE}/api/tool`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...AUTH },
    body: JSON.stringify({ name, arguments: args }),
  });
  if (!r.ok) throw new Error(`Najja server error: HTTP ${r.status}`);
  return r.json();
}

const handle = createMcpHandler({
  name: 'najja-editor',
  version: PKG.version,
  callTool,
  onInitialize: (info, v) => {
    clientInfo = info;
    protocolVersion = v;
    // Start (or find) the web server early so the editor is ready by the first tool call.
    ensureServer()
      .then(() => {
        if (local) local.bridge.noteMcpClient(info, v, 'stdio');
        else fetch(`${BASE}/api/tool`, { method: 'POST', headers: { 'content-type': 'application/json', ...AUTH }, body: JSON.stringify({ clientInfo: info, protocolVersion: v }) }).catch(() => {});
      })
      .catch((e) => log('could not start the web server:', e.message));
  },
});

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const write = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const messages = Array.isArray(msg) ? msg : [msg];
  const out = (await Promise.all(messages.map((m) => handle(m)))).filter(Boolean);
  if (!out.length) return;
  write(Array.isArray(msg) ? out : out[0]);
});

rl.on('close', async () => {
  if (local) await local.close().catch(() => {});
  process.exit(0);
});

log(`ready (stdio). Editor: ${BASE}`);
