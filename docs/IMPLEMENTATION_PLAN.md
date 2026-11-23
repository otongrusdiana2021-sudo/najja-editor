# Implementation Plan — Najja Editor → Najja Creative Studio

- **Dasar:** [`AUDIT_REPORT.md`](AUDIT_REPORT.md), [`MCP_COMPATIBILITY_REPORT.md`](MCP_COMPATIBILITY_REPORT.md), [`DESIGN.md`](DESIGN.md), dan directive product owner (2026-11-23).
- **Melanjutkan**, bukan mengganti, [`NAJJA-VIDEO-IMPLEMENTATION-PLAN.md`](NAJJA-VIDEO-IMPLEMENTATION-PLAN.md) (P0–P7 lama, selesai di v1.7). Dua item lama yang ditunda masuk ke sini: render worker (→ P2-2) dan cloud render (→ P3-6).
- **Urutan berdasarkan ketergantungan teknis**, bukan kemudahan. ID temuan (M1, V6, D2, …) merujuk ke laporan audit.

## Aturan kerja setiap milestone

1. **Tujuan, file yang diubah, kriteria terima** ditulis sebelum kode.
2. **Quality gate:** `npm test` lulus (kecuali kegagalan karena lingkungan yang dicatat), test baru untuk perubahan itu, `npm run test:e2e` terkait lulus di mesin yang punya Playwright + ffmpeg, tidak ada error kritis di console, tidak ada regresi di 27 tool MCP.
3. **Performa:** setiap optimasi wajib punya hasil `bench/run.mjs` sebelum dan sesudah (profil `desktop` dan `ipad`) yang disimpan di `bench/results/`. Tanpa angka, tidak ada klaim.
4. **Kompatibilitas:** proyek lama harus tetap terbuka. Perubahan format wajib punya migrasi + test. Kontrak MCP v1 hanya boleh berubah aditif.
5. **Perangkat:** desktop (Chrome/Edge) dan iPad (Safari) diuji terpisah. Hasil iPad yang belum diuji di perangkat asli ditandai *belum diverifikasi di iPad*.
6. **Tidak ada perubahan destruktif atau migrasi besar** tanpa penjelasan dampak dan persetujuan product owner.

## Peta ketergantungan

```
P0-1 Antrian MCP ──┐
P0-2 Autosave benar ┼─► P0-6 Service layer core/ ──► P1-2 Job system ──► P1-5 MCP headless ──► P3-6 Cloud render
P0-3 Test + CI ─────┘            │                        │
                                 ├─► P1-1 Waktu frame-accurate ──► P1-4 Audio engine ──► P2-2 Ekspor di Worker
                                 └─► P1-3 Undo berbasis patch (video + Desain) ──► P2-1 Timeline cepat
P0-4 Keamanan + deploy (paralel)      P0-5 Ekspor Desain aman ──► P2-3 Memori Desain
```

---

## P0 — Critical foundation

| ID | Milestone | Temuan | File utama | Kriteria terima | Test |
|---|---|---|---|---|---|
| **P0-1** | **Antrian perintah MCP + mutex capture** | M1, M3 (sebagian) | `public/js/bridge.js`, `public/js/engine.js`, `server.js` (kirim tenggat) | Perintah dijalankan satu per satu per tab (FIFO), termasuk `runLocal`. Perintah yang sudah lewat tenggat server tidak dijalankan. Error di satu perintah tidak menghentikan antrian. 3 `get_frame` paralel → 3 frame benar. Tidak ada perubahan kontrak tool | Unit: urutan, tenggat, error, runLocal. E2E: 3 `get_frame` paralel |
| P0-2 | Autosave dan pengunci ekspor | V1, V5, V14 | `public/js/store.js`, `public/js/app.js` | Undo saat save berjalan tidak memunculkan konflik palsu. Draft di-flush saat unload. Retry dengan backoff. Pintasan dan tool MCP pengubah proyek ditolak dengan pesan jelas selama ekspor | Unit store (save + undo bersamaan, mock storage). E2E ekspor + Spasi |
| P0-3 | Test infra dan CI | T1, T2, T3 | `.github/workflows/ci.yml`, `test/proxy.test.js`, `test/mcp-contract.test.js` (baru) | CI menjalankan `npm test` di setiap push/PR. Snapshot kontrak 27 tool + 4 prompt gagal bila ada yang dihapus/diganti nama | CI hijau |
| P0-4 | Keamanan dan deploy | S1–S5, M8 | `server.js` (header), `public/sw.js`, `docs/DEPLOY.md`, nginx VPS, DNS | Header keamanan di semua HTML (CSP mulai report-only). Cache SW dihapus saat logout. `/.well-known/oauth-*` diteruskan ke app. `www.editor.najja.id` redirect. Deploy aaPanel terdokumentasi | Unit header. Cek `curl` setelah deploy |
| P0-5 | Ekspor Najja Desain aman | D2, D1, D3 | `public/js/design/assets.js`, `design/app.js`, `design/ui.js` | Foto yang gagal dimuat → ekspor dibatalkan dengan daftar foto bermasalah. Ukuran di atas batas perangkat → peringatan + downscale/tile. Font yang belum termuat → peringatan | `test/design.test.js` + e2e design |
| P0-6 | Application service layer (kerangka) | M2, M5 | `public/js/core/` (baru): `commands.js`, `validate.js`; `public/js/api.js`, `public/js/actions.js`, `mcp/protocol.js` | Operasi edit inti (tambah/ubah/hapus/pindah/split klip) jadi fungsi murni yang dipanggil **UI dan MCP**. Validasi schema `inputSchema` di server sebelum diteruskan ke tab. Perilaku tool tidak berubah | Unit `core/` di Node (tanpa DOM). Kontrak MCP lulus |

## P1 — Core editing engine

| ID | Milestone | Temuan | Kriteria terima | Ketergantungan |
|---|---|---|---|---|
| P1-1 | **Waktu frame-accurate** | V6, V7 | Batas edit (split, trim, drag, lepas scrub) dibulatkan ke grid fps. Klip minimum = 1 frame. Proyek lama dimigrasi tanpa mengubah durasi > ½ frame. Aturan pilih frame sama di pratinjau dan ekspor | P0-6 |
| P1-2 | Job system | M4, M3 | `export_video`, `get_transcript`, `apply_style` mengembalikan `job_id` (field lama tetap). Tool baru `get_job`, `cancel_job`, `list_jobs`. Pembatalan aman (ekspor dihentikan, file sementara dibersihkan) | P0-6 |
| P1-3 | Undo berbasis patch | V13, D5, D4 | Riwayat menyimpan patch, bukan snapshot penuh. Satu modul riwayat untuk video dan Desain. Desain punya rantai migrasi `designV` dan draft lokal IndexedDB | P0-6 |
| P1-4 | Audio engine | V2, V10, V11 | Satu `gainEnvelope(clip)` untuk pratinjau dan ekspor. Klip dengan kecepatan ≠ 1 tetap lewat ekspor cepat (time-stretch offline). Mix ekspor per blok 30–60 dtk | P1-1 |
| P1-5 | MCP headless (tool non-render) | M2 | Tool baca/ubah proyek bisa jalan tanpa tab terbuka, di atas `lib/storage.js` (revisi + lock per proyek). Tab yang terbuka menerima perubahan lewat sinkron yang sudah ada. `get_frame`/`export_video` tetap butuh tab | P0-6, P1-2 |

## P2 — Performance optimization (wajib benchmark sebelum/sesudah)

| ID | Milestone | Temuan | Ukuran sukses (diukur, bukan diklaim) |
|---|---|---|---|
| P2-1 | Timeline cepat | V15 | Fixture 500 klip subtitle: waktu render ulang timeline dan drag/trim per frame, sebelum vs sesudah |
| P2-2 | Ekspor di Worker + `OffscreenCanvas` | V4, V12 | Waktu ekspor dan jank main thread selama ekspor (B-fixture 1080p/4K), desktop dan iPad |
| P2-3 | Memori Najja Desain | D6, D7, D1 | Puncak memori dokumen 20 foto 6000 px, sebelum vs sesudah |
| P2-4 | Akselerasi hardware | V8, V16 | Pilih decoder dari statistik. Pulihkan WebGL setelah context lost. Eksperimen compositor WebGPU **di balik flag**, aktif hanya bila feature detection lolos, dengan fallback Canvas 2D |
| P2-5 | Kualitas pratinjau adaptif | — | Ukur mekanisme yang sudah ada (`player.js:72-99`) sebelum mengubah apa pun |

## P3 — Advanced features

| ID | Milestone | Catatan |
|---|---|---|
| P3-1 | Alat "Segera" yang paling diminta (Stabilkan, Putar mundur, Mask) | Satu per satu, masing-masing lengkap sesuai Definition of Done. Perlu dicek: README v1.9 menyebut "Kurangi kebisingan" dan "Sempurnakan suara" sudah ada di panel Volume, tapi toolbar masih menandainya *Segera* |
| P3-2 | Tool MCP baru | `get_frames`, `batch_edit`, `get_clip`, `get_project` ringkas, `lint_project`, resource aset |
| P3-3 | Kualitas Style Konsep | C1–C7: crossfade loop musik, buang potongan < 0,3 dtk, batas kepadatan SFX, zona aman platform, peringatan resolusi sumber |
| P3-4 | MCP untuk Najja Desain | `design_*` tools di atas service layer Desain |
| P3-5 | Ekspor besar | V3 (MP4 > 4 GB), V9 (salinan 4K untuk ekspor 4K) |
| P3-6 | Cloud render | Lanjutan P7 lama. Menghapus ketergantungan `get_frame`/`export_video` pada tab |
| P3-7 | Tata letak desktop | U5. **Butuh keputusan product owner** dan validasi user, karena mengubah komposisi |

## P4 — Polish and release readiness

