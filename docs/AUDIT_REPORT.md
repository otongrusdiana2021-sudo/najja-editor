# Audit Report — Najja Editor v1.13.1 (menuju Najja Creative Studio)

- **Tanggal:** 2026-11-23
- **Basis kode:** commit `86305a7`, sama dengan produksi (`/opt/najja-editor` di VPS, Docker Compose, di belakang nginx aaPanel → `127.0.0.1:3333`).
- **Metode:** baca kode per modul (server, MCP, video engine, Najja Desain, UI shell), jalankan unit test, uji black-box ke `https://editor.najja.id`, dan uji MCP langsung pada proyek produksi "cek ai test · Editorial Review".
- **Label status:** **FAKTA** = dilihat di kode (dengan file:baris) atau direproduksi. **DUGAAN** = masuk akal dari kode, tapi perlu diuji di runtime atau di perangkat.
- **Verifikasi:** audit modul video engine dan Najja Desain dikerjakan dua auditor terpisah. Semua temuan berisiko Tinggi dicek ulang langsung di kode (V1, V2, U1, U2, M1, D2).

## 0. Sumber spesifikasi

| Dokumen | Status |
|---|---|
| `DESIGN.md` | ✅ Ada (dari user, disalin ke `docs/DESIGN.md`) |
| `MASTER_BLUEPRINT.md`, `PRD.md`, `TECHNICAL_ARCHITECTURE.md`, `MIGRATION_PLAN.md`, `DEVELOPMENT_ROADMAP.md` | ❌ Tidak ditemukan (dicari di repo dan seluruh Mac lewat Spotlight) |
| `ENGINEERING_STANDARDS.md`, `VIDEO_ENGINE_SPEC.md`, `DESIGN_ENGINE_SPEC.md`, `AUDIO_ENGINE_SPEC.md`, `COLOR_MANAGEMENT_SPEC.md`, `PERFORMANCE_BENCHMARK.md`, `TESTING_QA_STRATEGY.md`, `SECURITY_RELIABILITY.md`, `DEVICE_COMPATIBILITY.md`, `ENGINE_API_CONTRACT.md` | ❌ Tidak ditemukan |
| Dokumen internal repo | ✅ `docs/NAJJA-VIDEO-IMPLEMENTATION-PLAN.md` (P0–P7 lama), `docs/ANALISA-LAG-IPAD.md`, `docs/NAJJA-VIDEO-V1.7-LAPORAN.md`, `docs/NAJJA-DESAIN.md`, `docs/STYLE-KONSEP.md`. Kode menyebut "Performance Blueprint §9.1–9.3", tapi file blueprint itu tidak ada di repo |

Isi dokumen yang tidak ada **tidak dikarang**. Rencana ini berpegang pada `DESIGN.md`, directive dari product owner, dan kondisi kode.

> **Konflik penting dengan `DESIGN.md` §3.1:** dokumen itu menggambarkan editor dengan media di kiri, inspector di kanan, dan timeline di bawah. **Najja Editor yang sebenarnya tidak begitu.** Tata letaknya vertikal ala tablet: topbar (56 px) → pratinjau → timeline dengan playhead di tengah → toolbar ikon besar di bawah → panel muncul sebagai *sheet* dari bawah (`public/css/app.css:81`, `public/index.html:22-26`). Sesuai aturan utama `DESIGN.md` ("preserve what users recognize"), tata letak **yang sebenarnya** yang dipertahankan, dan `DESIGN.md` §3.1 perlu dikoreksi (lihat U5).

## 1. Ringkasan arsitektur (FAKTA)

