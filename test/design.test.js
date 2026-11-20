// Najja Desain (v1.13): the design document and its pure operations (model.js), the templates and text combinations,
// the ZIP writer, the renderer's helpers for designs (wrap, curve, text effects, shapes), the icon search, the text
// effect chooser, the Lucide icons from /vendor (gzipped) and design projects in the project list. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  SIZES, newDesign, normalizeDesign, newPage, textEl, shapeEl, slotEl, imageEl, fillSlot, iconEl, badgeEl, swatchEl, unit,
  aabb, union, hit, snap, snapAngle, moveEl, duplicateEls, duplicatePage, alignMoves, distributeMoves, History, snapshotOf, TEXT_KINDS,
  slotOf, resizeDesign, SHAPE_NAMES, SHAPE_DIMS,
} from '../public/js/design/model.js';
import { TEMPLATES, COMBOS, templatesFor, ICON_NODES } from '../public/js/design/templates.js';
import { zip, crc32 } from '../public/js/design/zip.js';
import { wrapLine, curveArc, textEffect, baseSize, shapePath } from '../public/js/render.js';
import { searchIcons } from '../public/js/design/assets.js';
import { applyFx, fxOf } from '../public/js/design/ui.js';
import { untar, createVendor, VENDOR } from '../lib/vendor.js';
import { createStorage } from '../lib/storage.js';

// a canvas context good enough for measuring: every letter is 0.6 em wide
const fakeCtx = () => ({ font: '', letterSpacing: '0px', measureText(s) { const m = /(\d+(?:\.\d+)?)px/.exec(this.font); return { width: String(s).length * (m ? Number(m[1]) : 10) * 0.6 }; } });
const envOf = (d) => ({ project: { width: d.width, height: d.height }, s: 1, mediaMeta: (id) => d.media.find((m) => m.id === id) || null, source: () => null });

test('a new design: the size asked (clamped), one empty page, a project id the server takes, kind design', () => {
  const d = newDesign({ w: 1080, h: 1350, sizeId: 'feed', name: 'Feed' });
  assert.match(d.id, /^p_[a-z0-9]{4,40}$/);
  assert.equal(d.kind, 'design');
  assert.deepEqual([d.width, d.height, d.aspect, d.pages.length, d.pages[0].els.length], [1080, 1350, '4:5', 1, 0]);
  const big = newDesign({ w: 99999, h: 10 });
  assert.deepEqual([big.width, big.height], [8000, 64]);
  assert.ok(SIZES.find((s) => s.id === 'produk' && s.w === 1080 && s.h === 1080), 'marketplace product photo first');
  assert.equal(SIZES[0].id, 'produk');
});

test('normalizeDesign makes an old or partial record whole', () => {
  const d = normalizeDesign({ id: 'p_abcd', width: 1920, height: 640 });
  assert.equal(d.kind, 'design');
  assert.equal(d.aspect, '3:1');
  assert.equal(d.pages.length, 1);
  assert.deepEqual(d.media, []);
  const e = normalizeDesign({ id: 'p_abcd', width: 1080, height: 1080, pages: [{ els: [{ id: 'c1' }] }], clips: [{ x: 1 }] });
  assert.ok(e.pages[0].id && e.pages[0].bg);
  assert.deepEqual(e.clips, []);
});

test('elements: sizes follow the page (its shorter side), a text box wraps, a slot is a shape with a label', () => {
  const sq = { width: 1080, height: 1080 };
  const story = { width: 1080, height: 1920 };
  const banner = { width: 1920, height: 640 };
  assert.equal(unit(story), 1);
  assert.equal(Math.round(unit(banner) * 1000) / 1000, 0.593);
  const t = textEl(banner, { ...TEXT_KINDS.heading, width: 900 });
  assert.equal(t.text.size, Math.round(120 * unit(banner)));
  assert.equal(t.text.width, Math.round(900 * unit(banner)));
  assert.equal(t.text.color, '#111111');
  assert.equal(t.type, 'text');
  assert.equal(t.transition, undefined, 'no video-only fields');
  const s = shapeEl(sq, 'star');
  assert.deepEqual([s.type, s.shape.kind, s.shape.w, s.shape.h], ['shape', 'star', 400, 400]);
  const slot = slotEl(sq, 'rect', 600, 500, { radius: 40, x: 0.1 });
  assert.deepEqual([slot.slot.label, slot.shape.radius, slot.x, 'radius' in slot], ['Foto produk', 40, 0.1, false]);
  const ic = iconEl(sq, 'truck', ICON_NODES.truck);
  assert.equal(ic.sticker.icon.name, 'truck');
  assert.ok(ic.sticker.icon.nodes.length > 2);
  assert.equal(badgeEl(sq, { text: 'COD' }).sticker.badge.text, 'COD');
  assert.equal(swatchEl(sq, '#141414', 'Hitam').sticker.swatch.label, 'Hitam');
});

