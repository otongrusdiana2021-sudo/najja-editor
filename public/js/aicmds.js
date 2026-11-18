// AI · MCP panel helpers (v1.12.3), pure: the ready-made prompts, and reading tool calls pasted as JSON (from any AI —
// ChatGPT, Claude without the connector — or written by hand) so the editor can run them itself.

/** Prompts to paste into Claude (connected to Najja). {proyek} becomes the open project's name; [..] is for the user. */
export const PROMPT_GROUPS = [
  ['Mulai', [
    'Lihat proyek "{proyek}" di Najja Editor, lalu ringkas isinya: klip, durasi, teks, dan media yang dipakai.',
    'Di proyek "{proyek}", tambahkan judul "[judul]" di 3 detik pertama dengan animasi teks kinetik Pop per kata, lalu cek hasilnya pakai get_frame.',
  ]],
  ['Style Konsep', [
    'Edit proyek "{proyek}" pakai Style Konsep Story Pop. Ambil transkripnya dulu, lalu pilih hook, kata kunci, dan momen harga seperti editor. Produk: [nama produk], harga: [harga], merek: [merek].',
    'Edit proyek "{proyek}" pakai Style Konsep Editorial Review. Ambil transkripnya, buang jeda dan take ulang, pilih kata kunci terkuat, dan pasang label harga saat harga disebut. Produk: [nama produk], harga: [harga].',
    'Edit proyek "{proyek}" pakai Style Konsep Showcase Clean. Varian: [varian 1], [varian 2], [varian 3]. Harga: [harga].',
    'Buat ketiga Style Konsep (Showcase Clean, Editorial Review, Story Pop) untuk proyek "{proyek}" supaya bisa saya bandingkan. Produk: [nama produk], harga: [harga].',
    'Edit proyek "{proyek}" pakai Style Konsep Story Pop. Ambil transkripnya, lalu tiap warna yang disebut kasih bulatan warna, kalau bilang tinggal beberapa hari kasih timer, dan kalau menyebut kegunaan (bisa buat …) kasih chip dengan emoji. Produk: [nama produk], harga: [harga].',
  ]],
  ['Subtitle & teks', [
    'Ambil transkrip proyek "{proyek}", betulkan salah ketik nama produk ([nama produk]), lalu buat subtitle dengan animasi Sorot per kata warna kuning, tiap kata menyala saat diucapkan.',
    'Di proyek "{proyek}", ubah semua subtitle jadi animasi Pop per kata dan tambahkan efek suara pop di kata kunci.',
  ]],
  ['Grafis & SFX (bahan sudah dipotong)', [
    'Bahan di proyek "{proyek}" sudah dipotong, jangan potong ulang. Ambil transkripnya dan lihat beberapa frame (get_frame). Tambahkan: subtitle per frasa, hook di detik 0, teks besar saat klaim utama, daftar fitur yang muncul saat disebut, harga dengan Angka berjalan, dan ajakan checkout di keranjang kuning di akhir. Jangan tutupi wajah. Produk: [nama produk].',
  ]],
  ['Ekspor', [
    'Ekspor proyek "{proyek}" ke 1080p, tunggu sampai selesai, lalu beri tahu saya.',
  ]],
];
export const fillPrompt = (p, project) => p.replace(/\{proyek\}/g, project || 'proyek ini');

/** The address that opens a new Claude chat with a prompt already typed in. */
export const claudeUrl = (prompt) => `https://claude.ai/new?q=${encodeURIComponent(prompt)}`;

const MAX_CALLS = 100;
const err = (message) => Object.assign(new Error(message), { user: true });