| Lapisan | Isi |
|---|---|
| Frontend | Vanilla JS ES module, tanpa framework dan tanpa bundler (`public/js/*.js`, ±20 ribu baris). Najja Desain = halaman terpisah (`public/design.html`, `public/js/design/`) |
| Server | Node.js tanpa dependency (`server.js` 1.203 baris + `lib/`). Penyimpanan berbasis file di `data/` (volume Docker `najja-editor_najja-data`) |
| Layanan AI | Python + onnxruntime (`ai/server.py`), container terpisah `najja-editor-ai-1`: hapus latar, upscale, Whisper |
| Model proyek | `store.P` (`store.js`). Waktu = detik float. Undo/redo = snapshot JSON penuh (maks. 150). Autosave debounce 700 ms ke server dengan `baseRev` + draft IndexedDB |
| Pemutaran | `engine.js`: rAF + worker cadangan 16 ms. Jam = `AudioContext.getOutputTimestamp`, video mengikuti. Satu elemen `<video>` per potongan file, digilir (v1.12.7) |
| Compositor | `renderFrame` (`render.js:1660`), Canvas 2D + WebGL1 untuk chroma key/blur. **Dipakai bersama** oleh pratinjau, ekspor cepat, dan ekspor real-time |
| Proxy | Server membuat salinan 720p (pratinjau) dan H.264 1080p (ekspor) dengan ffmpeg. Salinan di perangkat disimpan di OPFS (5 GB, LRU) |
| Ekspor | Cepat: demux MP4 buatan sendiri → `VideoDecoder` → `renderFrame` → `VideoEncoder` H.264 → mux MP4, spool ke OPFS. Cadangan: `MediaRecorder` real-time |
| MCP | 27 tool + 4 prompt, protokol sendiri. **Tool dijalankan di tab browser** lewat SSE bridge. Detail: [`MCP_COMPATIBILITY_REPORT.md`](MCP_COMPATIBILITY_REPORT.md) |
| Auth | Login email+password per akun, cookie `HttpOnly; SameSite=Lax; Secure`, rate limit login 10×/15 menit, cek Origin, OAuth 2.1 untuk MCP, data dipisah per akun |
| Test | 24 file unit test (`node --test`), 14 skenario e2e Playwright, benchmark `bench/run.mjs` (fixture B0–B5, profil desktop/iPad). **Tidak ada CI** (tidak ada `.github/`) |

## 2. Quality gate baseline (sebelum perubahan apa pun)

| Gate | Hasil | Catatan |
|---|---|---|
| Build | n/a | Tidak ada langkah build (vanilla JS, tanpa dependency) |
| Unit test (`npm test`, Node 26.8.2) | **122 lulus, 8 gagal, 13 dilewati** dari 143 | 7 gagal karena **disk Mac penuh** (sisa ±300 MB, server menolak upload bila sisa < 512 MB → HTTP 507, `lib/storage.js:69-71`). 1 gagal karena ffmpeg tidak terpasang (T2). **Bukan regresi kode** |
| E2E (`npm run test:e2e`) | Tidak dijalankan | Paket `playwright` dan ffmpeg tidak ada di Mac, dan disk penuh |
| Benchmark (`bench/run.mjs`) | Tidak dijalankan | Alasan sama. Hasil lama ada di `bench/results/` (2026-11-13 s.d. 2026-11-18, desktop dan iPad) |
| Console error | Belum dicek | Perlu sesi browser khusus |

## 3. Temuan

Kolom: **Risiko** T/S/R (Tinggi/Sedang/Rendah) · **Kompl.** S/M/L · **Status** FAKTA/DUGAAN.

### 3.1 MCP dan integrasi AI (detail di `MCP_COMPATIBILITY_REPORT.md`)

| ID | Risiko | Status | Lokasi | Masalah → dampak ke user | Solusi | Kompl. | Dependensi |
|---|---|---|---|---|---|---|---|
| M1 | T | FAKTA (direproduksi) | `public/js/bridge.js:53, 91`; `public/js/engine.js:809-826` | Perintah MCP tidak diantrikan, dan `capture()` me-seek engine bersama lalu `await` sebelum menggambar. 3 `get_frame` paralel → 3 gambar identik. Edit paralel bisa saling selip → AI menilai hasil dari gambar yang salah | Antrian FIFO per tab + tenggat dari server + mutex di `capture()` | S | — |
| M2 | T | FAKTA | `server.js:193-212`; `public/js/api.js` | Semua tool butuh tab editor terbuka, dan logika tool ada di runtime UI → AI tidak bisa bekerja kalau tab tertutup. Melanggar §10.3 | Service layer (`core/`) dipakai UI dan MCP, lalu eksekusi headless untuk tool non-render | L | P0-2 |
| M3 | S | FAKTA | `server.js:200-203`; `mcp/protocol.js:122` | Timeout server tidak membatalkan perintah di tab → edit tetap terjadi setelah AI menerima error | Tenggat ikut dikirim ke tab, dan `notifications/cancelled` diteruskan | S | M1 |
| M4 | S | FAKTA | `public/js/api.js:434-470` | Ekspor tanpa `job_id`, satu ekspor sekaligus, tidak bisa dibatalkan lewat MCP | Job system aditif | M | P0-2 |
| M5 | S | FAKTA | `mcp/protocol.js:99-108` | Schema input tidak ditegakkan di server → argumen salah baru gagal di tab (atau diam-diam diabaikan) | Validasi schema di server | M | — |

**Status perbaikan (2026-11-23):** M1 diperbaiki di P0-1. M5 diperbaiki di P0-6a (validasi argumen di server, tanpa memutus panggilan lama). M8 disiapkan di P0-4 (snippet nginx, belum dipasang).