test('a photo fills a slot: same place, its size, cropped to the slot (not squashed), framed like the slot', () => {
  const d = newDesign({ w: 1080, h: 1080 });
  const slot = slotEl(d, 'rect', 600, 400, { radius: 50, x: -0.1, y: 0.2, rotation: 8 });
  const m = { id: 'm_tall1', width: 600, height: 800 };
  d.media.push(m);
  const img = fillSlot(d, slot, m);
  assert.deepEqual([img.id, img.x, img.y, img.rotation, img.type], [slot.id, -0.1, 0.2, 8, 'image']);
  // the photo is tall, the slot wide: top and bottom cropped, evenly
  assert.equal(img.crop.l, 0);
  assert.ok(img.crop.t === 0.25 && img.crop.b === 0.25, 'half the height kept: 600×800 → 3:2');
  const size = baseSize(img, envOf(d), null);
  assert.ok(Math.abs(size.w * img.scale - 600) < 1 && Math.abs(size.h * img.scale - 400) < 1, `${size.w * img.scale}×${size.h * img.scale}`);
  assert.equal(img.mask.kind, 'rect');
  assert.equal(img.mask.radius, 0.25, 'radius as a part of the half shorter side (50 of 200)');
  assert.deepEqual(img.fromSlot, { kind: 'rect', w: 600, h: 400, radius: 50, label: 'Foto produk', scale: 1, imgScale: img.scale });
  const circle = fillSlot(d, slotEl(d, 'circle', 500, 500), m);
  assert.equal(circle.mask.kind, 'circle');
  const plain = fillSlot(d, slotEl(d, 'rect', 500, 500), m);
  assert.equal(plain.mask, null, 'a square slot needs no frame');
  const placed = imageEl(d, m, {}, 0.5);
  const ps = baseSize(placed, envOf(d), null);
  assert.ok(Math.abs(Math.max(ps.w, ps.h) * placed.scale - 540) < 1, 'a photo added at half the page');
});

test('geometry: rotated bounds, hit test, snapping to the page and to others, rotation snap', () => {
  const b = { cx: 100, cy: 100, w: 100, h: 50, rot: Math.PI / 2 };
  const a = aabb(b);
  assert.ok(Math.abs(a.x2 - a.x1 - 50) < 1e-9 && Math.abs(a.y2 - a.y1 - 100) < 1e-9);
  assert.ok(hit(b, 100, 140) && !hit(b, 140, 100));
  assert.deepEqual(union([{ x1: 0, y1: 5, x2: 10, y2: 10 }, { x1: -5, y1: 0, x2: 3, y2: 20 }]), { x1: -5, y1: 0, x2: 10, y2: 20 });
  const page = { width: 1000, height: 800 };
  // near the page's centre line: pulled onto it, a guide there
  const s = snap({ x1: 400, y1: 100, x2: 597, y2: 200 }, [], page, 6);
  assert.ok(Math.abs(s.dx - 1.5) < 1e-9 && s.dy === 0);
  assert.ok(s.guides.some((g) => g.axis === 'x' && Math.abs(g.at - 500) < 1e-9));
  // to another element's edge
  const o = snap({ x1: 10, y1: 304, x2: 60, y2: 354 }, [{ x1: 200, y1: 300, x2: 300, y2: 400 }], page, 6);
  assert.equal(o.dy, -4);
  // too far: nothing
  const n = snap({ x1: 10, y1: 315, x2: 60, y2: 365 }, [{ x1: 200, y1: 300, x2: 300, y2: 400 }], page, 6);
  assert.deepEqual([n.dx, n.dy, n.guides.length], [0, 0, 0]);
  assert.equal(snapAngle(43), 45);
  assert.equal(snapAngle(-88), -90);
  assert.equal(snapAngle(30), 30);
});

