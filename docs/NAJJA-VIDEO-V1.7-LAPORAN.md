# Najja Video v1.7 — Laporan per fase

Laporan ini mengikuti format output yang diminta *NAJJA VIDEO Performance Blueprint* untuk setiap fase:
masalah (file/baris), keputusan desain dan trade-off, file yang berubah, tes, benchmark sebelum/sesudah,
risiko/fallback/deploy/migrasi/rollback, dan pekerjaan berikutnya. Rencananya ada di
[NAJJA-VIDEO-IMPLEMENTATION-PLAN.md](NAJJA-VIDEO-IMPLEMENTATION-PLAN.md).

---

## P0 — Fondasi keamanan: data per akun

### Masalah (kode v1.6.0)

| Lokasi | Masalah |
|---|---|
| `lib/storage.js` `listProjects/getProject/putProject/deleteProject`, `getMeta/mediaFile/deleteMedia`, `putChunk/finishUpload` | Semua data global. Tidak ada konsep pemilik. |
| `server.js` route `/api/projects/*`, `/api/media/*`, `/api/upload/*`, `/exports/*`, `/media-cache/*` | Tidak memeriksa siapa pemiliknya. Akun B bisa membaca, menimpa, atau menghapus proyek/media akun A kalau tahu ID-nya. |
| `server.js` `Bridge.request()` | Perintah MCP dikirim ke editor yang paling aktif dari **akun mana pun**. `/bridge/result` menerima jawaban dari siapa saja. |
| `server.js` `/api/status` | `lastExport`, `exportsDir`, dan daftar klien MCP terlihat oleh semua akun. |
| `server.js` `prepareImport()` | Impor file dari disk server terbuka untuk semua akun. Impor URL bisa diarahkan ke layanan internal VPS (localhost/LAN). |
| `lib/auth.js` | Pengguna tidak punya ID tetap. Hanya ada satu token MCP (token server) untuk semua orang. |

### Keputusan desain

- **Pemilik disimpan sebagai metadata, file tidak dipindah.** Proyek dan `meta.json` media mendapat kolom `ownerId`. Ekspor dicatat di `data/exports-index.json`. Upload yang sedang berjalan diklaim lewat file `owner` di folder upload-nya.
  - *Trade-off:* folder masih satu untuk semua akun, jadi isolasinya ada di lapisan API, bukan di filesystem.
  - *Keuntungan:* tidak ada pemindahan file video (bisa puluhan GB). Migrasi hanya menulis JSON kecil, dan v1.6 tetap bisa membaca data (rollback mudah).
- **Identitas selalu dari server.** `authenticate()` mengembalikan `{ id, email, role, via }` dari sesi, token server, atau token AI pribadi. `ownerId` di body request selalu ditimpa server.
- **Data orang lain dijawab 404**, bukan 403, supaya keberadaannya tidak bocor.
- **Data lama → admin pertama.** Record tanpa pemilik (atau milik mode lokal `local`) dianggap milik admin paling awal. Migrasi menuliskannya secara eksplisit.
- **Token AI pribadi** (`najja_pat_…`):
  - Satu token per pengguna, ditampilkan sekali. Server hanya menyimpan hash SHA-256 dan 4 karakter terakhir.
  - Token server `NAJJA_TOKEN` tetap berlaku dan bertindak sebagai admin pertama, jadi konfigurasi MCP lama tidak putus.
- **Bridge MCP per akun.**
  - Editor terdaftar dengan kunci `pemilik:clientId`. Perintah hanya dikirim ke editor milik pemanggil.
  - Jawaban `/bridge/result` hanya diterima dari akun yang sama.
- **Impor dari disk server hanya untuk admin.** Impor URL oleh akun non-admin hanya ke alamat internet publik:
  - DNS dicek di setiap redirect.
  - Ditolak: loopback, 10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10, IPv6 lokal.
- **Path server disembunyikan dari non-admin:** `exportsDir`, path `mcp-stdio.js`, dan `path` hasil upload ekspor.

### File yang berubah