### 3.2 Video engine

| ID | Risiko | Status | Lokasi | Masalah → dampak ke user | Solusi | Kompl. | Dependensi |
|---|---|---|---|---|---|---|---|
| V1 | T | FAKTA (409 palsu direproduksi di unit test P0-2) | `public/js/store.js:592`, `484-499` | `_save` membuang ack server bila `this.project !== project`. Undo/redo/batal membuat objek proyek baru → `baseRev` basi → save berikutnya bisa memunculkan dialog "diubah di perangkat lain" padahal hanya satu perangkat | Bandingkan `project.id`, terapkan `res.rev` | S | — |
| V2 | T | FAKTA | `public/js/fastexport.js:634` | Klip bersuara dengan kecepatan ≠ 1 membuat seluruh ekspor jatuh ke mode real-time → ekspor selama durasi video, dengan pacing frame tidak stabil | Time-stretch offline (pakai algoritma pratinjau / `voicedsp.js`) | M | — |
| V3 | S | FAKTA | `public/js/exporter.js:225-226, 273`; `fastexport.js:898` | Ekspor > 4 GB ditolak jalur cepat (MP4 32-bit), dan jalur real-time menampung semua chunk di RAM → ekspor panjang/4K paling rawan | `co64` / fragmented MP4 ke spool OPFS | M | — |
| V4 | S | FAKTA | `fastexport.js:1037-1100`; `render.js:1660` | Loop ekspor (demux, render, encode, mux) di main thread → UI macet saat ekspor berat, lambat di iPad dan tab tersembunyi | Pindah ke module Worker + `OffscreenCanvas` | L | Lepas ketergantungan font/DOM di `render.js` |
| V5 | S | FAKTA | `public/js/app.js:302-303, 789` | Pintasan keyboard tetap aktif selama ekspor (overlay ekspor bukan `.modal-wrap`). Spasi menjeda engine → ekspor real-time menggantung | Kunci pintasan dan handler MCP selama `exportState.state==='running'` | S | — |
| V6 | S | FAKTA | `engine.js:199-209, 516`; `timeline.js:591, 799-830`; `store.js:9, 201-217` | Waktu edit (scrub, split, trim) tidak dibulatkan ke frame, dan klip minimum 0,1 dtk (±3 frame) → tidak frame-accurate, bisa ada celah sub-frame di sambungan | Kuantisasi `round(t·fps)/fps` di batas edit; klip minimum 1 frame | M | Aturan pemilihan frame bersama (V7) |
| V7 | S | DUGAAN | `engine.js:516` vs `fastexport.js:415-430` | Pratinjau (elemen `<video>`, proxy 720p) dan ekspor (`VideoDecoder`, salinan penuh) memilih frame dengan aturan berbeda → selisih ±1 frame atau warna (BT.601/709) | Golden-frame test pratinjau vs ekspor | M | V6 |
| V8 | R | FAKTA | `exporter.js:164`; `fastexport.js:933` | Percobaan pertama memakai decoder software → lebih lambat dari hardware di desktop | Pilih decoder per resolusi/platform dari statistik `decoder_accel` | S | Telemetri |
| V9 | R–S | DUGAAN | `public/js/media.js:149-155` | Video yang tidak bisa di-decode browser (mis. HEVC iPhone) diekspor dari salinan H.264 1080p → ekspor 4K hasil upscale | Peringatan di dialog ekspor, atau salinan 4K bila target > 1080p | M | Server proxy |
| V10 | S (proyek panjang) | FAKTA | `fastexport.js:629-684, 592-600` | Mix audio offline satu buffer untuk seluruh durasi (±23 MB/menit) → proyek 1 jam ±1,4 GB RAM, iPad bisa crash | Mix dan encode per blok 30–60 dtk | M | — |
| V11 | R | FAKTA | `fastexport.js:629-684` vs `audio.js:325-350` | Logika volume/fade ditulis dua kali (pratinjau dan ekspor) → risiko beda di fitur audio berikutnya | Satu fungsi `gainEnvelope(clip)` bersama | S | — |
| V12 | S | DUGAAN | `engine.js:81-82`; `exporter.js:212-258` | Ekspor real-time bergantung pada rAF/worker yang dibatasi browser saat tab tersembunyi → frame hilang atau dobel | Wake Lock + peringatan `visibilitychange` saat fallback dipilih | S | — |
| V13 | S | FAKTA | `store.js:434-458, 484-499` | Undo menyimpan `JSON.stringify` seluruh proyek per langkah (150 langkah, stringify 2× per edit) → edit dan undo makin lambat di proyek besar | Riwayat berbasis patch; jangka pendek hilangkan stringify kedua | L (S untuk perbaikan kecil) | — |
| V14 | R–S | FAKTA | `store.js:402-415, 616`; `app.js:93-102, 345-346` | `beforeunload` tidak flush draft 400 ms. Retry save tetap 5 dtk tanpa backoff. Thumbnail JPEG dibuat di setiap autosave → edit terakhir bisa hilang, server dibanjiri retry, main thread terbebani | Flush draft saat unload, backoff, thumbnail hanya saat sampul berubah | S | — |
| V15 | S | FAKTA (kode); dampak DUGAAN | `timeline.js:100-118, 255`; `store.js` (`clip()` = `Array.find`) | Setiap event `project` membangun ulang seluruh HTML lane, dan `relayout()` O(n²) → drag/trim lambat dengan ratusan klip subtitle | `Map` indeks klip + render klip di viewport saja | M | — |
| V16 | R | FAKTA | `gpufx.js:199`; `render.js:216, 257` | `webglcontextlost` mematikan WebGL permanen tanpa restore → chroma/blur diam-diam pindah ke CPU (lambat). Tidak ada jalur WebGPU di compositor | Handler `webglcontextrestored`. WebGPU hanya dengan feature detection + fallback | S | — |
| V17 | R | FAKTA | `fastexport.js:1072` | `i % (fps*2)` tidak pernah 0 untuk fps pecahan (29,97) → GOP sangat panjang, seek buruk | `Math.round(fps*2)` | S | — |
| V18 | R | FAKTA (teramati di browser lokal) | Polling sinkron proyek (`/api/projects/:id/rev`) | Proyek baru yang belum pernah tersimpan tetap dipoll ±1×/dtk → 404 berulang di console dan "request error: Project not found" di log server | Jangan poll sebelum save pertama sukses | S | — |
| V19 | R | FAKTA (teramati di browser lokal) | `public/js/app.js` `pollRevision` | Proyek yang sedang terbuka lalu dihapus (dari perangkat lain atau tab lain) tetap dipoll `/rev` tiap detik → 404 berulang di console dan "Project not found" di log server, dan editor tidak memberi tahu pengguna bahwa proyeknya sudah tidak ada | Pada 404, hentikan polling untuk proyek itu dan tampilkan pemberitahuan (simpan sebagai salinan / kembali ke beranda) | S | — | **Diperbaiki 2026-11-23** (branch `fix/v19-deleted-project`). Saat uji ditemukan juga bahwa autosave yang tertunda membuat ulang proyek yang dihapus secara diam-diam; server kini menjawab 410 dan editor serta Desain bertanya ke pengguna |
| V20 | S | FAKTA (direkam di `test/update-clip.test.js`) | `public/js/core/clipedit.js` `updateClip` (dulu `api.js` `update_clip`) | Argumen diterapkan satu per satu di dalam `store.mutate`. Kalau argumen yang belakangan ditolak (mis. `filter` tak dikenal), argumen sebelumnya (mis. `x`) **sudah masuk** ke proyek, tanpa langkah undo, dan AI menerima error seolah tidak ada yang berubah | Validasi semua argumen dulu (atau kerjakan di salinan), baru ubah proyek. Mengubah perilaku, jadi rekaman `update-clip-golden.json` untuk skenario itu sengaja diperbarui | S | — | **Diperbaiki 2026-11-23** (branch `fix/v20-update-clip-atomic`): semua argumen dicek pada salinan proyek dulu |

