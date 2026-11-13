# Najja Video — Rencana Implementasi (dari Performance Blueprint)

Dokumen ini menerjemahkan *NAJJA VIDEO Performance Blueprint* (v1.0, 13 Nov 2026) menjadi pekerjaan nyata di repo ini.
Basis audit: Najja Editor **v1.6.0** (commit `6adf64a`). Target rilis: **v1.7.0**.

Aturan kerja (dari blueprint, bagian 12–13):
- Tidak ada rewrite total, ganti framework, atau perubahan UI tanpa alasan terukur.
- Fitur editor, skema proyek lama, tool MCP, dan alur deploy tetap kompatibel.
- Setiap fase dikerjakan dan di-commit terpisah, dengan tes dan (bila relevan) benchmark before/after.
- Setiap jalur baru punya feature detection + fallback.
- Kualitas ekspor tidak boleh turun diam-diam.

Status: ✅ selesai di v1.7 · 🟡 sebagian · ⏸ ditunda (alasan dicatat)

---

## Audit ulang: temuan blueprint vs kode v1.6.0

| Temuan blueprint | Verifikasi di kode | Status temuan |
|---|---|---|
| Storage global tanpa owner (P0) | `lib/storage.js` `listProjects/getProject/putProject/deleteProject`, `getMeta/mediaFile/deleteMedia`, `putChunk/finishUpload` tidak menerima identitas. `server.js` route `/api/projects`, `/api/media/*`, `/api/upload/*`, `/exports/*`, `/media-cache/*` tidak memeriksa pemilik. `authenticate()` hanya mengembalikan email/role. | **Benar, kritis.** User B bisa membaca/menimpa/menghapus proyek & media user A bila tahu ID. |
| MCP tanpa konteks pemilik | `Bridge.request()` memilih editor paling aktif dari **semua** akun; `/bridge/result` tidak memeriksa pengirim; `/api/status` membocorkan `lastExport`, `exportsDir`, `mcpClients` lintas akun. | **Benar, kritis.** |
| `sortedClips()` filter+sort tiap panggilan | `store.js:73`, dipanggil dari `render.js renderFrame` (per frame, per track) dan `engine.sync` (per tick). | Benar. |
| `renderFrame` membangun ulang struktur | `render.js:896-947` memfilter `P.tracks` dan memanggil `sortedClips` setiap frame. | Benar. |
| Ekspor memuat seluruh sumber ke RAM | `fastexport.js` `fetch(url).then(r => r.arrayBuffer())`; output `chunks[]` di RAM; `new Blob([...])` di akhir. | Benar. |
| Fallback realtime | `exporter.js` fallback ke MediaRecorder, label mode sudah dikirim (`exportState.mode`). | Benar; label sudah ada sejak v1.3. |
| Antrean proxy satu job | `media-proxy.js` antrean cepat/lambat di memori (v1.6), tanpa jurnal, retry, cancel, atau status job. | Benar (sebagian sudah diperbaiki di v1.6: prioritas). |
| Simpan proyek tanpa revisi | `PUT /api/projects/:id` menimpa begitu saja (last-write-wins); tidak ada deteksi konflik antar perangkat. | Benar. |

---

## P0 — Security foundation ✅ (v1.7)

**Tujuan:** setiap proyek, media, upload, ekspor, cache unduhan, status job, dan perintah MCP terikat ke satu pemilik.
Identitas selalu dari sesi/token yang diverifikasi server, tidak pernah dari body request.

| File | Task |
|---|---|
| `lib/auth.js` | ID pengguna stabil (`u_…`) + migrasi pengguna lama; **token AI pribadi** per pengguna (disimpan sebagai hash SHA-256, ditampilkan sekali); lookup token → pengguna. |
| `lib/tenancy.js` (baru) | Aturan pemilik (`effectiveOwner`), indeks pemilik file ekspor, **migrasi data lama**: dry-run → backup → tulis `ownerId` → verifikasi; log migrasi. |
| `lib/storage.js` | Semua operasi proyek/media/upload menerima `ownerId`; akses milik orang lain → 404 (tidak membocorkan keberadaan); `ownerId` ditulis server; `deleteMedia` hanya melihat proyek pemilik yang sama. |
| `server.js` | `authenticate()` → `{ id, email, role, via }`; server token = pemilik utama (admin pertama); token pribadi = pengguna itu. Semua route meneruskan identitas. Bridge MCP: editor & perintah dipisah per pemilik; `/bridge/result` divalidasi. `/api/status` per pemilik. `/exports/*` & `/media-cache/*` diperiksa pemiliknya. Impor file lokal server (`path`) hanya untuk admin. Endpoint token pribadi `/api/me/token`. |
| `public/js/account.js`, `library.js` | Menu akun "Token AI (MCP)" untuk membuat/mengganti token pribadi; panel AI memakai token pribadi. |
| Tes | `test/tenancy.test.js`: migrasi + aturan pemilik, dan tes negatif user A vs user B (list/get/put/delete proyek, semua route media, upload, ekspor, cache, MCP bridge, token pribadi, impor URL internal). |