| File | Perubahan |
|---|---|
| `lib/tenancy.js` (baru) | `ownerOf/owns`, indeks pemilik ekspor, `migrate()` (dry-run → backup → tulis → verifikasi → `migration.json`), `transfer()` saat pengguna dihapus. |
| `lib/auth.js` | ID pengguna `u_…` + `ensureIds()`, `primaryOwner()`, token AI pribadi (`createToken/revokeToken/tokenInfo/userByToken`). |
| `lib/storage.js` | `ownerId` di `putMeta/adoptFile/finishUpload`, klaim pemilik upload, `deleteMedia` hanya menghitung proyek pemilik yang sama. |
| `server.js` | Identitas per request, `initData()` (ID pengguna + migrasi saat start), cek pemilik di semua route data, bridge per akun, `/api/status` per akun, `/api/me/token`, transfer data saat hapus pengguna, `fetchPublic()`. |
| `public/js/account.js`, `public/css/app.css` | Menu **Token AI (MCP)**: buat, salin, ganti, cabut. Teks Kelola pengguna diperbarui. |
| `public/js/library.js` | Panel AI memakai `<TOKEN_AI_KAMU>` + tombol kelola token. |
| `public/js/app.js` | Status "Salinan tersimpan di server" tetap muncul walau path server tidak dikirim. |
| `test/tenancy.test.js` (baru) | 8 tes (lihat bawah). |
| `README.md`, `docs/DEPLOY.md` | Data per akun, token AI, migrasi & rollback. |

### Tes

`npm test` → **29/29 lolos** (21 lama + 8 baru). `npm run test:e2e` → lolos (get_frame + semua cek UI iPad).

Tes baru di `test/tenancy.test.js` dijalankan pada folder data berformat v1.6 (admin tanpa ID, proyek, media, dan ekspor tanpa pemilik):

1. **Migrasi:**
   - Pengguna mendapat ID, dan `users.json` dicadangkan dulu.
   - Proyek, media, dan ekspor lama jadi milik admin. Cadangan berisi file asli yang belum diubah.
   - `migration.json` mencatat `remaining: 0`.
2. **Proyek:**
   - Akun B mendapat 404 untuk get/put/delete dan daftar kosong.
   - `ownerId` palsu di body diabaikan.
3. **Media:**
   - Akun B mendapat 404 di semua route: meta, file, edit, sprite, poster, peaks, proxy, proxy-status, adopt, dan delete.
   - B tidak bisa menyelesaikan upload ke media A. Sebaliknya, A tidak bisa menulis atau menyelesaikan sesi upload B.
4. **Ekspor dan status:**
   - File ekspor A tidak bisa diunduh B, dan sebaliknya.
   - `lastExport` dan `editors` dihitung per akun.
   - `exportsDir` hanya untuk admin.
5. **MCP:**
   - Token pribadi B tidak menjangkau editor A ("not open in a browser for this account").
   - Token server menjangkau editor admin pertama.
   - Jawaban palsu dari B untuk perintah A diabaikan.
   - Token salah atau yang sudah dicabut → 401. Token hanya bisa diatur dari sesi login.
6. **Impor:**
   - Path disk server ditolak untuk non-admin.
   - URL ke 127.0.0.1, localhost, 10.x, [::1], dan 169.254.169.254 ditolak.
7. **Hapus pengguna:** data B pindah ke admin, dengan cadangan.
8. **Unit tenancy:**
   - Dry-run tidak mengubah apa pun, dan migrasi idempoten.
   - Data mode lokal menunggu sampai akun dibuat.

**Uji di data nyata:** salinan folder data v1.6 (1 proyek, 57 klip, 6 media, 3 ekspor, 557 MB) dijalankan dengan server v1.7.
- Migrasi: 1 proyek, 6 media, 3 ekspor diberi pemilik, `remaining: 0`. Cadangan hanya berisi JSON (file video tidak disalin atau disentuh).
- Di browser, admin membuka proyek seperti biasa.
- Akun editor baru hanya melihat proyeknya sendiri (editor terhitung 1 untuk akunnya, bukan 2).
- Modal Token AI rapi di iPad (1180×820) dan HP (390×844), tanpa geser samping. Tidak ada error konsol.

### Benchmark sebelum/sesudah

Server v1.6.0 vs v1.7 pada salinan data yang sama, request berurutan lewat keep-alive (400 sampel × 3 putaran, ms):

| Route | v1.6 p50 | v1.7 p50 | v1.6 p95 | v1.7 p95 |
|---|---|---|---|---|
| `GET /api/projects` | 1,54–1,72 | 1,57–1,82 | 2,01–2,32 | 2,07–2,42 |
| `GET /api/media/:id/meta` | 2,00–2,13 | 2,36–2,49 | 2,48–2,68 | 2,98–3,47 |
| `GET /api/media/:id/edit` (range 64 KB) | 0,54–0,74 | 0,96–1,10 | 1,09–1,28 | 1,55–1,60 |