**Status perbaikan (2026-11-23):** V1, V5, dan V18 diperbaiki di P0-2. V14 diperbaiki sebagian (flush draft saat unload dan backoff retry; thumbnail per-autosave ditunda ke P2). Detail dan bukti test ada di `IMPLEMENTATION_PLAN.md` → Log milestone P0-2. Belum di-deploy.

### 3.3 Najja Desain (design engine)

| ID | Risiko | Status | Lokasi | Masalah → dampak ke user | Solusi | Kompl. | Dependensi |
|---|---|---|---|---|---|---|---|
| D1 | T | FAKTA (tanpa batas); gagal = DUGAAN | `public/js/design/ui.js:1228-1233`; `design/app.js:550-574`; `design/model.js:33` | Ukuran desain sampai 8000×8000 (64 MP), tapi hanya ekspor 2× yang dibatasi. Ekspor 1× > ±16,7 MP di Safari iPad bisa kosong atau `toBlob` null | Tile/downscale saat ekspor, atau batas per perangkat + peringatan | M | — |
| D2 | T | FAKTA | `design/assets.js:88-91` | Foto yang gagal dimuat saat ekspor dilewati diam-diam (`catch {}`), toast tetap "Diunduh" → file marketplace keluar tanpa foto produk | Kumpulkan yang gagal, batalkan/peringatkan sebelum ekspor | S | — |
| D3 | S | FAKTA | `render.js:31-40`; `design/app.js:553-554`; `design.html:16` | Font Google tidak dijamin termuat (timeout 2,5–3 dtk lalu tetap menggambar) → ekspor pertama saat offline/lambat bisa pakai font pengganti | `document.fonts.check()` per font, blokir/peringatkan | S | — |
| D4 | S | FAKTA | `design/app.js:147-185, 602-604` | Tidak ada draft lokal: saat server tidak terjangkau, perubahan hanya di memori → tab ditutup/dibuang Safari = kerja hilang | Cermin dokumen kotor ke IndexedDB + pulihkan saat buka | M | — |
| D5 | S | FAKTA | `design/model.js:34-47` | `normalizeDesign` tidak punya rantai migrasi versi dan tidak memvalidasi elemen → risiko saat format dokumen berubah | `migrate(d)` per `designV` + validasi | S–M | — |
| D6 | S | FAKTA | `design/assets.js:56-64` | Semua foto disimpan versi penuh (sampai 6000 px ≈ 144 MB bitmap) sepanjang sesi → tab iPad bisa dimatikan | Decode original hanya saat ekspor, lalu `close()` | M | — |
| D7 | S | FAKTA | `design/app.js:571`; `design/zip.js:57-67` | ZIP multi-halaman menyalin data ±3× di memori | Streaming blob ke ZIP | M | — |
| D8 | S | DUGAAN | `design/ui.js:1263-1267` | `navigator.share` dipanggil setelah `await` ekspor beberapa detik → iOS bisa menolak (aktivasi user hilang), lalu muncul "Ekspor gagal" padahal file sudah jadi | Render dulu, atau fallback unduh saat `NotAllowedError` | S | — |
| D9 | R–S | FAKTA | `design/stage.js:253-258` | Di layar sentuh, satu jari di area kosong selalu menggeser kanvas → tidak ada multi-select lewat sentuh. Pencil diperlakukan sama dengan jari | Gestur seleksi sentuh (mis. tekan lama + tarik), mode Pencil | M | — |
| D10 | R–S | DUGAAN | `public/css/design.css:15`; `design.html:8` | Topbar tetap tanpa `safe-area-inset` → saat dipasang sebagai PWA bisa tertutup status bar | `viewport-fit=cover` + `env(safe-area-inset-top)` | S | Uji visual iPad |