test('layer order, copies, page copies, align and distribute', () => {
  const d = newDesign();
  const p = d.pages[0];
  p.els = ['a', 'b', 'c', 'd'].map((id) => ({ id, x: 0, y: 0 }));
  moveEl(p, 'a', 'top');
  moveEl(p, 'd', 'bottom');
  moveEl(p, 'c', 'up');
  assert.deepEqual(p.els.map((e) => e.id), ['d', 'b', 'a', 'c']);
  const [c] = duplicateEls(d, [p.els[0]], 54);
  assert.notEqual(c.id, 'd');
  assert.equal(c.x, 0.05);
  const p2 = duplicatePage(d, 0);
  assert.equal(d.pages.length, 2);
  assert.ok(p2.id !== p.id && p2.els.every((e, i) => e.id !== p.els[i].id));
  const boxes = { a: { x1: 10, y1: 10, x2: 110, y2: 60 }, b: { x1: 300, y1: 200, x2: 350, y2: 260 } };
  assert.deepEqual(alignMoves({ a: boxes.a }, { width: 1000, height: 1000 }, 'right'), { a: { dx: 890, dy: 0 } }, 'one element: to the page');
  assert.deepEqual(alignMoves(boxes, { width: 1000, height: 1000 }, 'top'), { a: { dx: 0, dy: 0 }, b: { dx: 0, dy: -190 } }, 'several: to each other');
  const three = { a: { x1: 0, y1: 0, x2: 100, y2: 10 }, b: { x1: 120, y1: 0, x2: 170, y2: 10 }, c: { x1: 400, y1: 0, x2: 500, y2: 10 } };
  const dm = distributeMoves(three, 'h');
  assert.deepEqual(dm.b, { dx: 105, dy: 0 }, 'equal gaps: 75 on each side');
  assert.deepEqual(distributeMoves({ a: three.a, b: three.b }, 'h'), {}, 'needs three');
});

test('History: undo / redo of whole snapshots, the same state not twice, a new change drops the redo', () => {
  const h = new History(3);
  h.push('A');
  h.push('A');
  assert.equal(h.past.length, 1);
  h.push('B');
  assert.equal(h.undo('C'), 'B');
  assert.equal(h.undo('B'), 'A');
  assert.equal(h.undo('A'), null);
  assert.equal(h.redo('A'), 'B');
  h.push('X');
  assert.equal(h.canRedo, false);
  for (const s of ['1', '2', '3', '4']) h.push(s);
  assert.equal(h.past.length, 3, 'at most max steps');
  const d = newDesign();
  assert.deepEqual(Object.keys(JSON.parse(snapshotOf(d))), ['pages', 'media', 'width', 'height', 'sizeId'], 'the page size is undone too (v1.13.1)');
});

test('every template fits every size: elements valid, inside the page, slots for the photos', () => {
  const ctx = fakeCtx();
  for (const size of SIZES) {
    const d = newDesign({ w: size.w, h: size.h, sizeId: size.id });
    const list = templatesFor(size.id);
    assert.equal(list.length, TEMPLATES.length);
    assert.ok(list[0].for.includes(size.id) || !TEMPLATES.some((t) => t.for.includes(size.id)), 'templates made for the size first');
    for (const t of list) {
      const out = t.make(d);
      assert.ok(out.bg && (out.bg.color || out.bg.color2), `${t.id}: background`);
      assert.ok(out.els.length >= 3, `${t.id}: elements`);
      const ids = new Set(out.els.map((e) => e.id));
      assert.equal(ids.size, out.els.length, `${t.id}: unique ids`);
      if (!t.for.includes(size.id)) continue;
      // (the thank-you card and the voucher carry words, not a product photo)
      if (!['kartu', 'voucher'].includes(t.id)) assert.ok(out.els.some((e) => e.slot), `${t.id}/${size.id}: a photo slot`);
      for (const e of out.els) {
        assert.ok(['text', 'shape', 'sticker', 'image'].includes(e.type));
        // the centre of every element on the page
        assert.ok(Math.abs(e.x || 0) <= 0.5 && Math.abs(e.y || 0) <= 0.5, `${t.id}/${size.id}: ${e.name} at ${e.x},${e.y}`);
        const s = baseSize(e, envOf(d), ctx);
        assert.ok(s.w > 0 && s.h > 0, `${t.id}: ${e.name} has a size`);
      }
    }
  }
  for (const c of COMBOS) {
    const els = c.make(newDesign());
    assert.ok(els.length >= 2 && els.every((e) => e.type === 'text'), c.id);
  }
});