Overhead cek pemilik ≈ 0,3–0,5 ms per request (satu baca `meta.json` kecil). Ini jauh di bawah latensi jaringan (puluhan ms), jadi pemutaran dan scrubbing tidak terpengaruh. Kalau nanti terlihat di metrik P1, pemilik media bisa di-cache di memori.

### Risiko, fallback, deploy, migrasi, rollback

- **Deploy:** sama seperti biasa (jalankan installer). Migrasi otomatis saat server start, lalu tercatat di log server dan di `data/backups/v1.7-owner-migration-<waktu>/migration.json`.
- **Kalau migrasi gagal** (misalnya disk penuh):
  - Request dijawab error (fail closed: tidak ada data yang terbuka tanpa pemilik).
  - Server mencoba lagi di request berikutnya.
  - Cadangan dibuat sebelum ada file yang ditulis.
- **Rollback:** pasang v1.6 lagi.
  - Kolom `ownerId`/`id` diabaikan v1.6, jadi semua data tetap terbaca.
  - Untuk mengembalikan file persis, salin isi folder cadangan ke `data/`. Langkahnya ada di `docs/DEPLOY.md`.
- **Perubahan perilaku untuk pengguna:**
  - Akun editor tidak lagi melihat proyek admin. Ini memang tujuan blueprint, dan sudah dijelaskan di Kelola pengguna dan DEPLOY.md.
  - Klien MCP lama yang memakai token server tetap jalan sebagai admin pertama.
- **Sisa risiko:**
  - Cek DNS untuk impor URL rentan DNS rebinding (waktu cek ≠ waktu unduh). Mitigasinya: hanya file media yang disimpan, dan hasilnya hanya bisa diunduh pemiliknya.
  - File `media-cache` yang diunduh sebelum restart dan tidak tercatat dianggap milik admin pertama.

### Berikutnya

P1 — metrik pipeline (impor, proxy, pratinjau, ekspor) dan fixture benchmark B0–B5, supaya fase P2/P4/P5/P6 bisa diukur sebelum/sesudah.

---

## P1 — Pengukuran (observability) dan fixture benchmark

### Masalah

v1.6 tidak punya angka. Tidak bisa menjawab pertanyaan blueprint bagian 9: stage mana yang lambat, di perangkat apa, untuk proyek seperti apa, dan apakah sebuah perubahan memperbaikinya. Hanya ekspor cepat yang mencetak profil ke console, dan server tidak punya metrik antrean.

### Keputusan desain

- **Kolektor di memori, tanpa layanan luar** (`public/js/metrics.js`):
  - Sampel disimpan di ring buffer 600 nilai per metrik, jadi memori tetap datar walau editor terbuka berjam-jam.
  - Tidak ada data yang dikirim ke mana pun. Pengguna menyalin JSON sendiri dari menu **⋯ → Diagnostik performa**.
  - *Trade-off:* belum ada agregasi lintas pengguna. Kalau nanti dibutuhkan, JSON yang sama bisa dikirim ke endpoint VPS sendiri.
- **Diukur di titik yang benar-benar dirasakan pengguna:**
  - *Seek → frame tepat:* dari perintah seek sampai video di layar menunjukkan frame posisi itu (menunggu decoder, bukan sekadar event `seeked`).
  - *Impor → bisa dipakai:* sampai frame berikutnya tergambar.
  - *Geser/trim klip:* dari event input sampai frame berikutnya.
- **Benchmark yang bisa diulang:**
  - `bench/fixtures.mjs` membuat B0–B3 dengan ffmpeg: H.264 High, GOP 1 dtk, bitrate konstan supaya ukuran file realistis.
  - `bench/run.mjs` menjalankan editor asli di Chromium (Playwright). Proyek disusun lewat MCP, upload lewat input file seperti pengguna. B4 memakai dua perangkat (desktop dan profil HP), B5 memakai empat akun bersamaan.
  - *Trade-off:* angka dari mesin lab headless (tanpa GPU) adalah **baseline untuk perbandingan sebelum/sesudah**, bukan vonis per perangkat. Blueprint 9.3 tetap meminta pengukuran di PC, iPad, dan HP nyata, dan menu Diagnostik dibuat untuk itu.

### Metrik yang dikumpulkan (blueprint 9.1)