**Migrasi data lama:** dijalankan otomatis saat server start (idempoten). Semua proyek/media tanpa `ownerId` (atau milik mode lokal) diberikan ke **admin pertama**. Sebelum menulis apa pun, `users.json` disalin ke `data/backups/v1.7-user-ids-<waktu>/` dan semua `projects/*.json`, `library/*/meta.json` yang diubah ke `data/backups/v1.7-owner-migration-<waktu>/`. Field baru hanya **ditambahkan**, sehingga v1.6 tetap bisa membaca data (rollback = pasang v1.6 lagi).

**Exit gate:** User A tidak bisa mengakses aset User B lewat API, file, maupun MCP (tes negatif otomatis); backup + migrasi terverifikasi di tes.

## P1 — Measurement baseline ✅ (v1.7)

| File | Task |
|---|---|
| `public/js/metrics.js` (baru) | Kolektor metrik di browser (bagian 9.1 blueprint): impor (`time_to_timeline_visible`, `asset_ready_time`, `upload_duration`), playback (fps, dropped frames, p50/p95 frame time, `seek_to_frame_ms`, decoder aktif, buffer wait, resolusi pratinjau), UI (long task > 50 ms), memori (JS heap bila tersedia, pemakaian OPFS), ekspor (prepare/decode/render/encode/mux, realtime factor, mode), sync (`save_ack_ms`, konflik). |
| `public/js/app.js` | Menu ⋯ → **Diagnostik**: ringkasan metrik + tombol salin JSON (untuk laporan bug/benchmark). |
| `lib/media-proxy.js`, `server.js` | Metrik backend: waktu tunggu antrean & durasi job per jenis, jumlah job, ruang disk; tersedia di `/api/status` (admin) dan `/api/jobs`. |
| `bench/` (baru) | `bench/fixtures.mjs` membuat fixture **B0–B3** dengan ffmpeg; `bench/run.mjs` (Playwright) mengukur B0–B5 dan menulis laporan JSON + Markdown yang bisa diulang. |

**Exit gate:** bottleneck bisa diidentifikasi per stage; laporan before/after untuk fase berikutnya.

## P2 — Timeline hot path ✅ (v1.7)

| File | Task |
|---|---|
| `public/js/store.js` | Nomor **revisi** proyek di memori (naik pada setiap mutate/live/undo/redo/load). |
| `public/js/plan.js` (baru) | **Render plan terkompilasi** per revisi: track visual/efek berurutan, klip terurut per track, indeks awal klip untuk **binary search**, chain key media. Dibangun ulang hanya saat revisi berubah. |
| `public/js/render.js`, `engine.js` | `renderFrame` & `engine.sync` memakai plan (tanpa filter/sort per frame). |
| Tes/benchmark | Tes kesetaraan hasil render (plan vs cara lama) + benchmark JS per frame pada proyek B2/B3 sintetis. |

**Exit gate:** B1/B2 tidak regresi; waktu JS per frame turun pada proyek besar; undo/redo & MCP tetap benar (tes e2e lama lolos).

## P3 — Render worker / WebGL2 ⏸ (ditunda)

Alasan: blueprint mewajibkan benchmark di perangkat nyata (PC, iPad, HP) sebelum memindahkan compositing ke OffscreenCanvas/WebGL2, dan menganggap WebGL bukan "tombol ajaib". Pengukuran v1.6 di Chromium tanpa GPU tidak mewakili iPad/HP. Langkah berikut: kumpulkan data **Diagnostik** (P1) dari perangkat nyata, lalu prototipe compositor WebGL2 untuk filter/adjustment layer di balik feature flag, dengan Canvas 2D tetap sebagai fallback.

## P4 — Export memory 🟡 (v1.7)

