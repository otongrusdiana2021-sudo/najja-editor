// AI · MCP panel (v1.12.3): tool calls pasted as JSON, ready-made prompts, the guide for other AIs. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseToolCalls, PROMPT_GROUPS, fillPrompt, claudeUrl, guideForOtherAi, EXAMPLE_JSON } from '../public/js/aicmds.js';
import { TOOLS } from '../mcp/tools.js';

const NAMES = TOOLS.map((t) => t.name);

test('pasted JSON: one call, a list, JSON-RPC, wrapped lists, a ```json block in an AI answer', () => {
  assert.deepEqual(parseToolCalls('{"tool":"add_text","arguments":{"text":"Hai"}}', NAMES), [{ tool: 'add_text', args: { text: 'Hai' } }]);
  assert.deepEqual(parseToolCalls('[{"name":"get_project"},{"tool":"add_text","args":{"text":"A"}}]', NAMES), [{ tool: 'get_project', args: {} }, { tool: 'add_text', args: { text: 'A' } }]);
  assert.deepEqual(parseToolCalls('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"add_text","arguments":{"text":"B"}}}', NAMES), [{ tool: 'add_text', args: { text: 'B' } }]);
  assert.equal(parseToolCalls('{"steps":[{"tool":"get_project"},{"tool":"list_media"}]}', NAMES).length, 2);
  assert.deepEqual(parseToolCalls('{"tool":"add_text","arguments":"{\\"text\\":\\"C\\"}"}', NAMES)[0].args, { text: 'C' }, 'arguments as a JSON string');
  const answer = 'Siap! Ini perintahnya:\n```json\n[{"tool":"add_text","arguments":{"text":"DISKON"}}]\n```\nSemoga membantu.';
  assert.deepEqual(parseToolCalls(answer, NAMES), [{ tool: 'add_text', args: { text: 'DISKON' } }]);
  assert.equal(parseToolCalls('Berikut: [{"tool":"get_project"}]', NAMES).length, 1, 'text before the JSON');
});

test('pasted JSON: clear messages for what is wrong', () => {
  assert.throws(() => parseToolCalls('', NAMES), /Kosong/);
  assert.throws(() => parseToolCalls('{"tool": "add_text", ', NAMES), /Bukan JSON yang valid/);
  assert.throws(() => parseToolCalls('[{"arguments":{}}]', NAMES), /tidak punya nama tool/);
  assert.throws(() => parseToolCalls('{"tool":"add_txt","arguments":{}}', NAMES), /Tool "add_txt" tidak ada\. Mungkin: add_/);
  assert.throws(() => parseToolCalls('{"tool":"add_text","arguments":[1]}', NAMES), /harus berupa objek/);
  assert.throws(() => parseToolCalls(JSON.stringify(Array.from({ length: 101 }, () => ({ tool: 'get_project' }))), NAMES), /maksimal 100/);
  assert.throws(() => parseToolCalls('[]', NAMES), /kosong/);
});

test('the example JSON is valid for the real tools: names and argument names', () => {
  const calls = parseToolCalls(EXAMPLE_JSON, NAMES);
  assert.ok(calls.length >= 2);
  for (const c of calls) {
    const t = TOOLS.find((x) => x.name === c.tool);
    const props = Object.keys(t.inputSchema.properties || {});
    for (const k of Object.keys(c.args)) assert.ok(props.includes(k), `${c.tool}.${k} is an argument of the tool`);
    for (const r of t.inputSchema.required || []) assert.ok(r in c.args, `${c.tool} needs ${r}`);
  }
});

test('prompts: the project name goes in; every tool a prompt names exists; Claude link carries the prompt', () => {
  const all = PROMPT_GROUPS.flatMap(([, list]) => list);
  assert.ok(all.length >= 8);
  for (const p of all) {
    const f = fillPrompt(p, 'Olive Bag');
    assert.ok(!f.includes('{proyek}'));
    for (const m of f.match(/\b[a-z]+_[a-z_]+\b/g) || []) assert.ok(NAMES.includes(m), `${m} named in a prompt is a tool`);
  }
  assert.match(fillPrompt(all[0], 'Olive Bag'), /"Olive Bag"/);
  const u = new URL(claudeUrl('Edit "proyek" & ekspor?'));
  assert.equal(u.origin + u.pathname, 'https://claude.ai/new');
  assert.equal(u.searchParams.get('q'), 'Edit "proyek" & ekspor?');
});

test('the guide for other AIs lists every tool with its arguments and the answer format', () => {
  const g = guideForOtherAi(TOOLS, 'Olive Bag');
  assert.match(g, /HANYA dengan JSON/);
  assert.match(g, /"tool": "nama_tool"/);
  for (const t of TOOLS) assert.ok(g.includes(`- ${t.name}:`), t.name);
  assert.match(g, /add_text: .*Argumen: text\*/);
  assert.match(g, /text_motion\(none\|wordPop/);
});