| Kategori | Metrik |
|---|---|
| Impor | `import_visible_ms`, `upload_ms`, `upload_mbps`, `upload_retry_count`, `asset_ready_ms` (salinan ringan siap) |
| Pemutaran | `fps_rendered`, `preview_frames_missed_pct`, `video_dropped_frames_pct` (dari `getVideoPlaybackQuality`), `frame_draw_ms`, `buffer_wait_ms`, `seek_to_frame_ms`, `seek_timeouts`, `preview_quality_down`, elemen media aktif, ukuran kanvas pratinjau |
| Respons UI | `long_tasks_over_50ms`, `main_thread_blocked_ms`, `long_task_ms`, `interaction_ms` (Event Timing), `timeline_drag_ms`, `timeline_trim_ms` |
| Memori/perangkat | JS heap, pemakaian penyimpanan browser (OPFS), core, RAM, layar, GPU, dukungan WebCodecs H.264/HEVC, OPFS, frame callback video, jaringan |
| Ekspor | `fetch_media_ms`, `prepare_ms`, `decode_ms`, `composite_ms`, `encode_ms`, `mux_ms`, `total_ms`, `realtime_factor`, `mode`, `fallback`, `encoder_queue_max`, `output_size`, `failure_stage` |
| Sync | `save_ack_ms`, `save_failed` (konflik revisi menyusul di P6) |
| Backend (admin, `/api/status` → `metrics`) | antrean job per jenis (selesai/gagal, tunggu p50/p95, durasi p50/p95, jalan/batas, antre), disk kosong, RAM, load CPU, respons HTTP 2xx/3xx/4xx/5xx |

### File yang berubah

| File | Perubahan |
|---|---|
| `public/js/metrics.js` (baru) | Kolektor: `sample/count/gauge/event/timer/afterPaint`, `stats` (p50/p95/max), `snapshot` (+ info perangkat), observer long task & Event Timing. |
| `public/js/engine.js` | FPS, frame terlewat, frame video di-drop per sesi putar; tunggu buffer; seek → frame tepat; waktu gambar frame. |
| `public/js/media.js`, `remote.js`, `store.js` | Impor → bisa dipakai, durasi/kecepatan upload, upload diulang, salinan ringan siap, simpan → diterima server. |
| `public/js/fastexport.js`, `exporter.js` | Waktu per tahap ekspor, antrean encoder maksimum, mode/fallback, tahap gagal, kecepatan real-time. |
| `public/js/timeline.js`, `player.js` | Latensi geser/trim klip; berapa kali kualitas pratinjau diturunkan. |
| `public/js/app.js`, `public/css/app.css` | Menu ⋯ → **Diagnostik performa** (juga lewat 🔍 cari fitur, termasuk di HP): ringkasan, Salin/Unduh JSON, Reset. |
| `lib/media-proxy.js`, `server.js` | Metrik antrean job + disk/RAM/load/HTTP di `/api/status` (admin). |
| `bench/fixtures.mjs`, `bench/run.mjs`, `bench/report.mjs` (baru) | Fixture B0–B3, runner B0–B5, laporan + perbandingan sebelum/sesudah. |
| `test/metrics.test.js` (baru) | Persentil, ring buffer terbatas, counter/event/timer/snapshot. |

### Temuan langsung: bug frame salah setelah seek (sudah diperbaiki, commit terpisah)

Metrik `seek_to_frame_ms` langsung memperlihatkan bug di v1.6.

- **Gejala:** saat dijeda, seek jauh ke klip lain atau scrub cepat bisa membuat pratinjau tertahan di frame yang salah.
- **Penyebab:** `sync()` melewati elemen yang belum punya metadata atau masih seeking, dan tidak ada yang memposisikannya ulang.
- **Bukti:** sebelum diperbaiki, di proyek nyata 6 dari 10 seek tidak pernah menampilkan frame yang benar dalam 10 detik. Sesudahnya 10/10 benar dalam 41–77 ms.
- **Perbaikan:** commit "Perbaiki pratinjau yang tertahan di frame salah…" (`engine.js`, sinkron ulang saat `loadedmetadata`/`seeked`).

### Tes

- `npm test`: **32/32 lolos** (3 tes metrik baru).
- `npm run test:e2e`: lolos. `get_frame` tepat 8/8, dan semua cek UI iPad lolos.

### Baseline B0–B5 (sebelum P2–P6)