| File | Task |
|---|---|
| `public/js/fastexport.js` | Sumber video dibaca **bertahap** dari Blob (disk-backed) per sampel, bukan `arrayBuffer()` penuh; **backpressure** encoder (`encodeQueueSize` dibatasi); hasil encode video ditulis bertahap ke **file sementara OPFS** (bila tersedia) sehingga RAM tidak tumbuh sepanjang durasi; file akhir disusun dari Blob disk-backed. Pencatatan sumber yang dipakai per media. |
| `public/js/exporter.js` | Status mode (cepat/realtime) dan sumber kualitas penuh per media dicatat di hasil ekspor. |

Belum di v1.7: mix audio masih men-decode file audio utuh lewat `decodeAudioData` (perlu jalur AudioDecoder streaming).

## P5 — Media job system ✅ (v1.7)

| File | Task |
|---|---|
| `lib/jobs.js` (baru) | Antrean job **tahan restart** (jurnal di `data/jobs/`): id, idempotency key, state `queued/running/succeeded/failed/cancelled`, progress, heartbeat, retry dengan backoff, timeout, cancel (hentikan ffmpeg), concurrency terbatas per kelas (cepat/lambat) berdasarkan core & RAM. |
| `lib/media-proxy.js` | Memakai `lib/jobs.js` untuk salinan pratinjau, thumbnail/waveform, dan salinan kualitas penuh. |
| `server.js` | `GET /api/jobs` (hanya job milik pengguna), `POST /api/jobs/:id/cancel`, `POST /api/jobs/:id/retry`. |

## P6 — Multi-device sync ✅ (v1.7)

| File | Task |
|---|---|
| `lib/storage.js`, `server.js` | Revisi proyek (`rev`) + **optimistic concurrency**: simpan wajib membawa `baseRev`; jika tertinggal → `409` + info versi server (tidak ditimpa diam-diam). `GET /api/projects/:id/rev` ringan untuk polling. |
| `public/js/store.js`, `storage.js` | Kirim `baseRev`, simpan `rev` dari server; **draf lokal** (IndexedDB) setiap perubahan; flush saat tab disembunyikan/ditutup. |
| `public/js/app.js` | Polling revisi saat editor terbuka; perubahan dari perangkat lain dimuat otomatis bila tidak ada perubahan lokal; **dialog konflik**: muat versi terbaru / simpan sebagai salinan / timpa dengan sadar. |

## P7 — Cloud render ⏸ (ditunda)

Butuh keputusan biaya/infrastruktur (worker GPU terpisah). Blueprint: hanya setelah ekspor lokal stabil. Tidak dikerjakan.

---

## Rencana tes per fase

| Fase | Tes |
|---|---|
| P0 | `npm test`: tes negatif lintas akun (API, file, MCP, token pribadi), migrasi + backup, mode lokal tetap jalan. |
| P1 | Tes unit statistik metrik; `bench/run.mjs` menghasilkan laporan. |
| P2 | Tes kesetaraan render plan; e2e `ipad-ui`, `get-frame`; benchmark JS per frame. |
| P4 | Ekspor B1/B3: file valid (ffprobe: codec, resolusi, fps, durasi, audio), heap tidak tumbuh linear. |
| P5 | Tes unit antrean: idempotensi, retry, cancel, restart (jurnal), concurrency. |
| P6 | Tes API 409; e2e dua konteks browser (perangkat A & B). |

## Risiko & mitigasi

| Risiko | Mitigasi |
|---|---|
| Migrasi owner salah pemilik | Data lama → admin pertama (pemilik VPS); backup otomatis sebelum menulis; field hanya ditambahkan; rollback ke v1.6 aman. |
| MCP lama memakai server token | Server token tetap bekerja sebagai admin pertama (perilaku sama untuk instalasi satu pengguna). |
| Pengguna non-admin kehilangan akses AI | Token AI pribadi di menu akun. |
| Konflik revisi mengganggu alur satu perangkat | Polling hanya membandingkan revisi; dialog muncul hanya bila dua perangkat benar-benar mengubah proyek yang sama. |
| OPFS tidak tersedia (mode privat) | Ekspor kembali ke penyimpanan di memori (perilaku v1.6). |
| Job journal rusak | Jurnal per job (file kecil, tulis atomik); job tak terbaca dilewati dan dibuat ulang dari status media. |

## Rollout & rollback

- Semua perubahan backward compatible terhadap data v1.6 (field baru hanya ditambahkan).
- Rollback: pasang ulang v1.6.0; backup migrasi ada di `data/backups/`.
- Fitur baru yang berisiko punya saklar di `.env`: `NAJJA_JOB_FAST`, `NAJJA_JOB_SLOW` (concurrency), `NAJJA_SYNC_POLL_MS`, `NAJJA_EXPORT_SPOOL=0` (matikan spool OPFS).