**Status perbaikan (2026-11-23):** D1, D2, dan D3 diperbaiki di P0-5 (ekspor berhenti dengan daftar foto bila foto gagal; font yang belum termuat diberi tahu dengan opsi "Tetap unduh"; ukuran di atas batas perangkat diperkecil otomatis). D1 di iPad asli belum diuji. Detail di `IMPLEMENTATION_PLAN.md` → Log milestone P0-5.

### 3.4 UX, aksesibilitas, design token

| ID | Risiko | Status | Lokasi | Masalah → dampak ke user | Solusi | Kompl. | Dependensi |
|---|---|---|---|---|---|---|---|
| U1 | S | FAKTA | `public/js/toolbar.js:181-182, 199-203`; `app.js:254-260`; `timeline.js:275` | 14 alat "Segera" (Video AI, Retouch, Lipsync, Stabilkan, Mask, dll.) dan "Pemotong klip AI" berupa tombol aktif tanpa `disabled`/`aria-disabled`. Hanya warna abu-abu + badge + toast. Tidak pura-pura jalan, tapi belum sesuai aturan "tidak ada tombol palsu" | `aria-disabled="true"`, tidak bisa difokus sebagai aksi; penjelasan cukup di tooltip | S | — |
| U2 | S–T | FAKTA | `public/js/app.js:308` | Spasi selalu memutar/menjeda, termasuk saat fokus ada di `<button>` → user keyboard tidak bisa menekan tombol dengan Spasi | Abaikan bila target `button`, `[role=button]`, `a` | S | — |
| U3 | R–S | FAKTA | `app.css` (tanpa `prefers-reduced-motion`, `:575`); `design.css:18, 120` | Tidak menghormati reduced-motion. Beberapa elemen Desain `outline:none` tanpa `:focus-visible` | Blok reduced-motion global + `:focus-visible` di Desain | S | — |
| U4 | S | FAKTA | `design.css:35, 98`; `app.css:103`; `design/ui.js:443-446` | Banyak target sentuh 30–40 px (di bawah 44 pt Apple). Tombol ikon lapisan Desain hanya `title`, tanpa `aria-label` | Minimum 44 px untuk `(pointer:coarse)` + `aria-label` | S | — |
| U5 | R (risiko), L (kerja) | FAKTA | `app.css:81`; `index.html:22-26` | Di desktop lebar tata letaknya sama dengan tablet yang direntangkan (tanpa inspector samping) → ruang terbuang di desktop. **Bertentangan dengan deskripsi `DESIGN.md` §3.1** | Breakpoint desktop (≥ 1280 px) yang **menambah** panel samping tanpa memindah kontrol inti; validasi dengan user dulu | L | Keputusan product owner |
| U6 | R | FAKTA | `app.js:302-327`; `index.html:26` | Tidak ada J/K/L, I/O, `[`/`]`. Sheet `role="dialog"` tanpa focus trap | Tambah pintasan pro + focus trap | S | — |
| U7 | R | FAKTA | `app.css:4-44`; `design.css:3-5` | Token tidak seragam: aksen video `#47c9d7`, aksen Desain `#129aa9`. Video gelap, Desain terang. Radius 4/5/7/9/10/12 px tidak semua jadi token | Ekstrak ke `tokens.css` bersama (nilai asli, tanpa ganti warna merek) | S | — |

