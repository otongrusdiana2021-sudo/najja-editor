// "Style" sheet (v1.10): the three Style Konsep cards — how well the material fits each and the recommended one —,
// the product form and Generate (one style, or all three as three projects to pick from).
import { store } from './store.js';
import * as actions from './actions.js';
import { icon } from './icons.js';
import { escapeHtml } from './util.js';
import { toast } from './ui.js';
import { STYLES, checkMaterial } from './styles.js';
import { generateStyle, transcribeMaterial } from './stylerun.js';
import { transcribeStatus } from './captions.js';

const FIT = { yes: ['✓', 'Cocok'], warn: ['⚠', 'Bisa, ada catatan'], no: ['✗', 'Bahan kurang'] };
const FIELDS = [
  ['name', 'Nama produk', 'Travel Bag Motif Bunga', 'all'],
  ['variant', 'Varian', 'Mini, Medium, Jumbo', 'all'],
  ['size', 'Ukuran per varian', '28 cm, 35 cm, 45 cm', 'showcase'],
  ['note', 'Keterangan per varian', 'Fits 5-6 Outfits', 'showcase'],
  ['price', 'Harga normal', '189rb', 'all'],
  ['price_discount', 'Harga diskon', '149rb', 'all'],
  ['brand', 'Merek (outro)', 'NAJJA', 'speech'],
];
// a small picture of each look, drawn with CSS (no images)
const ART = {
  showcase: '<span class="sa-l1">Motif Bunga</span><span class="sa-l2">Mini Fits 5-6</span><span class="sa-sz">←  28 cm  →</span>',
  editorial: '<span class="sa-w">SEHARGA</span><span class="sa-w">TIKET</span><span class="sa-w">BIOSKOP</span><span class="sa-sub">harganya cuma segini</span>',
  storypop: '<span class="sa-t">turun</span><span class="sa-h">HARGA!!</span><span class="sa-e">🤔</span><span class="sa-p">Rp149.000</span>',
};

const S = { style: null, product: null, all: false, busy: null, status: null, statusAt: 0 };

export function styleSheet(sheet) {
  sheet.open({
    id: 'style',
    title: 'Style Konsep',
    size: 'tall',
    keepOnLoad: () => !!S.busy, // (Generate opens the new project: the progress stays in view)
    render: (body) => {
      S.body = body;
      S.product = S.product && S.forProject === store.P.id ? S.product : { ...(store.P.styleProduct || store.P.style?.product || {}) };
      S.forProject = store.P.id;
      draw();
      body.addEventListener('click', onClick);
      body.addEventListener('input', onInput);
      const off = store.on('project', () => { if (!S.busy) draw(); });
      if (!S.statusAt || Date.now() - S.statusAt > 60000) {
        S.statusAt = Date.now();
        transcribeStatus().then((st) => { S.status = st; if (!S.busy && S.body === body) draw(); });
      }
      return () => { off(); body.removeEventListener('click', onClick); body.removeEventListener('input', onInput); if (S.body === body) S.body = null; };
    },
  });
}

function draw() {
  const body = S.body;
  if (!body) return;
  const c = checkMaterial(store.P);
  if (!S.style) S.style = c.recommended || 'editorial';
  const st = STYLES.find((x) => x.id === S.style);
  const fit = c.styles[S.style];
  const n = c.talks.length;
  const canTranscribe = S.status?.ok;
  const srcName = store.P.styleSource?.name;
  const mat = c.pending
    ? `<b>Bahan belum diperiksa.</b> Suara videonya perlu ditranskrip dulu supaya Najja tahu mana video kamu ngomong. ${canTranscribe ? '' : `<span class="warn">${escapeHtml(S.status && !S.status.ok ? S.status.reason : 'Mengecek layanan transkripsi…')} Showcase Clean tetap bisa dipakai.</span>`}`
    : `${n ? `${n} video kamu ngomong (${Math.round(c.talkSec)} dtk)` : 'Tidak ada video ngomong'} · ${c.shots.length} klip / foto lain`;
  const fields = FIELDS.filter(([, , , w]) => w === 'all' || w === S.style || (w === 'speech' && st.speech));
  body.innerHTML = `<div class="stp">
    <p class="stp-lead">Pilih konsep, isi info produk, lalu <b>Generate</b>. Hasilnya jadi <b>proyek baru</b>${srcName ? '' : ' — proyek ini tidak diubah'}.</p>
    ${srcName ? `<p class="hint">Proyek ini hasil style dari “${escapeHtml(srcName)}”. Generate di sini memakai bahan yang sama.</p>` : ''}
    <div class="stp-mat">${icon('film', 16)}<span>${mat}</span>${c.pending && canTranscribe && !S.busy ? '<button class="btn sm" data-do="check">Periksa bahan</button>' : ''}</div>
    <div class="stp-cards">${STYLES.map((x) => {
      const f = c.styles[x.id];
      return `<button class="stp-card ${S.style === x.id ? 'on' : ''}" data-st="${x.id}" ${S.busy ? 'disabled' : ''}>
        <span class="stp-art sa-${x.id}">${ART[x.id]}</span>
        ${c.recommended === x.id ? '<i class="stp-rec">Disarankan</i>' : ''}
        <b>${escapeHtml(x.name)}</b><span class="stp-short">${escapeHtml(x.short)}</span>
        <em class="stp-fit fit-${f.ok}">${FIT[f.ok][0]} ${FIT[f.ok][1]}</em></button>`;
    }).join('')}</div>
    <div class="stp-about"><p>${escapeHtml(st.about)}</p><p class="stp-note fit-${fit.ok}">${FIT[fit.ok][0]} ${escapeHtml(fit.note)}</p></div>
    <div class="stp-form">${fields.map(([k, label, ph]) => `<label class="ctl"><span>${label}</span><input type="text" data-pf="${k}" value="${escapeHtml(S.product[k] ?? '')}" placeholder="${escapeHtml(ph)}" maxlength="80" ${S.busy ? 'disabled' : ''}></label>`).join('')}</div>
    <label class="ac-check stp-all"><input type="checkbox" data-all ${S.all ? 'checked' : ''} ${S.busy ? 'disabled' : ''}> Buat ketiganya (3 proyek baru, nanti pilih yang dipakai)</label>
    ${S.busy ? `<div class="ac-prog"><div class="ai-bar"><i style="width:${Math.max(3, Math.round((S.busy.p || 0) * 100))}%"></i></div><span>${escapeHtml(S.busy.label || '')}</span><button class="btn sm ghost" data-do="cancel">Batal</button></div>`
      : `<button class="ac-go" data-do="go" ${!S.all && fit.ok === 'no' ? 'disabled' : ''}>${icon('wand', 18)} Generate ${S.all ? 'ketiga style' : escapeHtml(st.name)}</button>`}
    <p class="hint">Lewat Claude (MCP): ketik <code>/najja-${S.style}</code> atau “edit pakai ${escapeHtml(st.name)}” — Claude yang memilih kata kunci, potongan, dan B-roll dari isi ucapanmu.</p>
  </div>`;
}

