# MCP Compatibility Report — Najja Editor → Najja Creative Studio

- **Basis:** commit `86305a7` (v1.13.1), sama persis dengan yang berjalan di produksi (`/opt/najja-editor` di VPS, dicek 2026-11-23).
- **Cara audit:** baca kode (`mcp/`, `mcp-stdio.js`, `server.js`, `public/js/bridge.js`, `public/js/api.js`, `public/js/engine.js`, `lib/oauth.js`) + uji langsung ke `https://editor.najja.id/mcp` lewat konektor Claude.
- **Label:** **FAKTA** = dilihat di kode atau direproduksi. **DUGAAN** = perlu diuji di runtime.

---

## 1. Arsitektur MCP saat ini

```
MCP client (Claude, Cursor, Claude Code)
   │  Streamable HTTP  POST /mcp   (atau stdio: mcp-stdio.js → POST ke server yang sama)
   ▼
server.js  createMcpHandler (mcp/protocol.js)  →  callTool()  server.js:589
   │  Bridge.request()  server.js:193   — pilih tab editor akun itu yang paling baru aktif (pick, server.js:149)
   │  SSE event "command" {id, tool, args}  lewat GET /bridge/events
   ▼
Tab browser editor  public/js/bridge.js  run()  bridge.js:91
   │  handler di public/js/api.js  (27 fungsi)  → store.js / engine.js / actions.js
   ▼
POST /bridge/result  →  Bridge.resolveResult()  server.js:213  →  formatToolResult()  →  jawaban JSON-RPC
```

| Aspek | Kondisi (FAKTA) | Lokasi |
|---|---|---|
| Protokol | Implementasi sendiri tanpa SDK. Versi `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05` | `mcp/protocol.js:5` |
| Capability | `tools`, `prompts`. `resources/list` dan `resources/templates/list` selalu kosong | `mcp/protocol.js:90, 110-113` |
| Transport HTTP | `POST /mcp` balas JSON biasa. `GET` = 405 (tidak ada stream dari server). `DELETE` didukung | `server.js:604-640` |
| Transport stdio | `mcp-stdio.js` menyalakan server web di proses yang sama bila belum jalan, lalu meneruskan panggilan tool ke server | `mcp-stdio.js:1-4`, `server.js:906-912` |
| Autentikasi | Bearer: token AI pribadi, token server `NAJJA_TOKEN` (= admin), atau OAuth 2.1 (PKCE S256, pendaftaran klien dinamis, refresh berotasi, revoke) | `lib/oauth.js`, `server.js:604-618, 660-800` |
| Discovery OAuth | `WWW-Authenticate: Bearer resource_metadata=".../oauth/protected-resource"`. Metadata juga dilayani di `/.well-known/*` dan cadangan `/oauth/*` | `server.js:618, 670-674` |
| Tenancy | Perintah hanya dikirim ke editor milik akun pemanggil, dan hasil hanya diterima dari akun yang sama | `server.js:149-152, 211-219` |
| Timeout | `import_media` 180 dtk, `get_frame` 45 dtk, `export_video` 20 dtk, `new_project` 20 dtk, `get_transcript`/`apply_style` 50 mnt, lainnya 30 dtk. Tunggu editor terbuka 20 dtk | `server.js:92, 193-212` |
| Eksekusi | Seluruh logika tool berjalan di tab browser (`api.js`) dan memakai `store`, `engine`, `actions` milik UI | `public/js/api.js` |
| Log aktivitas | Event `mcp-activity` ke editor, log 200 entri di panel AI · MCP, klip yang diubah berkedip | `server.js:592`, `bridge.js:91-116` |

## 2. Inventaris tool (27) — kontrak v1 yang dibekukan

Kolom **Sifat**: R = baca saja, M = mengubah proyek (masuk undo), S = efek samping di luar proyek, L = lama/asinkron.