Lab: 4 vCPU Xeon 2,1 GHz, 17 GB, Chromium headless **tanpa GPU** (SwiftShader), profil desktop 1280×800. Detail lengkap ada di `bench/results/2026-11-13-p1-baseline-desktop.{json,md}`.

| Fixture | Angka utama |
|---|---|
| **B0** 1 klip 1080p 60 dtk + musik | Impor → bisa dipakai p95 **167 ms**. Upload 88 MB 0,8 dtk (loopback). Salinan ringan siap 10 dtk. Putar 30,1 fps, 0% frame terlewat, gambar frame p50/p95 5,9/8,5 ms. Seek → frame p50/p95 **25/41 ms**. Ekspor 1080p **2,85× real-time** (komposit 16,2 dtk dari 21 dtk total). RAM renderer naik 741 → 1.141 MB. |
| **B1** 9:16, 6 klip + 2 teks + musik + filter | Putar 30,3 fps, 1,6% frame terlewat. Seek p95 110 ms. Ekspor **1,2× real-time** (komposit 41 dtk dari 50 dtk: filter di 9:16 1080×1920 mahal). RAM renderer puncak 1.452 MB. |
| **B2** 3 klip + 2 overlay + teks animasi + efek + transisi | Putar 30,5 fps tapi **8,7% frame terlewat**, gambar frame p95 15,1 ms. Seek p95 209 ms. Ekspor 1,6× real-time. |
| **B3** 10 menit, 62 potongan, 2 audio | Putar 30,1 fps. Seek p95 58 ms. Ekspor 120 dtk pertama: 2,6× real-time, tapi **RAM renderer 770 → 2.715 MB dan JS heap 669 MB**, karena file sumber 440 MB dibaca utuh ke memori. |
| **B4** perangkat kedua (profil HP, CPU 4× lebih lambat) membuka proyek B1 | Dingin: siap 1,2 dtk, frame pertama 159 ms, seek p95 145 ms, semua media tersalin 1,1 dtk. Hangat (reload): siap 0,9 dtk. |
| **B5** 4 akun impor bersamaan (12–440 MB) | Latensi API saat antrean penuh p50/p95 **9,5/32 ms** (tetap responsif). Tapi job thumbnail/waveform **menunggu sampai 117 dtk** di belakang konversi video 10 menit (satu antrean, satu job). Salinan ringan file 88 MB baru siap setelah 22,5 dtk. |

**Bottleneck yang teridentifikasi (masukan untuk fase berikutnya):**

1. **Memori ekspor (P4):** sumber dibaca utuh dan hasil encode dikumpulkan di RAM. B3 menembus 2,7 GB untuk 2 menit ekspor, dan di HP/iPad ini berarti tab crash.
2. **Antrean job tunggal (P5):** pekerjaan kecil tertahan di belakang pekerjaan besar akun lain. Tidak ada retry, cancel, atau status job, dan job hilang saat restart.
3. **Proyek berlapis (P2, lalu P3):** B2 kehilangan 8,7% frame. Waktu gambar frame dan komposit ekspor mendominasi. P2 mengurangi kerja JS per frame. Biaya gambar Canvas 2D sendiri adalah wilayah P3 (ditunda sampai ada data perangkat nyata).

### Risiko, fallback, rollback

- Metrik pasif dan ringan: satu `performance.now()` dan satu tulis ke ring buffer per event. Observer long task dan Event Timing dibungkus `try`, jadi browser yang tidak mendukung tidak terpengaruh.
- Tidak ada data yang dikirim keluar. JSON hanya keluar kalau pengguna menekan Salin/Unduh.
- `/api/status` → `metrics` hanya untuk admin.
- Rollback: revert commit. Tidak ada perubahan data atau skema.

### Berikutnya

P2: render plan terkompilasi (indeks per track + binary search), lalu ukur ulang B1/B2/B3 dengan `node bench/report.mjs baseline.json sesudah.json`.

---

## P2 — Timeline hot path: render plan terkompilasi

### Masalah (kode v1.6/P1)

| Lokasi | Masalah |
|---|---|
| `public/js/render.js` `renderFrame` | Setiap frame (30–60×/dtk): `P.tracks.filter(...)` dua kali, lalu `sortedClips()` (filter + sort semua klip) untuk **setiap** track, lalu `mainTrackState` yang menyisir track utama dari awal. |
| `public/js/engine.js` `sync()` | Setiap tick saat diputar: `chainKeys()` (kelompokkan + sort semua klip video/audio), `sortedClips('main')`, bangun ulang peta grup elemen, dan `mainList.indexOf()` per klip (O(n²)). |

