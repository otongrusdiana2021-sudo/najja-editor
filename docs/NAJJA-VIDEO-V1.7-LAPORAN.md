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