| ID | Milestone | Temuan |
|---|---|---|
| P4-1 | Aksesibilitas | U1 (`aria-disabled` alat Segera), U2 (Spasi di tombol), U3 (reduced-motion, focus-visible), U4 (target 44 px, `aria-label`), U6 (J/K/L, I/O, focus trap) |
| P4-2 | Design token bersama | U7: `tokens.css` dengan nilai asli yang diekstrak, tanpa mengganti warna merek |
| P4-3 | iPad | D8 (fallback share), D9 (multi-select sentuh, mode Pencil), D10 (safe area). Uji Safari iPad asli per rilis (T4) |
| P4-4 | Dokumentasi | README (27 tool, M7), dokumentasi tool MCP lengkap, `DESIGN.md` §3.1 dikoreksi sesuai tata letak asli |

---

## Status

| Milestone | Status |
|---|---|
| P0-1 Antrian perintah MCP + mutex capture | ✅ selesai. **Di produksi sejak 2026-11-23** (PR #1, `96d2e9f`) bersama P0-2 sampai P0-6b langkah 3, V19, dan V20 |
| P0-2 Autosave + kunci ekspor | ✅ selesai, di-commit di branch `feat/p0-2-autosave-export-lock` (dibangun di atas P0-1; **belum di-push dan belum di-deploy**). Thumbnail per-autosave (bagian V14) ditunda ke P2 karena butuh benchmark |
| P0-3 Test infra + CI | ✅ selesai. Branch `feat/p0-3-contract-ci` (berisi P0-1 + P0-2 + P0-3) **sudah di-push** ke GitHub (belum di-merge ke `main`, belum di-deploy). Run CI pertama **hijau** (run 45125714348). E2E Playwright di CI ditunda |
| P0-4 Keamanan dan deploy | 🟡 bagian kode selesai, di-commit di branch `feat/p0-4-security-deploy`, ikut di-push lewat branch `feat/p0-5-design-export` (CI hijau, run 45129262367). Snippet nginx `.well-known` **dipasang di VPS 2026-11-23**. **Belum:** record DNS `www` (butuh akses pengelola DNS) |
| P0-5 Ekspor Najja Desain aman | ✅ selesai, branch `feat/p0-5-design-export` (berisi P0-1 sampai P0-5) **sudah di-push**. CI hijau di Node 22 (run 45129262367). Belum di-merge ke `main`, belum di-deploy. Belum diuji di iPad Safari asli (jalur perkecil-otomatis hanya terpicu di sana) |
| P0-6a Validasi argumen MCP di server | ✅ selesai, di-commit di branch `feat/p0-6-mcp-validation` (di atas P0-5; belum di-push) |
| P0-6b Service layer `public/js/core/` | 🟡 langkah 1 (validator + schema), 2 (split/hapus/duplikat/pindah/tambah), dan 3 (`update_clip` + helper gaya/visual/animasi) selesai. Langkah 3 dan perbaikan V20 di branch `fix/v20-update-clip-atomic` (sudah di-push, CI hijau run 45135252249). Sisa: subtitle, efek klip, keyframe, dan helper model dari `store.js` |
| P1-2 Job system | ✅ selesai. PR #3 (`01fbfff`) **di produksi sejak 2026-11-23**. Jalur sukses `apply_style`/`get_transcript` di latar belakang belum diuji dengan layanan AI sungguhan |
| DESIGN §3.1 → Ukuran layar per perangkat | ✅ selesai. **Di produksi sejak 2026-11-23** (`0744fd6`). Desain tetap; tiap perangkat mengatur skalanya di menu akun. Belum dicoba di iPad asli dan Safari Mac |
| Lainnya | ⏳ belum mulai |

### Log milestone

#### P0-1 — Antrian perintah MCP + mutex capture (2026-11-23)

- **Tujuan:** perbaiki M1 (frame salah dan edit saling selip saat perintah datang bersamaan) dan sebagian M3 (perintah basi), tanpa mengubah kontrak tool.
- **Perubahan:**
  - `public/js/cmdqueue.js` (baru): antrian FIFO murni (tanpa DOM) + tenggat + daftar `PURE_READS`.
  - `public/js/bridge.js`: `run()` dan `runLocal()` lewat `schedule()`. Tool baca murni (`get_project`, `list_assets`, `list_media`, `list_styles`, `get_export_status`) langsung jalan. Perintah yang masih antri saat server berhenti menunggu tidak dijalankan. Status log `wait` → `run` → `ok/error`.
  - `public/js/engine.js`: `capture()` dikunci (satu per satu). Isi lamanya jadi `captureNow()`. Ini juga melindungi pembuatan sampul (`cover.js`) dari bentrok dengan `get_frame`.
  - `server.js`: perintah ke tab membawa `timeout_ms` (aditif. Editor lama mengabaikannya, editor baru dengan server lama tetap jalan tanpa tenggat).
  - `public/js/library.js`: log AI menampilkan "antri".
  - `test/cmdqueue.test.js` (baru, 11 test), `test/e2e/get-frame.mjs` (+ kasus 3 `get_frame` paralel), `package.json` (daftar test).
- **Kontrak MCP:** tidak berubah (nama, schema, bentuk hasil sama). Satu perubahan perilaku yang disengaja: perintah yang masih antri melewati timeout server menjawab error "Not run: …" dan tidak mengubah proyek.
- **Hasil test:**
  - Unit: **154 test, 133 lulus, 8 gagal, 13 dilewati**. Daftar 8 yang gagal **identik dengan baseline** (7 karena disk Mac penuh → HTTP 507, 1 karena ffmpeg tidak ada). 11 test baru lulus.
  - Mutation check: dengan antrian dimatikan, 3 test bridge gagal. Artinya test benar-benar mendeteksi bug.
  - Browser asli (Chromium di app, server lokal, engine asli), 3 `get_frame` paralel pada klip merah/hijau/biru dengan font yang belum termuat: **perilaku v1.13.1 → biru, biru, biru** (bug produksi tereproduksi). **Setelah perbaikan → merah, hijau, biru.**
  - Console: tidak ada exception JS. Satu-satunya error adalah 404 polling `/rev` untuk proyek baru yang belum tersimpan (perilaku lama, dicatat sebagai V18).
  - **Belum:** `npm run test:e2e` (butuh paket Playwright + ffmpeg + ruang disk), uji di iPad Safari asli, deploy.
- **Risiko tersisa:**
  - Tool panjang (`apply_style`, `get_transcript` sampai 50 menit) sekarang menahan tool pengubah lain di belakangnya. Itu memang benar (tidak boleh selip), tapi AI akan menerima error timeout/"Not run" untuk perintah yang antri terlalu lama. Solusi permanen ada di P1-2 (job ID).
  - Edit manual user di UI tidak ikut antrian MCP. Tabrakan edit user vs AI ditangani di P0-6/P1-5 (revisi + `expected_rev`).
- **Berikutnya:** P0-2 (autosave + kunci ekspor), lalu P0-3 (snapshot kontrak MCP + CI).

#### P0-2 — Autosave benar + kunci ekspor (2026-11-23)

- **Tujuan:** V1 (konflik palsu setelah undo saat save), V5 (pintasan dan tool MCP aktif saat ekspor), V14 (draft tidak di-flush saat tab ditutup, retry tanpa backoff), plus V18 (polling `/rev` 404 untuk proyek yang belum tersimpan).
- **Perubahan:**
  - `public/js/store.js`:
    - Balasan save tidak lagi dibuang saat objek proyek diganti undo/redo/batal-geser. Pembandingnya sekarang `loads` (naik hanya saat proyek dibuka lewat `setProject`), bukan identitas objek. V1 kini **FAKTA**: server menolak `baseRev` basi dengan 409 (`lib/storage.js:122`), dan bug-nya direproduksi di unit test.
    - "Ada perubahan selama save" sekarang dihitung lewat `edits` yang naik di setiap `scheduleSave()`, bukan `updatedAt`. Ini juga menutup bug yang ditemukan saat implementasi: perubahan info media yang memanggil `scheduleSave()` tanpa `touch()` (`media.js`, `stylerun.js`, misalnya saat upload selesai) di tengah save dulu ditandai tersimpan padahal belum sampai server.
    - Batal-geser (`cancelLive`) di tengah save memicu save ulang, supaya server tidak menyimpan posisi setengah-geser.
    - Retry setelah gagal: 5, 10, 20, 40, lalu 60 dtk (maksimal), kembali ke awal setelah sukses.
  - `public/js/app.js`:
    - `flushNow()` menulis draft perangkat seketika (bukan setelah 400 ms) dan memulai save. Dipanggil di `beforeunload`, `pagehide` (Safari iPad bisa menutup tab tanpa `beforeunload`), dan saat tab disembunyikan.
    - Event `online` langsung menyimpan tanpa menunggu sisa backoff.
    - Polling revisi dilewati selama `baseRev` = 0 (V18).
    - Saat ekspor berjalan, pintasan keyboard tidak menjalankan apa pun. Spasi, Enter, dan kombinasi Ctrl/⌘ milik app ditahan supaya tidak "menekan" tombol yang masih fokus di belakang overlay (kecuali tombol di kartu ekspor sendiri, misalnya Batal). Kartu ekspor menampilkan "Pintasan keyboard tidak aktif selama ekspor. Tekan Batal untuk berhenti." selama 3 dtk. Pesannya ditaruh di kartu karena toast (z-index 60) tertutup overlay (z-index 90).
  - `public/js/cmdqueue.js`: `DURING_EXPORT` (baca murni + `export_video`) dan `blockedReason()`.
  - `public/js/bridge.js`: `schedule()` menanyakan `handlers.blocked(tool)` **saat giliran tool tiba**, sehingga tool yang sudah antri sebelum ekspor dimulai pun ditolak (kode `BUSY`, proyek tidak berubah).
  - `test/store-save.test.js` (baru, 7 test), `test/cmdqueue.test.js` (+3 test), `package.json`.
- **Kontrak MCP:** nama, schema, dan bentuk hasil tidak berubah. Perubahan perilaku yang disengaja: selama ekspor merender, tool selain baca murni dan `export_video` menjawab error "Not run: a video export is rendering… Poll get_export_status and call it again when the export is done." Sebelumnya `get_frame`/`playback` bisa menjeda dan men-seek engine yang sedang diputar ekspor real-time, dan tool edit mengubah proyek yang sedang dirender.
- **Hasil test:**
  - Unit: **164 test, 150 lulus, 1 gagal, 13 dilewati**. Satu-satunya yang gagal adalah `proxy.test.js:132` karena ffmpeg tidak ada (T2, jatah P0-3). 7 kegagalan "disk penuh" di baseline hilang karena ruang disk sudah ada (1,8 GB), bukan karena perubahan kode. 10 test baru lulus.
  - Mutation check: `store.js` lama → 5 dari 7 test store gagal (2 sisanya memang menjaga perilaku yang sudah benar: proyek lain dibuka saat save, dan konflik asli tetap ditanyakan). `bridge.js` lama → 2 test kunci ekspor gagal.
  - Browser asli (server lokal, storage server sungguhan):
    - Undo di tengah save yang diperlambat: tidak ada konflik, `saveState` = `saved`, server rev 3 berisi hasil undo.
    - Ekspor cepat (WebCodecs) 1080p: Spasi, ⌘Z, dan Delete tidak berefek, catatan muncul di kartu, `update_clip`/`get_frame`/`playback` → `BUSY`, `get_project`/`get_export_status` tetap jalan, ekspor selesai.
    - Ekspor real-time (WebM) 5 dtk: Spasi di tengah ekspor tidak menjeda engine, ekspor selesai dalam 5,18 dtk.
    - `pagehide` → draft ditulis pada 0 ms (sebelumnya menunggu 400 ms).
    - Proyek belum tersimpan → 0 request `/rev` dalam 3,5 dtk (sebelumnya ±1/dtk, 404).
    - Console dan log server tanpa error.
    - Data uji (1 proyek, 2 file ekspor) dihapus dari `data/` lokal.
  - **Belum:** `npm run test:e2e` (butuh paket Playwright + ffmpeg), iPad Safari asli (`pagehide` dan pintasan keyboard eksternal), deploy.
- **Risiko tersisa:**
  - `exportState.state` baru menjadi `running` setelah `ensureCutout()` selesai (`exporter.js:118`). Selama model hapus-latar dimuat di awal ekspor, tool dan pintasan belum terkunci. Jendelanya pendek dan hanya terjadi kalau ada klip "Hapus latar otomatis". Bisa ditutup di P1-2 (job system).
  - Penulisan IndexedDB saat `pagehide`/`beforeunload` dimulai seketika, tapi browser tidak menjamin transaksinya selesai sebelum halaman mati. Ini lebih baik dari sebelumnya, tapi bukan jaminan.
  - Thumbnail JPEG masih dibuat di setiap autosave (bagian V14). Ditunda ke P2 karena butuh benchmark main thread sebelum dan sesudah.
- **Berikutnya:** P0-3 (snapshot kontrak MCP + guard skip `proxy.test.js` + CI).

#### P0-3 — Test infra dan CI (2026-11-23)

- **Tujuan:** T1 (tidak ada CI), T2 (test ffmpeg tanpa skip), T3 (kontrak 27 tool tidak dijaga test).
- **Perubahan:**
  - `test/mcp-contract.mjs` (baru): mengambil kontrak dari `tools/list` dan `prompts/list` handler protokol yang asli (bukan salinan), lalu membandingkannya dengan snapshot. `node test/mcp-contract.mjs --update` menulis snapshot dan **menolak** bila perubahannya merusak (aturan lengkap di `MCP_COMPATIBILITY_REPORT.md` §7).
  - `test/fixtures/mcp-contract-v1.json` (baru): snapshot 27 tool + 4 prompt. Dibuat dari kode yang `mcp/` dan `lib/`-nya identik dengan v1.13.1 produksi (`git diff 86305a7 -- mcp/ lib/` kosong).
  - `test/mcp-contract.test.js` (baru, 27 test):
    - Kontrak v1 utuh, dan snapshot berisi 27 tool + 4 prompt.
    - Isi `tools/list` = `TOOLS`.
    - Setiap tool punya handler di `public/js/api.js` (cek statis), sehingga tidak ada yang menjawab "not supported".
    - 16 jenis perubahan merusak ditolak, 7 jenis perubahan aditif diterima.
  - `test/proxy.test.js`: test "light copy 60 fps" sekarang `{ skip }` bila ffmpeg/libx264 tidak ada. Guard-nya terpisah (`skipX264`) karena test ini tidak butuh libx265.
  - `.github/workflows/ci.yml` (baru): setiap push dan PR, Node 22 (versi image produksi), pasang ffmpeg, `node --check` 59 modul `public/js`, lalu `npm test`. Izin hanya `contents: read`. Run lama dibatalkan bila ada push baru di ref yang sama.
  - `package.json`: `test/mcp-contract.test.js` masuk `npm test`.
- **Hasil test:**
  - Unit lokal (Node 26, tanpa ffmpeg): **191 test, 177 lulus, 0 gagal, 14 dilewati**. Run lokal pertama yang hijau total (sebelumnya 1 gagal karena T2).
  - Mutation check di kode asli: `split_clip` diganti nama sementara di `mcp/tools.js` → test kontrak gagal dengan pesan "tool split_clip: gone…", dan `--update` menolak menulis (exit 1). File dikembalikan, snapshot tidak tersentuh.
  - Workflow: YAML valid (diparse Ruby), langkah `find … | xargs node --check` dijalankan lokal dan lulus.
  - **CI di GitHub (2026-11-23):** branch di-push (token keychain ternyata punya scope `workflow`). Run pertama https://github.com/otongrusdiana2021-sudo/najja-editor/actions/runs/45125714348 **sukses**. Semua langkah lulus: pasang ffmpeg 15 dtk, cek sintaks 1 dtk, `npm test` di Node 22 10 dtk. Jadi suite lulus di Node 22. Jumlah test per status belum dilihat karena log Actions hanya bisa dibuka setelah login GitHub. Durasi `npm test` 10 dtk (lokal tanpa ffmpeg 1,5 dtk) **mengindikasikan** test proxy ffmpeg ikut jalan, tapi itu belum dipastikan dari log.
- **Risiko tersisa:**
  - Bentuk output tool belum masuk snapshot (tidak ada `outputSchema`). Ditangani test per tool di fase B.
  - E2E Playwright (Chromium + WebKit) belum ada di CI. Playwright bukan dependency project. Menambahkannya perlu memasang paket `playwright` dan browser, sebaiknya diuji lokal dulu.
- **Berikutnya:** P0-4 (header keamanan, cache SW dibersihkan saat logout, nginx `.well-known`, DNS www, DEPLOY doc). Sebagian butuh perubahan di VPS/DNS, jadi perlu izin eksplisit.

#### P0-4 — Keamanan dan deploy (2026-11-23)

- **Tujuan:** S1 (header keamanan), S2/M8 (OAuth `/.well-known` 404 di aaPanel), S3 (`www` tanpa DNS), S4 (deploy produksi tidak terdokumentasi), S5 (cache SW saat logout).
- **Fakta yang dicek sebelum mengubah apa pun:**
  - Produksi (curl read-only): `/.well-known/oauth-*` dan `/openid-configuration` = 404, cadangan `/oauth/*` = 200. Header keamanan di `/login` hanya HSTS (dari nginx).
  - VPS (SSH read-only): `/opt/najja-editor` = checkout git `86305a7` tanpa perubahan lokal. nginx 1.24 aaPanel. `location /.well-known{ root … }` mengalahkan proxy `^~ /` karena prefiksnya lebih panjang. Folder `extension/editor.najja.id/` di-include di blok server.
  - DNS: `www.editor.najja.id` tanpa record A.
  - Inventaris sumber eksternal app: hanya Google Fonts (`fonts.googleapis.com` CSS, `fonts.gstatic.com` font). Tidak ada iframe. Worker dari `blob:` (detak engine) dan modul origin sendiri (voicefx). WASM onnxruntime dari `/vendor/` sendiri. Halaman login tanpa script inline. Dashboard ecom (`~/Downloads/REA/najja`) tidak menyematkan editor.
- **Perubahan:**
  - `server.js`:
    - `X-Content-Type-Options: nosniff` di setiap respons.
    - Di setiap HTML (editor, Najja Desain, fallback SPA, login, dan juga respons 304): `Content-Security-Policy: frame-ancestors 'self'`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`, plus `Content-Security-Policy-Report-Only` (default `'self'`, `script-src 'self' 'wasm-unsafe-eval'`, Google Fonts, `blob:`/`data:` untuk media dan worker, `object-src 'none'`, `base-uri 'self'`).
    - `form-action` sengaja tidak dipakai, karena di Chrome direktif ini berlaku juga untuk redirect setelah submit form, sehingga persetujuan OAuth tidak bisa kembali ke klien AI.
    - HSTS tidak ditambahkan di app karena sudah dipasang nginx.
  - `public/sw.js`: navigasi ke `/logout` atau `/login` menghapus cache `najja-shell-*`. Model AI (`najja-models-*`) tetap. Halamannya sendiri tetap dimuat dari jaringan.
  - `deploy/aapanel/najja-wellknown.conf` (baru): dua `location` yang meneruskan hanya path OAuth discovery ke app, dengan header sama dengan proxy utama situs. ACME tidak tersentuh.
  - `docs/DEPLOY.md`: bagian aaPanel `.well-known`, bagian "Produksi editor.najja.id" (fakta, prosedur update dan rollback lewat git, cek setelah deploy, langkah `www`), dan catatan keamanan v1.13.2.
  - `test/security.test.js` (+4 test header), `test/sw.test.js` (baru, 4 test), `package.json`.
- **Hasil test:**
  - Unit: **199 test, 185 lulus, 0 gagal, 14 dilewati**.
  - Mutation check: `server.js` dan `sw.js` lama → 7 dari 8 test baru gagal. Yang lulus adalah test "halaman lain tidak menyentuh cache", yang memang menjaga perilaku yang tidak berubah.
  - Browser asli (server lokal):
    - Header sampai ke browser.
    - **0 pelanggaran CSP** sepanjang alur editor (project baru, warna, teks dengan font Bangers, stiker, filter, `get_frame`, putar, ekspor cepat) dan Najja Desain (templat, panel teks, panel elemen, bentuk).
    - Alat ukurnya divalidasi: script inline yang sengaja disuntikkan terlapor (`script-src-elem`) tapi tetap jalan, sesuai mode report-only.
    - Buka `/logout` → entri Najja Desain di cache shell turun dari 10 ke 1. Satu yang tersisa (`/js/design/model.js`) memang diimpor lagi oleh beranda editor.
    - Log server bersih. Data uji dihapus.
  - **Tidak diuji:** fitur yang membuat server mengunduh library vendor (ikon Lucide, hapus latar, deteksi wajah), karena belum pernah terunduh di server lokal dan unduhan pihak ketiga tidak dipicu tanpa izin. Fitur itu memakai `/vendor/` (origin sendiri) dan WASM, yang sudah diizinkan kebijakan, tapi belum terbukti di browser.
- **Belum dipasang (butuh izin/akses):**
  - S2: salin `deploy/aapanel/najja-wellknown.conf` ke `/www/server/panel/vhost/nginx/extension/editor.najja.id/`, lalu `nginx -t && nginx -s reload`. Tidak mengubah file vhost yang ada. Rollback dengan menghapus file itu lalu reload.
  - S3: record DNS `www.editor` di pengelola domain `najja.id`, lalu domain + SSL + redirect 301 di aaPanel.
  - Deploy kode P0-1 sampai P0-4 ke produksi: keputusan terpisah.
- **Temuan baru:** S7. Draft perubahan (IndexedDB) dan salinan media (OPFS) tetap ada setelah Keluar. Butuh keputusan produk; jangan hapus draft yang belum sampai server.
- **Risiko tersisa:**
  - CSP baru report-only. Mengubahnya jadi wajib sebaiknya setelah dipantau di produksi, termasuk fitur vendor.
  - `X-Frame-Options: SAMEORIGIN` akan memblokir siapa pun yang selama ini menyematkan editor dari domain lain. Di repo dan di dashboard ecom tidak ditemukan pemakaian seperti itu.
- **Berikutnya:** pasang S2 di VPS (dengan izin), lalu P0-5 (keamanan ekspor Najja Desain: D2, D1, D3).

#### P0-5 — Ekspor Najja Desain aman (2026-11-23)

- **Tujuan:** D2 (foto gagal dimuat dibuang diam-diam), D1 (ukuran di atas batas perangkat), D3 (font belum termuat).
- **Perubahan:**
  - `public/js/design/exportcheck.js` (baru, tanpa DOM):
    - `photosOf()`: foto yang dipakai, beserta nomor halamannya.
    - `fontsOf()`: font per tampilan teks, dengan bobot yang benar-benar ada dan huruf yang dipakai, supaya subset font yang dibutuhkan ikut dimuat.
    - `exportScale()`: skala terbesar yang bisa digambar perangkat.
    - `photoLabel()`.
    - `SAFE_PIXELS` = 4096 × 4096 (batas luas kanvas Safari iOS/iPadOS).
  - `public/js/design/assets.js`:
    - `exportSources()` mengembalikan `failed` (id, halaman, error), bukan menelan error dengan `catch {}`.
    - `original()` mengambil ulang foto asli bila yang tersisa hanya salinan layar. Sebelumnya fungsi ini bisa mengembalikan kosong.
  - `public/js/design/draw.js`: `canvasFits(w, h)` membuat kanvas, menggambar satu piksel di pojok terjauh, membacanya kembali, lalu langsung membebaskan memorinya.
  - `public/js/design/app.js` `exportFiles()`:
    - Foto gagal → berhenti dengan kode `PHOTOS` dan daftar nama fotonya.
    - Font yang belum termuat, setelah dimuat ulang dengan huruf yang dipakai (tunggu maks 3 dtk) → berhenti dengan kode `FONTS`, kecuali `anyway: true`.
    - Ukuran di atas `SAFE_PIXELS` ditanyakan ke perangkat. Bila tidak sanggup, diekspor pada skala terbesar yang muat.
    - Hasil ekspor sekarang menyertakan `width`, `height`, dan `reduced` (aditif).
  - `public/js/design/ui.js` (dialog ekspor, tanpa elemen baru):
    - Alasan berhenti ditampilkan di catatan dialog yang sudah ada, dengan warna `--danger`, ditambah toast.
    - Untuk font, tombol Unduh berubah menjadi "Tetap unduh".
    - Ukuran besar diberi tahu sebelum ekspor.
    - Toast hasil menyebut ukuran bila hasilnya diperkecil.
    - Tombol 2× tetap dinonaktifkan seperti sebelumnya.
  - `test/design-export.test.js` (baru, 6 test), `package.json`.
- **Hasil test:**
  - Unit: **205 test, 191 lulus, 0 gagal, 14 dilewati**.
  - Mutation check: `assets.js` lama → test `exportSources` gagal.
  - Browser asli (Chromium, server lokal, desain "Foto Produk" + foto 800×600 + teks Bangers):
    - Ekspor normal: 1080×1080, `reduced: false`.
    - Foto dibuat 404: ekspor berhenti dengan `PHOTOS` dan nama "kaos-merah". Dialog menampilkan catatan merah dan toast, tidak ada file. Setelah jaringan pulih, ekspor berhasil.
    - `document.fonts.check` dibuat gagal untuk Bangers: berhenti dengan `FONTS`. Dialog menampilkan catatan dan tombol "Tetap unduh" (tombol aktif), dan `anyway` menghasilkan file.
    - Probe kanvas di Chromium: 5000×4000 dan 8000×8000 muat, 20000×20000 tidak muat. Keempat probe (termasuk 64 MP) total 100 ms.
    - Desain 5000×4000 (20 MP, di atas batas aman) diekspor penuh 5000×4000 dalam 346 ms.
    - Console dan log server bersih. Data uji (desain + foto) dihapus.
  - Tombol Unduh di dialog tidak ditekan sampai mengunduh, supaya tidak ada file tersimpan di folder Downloads pengguna. Jalur unduhnya tidak berubah.
- **Belum diuji:** jalur "diperkecil otomatis" di iPad Safari asli. Di Chromium jalur ini tidak terpicu karena probe selalu muat; logikanya hanya dibuktikan di unit test dengan probe palsu.
- **Risiko tersisa:**
  - Probe memakai memori sebesar kanvas ekspor sesaat. Ini sama dengan yang dipakai ekspor itu sendiri, dan hanya dijalankan di atas 16,7 MP.
  - Foto yang memang sudah terhapus di server akan memblokir ekspor sampai foto itu diganti. Ini disengaja: lebih baik daripada file tanpa foto produk.
- **Berikutnya:** P0-6 (service layer `public/js/core/` + validasi schema di server). Ini milestone besar dan sebaiknya dipecah.

#### P0-6a — Validasi argumen MCP di server (2026-11-23)

- **Kenapa dipecah:** P0-6 punya dua bagian yang tidak saling bergantung: validasi schema di server (M5) dan service layer `core/` (M2). Validasi kecil, berisiko rendah, dan langsung mencegah data rusak, jadi dikerjakan dulu. Service layer adalah refactor besar, dan dikerjakan bertahap di P0-6b.
- **Fakta sebelum mengubah:**
  - Argumen tool diteruskan apa adanya ke tab editor. Contoh: `update_clip` mengubah `x: "abc"` menjadi `NaN` (`set('x', Number(a.x))`, `api.js:95`), dan `opacity` menjadi `NaN` lewat `clamp` (`api.js:99`). Nilai itu tersimpan sebagai `null` di JSON proyek.
  - Banyak `enum` **tidak** dicek handler (mis. `font`, `animation_in`, `preset`), dan `history` tanpa `action` menjalankan undo. Menolak hal-hal ini di server akan memutus panggilan yang selama ini jalan, dan itu melanggar aturan kontrak "hanya aditif".
- **Kebijakan (`mcp/validate.js`):**
  - **Ditolak:** tipe yang mustahil benar, bahkan setelah konversi yang dulu dilakukan editor. Contoh: object/array di tempat skalar, teks non-angka atau boolean di tempat angka, skalar di tempat array/object (bertingkat, mis. `items[0].start`). Dikembalikan sebagai *tool error* (`isError`) supaya AI bisa membetulkan sendiri, dan editor tidak menerima apa pun.
  - **Dikonversi:** apa yang dulu dikonversi editor, sekarang dilakukan sekali di server: `"1.5"` → `1.5`, `"true"`/`"false"` → boolean, angka → teks.
  - **Dicatat saja:** field wajib kosong, `enum` di luar daftar, nilai di luar rentang, bukan bilangan bulat, dan field tak dikenal. Panggilan tetap diteruskan, dan catatan `Note: …` ditambahkan sebagai item terakhir hasil (item pertama tetap data). Untuk error dari handler, catatan ikut di pesan error.
  - `null` berarti "tidak diisi" dan diteruskan tanpa diubah.
- **Perubahan:**
  - `mcp/validate.js` (baru).
  - `mcp/protocol.js` `tools/call`: dipakai bersama HTTP `/mcp` dan stdio.
  - `server.js` `/api/tool`: endpoint yang dipakai `mcp-stdio.js`. Di sini hanya penolakan tipe, tanpa catatan, supaya catatan tidak muncul dua kali.
  - `test/mcp-validate.test.js` (baru, 8 test), `test/security.test.js` (+1), `package.json`.
- **Kontrak MCP:** nama, schema, dan bentuk hasil tidak berubah (`test/mcp-contract.test.js` lulus). Perubahan perilaku yang disengaja:
  - Tipe mustahil ditolak.
  - Hasil bisa membawa item catatan tambahan di akhir `content`.
  - Pesan error tipe berubah dari error handler (kalau dulu ada) menjadi pesan validasi.
- **Hasil test:**
  - Unit: **214 test, 200 lulus, 0 gagal, 14 dilewati**.
  - **Test kompatibilitas:** untuk ke-27 tool, argumen valid yang dibangkitkan dari schema-nya sendiri (lengkap, dan hanya field wajib) lolos **tanpa diubah, tanpa error, tanpa catatan**.
  - Mutation check: `protocol.js` dan `server.js` lama → 4 test integrasi gagal.
  - MCP sungguhan (HTTP `/mcp` lokal, tab editor terbuka):
    - `update_clip x:"kiri"` → `isError` "Invalid arguments for update_clip: x: expected a number, got string "kiri". Nothing was changed.", dan `x` di proyek tetap `0`.
    - `opacity:"0.5"` → tersimpan `0.5`.
    - `add_text size:"120"` → tersimpan angka `120`, dengan catatan untuk field `colour` yang salah eja.
    - Log bridge di editor hanya berisi 4 perintah yang sah. Yang ditolak tidak pernah sampai ke tab.
    - Log server bersih. Proyek uji dihapus.
- **Belum dicakup:** perintah yang ditempel manual di panel AI · MCP (`bridge.runLocal`) jalan langsung di browser, tidak lewat server, jadi tidak divalidasi. Akan tercakup saat validasi dipindah ke `core/` (P0-6b).
- **P0-6b (usulan pemecahan):**
  1. `public/js/core/validate.js` memakai aturan yang sama (modul bersama untuk browser dan server).
  2. Operasi klip murni (tambah, ubah posisi, hapus, pindah, split) dipindah dari `actions.js`/`api.js` ke `core/commands.js` tanpa mengubah perilaku, dengan test kesetaraan sebelum dan sesudah.
  3. `api.js` dan UI memanggil `core/`.
- **Berikutnya:** P0-6b langkah 1.

#### P0-6b langkah 1 — Validator dan schema tool bersama di `public/js/core/` (2026-11-23)

- **Tujuan:** satu sumber aturan untuk server dan editor. Perintah yang ditempel di panel AI · MCP (`bridge.runLocal`) jalan langsung di browser, sehingga sebelumnya tidak ikut divalidasi.
- **Perubahan:**
  - `git mv mcp/tools.js public/js/core/tools.js` dan `git mv mcp/validate.js public/js/core/validate.js`. Import diperbaiki (`../presets.js`, `../kinetic.js`).
  - `mcp/tools.js` dan `mcp/validate.js` kini hanya meneruskan ekspor, sehingga semua import lama tetap jalan (`server.js`, `mcp-stdio.js`, test). Docker tetap menyalin `mcp/` dan `public/` seperti sebelumnya.
  - `public/js/bridge.js` `runLocal`:
    - Memakai `checkArgs` dan schema yang sama. Tipe salah ditolak (kode `INVALID`) sebelum proyek disentuh.
    - Argumen yang dikonversi diteruskan, dan catatan dikembalikan sebagai `result.notes`. Panggilan bersih menjawab persis seperti sebelumnya.
    - Schema dimuat lazily dengan dynamic import, hanya saat perintah ditempel pertama kali, sehingga editor tidak memuat 29 KB tambahan saat dibuka.
  - `public/js/library.js`: catatan validasi tampil di baris hasil panel, di sebelah ID klip, lewat `escapeHtml` yang sudah ada.
  - `test/cmdqueue.test.js` (+3 test).
- **Hasil test:**
  - Unit: **217 test, 203 lulus, 0 gagal, 14 dilewati**.
  - Mutation check: `bridge.js` lama → 2 test perintah tempel gagal.
  - Browser asli:
    - Server di-restart dengan susunan modul baru, dan `tools/list` tetap 27 tool.
    - `/js/core/validate.js` dan `/js/core/tools.js` dimuat dengan status 200.
    - `runLocal update_clip x:"kiri"` → `INVALID`, dan `x` tetap `0`. `x:"0.25"` → `0.25`, dengan catatan untuk `colour`.
    - Panel **Tempel JSON** sungguhan (2 perintah): `add_text` jalan dengan catatan *"warna" is not a parameter…* di barisnya, `size:"90"` tersimpan sebagai angka 90. `update_clip` ditolak dengan pesan validasi, dan toast berbunyi "1 dari 2 perintah jalan; berhenti di yang gagal".
    - Proyek uji dihapus.
- **Temuan baru:** V19 (lihat `AUDIT_REPORT.md`).
- **Berikutnya (P0-6b langkah 2):** operasi klip murni ke `core/commands.js`, dengan test kesetaraan sebelum dan sesudah.

#### P0-6b langkah 2 — Operasi klip inti di `public/js/core/commands.js` (2026-11-23)

- **Tujuan:** operasi edit inti yang dipakai UI **dan** MCP menjadi fungsi murni atas proyek, tanpa mengubah perilaku.
- **Cara membuktikan "tidak berubah":**
  1. **Rekam dulu, ubah kemudian.** Commit `3c1def0` berisi `test/core-commands.test.js` dan `test/fixtures/core-commands-golden.json`, direkam dari `actions.js` **sebelum** refactor. Isinya 21 skenario split/hapus/duplikat/pindah/tambah, dan untuk tiap skenario disimpan ringkasan track/klip, nilai balik, seleksi, dan **SHA-256 seluruh isi proyek** (key terurut), sehingga perubahan field apa pun ketahuan.
  2. Refactor dikerjakan, lalu rekaman yang sama diputar ulang: **21/21 identik**.
  3. **Mutation test pada `core`:**
     - Nama salinan diberi spasi → 6 skenario gagal.
     - Posisi pindah digeser 0,1 ms → awalnya **lolos**. Ternyata skenario "pindah ke waktu kosong" (`x1` ke 2,5 dtk) bertabrakan dengan `x2`, sehingga cabang tempat-kosong tidak pernah teruji. Skenarionya dibetulkan (ke 2 dtk), ditambah skenario tabrakan, lalu golden direkam ulang dari `actions.js` lama (hash file sama dengan commit `3c1def0`). Setelah itu mutasi ini ketahuan.
- **Perubahan:**
  - `public/js/core/commands.js` (baru): `mediaClip`, `addClip`, `splitTargets`, `splitClips`, `deleteClips`, `duplicateClip`, `moveClip`. Semuanya fungsi `(P, …)` tanpa `store`, engine, seleksi, atau DOM. Cek statis di test menjaganya.
  - `public/js/actions.js`: `addMediaClip`, `splitAt`, `deleteClips`, `duplicateClip`, dan `moveClip` memanggil `core` di dalam `store.mutate` (undo dan autosave tetap sama).
  - Yang tetap di `actions.js`: playhead, seleksi, cek file media hilang, dan "klip tidak ditemukan". Cek terakhir ini tetap di **luar** `mutate` seperti dulu, karena di dalamnya ia akan menghapus drag yang sedang berjalan (`store._live`).
  - Tool MCP `split_clip`, `delete_clip`, `move_clip`, `duplicate_clip`, dan `add_media_clip` sudah lewat `actions.*`, jadi otomatis ikut memakai `core`.
  - `test/core-commands.test.js` (22 test), `package.json`.
- **Hasil test:**
  - Unit: **239 test, 225 lulus, 0 gagal, 14 dilewati**.
  - Browser asli:
    - `core/commands.js` termuat.
    - Jalur MCP: split 3→4 klip, duplikat →5, pindah ke 0 (magnet mengurutkan ulang), hapus →4.
    - Jalur keyboard: S →5, ⌘D →6, Delete →5, ⌘Z →6, dengan riwayat undo tercatat.
    - Tidak ada error JS. Proyek uji dihapus.
- **Belum dipindah (langkah berikutnya):**
  - `update_clip` (handler besar di `api.js`).
  - Teks, subtitle, efek, dan keyframe.
  - Helper model (`makeClip`, `placeClip`, `splitClip`, `insertIntoMain`…) yang masih di `store.js`.
  - Masing-masing dipindah dengan pola rekam-dulu yang sama.
- **CI (2026-11-23):**
  - Run pertama (45132571639, commit `b6a8dac`) **gagal** di langkah unit test.
  - Di Mac tidak bisa direproduksi: Node 20 dan 26 lulus, `TZ=UTC` + locale C lulus, 6× konkurensi 3 lulus, semua import relatif cocok huruf besar/kecil, dan rekaman kesetaraan stabil 25×.
  - Log Actions butuh login, jadi ditambahkan langkah CI yang mengubah test gagal menjadi anotasi publik (`test/ci-annotate.mjs`, commit `86854dc`, sudah diuji pada output TAP asli).
  - Run berikutnya (45133468567) dengan kode aplikasi yang sama **hijau**. Artinya kegagalan pertama intermiten, dan nama test-nya tidak tercatat (lihat T5).
  - Perbaikan port test (`267463d`, port diminta ke OS) di-push. Run 45133833509 **hijau**. Belum terbukti bahwa ini memang penyebab flaky-nya; kalau terulang, anotasi CI akan menyebut test-nya.
- **Berikutnya:** P0-6b langkah 3 (`update_clip` ke `core/`) atau lanjut ke P1.

#### P0-6b langkah 3 — `update_clip` dan helpernya di `public/js/core/clipedit.js` (2026-11-23)

- **Cara (sama seperti langkah 2):**
  1. Commit `122caa7` merekam 21 skenario dari `api.js` **sebelum** refactor: teks, gaya, kinetik, visual dan keyframe, video, efek, warna, badge, nama, posisi dengan/tanpa magnet, semua penolakan, plus `add_text`/`add_sticker` yang memakai helper yang sama. Yang disimpan: jawaban tool, seleksi, jumlah langkah undo, dan SHA-256 seluruh proyek.
  2. Refactor, lalu diputar ulang: **identik**.
- **Mutation test:**
  - Batas skala 20→21, keyframe tanpa opacity, dan mute terbalik ketahuan.
  - "Ganti preset menghapus animasi kinetik" awalnya **lolos**, karena belum ada skenario yang mengganti preset pada teks yang beranimasi. Skenarionya ditambah, golden direkam ulang dari `api.js`/`actions.js` lama (hash file sama dengan `122caa7`), dan mutasi ini kemudian ketahuan.
- **Perubahan:**
  - `public/js/core/clipedit.js` (baru): `need`, `oneOf`, `color`, `fontFamily`, `presetStyle`, `applyTextStyle`, `applyVisual`, `applyAnim`, `updateClip(P, id, a)`. Dipindah apa adanya dari `api.js` dan `actions.js`.
  - `api.js` memakai helper itu untuk `update_clip` **dan** `add_media_clip`, `add_text`, `add_subtitles`, `add_sticker`. Pemindahan dengan magnet, hapus latar (async, layanan GPU/server), `clip_effects`, dan seleksi tetap di `api.js`.
  - `actions.js` meneruskan ekspor `presetStyle`, karena `inspector.js` mengimpornya dari sana.
  - Import yang tidak terpakai lagi dibersihkan.
  - Cek statis di test: `core/clipedit.js` dan `core/commands.js` tidak memakai `store`, `actions`, `document`, `window`, atau engine. Strip komentar kini juga membuang komentar blok, karena sebelumnya sempat salah menangkap kata `actions.moveClip` di JSDoc.
- **Perilaku lama yang sengaja dipertahankan (temuan V20):** nilai yang valid sudah masuk ke proyek walaupun argumen sesudahnya ditolak, dan tanpa langkah undo. Contoh: `{x: 0.3, filter: "nope"}` → `x` menjadi 0,3. Diperbaiki terpisah supaya perubahan perilakunya jelas tercatat.
- **Hasil test:**
  - Unit: **262 test, 248 lulus, 0 gagal, 14 dilewati**, stabil 3×. Satu run sempat gagal di `jobs.test.js` "restart: queued and interrupted jobs…" (file yang tidak disentuh). Test itu lulus 5× saat berdiri sendiri, jadi dicatat bersama T5 sebagai flaky.
  - Kontrak MCP lulus.
  - Browser asli lewat MCP:
    - `update_clip` teks: `preset: yellow`, `font: "Scholar"` → Libre Baskerville, `size: "150"` → 150, `x`, dan `text_motion: wordPop` terpasang semua dengan 2 langkah undo.
    - Warna latar dan warna kedua berubah. `color: "merah"` ditolak dengan pesan yang sama seperti dulu.
    - `inspector.js` termuat. Console bersih. Proyek uji dihapus.
- **Berikutnya:** perbaiki V20 (validasi semua argumen dulu, baru mengubah proyek), lalu sisa P0-6b atau lanjut ke P1.

#### Perbaikan V20 — `update_clip` yang ditolak tidak mengubah apa pun (2026-11-23)

- **Masalah:** panggilan `update_clip` yang ditolak tetap meninggalkan perubahan. Ada empat jalur:
  1. Nilai sebelum argumen yang ditolak sudah masuk, tanpa langkah undo.
  2. `start` di trek utama dengan magnet sudah memindahkan klip sebelum argumen lain dicek.
  3. `remove_background` di klip non-video/foto dicek setelah mutasi.
  4. `clip_effects` dengan efek tak dikenal dicek setelah mutasi.
  AI menerima error dan menganggap tidak ada yang berubah.
- **Cara:**
  1. Commit `82a4cb5` merekam keempat jalur itu dari kode **sebelum** perbaikan, plus satu `clip_effects` valid sebagai pembanding.
  2. Perbaikan dikerjakan, lalu golden direkam ulang. Diff golden di commit perbaikan adalah perubahan perilakunya.
- **Perbaikan:**
  - `api.js` `update_clip`: sebelum apa pun berubah, `updateClip` dijalankan pada **salinan** proyek (`store.snapshot()`), lalu cek `remove_background` dan `clip_effects`. Baru setelah semuanya lolos: pindah magnet, mutasi, dan sisanya.
  - `actions.js`: `checkClipEffects()` (aturan dan pesan sama, diambil dari `setClipEffects`).
- **Hasil:**
  - Golden: **hanya 4 skenario V20 yang berubah**. Sesudah perbaikan, `x` tetap, klip tidak pindah, dan 0 langkah undo. **Pesan penolakan identik**. 22 skenario lain tidak berubah.
  - Unit: **266 test, 252 lulus, 0 gagal**, 2×.
  - Browser (handler editor yang dipakai MCP): tiga panggilan yang ditolak meninggalkan proyek persis sama (urutan klip, `x`, 3 langkah undo, panjang snapshot). Panggilan valid tetap pindah dan mengubah `x` dengan 2 langkah undo, seperti dulu. Console bersih.
- **Kontrak MCP:** nama, schema, dan pesan error sama. Perubahan perilaku: panggilan yang ditolak tidak lagi mengubah proyek (perbaikan bug).
- **CI:** branch `fix/v20-update-clip-atomic` di-push, dan run 45135252249 hijau di Node 22.
- **Belum tercakup:** kegagalan **layanan** hapus latar (mis. model belum siap) yang terjadi setelah perubahan lain. Itu bukan argumen yang ditolak, dan perubahan lainnya sah dengan langkah undo sendiri.

#### Perbaikan V19 — proyek yang dihapus di perangkat lain saat sedang terbuka (2026-11-23)

- **Masalah yang terbukti:**
  1. Polling `/rev` mendapat 404 setiap detik tanpa henti, dan pengguna tidak pernah diberi tahu.
  2. **Ditemukan saat pengujian:** autosave yang masih tertunda saat proyek dihapus di perangkat lain **membuat ulang proyek itu diam-diam** di server. Server menerima `PUT` dengan `baseRev > 0` untuk proyek yang sudah tidak ada. Dibuktikan di browser: proyek kembali dengan rev 1.
  3. Najja Desain akan mencoba ulang tanpa henti setiap 5 dtk kalau server menolak.
- **Perbaikan:**
  - `lib/storage.js` `putProject`: proyek tidak ada + `baseRev > 0` + bukan `force` → **410** `{gone: true}`. Simpan pertama (`baseRev` 0), simpan paksa, dan klien lama (tanpa `baseRev`) tetap menulis.
  - `public/js/core/sync.js` (baru) `revCheck()`: keputusan polling (`gone`/`wait`/`same`/`mine`/`follow`) sebagai fungsi murni.
  - `public/js/store.js`: 410 → `saveState: 'gone'`, event `gone`, tanpa retry. Save biasa ditahan sampai pengguna memilih, dan `save({ force: true })` tetap jalan. Jawaban untuk proyek lain yang sudah ditutup diabaikan (`loads`).
  - `public/js/app.js`:
    - Polling berhenti untuk proyek yang hilang (404), dan event `gone` dari autosave memunculkan dialog yang sama sekali per proyek. Dialognya memakai `modal` + `conflict-list` yang sudah ada.
    - **Simpan lagi** memulihkan proyek dengan simpan paksa dan isi yang ada di perangkat ini. **Tutup** kembali ke beranda tanpa menyimpan, menghapus draft perangkat, dan proyek tetap terhapus.
    - Indikator simpan menulis "Dihapus di perangkat lain — pilih tindakan" (gaya dan klik sama dengan konflik).
  - `public/js/design/app.js`: 410 memunculkan dialog "Desain ini sudah dihapus" (pola `ds-modal` yang sama dengan dialog konflik Desain). Selama terhapus, label tetap jujur dan edit tidak mengirim request. "Simpan lagi" memakai simpan paksa.
  - `public/css/app.css`: `.save-state.gone` memakai gaya `.save-state.conflict`.
- **Test:**
  - Unit: `test/core-sync.test.js` (baru), `test/storage.test.js` (+1: 410, force, `baseRev` 0, klien lama), `test/store-save.test.js` (+1: 410 tanpa retry, save biasa ditahan, force jalan).
  - Suite **270 test, 256 lulus, 0 gagal**. Di satu dari dua run, `jobs.test.js` yang sudah tercatat flaky (T5) gagal lagi; file itu tidak disentuh.
- **Browser asli (server lokal di-restart):**
  - **Hapus saat terbuka:** satu 404, dialog muncul, lalu 0 request `/rev` dalam 4 dtk. **Simpan lagi** → proyek kembali (200) dan polling normal lagi.
  - **Race (edit lalu langsung dihapus):** autosave mendapat 410 dan dialog muncul. Proyek **tetap terhapus** (404), edit lokal masih ada, dan label jujur. **Tutup** → beranda, proyek tetap 404, draft perangkat terhapus.
  - **Najja Desain:** dialog muncul, 0 retry dalam 6 dtk, label "Dihapus di perangkat lain", dan edit selama terhapus mengirim 0 request. **Simpan lagi** memulihkan dengan nama terbaru, dan label kembali "Tersimpan".
  - Ditemukan dan diperbaiki saat uji: label Desain sempat tertahan di "Menyimpan…" karena ada save kedua yang antre.
  - Semua proyek dan desain uji dihapus, termasuk satu yang sempat dibuat ulang oleh race di kode lama.
- **Kontrak:** tidak ada perubahan pada tool MCP. REST `PUT /api/projects/:id` kini bisa menjawab 410. Klien yang dipakai (editor dan Desain) menanganinya.
- **CI:** branch `fix/v19-deleted-project` (berisi semua kerjaan sampai V19 dan perbaikan test jobs) di-push. Run 45136491124 hijau di Node 22.

#### S2/M8 — snippet nginx `.well-known` dipasang di VPS (2026-11-23)

- **Izin:** pemilik meminta pemasangan secara eksplisit. Perubahan hanya **satu file baru**; file vhost aaPanel tidak diedit.
- **Langkah (lewat SSH sebagai root):**
  1. Baseline dari luar: tiga path OAuth `/.well-known/` = 404, ACME = 404 (file tidak ada), `/oauth/authorization-server` = 200, `/login` = 200. `nginx -t` awal lolos. `/usr/bin/nginx` → `/www/server/nginx/sbin/nginx`, sama dengan master yang berjalan (PID 831).
  2. `deploy/aapanel/najja-wellknown.conf` dipasang ke `/www/server/panel/vhost/nginx/extension/editor.najja.id/` (mode 600 root, sama dengan `site_total.conf`). SHA-256 sama dengan versi di repo (`bc67ca4e…`).
  3. `nginx -t` lolos. Skripnya disiapkan untuk menghapus file itu tanpa reload kalau tes gagal.
  4. `nginx -s reload`: worker lama berhenti dengan rapi, dan 2 worker baru berjalan.
- **Verifikasi dari luar:**
  - `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource/mcp`, dan `/.well-known/openid-configuration` = **200 JSON**. Isinya: issuer `https://editor.najja.id`, endpoint HTTPS, resource `https://editor.najja.id/mcp`.
  - ACME tetap 404 seperti sebelumnya. `/oauth/*`, `/login`, dan `/` sama seperti sebelumnya.
  - Rantai discovery MCP: `POST /mcp` tanpa token → 401 dengan `resource_metadata` → URL itu 200.
- **Rollback:** hapus file tersebut, lalu `nginx -t && nginx -s reload`.
- **Belum dicoba:** menyambungkan klien AI sungguhan lewat discovery `/.well-known/`, karena butuh akun pengguna. Jalur yang dipakai klien kini menjawab benar.

#### Deploy produksi `96d2e9f` (PR #1) — 2026-11-23

- **Izin:** PR #1 di-merge pemilik (merge commit, semua 23 commit tetap ada), lalu pemilik menyetujui deploy secara eksplisit.
- **Sebelum:**
  - CI `main` hijau. Tree `96d2e9f` identik dengan branch PR yang sudah hijau.
  - `npm test` di `main`: 256 lulus, 0 gagal.
  - VPS di `86305a7`, bersih, disk sisa 65 GB, kedua container sehat.
  - Image lama ditandai `najja-editor-najja:v1.13.1-backup` (`029801390a7e`).
- **Langkah:** `git merge --ff-only` ke `96d2e9f` (Dockerfile dan compose tidak berubah), `docker compose build najja` (6 dtk, container lama tetap melayani), lalu ganti container.
- **Insiden (±2 menit down, 502):**
  - Container diganti dengan `docker compose up -d najja` yang hanya memakai `docker-compose.yml`. Produksi ternyata dijalankan dengan `docker-compose.yml` **dan** `deploy/compose.proxy.yml`; file kedua mem-publish `127.0.0.1:3333`.
  - Container baru sehat, tapi tanpa port ke host, sehingga nginx menjawab 502.
  - Penyebabnya terlihat di label `com.docker.compose.project.config_files` container `ai` yang belum diganti. Diperbaiki dengan `docker compose -f docker-compose.yml -f deploy/compose.proxy.yml up -d najja`, dan `healthz` 200 dalam 2 dtk.
  - **Akar masalah:** prosedur update di `DEPLOY.md` (ditulis di P0-4) tidak memeriksa file compose mana yang dipakai produksi. Prosedur itu kini diperbaiki: dua file selalu dipakai, image dicadangkan dulu, port dicek setelah deploy, dan ada rollback tanpa build. Pencegahan tambahan yang diusulkan: `COMPOSE_FILE=docker-compose.yml:deploy/compose.proxy.yml` di `.env` VPS, supaya `docker compose` biasa memakai kedua file (butuh izin, belum dilakukan).
- **Sesudah (dari luar):**
  - `/healthz`, `/login`, `/oauth/*`, dan ketiga `.well-known` = 200.
  - Header keamanan P0-4 muncul di `/login`, bukti kode baru berjalan.
  - Rantai `/mcp` 401 → metadata jalan.
  - Port `127.0.0.1:3333->3333/tcp`. Log 0 error. Kedua container sehat.
  - `healthz` tetap menyebut 1.13.1, karena versi di `package.json` belum dinaikkan.
- **Belum dicek:** alur pengguna yang butuh login (editor, Desain, MCP dengan token) dan iPad. Pemilik diminta mencoba.

#### `COMPOSE_FILE` di VPS dan Caddy dimatikan di mode proxy (PR #2) — 2026-11-23

- **`.env` VPS** (atas permintaan pemilik): ditambah `COMPOSE_FILE=docker-compose.yml:deploy/compose.proxy.yml`, sehingga `docker compose` biasa memakai kedua file. Cadangan `.env` ada di `/root/najja-env-backups/` (di luar repo, karena `.env.bak-*` tidak di-ignore git). Dicek: port `127.0.0.1:3333` ikut, dan dry-run tidak mengganti container.
- **PR #2** (`7a98b22`): `caddy` diberi `profiles: ["caddy"]` di `deploy/compose.proxy.yml`. Ada `test/deploy-config.test.js` (dengan file lama, test proxy gagal). CI hijau di run 45139243360.
- **VPS di-fast-forward ke `7a98b22`**, tanpa build dan tanpa mengganti container:
  - Service di `docker compose` biasa `ai caddy najja` → `ai najja`.
  - Dry-run `docker compose up -d` tanpa nama service: kedua container "Running", Caddy tidak dibuat.
  - Port tetap `127.0.0.1:3333`, dan `/login` 200.


#### P1-2 — Job system untuk pekerjaan panjang (2026-11-23)

- **Masalah:**
  - `apply_style` dan `get_transcript` menahan satu panggilan HTTP sampai 50 menit, dan AI tidak tahu progresnya.
  - `export_video` langsung kembali tanpa ID, sehingga ekspor tidak bisa dibatalkan lewat MCP (M4).
- **Perubahan (semua aditif):**
  - `public/js/core/jobs.js` (baru, tanpa DOM): registry job (`running` / `cancelling` / `done` / `error` / `cancelled`, progres, hasil) dan `runJob()` dengan AbortController.
    - Pekerjaan dimulai **seketika**, supaya pembatalan tepat setelah mulai tetap sampai. Bug ini ditemukan lewat test yang menggantung.
    - Job baru berstatus `cancelled` setelah pekerjaannya **benar-benar berhenti**, tidak pernah lebih dulu.
    - Job yang tidak bisa dihentikan dijawab "cannot be cancelled", bukan pura-pura berhenti.
  - Tool baru:
    - `get_job` dan `list_jobs`: baca saja, tidak ikut antrian, tetap boleh saat ekspor.
    - `cancel_job`: tidak ikut antrian, supaya bisa menghentikan job yang sedang menahan antrian.
  - `export_video` dan `get_export_status` mendapat `job_id`. Ekspor bisa dibatalkan (`cancelExport`), dan file sementaranya dihapus.
  - `apply_style` dan `get_transcript` mendapat parameter opsional `background`. Tanpa parameter itu, perilaku **sama persis**. Dengan parameter itu, tool langsung menjawab `job_id`, dan job-nya tetap **menahan antrian edit** (`bridge.hold`), sehingga tidak ada edit yang menyelip di antara langkah-langkahnya.
  - `editorForAI` tidak lagi membuka atau membuat proyek untuk tool job.
- **Kontrak:** snapshot `mcp-contract-v1.json` bertambah 27 → 30 tool, dan `--update` menerima karena perubahannya hanya menambah. Test kini memastikan ke-27 tool v1.13.1 tetap ada.
- **Hasil test:**
  - Unit: **277 test, 263 lulus, 0 gagal**, 2×.
  - Ditambah `test/jobs-registry.test.js` (4) dan test bridge: job di latar belakang menahan edit, sementara `get_job` dan `cancel_job` menjawab langsung.
- **Browser asli lewat `/mcp`:**
  - `tools/list` berisi 30 tool.
  - Ekspor sampai selesai: `get_job` menunjukkan progres 47 → 100 → `done`, dengan hasil file. `get_export_status` menyertakan `job_id`.
  - Ekspor 1080p dibatalkan di 9%: `cancelling` → `cancelled`, file sementara OPFS `najja-export/video-*.h264` ada selama render dan **kosong setelah dibatalkan**. Membatalkan lagi dijawab "already cancelled", dan ID yang tidak dikenal diberi alasan.
  - `get_transcript` dengan `background` menjawab dalam 17 ms. Job-nya berakhir `error` dengan pesan yang sama seperti mode biasa, dan mode biasa tetap bekerja.
  - Log bersih. Proyek dan file ekspor uji dihapus.
- **Belum diuji:**
  - Jalur **sukses** `apply_style`/`get_transcript` di latar belakang, termasuk pembatalan di tengah transkripsi. Ini butuh layanan AI dan model yang tidak ada di server lokal.
  - Di produksi.

- **Deploy produksi `01fbfff` (PR #3), 2026-11-23:**
  - Persiapan: CI `main` hijau (tree identik dengan branch PR), VPS bersih di `7a98b22`, dan image dicadangkan sebagai `najja-editor-najja:backup-7a98b22`.
  - Proses: fast-forward, lalu build 2 dtk (container lama tetap melayani), lalu `docker compose up -d najja` (`COMPOSE_FILE` memakai kedua file).
  - Hasil: port `127.0.0.1:3333` langsung terpasang, `healthz` 200 dalam 2 dtk, **tanpa downtime yang teramati**.
  - App di container memuat 30 tool (termasuk `get_job`, `list_jobs`, `cancel_job`). Log 0 error, dan endpoint publik normal.

- **Ukuran layar per perangkat (DESIGN §3.1, keputusan pemilik 2026-11-23):**
  - Desain tidak diubah. Menu akun (avatar) mendapat **Ukuran layar**: pilihan perangkat (Otomatis, HP, iPad mini/iPad/iPad Pro, laptop 13–16 inci, monitor 24/27 inci) dengan saran "disarankan", ukuran 75–130% per 5, dan kunci zoom (Otomatis/Nyala/Mati). Disimpan di `localStorage`, jadi tiap perangkat punya sendiri, dan berlaku juga di Najja Desain.
  - Aturan disalin dari app ecom (`src/lib/theme.js`): `public/js/core/screen.js` (tanpa DOM) dan `public/js/screen.js` (menerapkan).
  - **Beda dengan ecom (ditemukan saat uji):** CSS `zoom` pada `<html>` saja membuat pointer meleset di editor. Di 90%, ujung klip 0–4 dtk terbaca 3,28 dtk, karena posisi pointer dan `getBoundingClientRect` dihitung di layar sedangkan `scrollLeft`, `pps`, dan style dalam px halaman. Breakpoint `@media` juga melihat lebar jendela, sehingga di 110% tombol Ekspor terpotong. Jadi caranya dipilih per browser:
    - **Layar sentuh (iPad, HP):** skala viewport (`initial-scale`, dan dikunci dengan `minimum-scale`/`maximum-scale`). Satu ruang koordinat, jadi kode pointer tidak berubah.
    - **Chrome/Edge/Firefox di komputer:** CSS zoom. Semua titik yang mencampur ukuran layar dan px halaman memakai `toCss()`: timeline (`timeAt`, lajur, geser), handle preview, kanvas Desain (titik, zoom, geser, pinch), menu dan popover. Breakpoint `@media` diskalakan ikut (`scaleMedia`).
    - **Safari di Mac:** aturan CSS zoom-nya masih versi lama (kotak dilaporkan dalam px-nya sendiri, WebKit bug 77998), jadi tidak dipakai. Dialog mengarahkan ke zoom browser (⌘ + / ⌘ −).
  - **Hasil uji di browser lokal (Chrome 156):**
    - Di 90% dan 110%, posisi pointer ke waktu tepat (klip 0–4 dtk terbaca 0 dan 4).
    - Seret klip 72 px layar di 90% menggeser 0,500 dtk (seharusnya 0,5). Di 110%, seret 0,25 dtk tepat.
    - Seret teks di preview sejauh 10% lebar menggeser `x` 0,1, dan kotak seleksi ikut tepat (88,65 px). Di 110%, 20% tinggi menggeser `y` 0,1998.
    - Najja Desain 110%: titik layar ke halaman tepat (tengah = 540, 540). Seret 100×50 px layar memindahkan bentuk 258×129 px halaman (seharusnya 258,4×129,2).
    - Menu muncul di titik yang diminta (selisih 4 px sama seperti di 100%). `#app` tetap setinggi layar, dan di 110% bilah atas memakai tata letak ringkas dan muat.
    - Emulasi tablet 744 px: mode viewport, lebar halaman 826 px di 90% (`visualViewport.scale` 0,9), dan pemetaan timeline tepat.
  - **Test:** `test/screen-size.test.js` 5 test (saran perangkat, preset, kunci zoom, viewport meta, breakpoint). Suite: **285 test, 271 lulus, 0 gagal, 14 dilewati**.
    - Seret klip dengan mouse sungguhan (panel uji): di 100% +0,5 dtk tepat, di 90% 1,25 → 1,75 dtk (seharusnya 1,750).
  - **Belum diuji:** iPad asli (Safari) dan Safari Mac.

- **Deploy produksi `0744fd6` (Ukuran layar), 2026-11-23:**
  - Satu perintah dari Mac (`npm run deploy`): test lokal 271 lulus, 0 gagal, CI hijau (run 45146361737), lalu di VPS `01fbfff` → `0744fd6`. Image lama dicadangkan sebagai `najja-editor-najja:backup-01fbfff`.
  - Hasil: port `127.0.0.1:3333` terpasang, error di log 0. Dari luar: `/healthz`, `/login`, dan `/.well-known/oauth-authorization-server` 200.
  - Kode baru ada di container yang berjalan (`screen.js`, dialog di `account.js`, konversi di `timeline.js`). Container `running`, 0 restart. File JS dari luar butuh login (401), sesuai mode token.
  - **Belum dicek:** dialog Ukuran layar di akun yang login, dan di iPad asli. Pemilik diminta mencoba.

- **Preview video hitam: nginx membuang header Range (diperbaiki di VPS 2026-11-23):**
  - **Laporan pemilik:** preview hitam saat play, padahal thumbnail timeline tampil.
  - **Bukti:**
    - Log nginx 40 menit terakhir: `/api/media/<id>/edit` diminta berulang oleh Chrome 157 (8×) dan Safari 26.6 (5×, perangkat lain, kemungkinan iPad). Semuanya `200` dan terpotong di 1–52 MB, tidak ada satu pun `206`.
    - Permintaan Range langsung ke app (`127.0.0.1:3333`) dijawab `206`, tapi lewat editor.najja.id dijawab `200` file utuh.
  - **Akar masalah:** `proxy.conf` global aaPanel berisi `proxy_cache cache_one;`. Dengan cache proxy nyala, nginx tidak meneruskan `Range` ke app (dokumentasi nginx, `proxy_cache`). Ini sudah ada sejak situs dipasang, **bukan** akibat perubahan kode hari ini.
  - **Akibat:**
    - Chrome mengunduh ulang video dari awal setiap kali preview melompat, sehingga layar hitam selama menunggu.
    - Safari tidak memutar video tanpa `206`.
    - Unduhan ke penyimpanan perangkat yang terputus harus mulai dari nol.
  - **Perbaikan (dengan "ya" pemilik):** `deploy/aapanel/najja-proxy.conf` (`proxy_cache off;`) dipasang di `extension/editor.najja.id/`. `nginx -t` lulus, lalu reload. Situs lain tidak berubah. Test baru di `test/deploy-config.test.js` menjaga isi snippet.
  - **Hasil:** permintaan Range lewat editor.najja.id kini `206` (`bytes 0-9/504`). Permintaan biasa tetap `200`, dan `/healthz`, `/login`, serta `.well-known` tetap 200. Media `/edit` memakai `sendFile` yang sama, jadi ikut. Tidak ada error baru di log nginx setelah reload.
  - **Belum dicek:** pemutaran di akun pemilik (butuh login) dan di iPad. Pemilik diminta memuat ulang editor lalu mencoba.

- **iPad kurang mulus dibanding PC: salinan video di iPad macet di 100% (diperbaiki dan di-deploy 2026-11-23, `7f97dd9`):**
  - **Bukti dari log nginx setelah perbaikan Range:**
    - Chrome di PC hanya meminta 1 metadata media, karena ia memutar salinan dari disk perangkat.
    - iPad (Safari 26.6) mengirim **141 permintaan potongan** ke `/edit` dalam ±2,5 menit, ditambah 7 yang dibatalkan, jadi videonya di-stream lewat Wi-Fi.
    - Unduhan penuh 69 MB selesai pukul 09:39:28, lalu **langsung** ada permintaan melewati akhir file (`416`), dan terulang pukul 09:39:35 dan 09:39:54. Setelah itu muncul unduhan baru dari nol yang terpotong (2,3 / 2,5 / 16,5 MB).
  - **Akar masalah:** di `public/js/devicecache.js`, unduhan berhenti sementara selama preview memutar dari server (`shouldPause`). Unduhan dianggap selesai hanya kalau bacaan terakhir **tidak** dijeda (`!paused && got >= total`).
    - Kalau jeda jatuh tepat setelah potongan terakhir, semua byte sudah di disk tapi tidak ditandai lengkap.
    - Percobaan berikutnya meminta `bytes=<ukuran>-` dan dijawab `416`, lalu `download()` menyerah dan app jatuh ke unduhan ke memori.
    - Percobaan sesudahnya terus `416` karena entri tidak pernah lengkap, jadi iPad tidak pernah memutar dari disk.
    - Di iPad jeda ini sering terjadi, karena selama preview memutar dari server, unduhan selalu dijeda.
  - **Reproduksi:**
    - Di Chrome (OPFS asli), jeda pada potongan terakhir menghasilkan permintaan `[0 → 200, 73364 → 416]`, nilai kembali `null`, dan entri berisi 73364 byte dengan `complete: false`. Pola ini sama dengan log iPad.
    - Test baru `test/device-cache.test.js` (OPFS palsu di memori) gagal 2 dari 3 sebelum perbaikan.
  - **Perbaikan:**
    - Selesai ditentukan dari byte yang diterima (`got >= total`), bukan dari cara bacaan terakhir berakhir.
    - Entri yang sudah berisi semua byte tapi belum ditandai lengkap (seperti di iPad sekarang) langsung diselesaikan tanpa jaringan.
    - Lanjut-dari-tengah (Range) tidak berubah dan dijaga test ketiga.
  - **Hasil:**
    - Test 3/3 lulus. Suite 289 test, 275 lulus, 0 gagal, 14 dilewati.
    - Di Chrome, skenario yang sama kini 1 permintaan, salinan dari disk bisa diputar, dan isinya identik.
  - **Belum diketahui:** apakah ini **satu-satunya** penyebab iPad kurang mulus. Ukuran pembanding: setelah deploy, iPad seharusnya berhenti mengirim permintaan `/edit` begitu salinannya selesai, lalu Diagnostik (menu ⋯) di iPad dan PC dibandingkan untuk FPS dan frame yang hilang.
  - **Catatan kecil (tidak diubah):** `open()` menulis metadata tanpa menunggu, sehingga daftar penyimpanan bisa sesaat membaca entri sebagai belum lengkap. Ini tidak memengaruhi pemutaran.

- **Deploy produksi `7f97dd9` (perbaikan salinan video di perangkat), 2026-11-23:**
  - `npm run deploy` berjalan: test lokal 275 lulus, 0 gagal, CI hijau, lalu VPS `0744fd6` → `7f97dd9`. Image lama dicadangkan sebagai `backup-0744fd6`.
  - Hasil: port terpasang, error di log 0, container `running` dengan 0 restart. `/healthz`, `/login`, dan `.well-known` 200, dan Range lewat nginx tetap `206`. Perbaikan ada di `devicecache.js` di dalam container.
  - **Belum diukur:** apakah iPad kini memutar dari disk (log server seharusnya berhenti menerima permintaan `/edit` dari iPad setelah salinan selesai), dan Diagnostik iPad dibanding PC.