| # | Tool | Sifat | Anotasi | Catatan kompatibilitas |
|---|---|---|---|---|
| 1 | `get_project` | R | readOnly | Mengembalikan **seluruh** proyek. Proyek uji 2026-11-23 (95 klip) ≈ 25 KB JSON per panggilan |
| 2 | `list_assets` | R | readOnly | Statis per versi, cocok dijadikan resource |
| 3 | `new_project` | M+S | — | Membuka proyek baru di tab |
| 4 | `set_project` | M | — | |
| 5 | `import_media` | S+L | — | Server menyiapkan file (`prepareImport`), path dibatasi `NAJJA_MEDIA_DIR` di mode token |
| 6 | `list_media` | R | readOnly | |
| 7 | `add_media_clip` | M | — | |
| 8 | `add_text` | M | — | |
| 9 | `add_subtitles` | M | — | |
| 10 | `add_sticker` | M | — | |
| 11 | `add_solid` | M | — | |
| 12 | `add_effect` | M | — | |
| 13 | `update_clip` | M | — | Schema terbesar. Bisa memicu analisis hapus latar |
| 14 | `apply_filter` | M | — | |
| 15 | `apply_transition` | M | — | |
| 16 | `split_clip` | M | — | |
| 17 | `delete_clip` | M | destructive | |
| 18 | `move_clip` | M | — | |
| 19 | `duplicate_clip` | M | — | |
| 20 | `playback` | S | — | Mengubah status pemutar milik user |
| 21 | `get_frame` | R* | readOnly | *Sebenarnya menjeda pemutaran dan memindah playhead (`engine.js:809-815`) |
| 22 | `history` | M | — | Undo/redo memakai riwayat yang sama dengan user |
| 23 | `export_video` | S+L | — | Langsung kembali. Tidak ada `job_id`. Hanya satu ekspor sekaligus |
| 24 | `get_export_status` | R | readOnly | Melaporkan ekspor "yang sedang atau terakhir", tanpa `job_id` |
| 25 | `list_styles` | R | readOnly | |
| 26 | `get_transcript` | S+L | — | Whisper di server, hasil disimpan di proyek. Bisa beberapa menit |
| 27 | `apply_style` | M+L | — | Default membuat proyek baru. Satu undo membatalkan seluruh edit |

**Prompt (4):** `najja-showcase`, `najja-editorial`, `najja-storypop`, `najja-semua-style` (`mcp/protocol.js:34-39`).
**Resource:** tidak ada.

Nama tool di `mcp/tools.js` sama 1:1 dengan handler di `public/js/api.js` (27 = 27, dicek dengan grep).

## 3. Integrasi yang sudah ada

- **Konektor Claude** (claude.ai, desktop, HP) lewat OAuth, tanpa token manual.
- **Claude Code** lewat `claude mcp add --transport http`.
- **Claude Desktop / Cursor / VS Code** lewat stdio atau JSON konfigurasi.
- **Panel AI · MCP → Tempel JSON** (`bridge.runLocal`, `bridge.js:65`): AI tanpa MCP (ChatGPT dll.) menjalankan tool dengan JSON tempelan.
- **Prompt slash** `/najja-editorial` dan sejenisnya.
- **Benchmark** `bench/run.mjs` membangun proyek uji lewat MCP, jadi bench juga konsumen kontrak tool.

## 4. Temuan dan risiko breaking change

| ID | Risiko | Temuan | Bukti |
|---|---|---|---|
| **M1** | **Tinggi** | **Perintah tidak diantrikan.** `bridge.js:53` menjalankan setiap event `command` langsung. `engine.capture()` melakukan seek di engine bersama lalu `await` (font, cutout, settle) sebelum menggambar `this.time`. Tiga `get_frame` paralel (1.2 dtk, 3.1 dtk, 44.2 dtk) menghasilkan **tiga gambar yang sama** (frame 44.2 dtk). Tool pengubah proyek yang berjalan bersamaan juga bisa saling selip | FAKTA. Direproduksi di produksi 2026-11-23. Kode: `bridge.js:53, 91`, `engine.js:809-826` |
| **M2** | **Tinggi** (arsitektur) | **MCP bergantung pada tab editor yang terbuka.** Tanpa tab: `Najja Editor is not open in a browser for this account`. Logika tool hidup di runtime UI (`api.js` memakai `actions.app.engine`, `store`). Ini bertentangan dengan syarat §10.3 (MCP tidak boleh bergantung pada state UI atau instance kanvas) | FAKTA. `server.js:194-196`, `api.js` |
| M3 | Sedang | **Timeout bukan pembatalan.** Server menolak setelah timeout, tapi tab tetap mengeksekusi perintahnya. `notifications/cancelled` diabaikan | FAKTA. `server.js:200-203`, `protocol.js:122` |
| M4 | Sedang | **Ekspor tanpa job ID.** Hanya satu ekspor (`An export is already running`), status hanya untuk ekspor terakhir, dan tidak bisa dibatalkan lewat MCP. Belum memenuhi §10.7 | FAKTA. `api.js:434-470` |
| M5 | Sedang | **Tidak ada validasi schema di server.** `arguments` diteruskan apa adanya. Validasi hanya per handler lewat `need()`. `additionalProperties:false` di schema tidak ditegakkan | FAKTA. `protocol.js:99-108`, `api.js:25` |
| M6 | Rendah | `get_frame` berlabel `readOnlyHint` padahal menjeda pemutaran dan memindah playhead user | FAKTA. `engine.js:809-815` |
| M7 | Rendah | Dokumen tidak sinkron: README menyebut "24 tool" (ada 27). `INSTRUCTIONS` bilang ekspor "real time", deskripsi tool bilang lebih cepat dari real time dengan WebCodecs | FAKTA. `README.md:156`, `protocol.js:16`, `tools.js:325` |
| M8 | Rendah (deploy) | Di produksi `/.well-known/oauth-*` = 404 karena vhost aaPanel menangkap semua `/.well-known` (`location /.well-known{ root … }`). Kode sudah menyediakan cadangan `/oauth/*` (dites di `test/oauth.test.js:98`), tapi klien yang hanya memakai discovery RFC 8414 akan gagal | FAKTA. Konfigurasi nginx VPS baris 110, `server.js:670-674` |
| M9 | Sedang | **Cakupan test per tool.** Unit test hanya mencakup protokol, HTTP, dan OAuth (`test/mcp.test.js`, `test/oauth.test.js`). Perilaku 27 tool hanya diuji lewat e2e Playwright (tidak jalan di mesin tanpa Playwright/ffmpeg). Belum ada test tool paralel | FAKTA untuk unit. DUGAAN untuk cakupan e2e per tool |
| M10 | Rendah (biaya) | `get_project` selalu mengembalikan seluruh proyek, jadi token AI boros di proyek besar | FAKTA (teramati) |