Biayanya tumbuh dengan jumlah klip, bukan dengan apa yang terlihat di layar.

### Keputusan desain

- **`store.rev`**: nomor revisi proyek, naik pada setiap perubahan (`mutate`, `live`, undo/redo, muat proyek, batal geser).
- **`public/js/plan.js` (baru, fungsi murni tanpa DOM):** `compilePlan(P)` membangun sekali per revisi:
  - klip per track terurut (sort stabil, urutan seri sama seperti `sortedClips`), plus `maxEnd` (maksimum berjalan ujung klip);
  - urutan track visual/efek, posisi klip di track utama, *chain key* elemen media, dan grup elemen.
- **`clipsAt(track, t)`**: binary search + mundur selama `maxEnd > t`, jadi O(log n + klip yang terlihat).
- **`mainStateAt(plan, t)`**: hasilnya persis sama dengan `mainTrackState` (klip, atau pasangan transisi + progres), tapi hanya memeriksa klip di sekitar `t`.
- **`renderFrame`** memakai `env.plan`. Pemanggil tanpa plan tetap benar karena plan dikompilasi di tempat. **Ekspor cepat** mengompilasi plan sekali per ekspor. **`engine.sync`** memakai grup, *chain key*, dan indeks track utama dari plan.
- *Trade-off:* cache bergantung pada setiap perubahan struktur yang lewat `store.mutate/live`. Semua jalur edit (timeline, inspector, MCP, undo) sudah memakainya. Selain itu, cache juga dikunci pada objek proyek, jadi undo/muat proyek selalu membuat plan baru. `mainTrackState` versi lama tetap ada sebagai referensi tes.

### File yang berubah

`public/js/plan.js` (baru), `public/js/store.js` (`rev`, `plan()`), `public/js/render.js`, `public/js/engine.js`, `public/js/fastexport.js`, `test/plan.test.js` (baru), `bench/plan-micro.mjs` (baru).

### Tes

- `test/plan.test.js` (4 tes) membandingkan langsung dengan kode lama di 20 proyek acak (hingga ~280 klip per proyek, termasuk celah, transisi, potongan dari file yang sama, dan start yang sama):
  - `clipsAt` = `sortedClips().filter()` di setiap track, ±8.000 titik waktu acak, plus semua batas klip (tepat di awal/akhir dan 1e-9 sebelumnya).
  - `mainStateAt` = `mainTrackState` (klip yang sama, atau pasangan A/B transisi yang sama dengan progres sama hingga 1e-12).
  - urutan track, track tersembunyi, chain key, grup elemen, dan cache per revisi.
- `npm test` **36/36 lolos**. `npm run test:e2e` lolos (`get_frame` 8/8 tepat, semua cek UI iPad).

### Benchmark sebelum/sesudah

**1. Mikro (`node bench/plan-micro.mjs`)**: biaya JS per frame untuk "apa yang terlihat di t" (renderFrame) ditambah pengelompokan elemen (engine.sync).

| Klip | v1.6 (ms/frame) | P2 (ms/frame) | Lebih cepat | Kompilasi plan (sekali per edit) |
|---|---|---|---|---|
| 50 | 0,033 | 0,007 | 4,6× | 0,04 ms |
| 200 | 0,064 | 0,019 | 3,5× | 0,12 ms |
| 1.000 | 0,407 | 0,010 | 41× | 0,46 ms |
| 3.000 | 1,618 | 0,034 | 47× | 0,98 ms |

**2. A/B `renderFrame` di browser**: renderer commit P1 vs P2, berselang-seling per blok 40 frame di halaman yang sama (menghilangkan noise antar-run). Dipakai proyek nyata pengguna (57 klip: 38 teks, 7 video, 6 efek, 5 stiker) dan versi yang ditambah klip teks. Dua putaran:

| Proyek | v1.6 (ms/frame) | P2 (ms/frame) | Perubahan |
|---|---|---|---|
| Nyata, 57 klip | 0,53–0,57 | 0,48–0,51 | **−10%** |
| +500 klip (557) | 0,66–0,67 | 0,51–0,54 | **−20%** |
| +2.000 klip (2.057) | 1,11–1,15 | 0,70–0,72 | **−37%** |

