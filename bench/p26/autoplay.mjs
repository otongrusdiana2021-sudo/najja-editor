// Resume after scrub (v1.14.2), iPad profile (touch): scrolls the timeline the way a finger does (touchstart, scroll
// steps, touchend, a little momentum) and checks when the preview plays. Owner's choice: a scrub that interrupted
// playback plays on where the timeline comes to rest; a scrub while paused stays paused; a ruler tap while playing
// jumps there and plays on.
// usage: NAJJA_BENCH_EMAIL=… NAJJA_BENCH_PASSWORD=… PLAYWRIGHT_DIR=… node bench/p26/autoplay.mjs <project id>
//        (a project of a few video clips on the local server at :3399, see README.md)
import { createRequire } from 'node:module';
const require = createRequire(`${process.env.PLAYWRIGHT_DIR}/`);
const { chromium, devices } = require('playwright');
const BASE = 'http://localhost:3399';
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ ...devices['iPad Pro 11 landscape'], userAgent: undefined });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/login`);
await page.fill('#email', process.env.NAJJA_BENCH_EMAIL);
await page.fill('#password', process.env.NAJJA_BENCH_PASSWORD);
await Promise.all([page.waitForNavigation(), page.click('button[type=submit]')]);
await page.goto(`${BASE}/?debug&p=${process.argv[2]}`);
await page.waitForSelector('body.ready', { timeout: 60000 });
await page.waitForTimeout(1500);
const out = await page.evaluate(async () => {
  const E = window.najja.engine;
  const sc = document.querySelector('.tl-scroll') || [...document.querySelectorAll('*')].find((el) => el.scrollWidth > el.clientWidth + 200 && getComputedStyle(el).overflowX !== 'visible');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const touch = (type) => {
    const r = sc.getBoundingClientRect();
    const t = new Touch({ identifier: 1, target: sc, clientX: r.left + 200, clientY: r.top + 60 });
    sc.dispatchEvent(new TouchEvent(type, { touches: type === 'touchend' ? [] : [t], changedTouches: [t], bubbles: true }));
  };
  const scrubBy = async (px, steps = 10) => { for (let i = 0; i < steps; i++) { sc.scrollLeft += px / steps; await sleep(16); } };
  const res = {};
  // 1. playing, finger scrubs forward, lets go, momentum: plays on from the new place
  E.seek(1); E.play(); await sleep(800);
  touch('touchstart'); await scrubBy(300); const during = E.playing;
  touch('touchend'); await scrubBy(60, 4); // (momentum after the finger left)
  const atRest = E.time;
  await sleep(150); const early = E.playing;
  await sleep(400);
  res.scrub_while_playing = { paused_during: !during, still_paused_150ms_after_rest: !early, playing_after: E.playing, resumed_from: +atRest.toFixed(2), now: +E.time.toFixed(2) };
  // 2. finger holds the timeline still (no scroll) after moving: no resume while it is down
  await sleep(500);
  touch('touchstart'); await scrubBy(-200); await sleep(700); const held = E.playing;
  touch('touchend'); await sleep(450);
  res.finger_held = { playing_while_held: held, playing_after_release: E.playing };
  // 3. paused, scrub: stays paused
  E.pause(); await sleep(300);
  touch('touchstart'); await scrubBy(250); touch('touchend'); await sleep(700);
  res.scrub_while_paused = { playing_after: E.playing };
  // 4. ruler tap while playing: jumps there and plays on
  E.play(); await sleep(500);
  const ruler = document.querySelector('.tl-ruler-wrap, .ruler-wrap') || sc.querySelector('[class*=ruler]');
  res.ruler_found = !!ruler;
  return res;
});
// 4b. a real tap on the ruler (pointer events from Playwright's touchscreen)
const box = await page.evaluate(() => { const el = document.querySelector('.tl-ruler-wrap, .ruler-wrap') || [...document.querySelectorAll('[class*=ruler]')][0]; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width * 0.3, y: r.top + r.height / 2, cls: el.className }; });
if (box) {
  const before = await page.evaluate(() => window.najja.engine.time);
  await page.touchscreen.tap(box.x, box.y);
  await page.waitForTimeout(600);
  out.ruler_tap_while_playing = { cls: box.cls, before: +before.toFixed(2), after: await page.evaluate(() => +window.najja.engine.time.toFixed(2)), playing: await page.evaluate(() => window.najja.engine.playing) };
}
console.log(JSON.stringify(out, null, 1));
console.log('errors:', errors);
await browser.close();