**Token yang diekstrak dari aplikasi (untuk `DESIGN.md` §4):**

| Token semantik | Video editor (`app.css`) | Najja Desain (`design.css`) |
|---|---|---|
| `--najja-app-bg` | `#0f0f11` (`:4`) | `#eceef2` (`:3`) |
| `--najja-panel-bg` | `#18181b` (`:5`) | `#ffffff` (`:3`) |
| `--najja-panel-raised` | `#1f1f23` / `#29292e` (`:6-7`) | `#f6f7f9` rail (`:3`) |
| `--najja-text-primary` | `#f2f2f5` (`:11`) | `#1b2430` (`:3`) |
| `--najja-text-secondary` | `#b8b8c2` / `#76767f` (`:12-13`) | `#5b6676` / `#8d97a5` (`:3`) |
| `--najja-border` | `#26262b` / `#36363d` (`:9-10`) | `#e2e5ea` / `#d3d8df` (`:3`) |
| `--najja-accent` | `#47c9d7`, gradasi ke `#22d3c5` (`:15-19`) | `#129aa9` / `#0d7f8c`, seleksi `#19b3c4` (`:4`) |
| `--najja-success` / `warning` / `danger` | `#2ed47a` / `#ffb020` / `#ff4d6d` (`:20-22`) | — / — / `#e5484d` (`:4`) |
| Radius | `10px`, `7px` (`:35-36`) | `12px` (`:5`) |
| Font | Poppins (UI), Raleway (wordmark) | Poppins |
| Tinggi | topbar 56 px (52 ≤600 px), timeline `clamp(200px,32vh,340px)`, toolbar 82 px (`:38-40`) | — |

### 3.5 Server, keamanan, deploy

| ID | Risiko | Status | Lokasi | Masalah → dampak ke user | Solusi | Kompl. | Dependensi |
|---|---|---|---|---|---|---|---|
| S1 | S | FAKTA (curl) | `server.js:666` (hanya halaman OAuth) | Halaman login dan aplikasi tanpa `Content-Security-Policy`, `X-Frame-Options`/`frame-ancestors`, `X-Content-Type-Options`, `Referrer-Policy` → aplikasi bisa di-iframe (clickjacking), tanpa lapisan pertahanan XSS | Header keamanan di semua respons HTML (CSP dimulai mode report-only) | S–M | Inventaris skrip/font eksternal |
| S2 | R | FAKTA | nginx VPS `editor.najja.id.conf:110` | `/.well-known/*` ditangkap nginx aaPanel → discovery OAuth standar 404 (cadangan `/oauth/*` jalan) | `location ^~ /.well-known/oauth-` → proxy ke app (sertifikat ACME tetap jalan) | S | Akses panel VPS |
| S3 | S | FAKTA (DNS) | DNS `najja.id` | `www.editor.najja.id` tidak punya record DNS → link dengan www gagal total | Record CNAME/A `www.editor` + redirect 301 | S | Akses DNS |
| S4 | R | FAKTA | Deploy produksi | Produksi memakai aaPanel nginx + Docker Compose di `/opt/najja-editor`, sedangkan `deploy/install.sh` di repo memakai Caddy. Jalur deploy nyata tidak terdokumentasi | Dokumentasikan deploy aaPanel di `docs/DEPLOY.md` | S | — |
| S5 | R | FAKTA (kode); kebocoran DUGAAN | `public/sw.js` (`networkFirst`) | Service worker menyimpan shell halaman yang sudah login dan tidak dibersihkan saat logout → di perangkat bersama, shell bisa terlihat saat offline | Hapus cache saat logout; cek apakah HTML memuat data akun | S | — |
| S6 | — | FAKTA (positif) | `server.js:760-794, 229-238`; `lib/tenancy.js` | Rate limit login, cek Origin, cookie aman, data per akun, OAuth PKCE sudah benar. **Pertahankan** | — | — | — |
| S7 | S | FAKTA (kode); dampak = DUGAAN | `public/js/store.js` (draft IndexedDB), `public/js/devicecache.js` (OPFS) | Setelah **Keluar**, draft perubahan proyek (isi proyek lengkap) dan salinan media di perangkat tetap tersimpan. Di perangkat bersama, akun berikutnya tidak bisa membukanya lewat app (data server per akun), tapi datanya masih ada di penyimpanan browser | Keputusan produk: (a) simpan dulu lalu hapus draft + salinan media saat keluar (aman untuk perangkat bersama, media harus diunduh ulang), atau (b) pisahkan penyimpanan per akun. Jangan hapus draft yang belum sampai server | M | Keputusan pemilik produk |