## 5. Strategi kompatibilitas

**Aturan kontrak v1 (berlaku mulai sekarang):**
1. 27 nama tool, schema input, dan bentuk output adalah **kontrak v1**. Snapshot schema (`test/mcp-contract.test.js`, golden file `test/fixtures/mcp-contract-v1.json`) gagal kalau ada tool yang dihapus, diganti nama, atau field wajib baru. Bentuk output belum masuk snapshot (lihat §7).
2. Perubahan hanya **aditif**: parameter opsional baru, field output baru, tool baru.
3. Tool yang mau diganti tetap ada sebagai **alias** minimal 2 versi minor, dengan catatan `deprecated` di deskripsinya.
4. MCP harus tetap jalan di setiap fase migrasi. Engine yang diganti dibungkus adapter yang memenuhi kontrak yang sama.

**Fase migrasi:**

| Fase | Isi | Kontrak berubah? |
|---|---|---|
| **A — sekarang (P0)** | Antrian FIFO perintah di `bridge.js` (satu perintah sekaligus per tab, `runLocal` ikut antri) + tenggat dari server (perintah yang sudah lewat tenggat tidak dijalankan) + mutex di `engine.capture()` | Tidak. Hanya perilaku jadi benar |
| B | **Application service layer** `public/js/core/` (modul murni: model proyek, command, validasi) yang dipakai UI **dan** `api.js`. `api.js` jadi adapter tipis | Tidak |
| C | Validasi schema di server sebelum diteruskan, memakai `inputSchema` yang sama. Error konsisten `{code, message, field}` | Aditif (pesan error lebih jelas) |
| D | Job system untuk `export_video`, `get_transcript`, `apply_style`: kembalikan `job_id` (field lama tetap ada). Tool baru `get_job`, `cancel_job`. `get_export_status` menerima `job_id` opsional | Aditif |
| E | Eksekusi headless untuk tool yang tidak butuh render (baca/ubah proyek) langsung di server, di atas `storage.js` yang sudah punya revisi dan lock per proyek. Tool render (`get_frame`, `export_video`) tetap butuh tab, atau renderer headless (P7 cloud render) | Tidak (perilaku sama, tab jadi opsional untuk edit) |
| F | Tool untuk Najja Desain setelah service layer desain ada | Aditif |

## 6. Rekomendasi tool baru (aditif)