**3. Fixture B1–B3** (`bench/results/2026-11-13-p2-desktop.*`):
- FPS, frame terlewat, seek, dan ekspor berada dalam rentang noise lab.
- Contoh noisenya: decode/encode ekspor, yang tidak disentuh P2, bergerak ±10–14% antar-run, dan B1 baseline sendiri 1,6% vs 2,4% frame terlewat di dua run.
- Di proyek ≤62 klip, pencarian klip hanya ~0,03 ms dari 6–10 ms waktu gambar frame. Biaya utamanya ada di gambar Canvas 2D (filter, teks, komposit), yang menjadi wilayah P3.
- **Kesimpulan jujur:** P2 tidak membuat B1–B3 terasa berbeda di desktop lab. P2 menghapus biaya yang tumbuh dengan jumlah klip, yang paling terasa di proyek panjang dan di HP (CPU 4–8× lebih lambat dari lab).

### Risiko, fallback, rollback

- **Risiko:** plan basi kalau ada kode yang mengubah `start/duration/trackId/transition/hidden` tanpa `store.mutate/live`. Mitigasinya: semua jalur edit sudah lewat store (diaudit: timeline, inspector, actions, MCP api), cache juga dikunci pada objek proyek, dan tes e2e iPad (geser, trim, transisi, pindah overlay) lolos.
- **Fallback:** `renderFrame` tanpa `env.plan` (atau plan untuk proyek lain) langsung mengompilasi plan sendiri.
- **Rollback:** revert commit. Tidak ada perubahan data.

### Berikutnya

P4: memori ekspor (B3 baseline 2,7 GB RAM renderer untuk 2 menit ekspor).

---

## P4 — Memori ekspor

### Masalah (kode sebelum P4)

| Lokasi | Masalah |
|---|---|
| `public/js/fastexport.js` `bytes()` | Setiap file sumber dibaca utuh ke RAM (`fetch(url).then(r => r.arrayBuffer())`). Untuk B3, itu 440 MB sebelum satu frame pun dirender. |
| `fastexport.js` `audioBufferFor` + `audioCache` | Audio setiap file di-decode **utuh** (10 menit stereo float ≈ 230 MB per file) dan disimpan di cache tingkat modul, yang tidak pernah dibersihkan, bahkan antar-ekspor. |
| `fastexport.js` encoder `output` | Semua chunk H.264 hasil encode dikumpulkan di `chunks[]` (RAM) sampai akhir. Memori tumbuh sepanjang durasi ekspor. |
| `muxMp4` | Ukuran `mdat` 32-bit: file > 4 GB akan ditulis rusak diam-diam. |

Baseline P1 (B3, 120 dtk pertama): RAM renderer naik 770 → 2.715 MB dan JS heap 669 MB.

### Keputusan desain

- **Sumber dibaca bertahap:**
  - `ByteSource` membaca Blob di balik URL media (File impor atau salinan OPFS, berbasis disk) per jendela 8 MB.
  - `moov()` mencari kotak `moov` dengan menelusuri header kotak tingkat atas (juga kalau `moov` ada di akhir file), lalu hanya kotak itu yang dibaca utuh.
  - Demuxer tidak berubah perilakunya: offset sampel tetap absolut.
  - Blob tiap URL dicatat lewat `objectUrl()/revokeUrl()` di `util.js`. URL tanpa catatan memakai `fetch().blob()` sebagai fallback.
- **Audio hanya rentang yang dipakai:**
  - `demuxAudio` membaca trak AAC (esds → AudioSpecificConfig, edit list untuk priming).
  - Rentang sumber semua klip dari file yang sama digabung, lalu di-decode dengan **WebCodecs AudioDecoder** hanya untuk rentang itu (±0,25 dtk).
  - Memori sebanding dengan durasi ekspor, bukan panjang file.
  - **Fallback:** file non-MP4 (MP3/WAV/OGG) atau browser tanpa AudioDecoder memakai `decodeAudioData` utuh seperti v1.6, tapi **tanpa cache permanen**.
- **Hasil encode ke file sementara OPFS:**
  - Data ditulis bertahap (batch 4 MB) dengan *backpressure* (encoder menunggu kalau > 32 MB belum tertulis).
  - MP4 akhir adalah Blob gabungan header + **File OPFS** (berbasis disk).
  - File sementara dihapus saat ekspor berikutnya dimulai, karena Blob hasil masih dipakai untuk unduh/upload.
  - **Fallback:** memori (perilaku v1.6) bila OPFS/`createWritable` tidak ada, atau server diset `NAJJA_EXPORT_SPOOL=0` (diteruskan lewat `/api/status` → `features.exportSpool`).
