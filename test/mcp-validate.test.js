// (v1.13.2, P0-6a) Tool arguments checked on the server (mcp/validate.js, mcp/protocol.js). Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkArgs, errorText } from '../mcp/validate.js';
import { createMcpHandler } from '../mcp/protocol.js';
import { TOOLS } from '../mcp/tools.js';

const tool = (n) => TOOLS.find((t) => t.name === n).inputSchema;

/** A valid value for a schema: every field filled, each with a value the schema accepts. */
function example(s) {
  if (s.enum) return s.enum[0];
  switch (s.type) {
    case 'object': return Object.fromEntries(Object.entries(s.properties || {}).map(([k, v]) => [k, example(v)]));
    case 'array': return Array.from({ length: Math.max(1, s.minItems || 1) }, () => example(s.items || { type: 'string' }));
    case 'number': return s.minimum ?? (s.maximum != null ? Math.min(1, s.maximum) : 1);
    case 'integer': return s.minimum ?? 1;
    case 'boolean': return true;
    case 'string': return 'x';
    default: return 'x';
  }
}

test('compatibility: a valid call of every tool passes unchanged, with no error and no note', () => {
  for (const t of TOOLS) {
    const full = example(t.inputSchema);
    const r = checkArgs(t.inputSchema, full);
    assert.deepEqual(r.errors, [], `${t.name}: no error`);
    assert.deepEqual(r.notes, [], `${t.name}: no note`);
    assert.deepEqual(r.args, full, `${t.name}: arguments unchanged`);
    const required = Object.fromEntries((t.inputSchema.required || []).map((k) => [k, full[k]]));
    assert.deepEqual(checkArgs(t.inputSchema, required), { args: required, errors: [], notes: [] }, `${t.name}: only the required fields`);
  }
});

test('refused: a type that can not be right, even after what the editor converted (it became NaN in the project)', () => {
  const cases = [
    ['update_clip', { clip_id: 'c1', x: 'abc' }, 'x', /expected a number, got string "abc"/],
    ['update_clip', { clip_id: 'c1', opacity: { v: 1 } }, 'opacity', /expected a number, got object/],
    ['update_clip', { clip_id: 'c1', opacity: true }, 'opacity', /expected a number, got boolean/],
    ['update_clip', { clip_id: 'c1', opacity: '' }, 'opacity', /expected a number/],
    ['add_text', { text: ['a', 'b'] }, 'text', /expected text, got array/],
    ['add_subtitles', { items: 'Halo' }, 'items', /expected an array, got string/],
    ['add_subtitles', { items: [{ text: 'Halo', start: 'awal', duration: 2 }] }, 'items[0].start', /expected a number/],
    ['add_subtitles', { items: ['Halo'] }, 'items[0]', /expected an object, got string/],
    ['get_project', 'semua', 'arguments', /expected an object, got string/],
  ];
  for (const [name, args, field, message] of cases) {
    const r = checkArgs(tool(name), args);
    assert.equal(r.errors.length, 1, `${name} ${JSON.stringify(args)}`);
    assert.equal(r.errors[0].field, field);
    assert.match(r.errors[0].message, message);
  }
  assert.match(errorText('update_clip', [{ field: 'x', message: 'expected a number, got string "abc"' }]), /^Invalid arguments for update_clip: x: expected a number, got string "abc"\. Nothing was changed\.$/);
});

test('converted once on the server, as the editor did: "1.5" → 1.5, "true" → true, 12 → "12"', () => {
  const r = checkArgs(tool('update_clip'), { clip_id: 12, x: '0.25', opacity: ' 0.5 ', muted: 'true' });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.args, { clip_id: '12', x: 0.25, opacity: 0.5, muted: true });
  assert.equal(checkArgs(tool('update_clip'), { clip_id: 'c', muted: 'false' }).args.muted, false);
});

test('noted, never refused: what the editor already handles itself (defaults, clamps, ignores)', () => {
  const r = checkArgs(tool('history'), { steps: 99, extra: 1 });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.args, { steps: 99, extra: 1 }, 'passed on as it came');
  assert.ok(r.notes.some((n) => /"extra" is not a parameter/.test(n)));
  assert.ok(r.notes.some((n) => /"steps" should be at most 50/.test(n)));
  assert.ok(r.notes.some((n) => /"action" is required/.test(n)), 'history without action undoes today: noted, still runs');
  assert.ok(checkArgs(tool('add_text'), { text: 'Hai', font: 'Arial' }).notes.some((n) => /"font" is not one of the listed values/.test(n)));
  assert.ok(checkArgs(tool('set_project'), { fps: 29.97 }).notes.some((n) => /whole number|one of/.test(n)));
});

test('null means "not given": passed on untouched', () => {
  const r = checkArgs(tool('update_clip'), { clip_id: 'c', x: null, text: null });
  assert.deepEqual(r, { args: { clip_id: 'c', x: null, text: null }, errors: [], notes: [] });
});

// ---- through the protocol handler, as AI clients call ----
function handler() {
  const calls = [];
  const handle = createMcpHandler({
    name: 't',
    version: '1',
    callTool: async (n, a) => {
      calls.push([n, a]);
      if (n === 'delete_clip') throw new Error('Clip not found: c9. Call get_project for valid clip ids.');
      return { data: { ok: true } };
    },
  });
  const call = (name, args) => handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return { calls, call };
}

test('protocol: a refused call never reaches the editor and says what to fix', async () => {
  const { calls, call } = handler();
  const r = await call('update_clip', { clip_id: 'c1', x: 'kiri' });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /^Error: Invalid arguments for update_clip: x: expected a number, got string "kiri"/);
  assert.equal(calls.length, 0);
});

test('protocol: converted arguments reach the editor; a valid call answers exactly as before', async () => {
  const { calls, call } = handler();
  const r = await call('update_clip', { clip_id: 'c1', x: '0.5' });
  assert.deepEqual(calls, [['update_clip', { clip_id: 'c1', x: 0.5 }]]);
  assert.deepEqual(r.result, { content: [{ type: 'text', text: JSON.stringify({ ok: true }, null, 2) }], isError: false });
});

test('protocol: a note is added after the result (the first item stays the data clients read)', async () => {
  const { calls, call } = handler();
  const r = await call('add_text', { text: 'Hai', colour: '#fff' });
  assert.equal(calls.length, 1);
  assert.equal(r.result.isError, false);
  assert.deepEqual(JSON.parse(r.result.content[0].text), { ok: true });
  assert.match(r.result.content.at(-1).text, /^Note: "colour" is not a parameter of this tool and was ignored\.$/);
  const err = await call('delete_clip', { clip_id: 'c9', force: true });
  assert.equal(err.result.isError, true);
  assert.match(err.result.content[0].text, /^Error: Clip not found: c9\..*\(Note: "force" is not a parameter/);
});