**Status perbaikan (2026-11-23):** S1, S4, dan S5 (cache shell) dikerjakan di kode P0-4. S2 **dipasang di VPS pada 2026-11-23** (snippet `deploy/aapanel/najja-wellknown.conf`; path OAuth `/.well-known/` kini 200). S3 (DNS `www`) masih menunggu akses pengelola DNS. S7 ditemukan saat P0-4 dan menunggu keputusan. Detail di `IMPLEMENTATION_PLAN.md` → Log milestone P0-4.

### 3.6 Test dan kualitas

| ID | Risiko | Status | Lokasi | Masalah → dampak | Solusi | Kompl. | Dependensi |
|---|---|---|---|---|---|---|---|
| T1 | S | FAKTA | — | Tidak ada CI. Unit dan e2e hanya dijalankan manual → regresi bisa lolos ke produksi | GitHub Actions: `npm test` + e2e Playwright (Chromium + WebKit) | M | — |
| T2 | R | FAKTA | `test/proxy.test.js:136` | Satu test ffmpeg tidak memakai `{ skip }` → gagal (bukan dilewati) di mesin tanpa ffmpeg | Tambah `{ skip }` | S | — |
| T3 | S | FAKTA | `test/mcp.test.js` | Unit test MCP hanya protokol/HTTP. Perilaku 27 tool hanya di e2e. Tidak ada test paralel | Snapshot kontrak + test antrian + e2e per tool | M | M1 |
| T4 | S | FAKTA | — | Tidak ada test perangkat iPad sungguhan. E2E iPad = emulasi viewport + sentuh di Chromium | Uji manual terjadwal di iPad (Safari) per rilis + WebKit Playwright | M | — |
| T5 | S | FAKTA (CI merah sekali, lalu hijau dengan kode yang sama); penyebab = DUGAAN | CI run 45132571639; `test/security.test.js`, `test/ai.test.js` | Ada test yang kadang gagal di CI (flaky), dan namanya tidak tercatat karena log butuh login. Kandidat terkuat: `security.test.js` (2 server) dan `ai.test.js` (1 server) memilih port acak di rentang yang sama (39500–39899) sementara file test jalan paralel. Port bentrok membuat server gagal start, dan semua test di file itu gagal (±0,75% per run) | Port diminta ke OS (`listen(0)`, seperti `image.test.js`). CI kini menulis test yang gagal sebagai anotasi publik (`test/ci-annotate.mjs`), jadi kalau terulang, namanya terlihat Juga teramati sekali di lokal (2026-11-23): `test/jobs.test.js` "restart: queued and interrupted jobs…" gagal saat suite penuh paralel, tapi lulus 5× saat berdiri sendiri (memakai `until()` yang menunggu status job) | S | — | **`jobs.test.js` diperbaiki 2026-11-23:** penyebabnya race di test. `start()` mengubah status ke `running` di memori sebelum journal ditulis ke disk, sementara test hanya menunggu status di memori lalu antrian kedua membaca disk. Test kini menunggu journal di disk. 4× suite penuh lulus (sebelumnya gagal 2 dari 3). **Diagnosis itu belum lengkap (2026-11-23, sore):** test masih gagal ±1 dari 12 run. Akar sebenarnya ada di `lib/jobs.js`, yaitu dua penulisan journal untuk job yang sama saling balapan. Job bisa mulai saat tulisan pertamanya (`queued`) masih di jalan, lalu tulisan lama itu mendarat terakhir. Hasilnya journal tetap `queued` untuk job yang berjalan (28 dari 400 run di loop). Diperbaiki dengan penulisan berantai per job, plus test deterministik (gagal 10/10 sebelum, lulus 10/10 sesudah). Loop 0 dari 400, `jobs.test.js` lulus 50/50 |

