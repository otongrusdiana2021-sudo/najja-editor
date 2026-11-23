// (v1.13.2) Tools run one at a time in the editor tab (public/js/cmdqueue.js, public/js/bridge.js). Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueue, PURE_READS } from '../public/js/cmdqueue.js';
import { TOOLS } from '../mcp/tools.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('queue: tasks start in order and never overlap, whatever their length', async () => {
  const q = createQueue();
  const log = [];
  let active = 0;
  let maxActive = 0;
  const task = (name, ms) => async () => {
    active++; maxActive = Math.max(maxActive, active);
    log.push(`start ${name}`);
    await sleep(ms);
    log.push(`end ${name}`);
    active--;
    return name;
  };
  const out = await Promise.all([q.run(task('a', 30)), q.run(task('b', 0)), q.run(task('c', 10))]);
  assert.deepEqual(out, ['a', 'b', 'c']);
  assert.deepEqual(log, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  assert.equal(maxActive, 1);
  assert.equal(q.waiting, 0);
  assert.equal(q.busy, false);
});

test('queue: a failing task rejects on its own and the next one still runs', async () => {
  const q = createQueue();
  const first = q.run(async () => { throw new Error('boom'); });
  const second = q.run(async () => 'ok');
  await assert.rejects(first, /boom/);
  assert.equal(await second, 'ok');
});

test('queue: a task still waiting at its deadline is dropped (EXPIRED) and never called', async () => {
  let clock = 0;
  const q = createQueue({ now: () => clock });
  let called = false;
  const slow = q.run(async () => { await sleep(20); clock = 100; return 'slow'; });
  const late = q.run(async () => { called = true; }, { deadline: 50 });
  const after = q.run(async () => 'after', { deadline: 500 });
  assert.equal(await slow, 'slow');
  await assert.rejects(late, (err) => err.code === 'EXPIRED');
  assert.equal(called, false);
  assert.equal(await after, 'after');
});

test('queue: onStart runs when the task really starts, not when it is queued', async () => {
  const q = createQueue();
  const events = [];
  const a = q.run(async () => { events.push('run a'); await sleep(10); }, { onStart: () => events.push('start a') });
  const b = q.run(async () => { events.push('run b'); }, { onStart: () => events.push('start b') });
  assert.equal(q.waiting, 2);
  await Promise.all([a, b]);
  assert.deepEqual(events, ['start a', 'run a', 'start b', 'run b']);
});

test('PURE_READS are real MCP tools marked read-only; get_frame is not one (it seeks)', () => {
  for (const name of PURE_READS) {
    const t = TOOLS.find((x) => x.name === name);
    assert.ok(t, `${name} is an MCP tool`);
    assert.equal(t.annotations?.readOnlyHint, true, `${name} is read-only`);
  }
  assert.equal(PURE_READS.has('get_frame'), false);
  assert.equal(PURE_READS.has('playback'), false);
});

// ---- The bridge itself, with a stand-in engine that behaves like engine.capture (seek, wait, draw this.time) ----

const { bridge } = await import('../public/js/bridge.js');
const posted = [];
globalThis.fetch = async (url, opts) => { if (url === '/bridge/result') posted.push(JSON.parse(opts.body)); return { ok: true }; };

const engine = { time: 0 };
async function capture(t) {
  engine.time = t; // seek the one shared engine
  await sleep(5 + Math.random() * 15); // fonts, cut-out masks, video frames arriving
  return engine.time; // draw the time the engine is at now
}
const resultOf = (id) => posted.find((b) => b.id === id);

test('bug reproduced without the queue: three get_frame at once all draw the last time', async () => {
  const drawn = await Promise.all([1.2, 3.1, 44.2].map((t) => capture(t)));
  assert.deepEqual(drawn, [44.2, 44.2, 44.2]); // what production returned on 2026-11-23
});

test('bridge: three get_frame calls at once each get their own time', async () => {
  bridge.handlers = { tools: { get_frame: async (a) => ({ data: { time: a.time, drawn: await capture(a.time) } }) } };
  posted.length = 0;
  const times = [1.2, 3.1, 44.2];
  await Promise.all(times.map((time, i) => bridge.run({ id: `gf${i}`, tool: 'get_frame', args: { time }, timeout_ms: 45_000 })));
  times.forEach((time, i) => assert.equal(resultOf(`gf${i}`).result.data.drawn, time, `call ${i}`));
  assert.ok(bridge.state.log.slice(0, 3).every((e) => e.state === 'ok'));
});

test('bridge: a command that waited past the server timeout is not run; the queue goes on', async () => {
  let ran = false;
  bridge.handlers = {
    tools: {
      apply_style: async () => { await sleep(150); return { data: { done: true } }; },
      update_clip: async () => { ran = true; return { data: {} }; },
      add_text: async () => ({ data: { clip_id: 'c_1' } }),
    },
  };
  posted.length = 0;
  await Promise.all([
    bridge.run({ id: 'style', tool: 'apply_style', args: {}, timeout_ms: 60_000 }),
    bridge.run({ id: 'late', tool: 'update_clip', args: {}, timeout_ms: 300 }), // gives up 50 ms in, while apply_style runs
    bridge.run({ id: 'next', tool: 'add_text', args: {}, timeout_ms: 30_000 }),
  ]);
  assert.equal(resultOf('style').result.data.done, true);
  assert.match(resultOf('late').error, /Not run/);
  assert.equal(ran, false);
  assert.equal(resultOf('next').result.data.clip_id, 'c_1');
});

test('bridge: pure reads answer at once while a long tool is busy', async () => {
  const order = [];
  bridge.handlers = {
    tools: {
      apply_style: async () => { await sleep(80); order.push('apply_style'); return { data: {} }; },
      get_project: async () => { order.push('get_project'); return { data: {} }; },
    },
  };
  await Promise.all([
    bridge.run({ id: 's', tool: 'apply_style', args: {}, timeout_ms: 60_000 }),
    bridge.run({ id: 'p', tool: 'get_project', args: {}, timeout_ms: 30_000 }),
  ]);
  assert.deepEqual(order, ['get_project', 'apply_style']);
});

test('bridge: pasted JSON (runLocal) waits its turn behind AI commands, and the log shows "wait" until it starts', async () => {
  let active = 0;
  let maxActive = 0;
  const tool = async () => { active++; maxActive = Math.max(maxActive, active); await sleep(20); active--; return { data: {} }; };
  bridge.handlers = { tools: { update_clip: tool, add_text: tool } };
  const ai = bridge.run({ id: 'ai', tool: 'update_clip', args: {}, timeout_ms: 30_000 });
  const local = bridge.runLocal('add_text', {});
  assert.equal(bridge.state.log[0].local, true);
  assert.equal(bridge.state.log[0].state, 'wait');
  await Promise.all([ai, local]);
  assert.equal(maxActive, 1);
  assert.equal(bridge.state.log[0].state, 'ok');
});

test('bridge: commands from an older server (no timeout_ms) still run', async () => {
  bridge.handlers = { tools: { set_project: async () => ({ data: { ok: 1 } }) } };
  posted.length = 0;
  await bridge.run({ id: 'old', tool: 'set_project', args: {} });
  assert.equal(resultOf('old').result.data.ok, 1);
});