| Tool | Tujuan | Fase |
|---|---|---|
| `get_project` + opsi `fields` / `summary:true` | Hemat token: ringkasan trek dan klip tanpa semua properti | C |
| `get_clip` | Ambil satu klip | C |
| `get_frames` | Beberapa waktu dalam satu panggilan (dikerjakan berurutan), sekaligus menggantikan kebiasaan AI memanggil `get_frame` paralel | A/C |
| `batch_edit` | Banyak operasi sebagai satu langkah undo, dengan `expected_rev` untuk mencegah tabrakan dengan edit user | B |
| `get_job`, `cancel_job`, `list_jobs` | Status dan pembatalan pekerjaan lama (§10.7) | D |
| `lint_project` | Cek otomatis: teks di zona UI TikTok, sumber video di bawah resolusi ekspor, musik di-loop tanpa crossfade, klip < 0,2 dtk, salah ketik transkrip | C |
| `design_get_document`, `design_add_element`, `design_update_element`, `design_export` | Najja Desain lewat MCP | F |
| Resource `najja://assets`, `najja://project/current/summary` | Data statis atau ringkasan yang bisa di-cache klien | C |

## 7. Rencana regression test MCP

| Test | Jenis | Status |
|---|---|---|
| Protokol: initialize, list, call, error | unit | ✅ ada (`test/mcp.test.js`) |
| OAuth: discovery, connect penuh, refresh, revoke | unit | ✅ ada (`test/oauth.test.js`) |
| Snapshot kontrak 27 tool + 4 prompt | unit | ✅ ditambahkan di P0-3 (`test/mcp-contract.test.js` + `test/fixtures/mcp-contract-v1.json`, dijalankan CI). Lihat catatan di bawah |
| Setiap tool MCP punya handler di editor (`public/js/api.js`) | unit | ✅ ditambahkan di P0-3 (cek statis) |
| Antrian perintah: urutan FIFO, perintah lewat tenggat dilewati, `runLocal` ikut antri, error tidak menghentikan antrian | unit | ✅ ditambahkan (`test/cmdqueue.test.js`) |
| Kunci ekspor: tool pengubah/seek ditolak, baca tetap jalan, dicek saat giliran tiba | unit | ✅ ditambahkan di P0-2 (`test/cmdqueue.test.js`) |
| 3 `get_frame` paralel → 3 frame berbeda dan benar | e2e | ✅ ditambahkan ke `test/e2e/get-frame.mjs`, **belum dijalankan** (butuh Playwright + ffmpeg). Sudah diverifikasi manual di browser asli: v1.13.1 → biru/biru/biru, perbaikan → merah/hijau/biru |
| Satu jalur sukses + satu jalur error per tool (27 tool) | e2e | ➕ baru (fase B) |

**Snapshot kontrak (P0-3):** `node test/mcp-contract.mjs --update` menulis snapshot dari `tools/list` dan `prompts/list` handler protokol yang asli, dan **menolak** menulis bila ada perubahan yang merusak. Yang diperiksa: tool dan prompt tidak hilang atau diganti nama, parameter tidak hilang, tidak ada parameter atau argumen prompt wajib yang baru, tipe tidak berubah (integer → number boleh), nilai `enum` tidak berkurang, batas `minimum`/`maximum`/`minItems`/`maxItems` tidak menyempit, objek tidak mulai menolak field lain, tool read-only tidak berubah jadi pengubah, dan tool tidak menjadi destruktif. Deskripsi dan judul boleh diubah bebas. **Belum dicakup:** bentuk output tool, karena hasil tool berupa data bebas tanpa `outputSchema`. Itu ditangani test per tool di fase B.

**Status M5 (2026-11-23):** validasi argumen di server (P0-6a, `mcp/validate.js`) sudah ada, dan sengaja tidak memutus panggilan lama: hanya tipe yang mustahil benar yang ditolak; sisanya dikonversi atau dicatat (`Note: …` di akhir hasil). Branch `feat/p0-6-mcp-validation`, belum di-push.

**Status M8 (2026-11-23):** snippet `deploy/aapanel/najja-wellknown.conf` disiapkan di P0-4 (meneruskan hanya `/.well-known/oauth-*` dan `/.well-known/openid-configuration` ke app). **Belum dipasang di VPS.**

**Status M1 (2026-11-23):** diperbaiki di P0-1 (branch `feat/p0-1-mcp-command-queue`), belum di-push dan belum di-deploy ke produksi.

**Kunci ekspor (P0-2, 2026-11-23):** selama ekspor merender, hanya `get_project`, `list_assets`, `list_media`, `list_styles`, `get_export_status`, dan `export_video` yang dijalankan. Tool lain menjawab error "Not run: a video export is rendering…" dan proyek tidak berubah. Kontrak (nama, schema, bentuk hasil) tetap. Branch `feat/p0-2-autosave-export-lock`, belum di-push dan belum di-deploy.

**MCP belum boleh dinyatakan selesai migrasi** sebelum semua test di atas lulus di desktop dan iPad.
