// (P0-3) The MCP contract (27 tools + 4 prompts of v1.13.1) may only grow. See test/mcp-contract.mjs. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { currentContract, readSnapshot, breaks, additions } from './mcp-contract.mjs';
import { TOOLS } from '../mcp/tools.js';

const snap = readSnapshot();
const cur = await currentContract();
const copy = (x) => JSON.parse(JSON.stringify(x));

test('contract v1: every tool and prompt of the snapshot still works the way clients call it', (t) => {
  const b = breaks(snap, cur);
  assert.deepEqual(b, [], `The MCP contract is broken:\n- ${b.join('\n- ')}`);
  const added = additions(snap, cur);
  if (added.length) t.diagnostic(`new since the snapshot (fine; run node test/mcp-contract.mjs --update): ${added.join(', ')}`);
});

test('contract v1 snapshot holds the 27 tools and 4 prompts of v1.13.1', () => {
  assert.equal(Object.keys(snap.tools).length, 27);
  assert.equal(Object.keys(snap.prompts).length, 4);
  for (const name of ['get_project', 'get_frame', 'update_clip', 'export_video', 'get_export_status', 'apply_style']) assert.ok(snap.tools[name], name);
});

test('the contract is what tools/list really sends (no tool missing from the handler)', () => {
  assert.deepEqual(Object.keys(cur.tools).sort(), TOOLS.map((x) => x.name).sort());
});

test('every MCP tool has a handler in the editor (public/js/api.js); none would answer "not supported"', () => {
  const src = fs.readFileSync(new URL('../public/js/api.js', import.meta.url), 'utf8');
  const start = src.indexOf('export const tools = {');
  assert.ok(start >= 0, 'api.js exports the tools object');
  const body = src.slice(start, src.indexOf('\n};', start));
  const handlers = new Set([...body.matchAll(/^ {2}async ([a-z_]+)\(/gm)].map((m) => m[1]));
  for (const name of Object.keys(cur.tools)) assert.ok(handlers.has(name), `no editor handler for ${name}`);
});

// ---- the checker itself catches every kind of break, and lets additive changes through ----

const BREAKING = {
  'a tool removed': (c) => { delete c.tools.split_clip; },
  'a tool renamed': (c) => { c.tools.cut_clip = c.tools.split_clip; delete c.tools.split_clip; },
  'a parameter removed': (c) => { delete c.tools.add_text.input.properties.text; },
  'a new required parameter': (c) => { c.tools.add_solid.input.required.push('color2'); },
  'a parameter type changed': (c) => { c.tools.history.input.properties.steps.type = 'string'; },
  'number narrowed to integer': (c) => { c.tools.history.input.properties.steps.type = 'integer'; },
  'an accepted value removed': (c) => { c.tools.history.input.properties.action.enum = ['undo']; },
  'free text limited to a list': (c) => { c.tools.add_text.input.properties.text.enum = ['halo']; },
  'a range narrowed': (c) => { c.tools.history.input.properties.steps.maximum = 10; },
  'a nested field removed': (c) => { delete c.tools.add_subtitles.input.properties.items.items.properties.start; },
  'read-only tool now changes things': (c) => { c.tools.get_project.readOnly = false; },
  'a tool now destructive': (c) => { c.tools.add_text.destructive = true; },
  'a prompt removed': (c) => { delete c.prompts['najja-editorial']; },
  'a prompt argument removed': (c) => { const a = c.prompts['najja-showcase'].arguments; delete a[Object.keys(a)[0]]; },
  'a new required prompt argument': (c) => { c.prompts['najja-storypop'].arguments.brand_new = { required: true }; },
};

test('checker refuses: other fields refused where they were accepted (no open object in v1, so a made-up pair)', () => {
  const tool = (input) => ({ tools: { x: { readOnly: false, destructive: false, input } }, prompts: {} });
  const open = { type: 'object', properties: { a: { type: 'string' } } };
  assert.ok(breaks(tool(open), tool({ ...open, additionalProperties: false })).length > 0);
  assert.deepEqual(breaks(tool({ ...open, additionalProperties: false }), tool(open)), [], 'accepting more fields is fine');
});

for (const [what, change] of Object.entries(BREAKING)) {
  test(`checker refuses: ${what}`, () => {
    const c = copy(cur);
    change(c);
    assert.ok(breaks(snap, c).length > 0, `${what} was not detected`);
  });
}

const ADDITIVE = {
  'a new tool': (c) => { c.tools.get_job = { readOnly: true, destructive: false, input: { type: 'object', properties: {} } }; },
  'a new optional parameter': (c) => { c.tools.add_text.input.properties.expected_rev = { type: 'number' }; },
  'a new accepted value': (c) => { c.tools.history.input.properties.action.enum.push('clear'); },
  'a wider range': (c) => { c.tools.history.input.properties.steps.maximum = 100; },
  'integer widened to number': (c) => { c.tools.set_project.input.properties.fps.type = 'number'; },
  'a new prompt': (c) => { c.prompts['najja-baru'] = { arguments: {} }; },
  'a new optional prompt argument': (c) => { c.prompts['najja-storypop'].arguments.tone = { required: false }; },
};

for (const [what, change] of Object.entries(ADDITIVE)) {
  test(`checker allows: ${what}`, () => {
    const c = copy(cur);
    change(c);
    assert.deepEqual(breaks(snap, c), []);
  });
}