function onInput(e) {
  const k = e.target.dataset?.pf;
  if (k) S.product[k] = e.target.value;
  if (e.target.matches('[data-all]')) { S.all = e.target.checked; draw(); }
}

async function onClick(e) {
  const card = e.target.closest('[data-st]');
  if (card && !S.busy) { S.style = card.dataset.st; draw(); return; }
  const d = e.target.closest('[data-do]')?.dataset.do;
  if (d === 'cancel') { S.busy?.ctl.abort(); return; }
  if (d === 'check') { await run(async (progress, signal) => { await transcribeMaterial({ onProgress: progress, signal }); toast('Bahan sudah diperiksa', { type: 'ok' }); }); return; }
  if (d === 'go') await run((progress, signal) => (S.all ? generateAll(progress, signal) : generateOne(S.style, progress, signal)));
}

async function run(fn) {
  if (S.busy) return;
  const ctl = new AbortController();
  S.busy = { p: 0, label: 'Menyiapkan…', ctl };
  draw();
  const progress = (p, label) => {
    if (!S.busy) return;
    Object.assign(S.busy, { p, label });
    const bar = S.body?.querySelector('.ac-prog');
    if (bar) { bar.querySelector('i').style.width = `${Math.max(3, Math.round(p * 100))}%`; bar.querySelector('span').textContent = label; }
  };
  try { await fn(progress, ctl.signal); } catch (err) {
    if (!ctl.signal.aborted) toast(`Style gagal: ${err.message}`, { type: 'error', timeout: 6000 });
  } finally { S.busy = null; draw(); }
}

const product = () => Object.fromEntries(Object.entries(S.product).map(([k, v]) => [k, String(v).trim()]).filter(([, v]) => v));

async function generateOne(id, progress, signal) {
  const r = await generateStyle(id, { product: product(), onProgress: progress, signal });
  S.forProject = store.P.id;
  actions.app.sheet?.close(); // (the edit is what to look at now)
  toast(`${r.name}: video ${Math.round(r.duration)} dtk jadi di proyek baru “${r.project_name}”${r.cut_seconds > 0.5 ? `, ${Math.round(r.cut_seconds)} dtk jeda dipotong` : ''}${r.sfx ? `, ${r.sfx} SFX` : ''}${r.faces?.moved ? `, ${r.faces.moved} teks digeser supaya tidak menutupi orang` : ''}`, { type: 'ok', timeout: 5000 });
  return r;
}

/** All three styles (the ones the material allows), each a new project; then the recommended one is opened. */
async function generateAll(progress, signal) {
  const sourceId = store.P.styleSource?.id || store.P.id;
  const c = checkMaterial(store.P);
  const list = STYLES.filter((x) => c.styles[x.id].ok !== 'no' || (c.pending && x.speech));
  const made = [];
  for (let i = 0; i < list.length; i++) {
    if (signal.aborted) break;
    if (store.P.id !== sourceId) await actions.app.openProject(sourceId);
    try {
      const r = await generateStyle(list[i].id, { product: product(), signal, onProgress: (p, l) => progress((i + p) / list.length, `${list[i].name}: ${l}`) });
      made.push(r);
    } catch (err) {
      if (signal.aborted) break;
      toast(`${list[i].name} dilewati: ${err.message}`, { type: 'warn', timeout: 5000 });
    }
  }
  if (!made.length) throw new Error('Tidak ada style yang bisa dibuat dari bahan ini.');
  const pick = made.find((r) => r.style === c.recommended) || made[0];
  if (store.P.id !== pick.project_id) await actions.app.openProject(pick.project_id);
  S.forProject = store.P.id;
  actions.app.sheet?.close();
  toast(`${made.length} proyek dibuat: ${made.map((r) => r.name).join(', ')}. Yang lain ada di Beranda.`, { type: 'ok', timeout: 6000 });
}