- **Jaga-jaga 4 GB:** output yang akan melewati batas ukuran 32-bit dilempar sebagai `unsupported`, lalu jatuh ke perekam real-time. File tidak pernah ditulis rusak.
- **Kualitas tidak diubah:** resolusi, fps, bitrate, codec, dan sumber kualitas penuh sama persis.

### File yang berubah

| File | Perubahan |
|---|---|
| `public/js/fastexport.js` | `sampleTable`/`traks` (dipakai bersama video dan audio), `demuxAudio`, `ByteSource`, rentang audio + `AudioDecoder`, spool OPFS, `VideoSource` membaca bertahap, muxer menerima body Blob + jaga 4 GB, statistik `spool`/`audio_decoded_s`/`audio_full_decode`. |
| `public/js/util.js`, `media.js`, `devicecache.js` | `objectUrl()/revokeUrl()/blobOfUrl()`: semua URL blob media lewat registri. |
| `public/js/exporter.js`, `server.js` | Saklar `NAJJA_EXPORT_SPOOL=0` → `features.exportSpool`. |
| `public/js/app.js` | Diagnostik: tempat hasil encode, detik audio yang di-decode, jumlah file yang di-decode utuh. |
| `bench/run.mjs` | Cek kebenaran: ffprobe + **loudness audio** (`volumedetect`) untuk hasil ekspor B0/B3. |
| `test/export-read.test.js` (baru) | `moov` di awal/akhir file, sampel identik dengan demux file utuh, pembacaan jendela = byte file, demux AAC (codec, rate, channel, ASC, priming), file tanpa audio/`moov` → unsupported. |

### Tes

- `npm test`: **38/38 lolos**.
- `npm run test:e2e`: lolos.
- Uji fallback MP3 di browser: ekspor tetap mode cepat dengan 1 file di-decode utuh. Audio hening −91 dB sebelum klip mulai dan −21,5 dB saat nada berbunyi. Durasi dan stream benar.

### Benchmark sebelum/sesudah (runner sama, kode commit P2 vs P4)

Data lengkap ada di `bench/results/2026-11-13-p4-{before,after}-desktop.*`.

| | Sebelum | Sesudah | Perubahan |
|---|---|---|---|
| **B3 ekspor 120 dtk** · RAM renderer puncak | 2.667 MB | **1.287 MB** | **−52%** |
| B3 · pertumbuhan RAM selama ekspor | +1.652 MB | **+224 MB** | **−86%** |
| B3 · JS heap puncak | 690 MB | **174 MB** | **−75%** |
| B3 · kecepatan ekspor | 2,48× real-time | 2,40× | noise |
| B3 · audio hasil (rata-rata/puncak) | −16,3 / −8,5 dB | −16,3 / −8,5 dB | **identik** |
| **B0 ekspor 60 dtk** · JS heap puncak | 140 MB | **74 MB** | **−47%** |
| B0 · RAM renderer puncak | 1.136 MB | 1.049 MB | −8% |
| B0 · kecepatan ekspor | 2,52× | 2,55× | noise |
| B0 · audio hasil | −18,1 / −10,9 dB | −18,1 / −10,9 dB | **identik** |
| Video hasil (B0, B3) | h264 1920×1080 30 fps | sama | identik |

### Risiko, fallback, rollback

- **Safari/iPad:** `createWritable` OPFS di main thread belum ada di semua versi Safari. Di sana spool otomatis kembali ke memori, sementara pembacaan sumber bertahap dan decode audio per rentang tetap bekerja. Spool untuk Safari butuh worker + `createSyncAccessHandle`. Ini dicatat sebagai pekerjaan lanjutan, bersama P3.
- **AudioDecoder tidak ada** (Safari lama): kembali ke `decodeAudioData` utuh, tanpa cache permanen.
- **Disk penuh saat spool:** error penulisan menggagalkan ekspor dengan pesan jelas (tahap tercatat di Diagnostik), lalu file sementara dihapus.
- **Rollback:** revert commit, atau `NAJJA_EXPORT_SPOOL=0` untuk mematikan spool saja. Tidak ada perubahan data.

### Berikutnya

P5: antrean job media yang tahan restart, dengan konkurensi terbatas, retry, cancel, dan status job. Baseline B5: job thumbnail menunggu sampai 117 dtk di belakang konversi video akun lain.