test('ZIP: a store-only archive any unzip reads (CRC-32 as zlib, UTF-8 names)', () => {
  const enc = new TextEncoder();
  for (const s of ['', 'a', 'Najja Desain', 'x'.repeat(10000)]) assert.equal(crc32(enc.encode(s)), zlib.crc32(s));
  const files = [{ name: 'Foto-Produk-1.png', data: crypto.randomBytes(3000) }, { name: 'Kartu-é-2.jpg', data: enc.encode('hello') }];
  const out = zip(files.map((f) => ({ name: f.name, data: new Uint8Array(f.data) })), new Date(2026, 10, 20, 10, 30));
  assert.equal(Buffer.from(out.subarray(0, 4)).toString('hex'), '504b0304');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'najja-zip-'));
  try {
    const p = path.join(dir, 'a.zip');
    fs.writeFileSync(p, out);
    let names;
    try {
      names = JSON.parse(execFileSync('python3', ['-I', '-c', 'import sys,zipfile,json;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(json.dumps([[i.filename,i.file_size,list(i.date_time)] for i in z.infolist()]))', p]).toString());
    } catch (err) {
      if (/ENOENT/.test(err.message)) return; // (no python3 here: the CRC check above stands)
      throw err;
    }
    assert.deepEqual(names, [['Foto-Produk-1.png', 3000, [2026, 11, 20, 10, 30, 0]], ['Kartu-é-2.jpg', 5, [2026, 11, 20, 10, 30, 0]]]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('renderer helpers: wrapping words in a box, a curve, text effects', () => {
  const ctx = fakeCtx();
  ctx.font = '700 100px Poppins';
  const lines = wrapLine(ctx, 'Tas kulit asli buatan tangan', 600);
  assert.ok(lines.length >= 3 && lines.every((l) => l.length * 60 <= 600 || !l.includes(' ')), JSON.stringify(lines));
  assert.equal(lines.join(' '), 'Tas kulit asli buatan tangan');
  assert.deepEqual(wrapLine(ctx, 'Superpanjangsekali', 300), ['Superpanjangsekali'], 'one long word stays whole');
  const up = curveArc(1000, 50, 120);
  const down = curveArc(1000, -50, 120);
  assert.ok(up.r > 0 && up.theta > 0 && up.w < 1000 && up.h > 120);
  assert.equal(Math.sign(up.sign), -Math.sign(down.sign));
  assert.ok(curveArc(1000, 100, 120).r < curveArc(1000, 20, 120).r, 'more curve: a smaller circle');
  const tx = { size: 100, color: '#ffffff', stroke: { enabled: false }, shadow: { enabled: false } };
  assert.equal(textEffect(tx), null);
  assert.equal(textEffect({ ...tx, effect: { type: 'none' } }), null);
  const splice = textEffect({ ...tx, effect: { type: 'splice', color: '#47C9D7', offset: 50 } });
  assert.equal(splice.fill, 'rgba(0,0,0,0)');
  assert.equal(splice.under[0].fill, '#47C9D7');
  assert.ok(splice.under[0].dx > 0 && splice.tx.stroke.enabled);
  const glitch = textEffect({ ...tx, effect: { type: 'glitch', offset: 50 } });
  assert.equal(glitch.under.length, 2);
  assert.ok(glitch.under[0].dx < 0 && glitch.under[1].dx > 0);
  const neon = textEffect({ ...tx, color: '#47C9D7', effect: { type: 'neon', intensity: 50 } });
  assert.ok(neon.tx.shadow.enabled && neon.tx.shadow.color === '#47C9D7');
  assert.equal(textEffect({ ...tx, effect: { type: 'echo' } }).under.length, 3);
});

test('text effects in the editor: one at a time, its settings kept when chosen again', () => {
  const tx = { size: 100, color: '#111111', bg: { enabled: false, color: '#000000' }, stroke: { enabled: false }, shadow: { enabled: true } };
  assert.equal(fxOf(tx), 'shadow-old');
  applyFx(tx, 'splice');
  assert.deepEqual([fxOf(tx), tx.shadow.enabled, tx.bg.enabled], ['splice', false, false]);
  tx.effect.offset = 80;
  applyFx(tx, 'splice');
  assert.equal(tx.effect.offset, 80);
  applyFx(tx, 'bg');
  assert.deepEqual([fxOf(tx), tx.effect, tx.bg.color], ['bg', null, '#FFD400'], 'a dark text gets a yellow box, not black on black');
  applyFx(tx, 'outline');
  assert.deepEqual([fxOf(tx), tx.bg.enabled, tx.stroke.enabled], ['outline', false, true]);
  applyFx(tx, 'none');
  assert.equal(fxOf(tx), 'none');
});

test('icon search: Indonesian words find the English names and tags, exact names first', () => {
  const icons = [
    { name: 'shopping-bag', tags: ['purchase', 'bag'] }, { name: 'truck', tags: ['delivery'] }, { name: 'star', tags: ['favorite'] },
    { name: 'stars', tags: [] }, { name: 'gift', tags: ['present'] },
  ];
  assert.deepEqual(searchIcons(icons, 'kirim').map((i) => i.name), ['truck']);
  assert.deepEqual(searchIcons(icons, 'tas').map((i) => i.name), ['shopping-bag']);
  assert.deepEqual(searchIcons(icons, 'star').map((i) => i.name), ['star', 'stars']);
  assert.deepEqual(searchIcons(icons, 'hadiah').map((i) => i.name), ['gift']);
  assert.equal(searchIcons(icons, '').length, 5);
  assert.deepEqual(searchIcons(icons, 'zzz'), []);
});

test('Lucide icons come from a pinned, checked package and are kept gzipped too', async () => {
  const spec = VENDOR.lucide;
  assert.equal(spec.license, 'ISC');
  assert.match(spec.tarball, /^https:\/\/registry\.npmjs\.org\/lucide-static\/-\/lucide-static-\d+\.\d+\.\d+\.tgz$/);
  assert.match(spec.sha256, /^[0-9a-f]{64}$/);
  const nodes = JSON.stringify({ truck: ICON_NODES.truck });
  const blocks = [];
  for (const [name, text] of [['package/icon-nodes.json', nodes], ['package/tags.json', '{"truck":["delivery"]}'], ['package/LICENSE', 'ISC License']]) {
    const data = Buffer.from(text);
    const h = Buffer.alloc(512);
    h.write(name, 0, 'utf8');
    h.write('0000644\0', 100);
    h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    h[156] = 48;
    h.write('ustar\0', 257);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  const tgz = zlib.gzipSync(Buffer.concat(blocks));
  assert.ok(untar(zlib.gunzipSync(tgz)).has('package/icon-nodes.json'));
  const saved = spec.sha256;
  spec.sha256 = crypto.createHash('sha256').update(tgz).digest('hex');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'najja-lucide-'));
  try {
    const v = createVendor({ dir, fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => tgz }) });
    assert.deepEqual(v.resolve(`/vendor/lucide-${spec.version}/icon-nodes.json`), { name: 'lucide', file: 'icon-nodes.json' });
    const base = await v.ensure('lucide');
    assert.equal(fs.readFileSync(path.join(base, 'icon-nodes.json'), 'utf8'), nodes);
    assert.equal(zlib.gunzipSync(fs.readFileSync(path.join(base, 'icon-nodes.json.gz'))).toString(), nodes);
    assert.ok(fs.existsSync(path.join(base, 'tags.json.gz')));
    assert.ok(!fs.existsSync(path.join(base, 'LICENSE.gz')), 'only the big text files');
  } finally {
    spec.sha256 = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the project list tells designs from videos (the home screen opens each in its editor)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'najja-design-store-'));
  try {
    const st = createStorage(dir, { exportDir: path.join(dir, 'exports'), extFor: () => '.bin' });
    const d = newDesign({ w: 1080, h: 1920, sizeId: 'story', name: 'Story promo' });
    d.pages.push(newPage(), newPage());
    await st.putProject(d.id, d);
    await st.putProject('p_video1', { id: 'p_video1', name: 'Video', width: 1920, height: 1080, clips: [], media: [], updatedAt: 1 });
    const list = await st.listProjects();
    const dl = list.find((x) => x.id === d.id);
    const vl = list.find((x) => x.id === 'p_video1');
    assert.deepEqual([dl.kind, dl.pages, dl.width, dl.height], ['design', 3, 1080, 1920]);
    assert.equal(vl.kind, 'video');
    assert.equal(vl.pages, undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------
// v1.13.1
test('every shape (and photo frame) is drawn inside its box', () => {
  // a Path2D that keeps the points it goes through
  class RecPath {
    constructor() { this.pts = []; this.cur = [0, 0]; }
    add(x, y) { this.pts.push([x, y]); this.cur = [x, y]; }
    moveTo(x, y) { this.add(x, y); }
    lineTo(x, y) { this.add(x, y); }
    // (curves: points along them, not their control points)
    quadraticCurveTo(cx, cy, x, y) {
      const [x0, y0] = this.cur;
      for (let i = 1; i <= 12; i++) { const t = i / 12; const u = 1 - t; this.pts.push([u * u * x0 + 2 * u * t * cx + t * t * x, u * u * y0 + 2 * u * t * cy + t * t * y]); }
      this.cur = [x, y];
    }
    bezierCurveTo(c1x, c1y, c2x, c2y, x, y) {
      const [x0, y0] = this.cur;
      for (let i = 1; i <= 16; i++) {
        const t = i / 16;
        const u = 1 - t;
        this.pts.push([u * u * u * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x, u * u * u * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y]);
      }
      this.cur = [x, y];
    }
    arcTo(x1, y1, x2, y2) { this.pts.push([x1, y1]); }
    arc(x, y, r, a0, a1, ccw = false) {
      // (along the arc, the way it is drawn)
      let e = a1;
      if (!ccw) while (e < a0) e += Math.PI * 2;
      else while (e > a0) e -= Math.PI * 2;
      for (let i = 0; i <= 24; i++) { const a = a0 + ((e - a0) * i) / 24; this.pts.push([x + Math.cos(a) * r, y + Math.sin(a) * r]); }
    }
    ellipse(x, y, rx, ry, rot, a0, a1) {
      // the points the arc goes through (every few degrees)
      const n = 24;
      for (let i = 0; i <= n; i++) { const a = a0 + ((a1 - a0) * i) / n; this.pts.push([x + Math.cos(a) * rx, y + Math.sin(a) * ry]); }
    }
    rect(x, y, w, h) { this.pts.push([x, y], [x + w, y + h]); }
    roundRect(x, y, w, h) { this.pts.push([x, y], [x + w, y + h]); }
    closePath() {}
  }
  const saved = globalThis.Path2D;
  globalThis.Path2D = RecPath;
  try {
    const kinds = Object.keys(SHAPE_NAMES).filter((k) => k !== 'rounded');
    assert.ok(kinds.length >= 33, `${kinds.length} shapes`);
    for (const kind of kinds) {
      for (const [w, h] of [[400, 400], [600, 240], [300, 520]]) {
        const p = shapePath(kind, w, h, 30);
        assert.ok(p.pts.length >= 2, `${kind}: drawn`);
        for (const [x, y] of p.pts) assert.ok(Math.abs(x) <= w / 2 + 0.5 && Math.abs(y) <= h / 2 + 0.5, `${kind} ${w}×${h}: (${x.toFixed(1)}, ${y.toFixed(1)}) outside`);
        // and it reaches its box (a frame fills its place): at least 70% of the width and height (a heart: ±75%)
        const xs = p.pts.map((q) => q[0]);
        const ys = p.pts.map((q) => q[1]);
        if (!['line', 'arrow', 'darrow', 'cross'].includes(kind)) {
          assert.ok(Math.max(...xs) - Math.min(...xs) >= w * 0.7 && Math.max(...ys) - Math.min(...ys) >= h * 0.7, `${kind} ${w}×${h}: fills its box`);
        }
      }
    }
  } finally { globalThis.Path2D = saved; }
  for (const [k, [w, h]] of Object.entries(SHAPE_DIMS)) assert.ok(SHAPE_NAMES[k] && w > 0 && h > 0, k);
});

test('a frame with a photo: its slot again, at its present size (a photo dropped on it fills the same place)', () => {
  const d = newDesign();
  const slot = slotEl(d, 'hexagon', 500, 400, { x: 0.2, y: -0.1, rotation: 12 });
  const m = { id: 'm_pic1', width: 800, height: 800 };
  d.media.push(m);
  const img = fillSlot(d, slot, m);
  const again = slotOf(img);
  assert.deepEqual([again.id, again.x, again.y, again.rotation, again.shape.kind, again.shape.w, again.shape.h, again.scale], [slot.id, 0.2, -0.1, 12, 'hexagon', 500, 400, 1]);
  assert.equal(img.mask.kind, 'hexagon');
  // made 1.5× bigger after it was filled: the frame is too, and another photo keeps that size
  img.scale *= 1.5;
  assert.ok(Math.abs(slotOf(img).scale - 1.5) < 1e-3);
  const other = fillSlot(d, slotOf(img), { id: 'm_pic2', width: 1200, height: 600 });
  d.media.push({ id: 'm_pic2', width: 1200, height: 600 });
  const sz = baseSize(other, envOf(d), null);
  assert.ok(Math.abs(sz.w * other.scale - 750) < 1 && Math.abs(sz.h * other.scale - 600) < 1, `${sz.w * other.scale}×${sz.h * other.scale}`);
  assert.equal(slotOf(slot), slot, 'an empty slot is its own slot');
  assert.equal(slotOf({ type: 'image' }), null, 'a loose photo has none');
});

test('resizing a design: places stay, sizes follow the shorter side, photos keep their look, undo knows the size', () => {
  const d = newDesign({ w: 1080, h: 1080, sizeId: 'produk' });
  const m = { id: 'm_wide1', width: 2000, height: 1000 };
  d.media.push(m);
  const t = textEl(d, { content: 'Halo', size: 100 }, { x: -0.2, y: 0.3 });
  const img = imageEl(d, m, { x: 0.1, y: -0.2 }, 0.5);
  d.pages[0].els.push(t, img);
  const before = JSON.parse(snapshotOf(d));
  const shown = (e, dd) => { const s = baseSize(e, envOf(dd), null); return [s.w * e.scale, s.h * e.scale]; };
  const imgBefore = shown(img, d);
  resizeDesign(d, 1920, 640, 'banner');
  assert.deepEqual([d.width, d.height, d.aspect, d.sizeId], [1920, 640, '3:1', 'banner']);
  const k = 640 / 1080;
  assert.ok(Math.abs(t.scale - k) < 1e-3, `text ${t.scale}`);
  assert.deepEqual([t.x, t.y, img.x, img.y], [-0.2, 0.3, 0.1, -0.2], 'places on the page unchanged');
  const imgAfter = shown(img, d);
  assert.ok(Math.abs(imgAfter[0] - imgBefore[0] * k) < 1 && Math.abs(imgAfter[1] - imgBefore[1] * k) < 1, `photo ${imgBefore} → ${imgAfter}`);
  assert.equal(JSON.parse(snapshotOf(d)).width, 1920);
  assert.equal(before.width, 1080);
  assert.deepEqual([resizeDesign(d, 10, 99999).width, d.height], [64, 8000], 'clamped');
});

test('27 templates: for every size, unique, their icons drawn', () => {
  assert.ok(TEMPLATES.length >= 27, `${TEMPLATES.length}`);
  const ids = new Set(TEMPLATES.map((t) => t.id));
  assert.equal(ids.size, TEMPLATES.length, 'unique ids');
  for (const size of ['produk', 'feed', 'story', 'banner', 'lebar', 'kartu']) assert.ok(TEMPLATES.some((t) => t.for.includes(size)), `a template for ${size}`);
  for (const t of TEMPLATES) for (const e of t.make(newDesign()).els) if (e.sticker?.icon) assert.ok(e.sticker.icon.nodes?.length, `${t.id}: icon ${e.sticker.icon.name} has its drawing`);
});
