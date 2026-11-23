// (P0-3) The MCP contract: what AI clients rely on when they call Najja Editor's tools and prompts by name.
// The v1 snapshot (test/fixtures/mcp-contract-v1.json) may only grow: a tool or prompt may be added, a parameter
// may be added when optional, a range or a list of values may get wider. Anything else breaks clients (and prompts
// people saved) that worked yesterday, so test/mcp-contract.test.js fails on it.
//
// Descriptions and titles are not part of the contract: they can be reworded freely.
//
// After adding tools or parameters, update the snapshot with:  node test/mcp-contract.mjs --update
// The update refuses to write a snapshot that breaks the current one.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpHandler } from '../mcp/protocol.js';

export const SNAPSHOT = fileURLToPath(new URL('./fixtures/mcp-contract-v1.json', import.meta.url));

const LOWER = ['minimum', 'exclusiveMinimum', 'minItems', 'minLength'];
const UPPER = ['maximum', 'exclusiveMaximum', 'maxItems', 'maxLength'];
const COMBINE = ['anyOf', 'oneOf', 'allOf'];

/** The parts of a JSON schema a client depends on (no descriptions). */
export function shape(s) {
  if (!s || typeof s !== 'object') return s;
  const o = {};
  if (s.type !== undefined) o.type = s.type;
  if (s.enum) o.enum = [...s.enum];
  for (const k of [...LOWER, ...UPPER]) if (s[k] !== undefined) o[k] = s[k];
  if (s.properties) o.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, shape(v)]));
  if (s.required?.length) o.required = [...s.required];
  if (s.additionalProperties !== undefined) o.additionalProperties = shape(s.additionalProperties);
  if (s.items) o.items = shape(s.items);
  for (const k of COMBINE) if (s[k]) o[k] = s[k].map(shape);
  return o;
}

/** The contract as MCP clients see it: tools/list and prompts/list of the real protocol handler. */
export async function currentContract() {
  const handle = createMcpHandler({ name: 'najja-editor', version: 'contract', callTool: async () => ({}) });
  const tools = (await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools;
  const prompts = (await handle({ jsonrpc: '2.0', id: 2, method: 'prompts/list' })).result.prompts;
  return contractOf(tools, prompts);
}

export function contractOf(tools, prompts) {
  return {
    tools: Object.fromEntries(tools.map((t) => [t.name, {
      readOnly: !!t.annotations?.readOnlyHint,
      destructive: !!t.annotations?.destructiveHint,
      input: shape(t.inputSchema),
    }])),
    prompts: Object.fromEntries(prompts.map((p) => [p.name, {
      arguments: Object.fromEntries((p.arguments || []).map((a) => [a.name, { required: !!a.required }])),
    }])),
  };
}

const sameType = (a, b) => JSON.stringify(a) === JSON.stringify(b) || (a === 'integer' && b === 'number');

function compareSchema(a, b, where, out) {
  if (b === undefined) { out.push(`${where}: removed`); return; }
  if (a.type !== undefined && !sameType(a.type, b.type)) out.push(`${where}: type ${JSON.stringify(a.type)} became ${JSON.stringify(b.type)}`);
  if (b.enum) {
    if (!a.enum) out.push(`${where}: now only accepts ${b.enum.join(', ')}`);
    else {
      const gone = a.enum.filter((v) => !b.enum.includes(v));
      if (gone.length) out.push(`${where}: no longer accepts ${gone.join(', ')}`);
    }
  }
  for (const k of LOWER) if (b[k] !== undefined && (a[k] === undefined || b[k] > a[k])) out.push(`${where}: ${k} ${a[k] ?? 'none'} became ${b[k]}`);
  for (const k of UPPER) if (b[k] !== undefined && (a[k] === undefined || b[k] < a[k])) out.push(`${where}: ${k} ${a[k] ?? 'none'} became ${b[k]}`);
  const wasRequired = new Set(a.required || []);
  for (const r of b.required || []) if (!wasRequired.has(r)) out.push(`${where}: "${r}" is now required`);
  for (const [k, v] of Object.entries(a.properties || {})) compareSchema(v, b.properties?.[k], `${where}.${k}`, out);
  if (a.additionalProperties !== false && b.additionalProperties === false) out.push(`${where}: no longer accepts other fields`);
  if (a.items) compareSchema(a.items, b.items, `${where}[]`, out);
  for (const k of COMBINE) {
    if ((a[k] || b[k]) && JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push(`${where}: ${k} changed (compare by hand, then update the snapshot)`);
  }
}

/** What in `cur` breaks a client written against `old` (empty: compatible). */
export function breaks(old, cur) {
  const out = [];
  for (const [name, t] of Object.entries(old.tools)) {
    const n = cur.tools[name];
    if (!n) { out.push(`tool ${name}: gone. Keep it (an alias that calls the new tool is fine): clients and saved prompts call it by name`); continue; }
    if (t.readOnly && !n.readOnly) out.push(`tool ${name}: no longer read-only (clients may run read-only tools without asking)`);
    if (!t.destructive && n.destructive) out.push(`tool ${name}: now destructive`);
    compareSchema(t.input, n.input, `tool ${name}`, out);
  }
  for (const [name, p] of Object.entries(old.prompts)) {
    const n = cur.prompts[name];
    if (!n) { out.push(`prompt ${name}: gone`); continue; }
    for (const [arg, a] of Object.entries(p.arguments)) {
      if (!n.arguments[arg]) out.push(`prompt ${name}: argument "${arg}" removed`);
      else if (!a.required && n.arguments[arg].required) out.push(`prompt ${name}: argument "${arg}" is now required`);
    }
    for (const [arg, a] of Object.entries(n.arguments)) if (!p.arguments[arg] && a.required) out.push(`prompt ${name}: new required argument "${arg}"`);
  }
  return out;
}

/** Tools and prompts in `cur` that the snapshot does not have yet. */
export function additions(old, cur) {
  return [
    ...Object.keys(cur.tools).filter((n) => !old.tools[n]).map((n) => `tool ${n}`),
    ...Object.keys(cur.prompts).filter((n) => !old.prompts[n]).map((n) => `prompt ${n}`),
  ];
}

export function readSnapshot() { return JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')); }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes('--update')) {
    console.log('Usage: node test/mcp-contract.mjs --update   (writes test/fixtures/mcp-contract-v1.json)');
    process.exit(0);
  }
  const cur = await currentContract();
  if (fs.existsSync(SNAPSHOT)) {
    const b = breaks(readSnapshot(), cur);
    if (b.length) {
      console.error(`Refused: the current tools break the v1 contract:\n- ${b.join('\n- ')}`);
      process.exit(1);
    }
  }
  fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
  fs.writeFileSync(SNAPSHOT, `${JSON.stringify(cur, null, 2)}\n`);
  console.log(`Wrote ${path.relative(process.cwd(), SNAPSHOT)}: ${Object.keys(cur.tools).length} tools, ${Object.keys(cur.prompts).length} prompts`);
}