**Status perbaikan (2026-11-23):** T1 (CI unit di GitHub Actions; e2e belum), T2, dan T3 (snapshot kontrak) dikerjakan di P0-3. Run CI pertama di GitHub sukses (Node 22). Detail di `IMPLEMENTATION_PLAN.md` → Log milestone P0-3.

### 3.7 Kualitas hasil Style Konsep (dari proyek produksi "cek ai test · Editorial Review")

Diamati lewat `get_project` / `get_frame` pada 2026-11-23. Angka dan posisi = FAKTA dari data proyek. Penyebab di `styles.js` = DUGAAN (belum ditelusuri).

| ID | Risiko | Temuan | Solusi |
|---|---|---|---|
| C1 | S | Musik 22,6 dtk diulang 3× dengan potongan keras di 22,6 dtk dan 45,2 dtk, tanpa crossfade | Crossfade otomatis di setiap loop musik |
| C2 | R | Ada klip 0,14 dtk (49,26–49,40 dtk) → kedipan 4 frame | Gabungkan potongan < 0,3 dtk ke tetangganya |
| C3 | S | 42 SFX dalam 51 dtk di 4 track, beberapa berdempetan (pop 28,37+28,67; swipe 49,5+49,8) → terlalu ramai | Batas kepadatan SFX dan jarak minimum per jenis |
| C4 | S | Subtitle bawah (y +0,38) dan stiker "Pink" di kanan tengah masuk area caption/tombol TikTok | Zona aman per platform di aturan penempatan |
| C5 | S | Sumber 720×1280 diekspor ke 1080×1920 dengan punch-in 1,28× → gambar pecah | Peringatan resolusi sumber; batasi punch-in untuk sumber < 1080p |
| C6 | R | Transkrip salah ("aku punya yang one -uping dan") | Tampilkan kata dengan keyakinan rendah agar dicek user |
| C7 | R | Judul "TRAVEL BAG OLIVE", padahal tas dan ucapan "pink" | Cek konsistensi nama produk dengan warna yang diucapkan (dari data `moments`) |

## 4. Yang sudah bagus dan wajib dipertahankan

- **Satu compositor bersama** (`renderFrame`) untuk pratinjau dan dua jalur ekspor. Ini alasan utama pratinjau dan ekspor sama.
- **Jam audio sebagai master** dengan cadangan jam dinding yang dibatasi (`engine.js:236-285`).
- **Ekspor cepat berlapis pengaman:** timeout, deteksi frame basi, retry dengan pasangan codec lain, fallback real-time, `VideoFrame.close()` rapi, backpressure encoder, spool OPFS.
- **Autosave dan sinkron multi-perangkat:** revisi + dialog konflik, draft IndexedDB, flush saat `visibilitychange`.
- **Keamanan dasar sudah benar:** tenancy per akun, OAuth PKCE, rate limit, cookie aman, cek Origin.
- **Model Najja Desain murni dan dites** (24 test), dengan caching lapisan saat drag.
- **Benchmark harness** dengan fixture dan profil iPad sudah ada. Fondasi bagus untuk aturan "tidak klaim performa tanpa benchmark".

## 5. Gap terhadap directive Najja Creative Studio

| Syarat directive | Kondisi sekarang | Temuan terkait |
|---|---|---|
| Frame-accurate timeline | Waktu float tanpa kuantisasi | V6, V7 |
| Background rendering, kerja berat di luar main thread | Ekspor dan compositing di main thread. Worker hanya untuk tick dan voicefx | V4 |
| WebCodecs dengan fallback | ✅ Ada, dengan fallback MediaRecorder | V2, V3 |
| WebGPU dengan fallback aman | Compositor tanpa WebGPU (WebGPU hanya untuk hapus latar) | V16 |
| Deterministic export | Jalur cepat deterministik. Fallback real-time tidak | V2, V12 |
| Memory budgeting | Ada di sebagian (OPFS LRU, kanvas Desain dibatasi). Undo, mix audio, foto Desain belum | V10, V13, D6 |
| Unified state + undo/redo | Video dan Desain punya store/riwayat sendiri-sendiri | V13, D5 |
| MCP lewat service layer | MCP langsung memanggil runtime UI | M2 |
| Job ID + polling + cancel | Belum | M4 |
| Desktop dan iPad diuji terpisah | Emulasi iPad di Chromium. Belum ada uji Safari iPad otomatis | T4 |