/** The JSON inside a pasted text: a ```json block, else the first {…} or […] that parses. */
function jsonOf(text) {
  const t = String(text ?? '').trim();
  if (!t) throw err('Kosong. Tempel perintah JSON dulu.');
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  const candidates = fence ? [fence[1].trim()] : [t];
  if (!fence) {
    const first = t.search(/[[{]/);
    if (first > 0) candidates.push(t.slice(first));
  }
  for (const c of candidates) {
    try { return JSON.parse(c); } catch { /* next */ }
  }
  throw err('Bukan JSON yang valid. Cek tanda kutip, koma, dan kurung kurawal.');
}

/** One call in any of the usual shapes → { tool, args }. */
function callOf(x, i) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw err(`Perintah ke-${i + 1} bukan objek.`);
  if (x.method === 'tools/call' && x.params) return callOf(x.params, i);
  const tool = x.tool ?? x.name ?? x.tool_name ?? x.function?.name;
  if (typeof tool !== 'string' || !tool) throw err(`Perintah ke-${i + 1} tidak punya nama tool ("tool": "...").`);
  let args = x.arguments ?? x.args ?? x.input ?? x.parameters ?? x.params ?? x.function?.arguments ?? {};
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { throw err(`Argumen perintah ke-${i + 1} (${tool}) bukan JSON.`); } }
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw err(`Argumen perintah ke-${i + 1} (${tool}) harus berupa objek.`);
  return { tool, args };
}

/**
 * The tool calls in a pasted text: one call, a list, JSON-RPC tools/call, or { calls | steps | commands: [...] };
 * known: the tool names this editor has (unknown names are refused with the closest ones).
 */
export function parseToolCalls(text, known = null) {
  const v = jsonOf(text);
  const list = Array.isArray(v) ? v : Array.isArray(v?.calls) ? v.calls : Array.isArray(v?.steps) ? v.steps : Array.isArray(v?.commands) ? v.commands : [v];
  if (!list.length) throw err('Daftar perintahnya kosong.');
  if (list.length > MAX_CALLS) throw err(`Terlalu banyak perintah (${list.length}); maksimal ${MAX_CALLS} sekali jalan.`);
  const calls = list.map(callOf);
  if (known) {
    const names = [...known];
    for (const c of calls) {
      if (names.includes(c.tool)) continue;
      const near = names.filter((n) => n.includes(c.tool.split('_')[0]) || c.tool.includes(n.split('_')[0])).slice(0, 3);
      throw err(`Tool "${c.tool}" tidak ada.${near.length ? ` Mungkin: ${near.join(', ')}.` : ''}`);
    }
  }
  return calls;
}

/** What to tell another AI (ChatGPT, Claude without the connector) so its answer can be pasted here. */
export function guideForOtherAi(tools, project) {
  const lines = tools.map((t) => {
    const props = t.inputSchema?.properties ? Object.entries(t.inputSchema.properties).map(([k, s]) => `${k}${(t.inputSchema.required || []).includes(k) ? '*' : ''}${s.enum ? `(${s.enum.slice(0, 12).join('|')}${s.enum.length > 12 ? '|…' : ''})` : s.type ? `:${s.type}` : ''}`).join(', ') : '';
    return `- ${t.name}: ${String(t.description || '').split('. ')[0]}.${props ? ` Argumen: ${props}` : ''}`;
  });
  return `Kamu membantu mengedit video di Najja Editor (proyek "${project || 'proyek ini'}"). Jawab HANYA dengan JSON berisi daftar perintah, tanpa penjelasan, dalam format:
[
  { "tool": "nama_tool", "arguments": { ... } }
]
Perintah dijalankan berurutan. Waktu dalam detik. Posisi x/y adalah pecahan dari tengah kanvas (-0.5..0.5). Argumen bertanda * wajib.
Tool yang tersedia:
${lines.join('\n')}

Permintaan saya: `;
}

/** A short example to start from. */
export const EXAMPLE_JSON = `[
  { "tool": "add_text", "arguments": { "text": "DISKON 50%", "start": 0, "duration": 3, "size": 150, "color": "#FFE600", "y": -0.2, "text_motion": "wordPop" } },
  { "tool": "add_sticker", "arguments": { "emoji": "🔥", "start": 0.4, "duration": 2.4, "x": 0.3, "y": -0.3 } }
]`;
