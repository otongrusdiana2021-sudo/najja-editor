# Deploy Najja Editor ke VPS

```
Browser kamu ──HTTPS──▶ Caddy (sertifikat otomatis) ──▶ Najja (Docker, port 3333 internal)
Claude Code  ──HTTPS + token──▶ /mcp ┘
```

Editing tetap berjalan **di browser kamu**. VPS hanya menyajikan aplikasi, menjalankan server MCP, dan menyimpan hasil ekspor dari AI. Karena itu VPS kecil (1 vCPU, 1 GB RAM) sudah cukup.

## Yang perlu disiapkan

1. **VPS Ubuntu 22.04 atau 24.04** dengan akses SSH root/sudo.
2. **Domain atau subdomain** yang **A record**-nya mengarah ke IP VPS, misalnya `editor.domainkamu.com`.
   - HTTPS wajib: tanpa HTTPS, rekam mikrofon dan salin-tempel tidak jalan.
   - Kalau domainnya di Cloudflare, set ke **DNS only** (awan abu-abu) dulu.
3. **Port 80 dan 443** terbuka di firewall VPS dan di panel provider.

## Cara tercepat — installer otomatis

Setelah A record mengarah ke VPS dan kode sudah ada di VPS (folder hasil ekstrak zip), jalankan satu perintah:

```bash
sudo bash deploy/install.sh editor.domainkamu.com
```

Installer akan:
- memasang Docker,
- mengecek DNS,
- membuka port 80/443,
- membuat token,
- menjalankan Najja + Caddy (HTTPS),
- lalu menampilkan URL, token login, dan perintah untuk Claude Code.

Kalau Docker Hub membatasi unduhan (error 429), installer otomatis memakai mirror Google. Menjalankan installer lagi aman: token lama tetap dipakai.

## VPS yang sudah punya website (aaPanel / nginx / apache)

Installer otomatis mendeteksi kalau port 80/443 sudah dipakai web server lain. Kalau begitu, Najja **hanya berjalan di port lokal** (`127.0.0.1:3333`) dan website lain di VPS **tidak diubah**.

- **nginx biasa:** installer menambahkan situs untuk domain kamu, mengecek `nginx -t` (dibatalkan otomatis kalau gagal), lalu memasang HTTPS dengan certbot.
- **aaPanel:** konfigurasi nginx tidak disentuh. Lakukan 3 langkah ini sekali di panel:
  1. **Website → Add site.** Domain: `editor.domainkamu.com`, PHP: Static/Pure static, lalu Submit.
  2. Buka situs itu → **SSL → Let's Encrypt.** Centang domainnya, Apply, lalu nyalakan **Force HTTPS**.
  3. **Reverse proxy → Add reverse proxy.** Name: `najja`, Target URL: `http://127.0.0.1:3333`, Sent Domain: `$host`, lalu Submit.
- **Lainnya** (apache, Nginx Proxy Manager, Traefik, dll.): buat reverse proxy dari domain kamu ke `http://127.0.0.1:3333`. Teruskan header Host, matikan buffering, dan atur timeout baca minimal 1 jam.

### aaPanel: OAuth untuk AI lewat `/.well-known/` (v1.13.2)

aaPanel melayani semua path `/.well-known/` dari folder situs (untuk cek sertifikat SSL). Akibatnya metadata OAuth yang disediakan editor di sana dijawab 404, dan klien AI yang hanya memakai discovery standar gagal terhubung. Cadangan `/oauth/authorization-server` dan `/oauth/protected-resource` tetap jalan.

Perbaikannya: pasang `deploy/aapanel/najja-wellknown.conf` ke `/www/server/panel/vhost/nginx/extension/<domain>/`. aaPanel meng-include semua `*.conf` di folder itu ke dalam blok server situs. File ini hanya meneruskan path OAuth ke editor. Cek sertifikat (`/.well-known/acme-challenge/`) tidak berubah.

```bash
cp deploy/aapanel/najja-wellknown.conf /www/server/panel/vhost/nginx/extension/editor.domainkamu.com/
nginx -t && nginx -s reload
curl -s https://editor.domainkamu.com/.well-known/oauth-authorization-server   # JSON, bukan 404
```

Batalkan dengan menghapus file itu, lalu `nginx -t && nginx -s reload`.

## Produksi editor.najja.id

Fakta (dicek read-only pada 2026-11-23):

| Bagian | Nilai |
|---|---|
| Server | VPS `najja-vps`, nginx 1.24 dari aaPanel. Vhost `/www/server/panel/vhost/nginx/editor.najja.id.conf`: reverse proxy `location ^~ /` → `http://127.0.0.1:3333`, HSTS dipasang nginx |
| App | `/opt/najja-editor`: checkout git dari GitHub, Docker Compose dengan **dua file**: `docker-compose.yml` + `deploy/compose.proxy.yml` (file kedua mem-publish `127.0.0.1:3333`, tempat nginx meneruskan). Container `najja-editor-najja-1` dan `najja-editor-ai-1`. Service `caddy` tidak dipakai. Versi berjalan: `01fbfff` (main setelah PR #3, dipasang 2026-11-23; sebelumnya `96d2e9f`, dan sebelum itu `86305a7` = v1.13.1). Image cadangan: `backup-7a98b22`, `v1.13.1-backup` |
| Data | Volume Docker `najja-editor_najja-data`. Tidak ikut berubah saat update kode |
| Konfigurasi rahasia | `/opt/najja-editor/.env` (jangan di-commit, jangan dibagikan) |
| DNS | `editor.najja.id` → `31.97.223.23`. `www.editor.najja.id` **belum punya record** |
| OAuth `.well-known` | `extension/editor.najja.id/najja-wellknown.conf` terpasang sejak 2026-11-23 (path OAuth discovery diteruskan ke app) |

**Deploy satu perintah dari Mac** (seperti `deploy/deploy.sh` di proyek ecom):

```bash
npm run deploy            # test → push main → tunggu CI hijau → di VPS: cadangan image, git ff, build, ganti container, cek port + healthz
DRY_RUN=1 npm run deploy  # hanya memeriksa, tidak push dan tidak mengubah VPS
```

Kalau port `127.0.0.1:3333` atau `/healthz` gagal setelah container diganti, skrip otomatis kembali ke image cadangan (`najja-editor-najja:backup-<commit lama>`). Langkah manualnya ada di bawah.

**Update ke versi baru** (kode dari git, data tetap di volume):

> **Sejak 2026-11-23** `/opt/najja-editor/.env` berisi `COMPOSE_FILE=docker-compose.yml:deploy/compose.proxy.yml`, jadi `docker compose …` biasa di folder itu sudah memakai kedua file (sudah dicek: port `127.0.0.1:3333` ikut, dan `up -d --dry-run najja` tidak mengganti container). Cadangan `.env` sebelum perubahan ada di `/root/najja-env-backups/` (di luar repo).
>
> Di mode proxy, `caddy` punya `profiles: ["caddy"]` (`deploy/compose.proxy.yml`, v1.13.2), jadi `docker compose up -d` tanpa nama service pun **tidak** menyalakannya. Sebelumnya `caddy` ikut menyala dan bentrok dengan nginx aaPanel di port 80/443. Dijaga `test/deploy-config.test.js`. Tetap sebaiknya menyebut nama service (`najja`, `ai`), sama seperti installer.
>
> ⚠️ Selalu pakai **kedua** file compose. `docker compose up` biasa hanya memakai `docker-compose.yml`, sehingga container baru **tidak** mem-publish `127.0.0.1:3333` dan situs langsung 502. Ini terjadi sekali saat deploy 2026-11-23 (±2 menit down). File yang dipakai sebuah container bisa dicek di label `com.docker.compose.project.config_files` (`docker inspect`).

1. Pastikan CI hijau untuk commit yang mau dipasang (tab Actions di GitHub).
2. Di VPS:
   ```bash
   cd /opt/najja-editor
   alias dc='docker compose -f docker-compose.yml -f deploy/compose.proxy.yml'
   git rev-parse --short HEAD                               # catat, untuk rollback
   docker tag najja-editor-najja:latest najja-editor-najja:backup-$(git rev-parse --short HEAD)
   git fetch origin main && git merge --ff-only FETCH_HEAD  # atau: git checkout <commit-atau-tag>
   dc build najja                                           # container lama tetap melayani selama build
   dc up -d najja                                           # ganti container (beberapa detik)
   ```
   Container `ai` tidak perlu dibangun ulang kalau `ai/` dan `Dockerfile.ai` tidak berubah.
3. Cek:
   ```bash
   docker ps --format '{{.Names}} | {{.Ports}}' | grep najja   # harus: 127.0.0.1:3333->3333/tcp
   curl -s https://editor.najja.id/healthz
   curl -sI https://editor.najja.id/login | grep -iE 'x-frame|content-security|referrer|nosniff'
   ```
4. Rollback cepat (tanpa build): `docker tag najja-editor-najja:backup-<commit> najja-editor-najja:latest && git checkout <commit> && dc up -d najja`.

**`www.editor.najja.id`:** butuh record DNS di pengelola domain `najja.id` (A `www.editor` → `31.97.223.23`, atau CNAME ke `editor.najja.id`). Setelah itu di aaPanel: tambahkan domain `www.editor.najja.id` ke situs, terbitkan ulang SSL untuk kedua nama, lalu buat redirect 301 dari `www.editor.najja.id` ke `https://editor.najja.id`.

## Cara A — Docker manual

**1. Upload kode** dari laptop kamu:

```bash
scp najja-editor.zip root@IP_VPS:/opt/
```

**2. Masuk ke VPS** dan pasang Docker:

```bash
ssh root@IP_VPS
```
```bash
apt update && apt install -y docker.io docker-compose-v2 unzip
```

**3. Ekstrak** kode lalu masuk ke foldernya:

```bash
cd /opt && unzip najja-editor.zip && cd najja-editor
```

**4. Buat file `.env`** dari contohnya:

```bash
cp .env.example .env
```

Buat token acak:

```bash
openssl rand -hex 24
```

Buka `.env`:

```bash
nano .env
```

Lalu isi dua baris ini:

```
DOMAIN=editor.domainkamu.com
NAJJA_TOKEN=hasil-openssl-rand-tadi
```

**5. Jalankan:**

```bash
docker compose up -d --build
```

**6.** Buka **https://editor.domainkamu.com**, lalu buat akun admin (email, password, dan token dari `.env`).

Caddy mengurus sertifikat Let's Encrypt secara otomatis. Percobaan pertama butuh beberapa detik.

Kalau firewall `ufw` aktif, buka port web:

```bash
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp
```

### Perawatan

| Keperluan | Perintah |
|---|---|
| Lihat log | `docker compose logs -f najja` |
| Log sertifikat | `docker compose logs caddy` |
| Update ke versi baru | upload zip baru, ekstrak ke folder yang sama, lalu `docker compose up -d --build` |
| Restart | `docker compose restart` |
| Stop | `docker compose down` |
| Ambil semua hasil ekspor AI | `docker compose cp najja:/data/exports ./exports` |
| Upload video ke server untuk AI | `docker compose cp video.mp4 najja:/data/media/` |

Setelah video di-upload ke `/data/media/`, AI bisa mengimpornya dengan `import_media` dan `path: "video.mp4"`.

## Cara B — tanpa Docker (Node + systemd + Caddy)

**1. Pasang Node.js.**
- Ubuntu 24.04: `apt install -y nodejs ffmpeg` (Node 18.19 sudah cukup; ffmpeg untuk konversi video iPhone/HEVC).
- Ubuntu 22.04: versi bawaannya terlalu lama. Pasang Node 22 dari NodeSource (lihat nodesource.com).

**2. Pasang Caddy** dengan mengikuti https://caddyserver.com/docs/install (bagian Debian/Ubuntu).

**3. Siapkan aplikasi:**

```bash
useradd --system --home /var/lib/najja-editor --create-home najja
```
```bash
cd /opt && unzip najja-editor.zip
```
```bash
cp /opt/najja-editor/deploy/najja-editor.service /etc/systemd/system/
```

**4. Buat file konfigurasi** `/etc/najja-editor.env`:

```bash
printf 'NAJJA_TOKEN=%s\nNAJJA_PUBLIC_URL=https://editor.domainkamu.com\n' "$(openssl rand -hex 24)" > /etc/najja-editor.env && chmod 600 /etc/najja-editor.env
```

Tokennya bisa dilihat dengan `cat /etc/najja-editor.env`.

**5. Nyalakan layanan:**

```bash
systemctl daemon-reload && systemctl enable --now najja-editor
```

**6. Arahkan Caddy ke Najja:** salin `deploy/Caddyfile.host` ke `/etc/caddy/Caddyfile`, ganti domainnya, lalu:

```bash
systemctl reload caddy
```

## Data tersimpan di mana?

Semua data ada **di VPS kamu**, tidak di layanan luar (tidak memakai Supabase atau cloud lain):

| Data | Lokasi di dalam container (volume Docker `najja-editor_najja-data`) |
|---|---|
| Proyek | `/data/projects/*.json` |
| Media (file asli, salinan pratinjau 720p, salinan H.264 1080p, thumbnail, waveform) | `/data/library/<id>/` |
| Hasil ekspor | `/data/exports/` (pemiliknya dicatat di `/data/exports-index.json`) |
| Akun & token AI (hanya hash) | `/data/users.json` |
| Cadangan otomatis sebelum migrasi | `/data/backups/` |
| Antrean pekerjaan media (konversi, thumbnail) | `/data/jobs/*.json` (satu file kecil per job; yang selesai dihapus setelah 7 hari) |
| Alat AI: foto & hasil (per akun) | `/data/ai/<id>/` (dihapus otomatis setelah 3 hari) |
| Model AI (±200 MB, sekali unduh) | `/data/models/` |

### Proyek dibuka di beberapa perangkat

Setiap simpan menaikkan **revisi** proyek di server. Editor yang terbuka mengecek revisi tiap detik (`NAJJA_SYNC_POLL_MS`):

- **Tidak ada perubahan lokal:** versi dari perangkat lain langsung dimuat (posisi playhead dipertahankan).
- **Dua perangkat mengubah proyek yang sama:** server menolak simpan yang berbasis versi lama (HTTP 409), lalu editor menanyakan *muat versi terbaru* / *simpan versiku sebagai salinan* / *timpa dengan versiku*.
- **Perubahan yang belum terkirim** (tab tertutup, koneksi putus) disimpan sebagai draf di browser (IndexedDB) dan dipulihkan saat proyek dibuka lagi.

### Alat AI (container `ai`)

Hapus latar belakang dan upscale di beranda dijalankan oleh container terpisah `ai` (Python + onnxruntime, `Dockerfile.ai`). Rinciannya ada di [AI-TOOLS.md](AI-TOOLS.md).

- **Batas RAM/CPU** dipilih installer dari ukuran VPS dan disimpan di `.env`: `NAJJA_AI_MEM`, `NAJJA_AI_CPUS`.
  - VPS ≥ 6 GB RAM: 2560m (BiRefNet, kualitas tinggi).
  - VPS lebih kecil: 1280m (IS-Net, ringan).
  - Batas ini hanya terpakai sesaat saat alat dijalankan. Situs lain di VPS tidak terganggu, dan kalau AI kehabisan memori hanya container `ai` yang dimulai ulang.
- **Model** diunduh sekali saat container pertama kali jalan (±200 MB, dari Hugging Face dan Qualcomm AI Hub, dicek sha256).
- **Tanpa AI:** `... | sudo bash -s editor.domainkamu.com --tanpa-ai`.
- **Log:** `cd /opt/najja-editor && docker compose logs ai`.

### Antrean pekerjaan media

Salinan ringan (pratinjau 720p), thumbnail/waveform, dan salinan kualitas penuh dibuat oleh antrean job di server:

- **Tahan restart.** Job yang antre atau sedang jalan saat server dimatikan (update, reboot) dilanjutkan otomatis.
- **Gagal → dicoba lagi** sampai 3 kali (jeda 5 dtk, lalu 20 dtk). Tiap job punya batas waktu, dan ffmpeg yang macet dihentikan.
- **Adil antar-akun:**
  - Thumbnail punya jalur sendiri, jadi tidak menunggu konversi video panjang.
  - Klip pendek didahulukan, tapi video panjang tetap dijalankan: makin lama menunggu, makin maju urutannya.
- **Status per akun:** menu ⋯ → **Diagnostik performa** → *Antrean server* (bisa **Batalkan**/**Ulangi**), atau `GET /api/jobs`.
- **Batas job bersamaan** mengikuti core/RAM VPS. Ubah lewat `.env` bila perlu: `NAJJA_JOB_LIGHT`, `NAJJA_JOB_FAST`, `NAJJA_JOB_SLOW`. Contoh untuk VPS 8 core yang juga menjalankan aplikasi lain: `NAJJA_JOB_FAST=1`.

Karena itu proyek bisa dibuka dari laptop, HP, atau browser mana pun setelah login. Upload video besar dipecah per 8 MB, jadi tidak terkena batas upload nginx/aaPanel.

### Salinan video di perangkat (maks. 5 GB)

Supaya refresh atau buka ulang browser tidak mengunduh video lagi, tiap perangkat menyimpan **salinan** video yang pernah dibuka di penyimpanan browser (OPFS), maksimal 5 GB per browser. VPS tetap sumber utama: salinan hanya cache.

- Unduhan pertama berjalan di background (kartu media: **Memuat xx%**), dijeda saat video diputar, dan dilanjutkan dari posisi terakhir kalau terputus.
- Kalau video di VPS dikonversi ulang, perangkat mengunduh versi baru sekali dan membuang yang lama.
- Kalau penuh, video yang paling lama tidak dibuka dihapus duluan (video di proyek yang sedang dibuka tidak ikut dihapus).
- Lihat atau hapus salinan: menu akun (bulatan inisial) → **Penyimpanan perangkat**. Salinan tetap ada setelah *Keluar*.
- Pasang editor sebagai aplikasi (PWA) supaya Chrome menandai penyimpanannya permanen dan tidak membersihkannya saat disk penuh.

### Salinan ringan untuk pratinjau (supaya edit lancar di semua perangkat)

Video dari HP biasanya berat: 1080p–4K dengan bitrate 10–50 Mbps. Kalau pratinjau memutar file asli, iPad dan HP harus mengunduh dan men-decode file besar itu, sehingga impor dan play terasa lambat. Karena itu server menyiapkan beberapa versi untuk tiap video:

| Versi | Untuk apa | Kapan dibuat |
|---|---|---|
| **Salinan pratinjau 720p** (`edit.mp4`) | Diputar di editor. Kecil diunduh, ringan di-decode, keyframe tiap 0,5 detik sehingga geser timeline langsung tepat. | Untuk setiap video yang lebih besar dari 720p, bitrate di atas 8 Mbps, atau codec-nya tidak didukung browser. Dibuat **paling dulu**. |
| Thumbnail timeline, gambar kartu, waveform | Tampil di timeline dan pustaka. HP tidak perlu men-decode seluruh video. | Sesudah salinan pratinjau. |
| **Salinan H.264 1080p** (`proxy.mp4`) | Dipakai saat ekspor, kalau file aslinya tidak bisa dibaca browser. | Hanya untuk video iPhone HEVC, AVI, 10-bit/HDR, ProRes. Dibuat **paling akhir**, prioritas rendah. |

- **Ekspor tetap kualitas penuh.** Hasil ekspor membaca file asli; kalau file asli tidak bisa dibaca browser, ekspor memakai salinan H.264 1080p. Salinan 720p hanya untuk pratinjau.
- **Impor tidak menunggu.** Begitu browser selesai membaca header file, klip langsung bisa dipakai. Upload (3 potongan paralel), thumbnail, dan salinan ringan berjalan di belakang.
  - Di perangkat yang mengimpor, file asli langsung diputar dari perangkat.
  - Begitu salinan 720p siap, salinan itu diunduh sekali lalu dipakai otomatis.
- **Waktu proses** untuk video HEVC 47 detik:
  - Salinan 720p: ±11 detik di 4 core, ±36 detik di 1 core.
  - Sebelumnya, salinan 1080p butuh ±85 detik di 1 core sebelum video bisa diputar di PC.
- Selama salinan dibuat, kartu media menampilkan **Konversi xx%**, tapi hanya kalau perangkat itu memang tidak bisa memutar file aslinya.
- Video yang sudah ada sebelum versi 1.6 diproses otomatis saat proyeknya dibuka.
- Semua proses berjalan **satu per satu** dengan prioritas rendah, jadi aplikasi lain di VPS tidak terganggu.
- Butuh `ffmpeg`. Image Docker sudah memasangnya, dan installer menampilkan *Konversi video otomatis … aktif ✓*. Untuk Cara B (tanpa Docker), pasang dengan `apt install -y ffmpeg` lalu `systemctl restart najja-editor`.

Pengaturan (opsional, di `.env`):

| Variabel | Default | Isi |
|---|---|---|
| `NAJJA_EDIT_MAX` | `1280` | Sisi terpanjang salinan pratinjau (px) |
| `NAJJA_EDIT_THREADS` | jumlah core (maks. 4) | Thread ffmpeg untuk salinan pratinjau |
| `NAJJA_PROXY_THREADS` | `2` | Thread ffmpeg untuk salinan 1080p |
| `NAJJA_PROXY` | | Isi `0` untuk mematikan semua konversi |

**Backup** satu file ke folder home:

```bash
tar czf ~/najja-backup-$(date +%F).tgz -C "$(docker volume inspect najja-editor_najja-data --format '{{.Mountpoint}}')" .
```

Folder volume itu juga bisa dimasukkan ke jadwal backup aaPanel.

## Pasang sebagai aplikasi

Buka editornya di Chrome atau Edge, lalu klik ikon **Install** di address bar, atau buka menu ☰ di kiri atas → **Pasang sebagai aplikasi**. Najja akan punya ikon sendiri dan terbuka di jendela terpisah seperti aplikasi biasa.

## Login dengan email

Saat pertama kali membuka editor, muncul halaman **Buat akun admin**. Isi email, password, dan **token server** sekali saja (token ada di `/opt/najja-editor/.env`). Setelah itu kamu masuk dengan email dan password.

- Menu akun ada di bulatan inisial di kanan atas: **Token AI (MCP)**, **Ganti password**, **Kelola pengguna** (admin bisa menambah atau menghapus pengguna), dan **Keluar**.
- Sejak v1.7 **setiap pengguna punya proyek, media, dan hasil ekspor sendiri**. Pengguna lain tidak bisa melihat, membuka, atau mengunduhnya (server menjawab "tidak ditemukan").
- Menghapus pengguna memindahkan proyek dan medianya ke admin yang menghapus. File yang berubah dicadangkan dulu ke `/data/backups/transfer-…`.

### Pindah dari v1.6 ke v1.7 (migrasi pemilik data)

Saat v1.7 pertama kali jalan, server otomatis:

1. Mencadangkan `users.json` ke `/data/backups/v1.7-user-ids-<waktu>/`, lalu memberi setiap akun ID tetap.
2. Mencadangkan semua file proyek/media yang belum punya pemilik ke `/data/backups/v1.7-owner-migration-<waktu>/`.
3. Memberikan semua proyek, media, dan ekspor lama ke **admin pertama** (akun admin yang paling awal dibuat).
4. Memeriksa ulang bahwa tidak ada data tanpa pemilik, lalu menulis laporan `migration.json` di folder cadangan.

Yang diubah hanya isi JSON kecil (ditambah kolom `ownerId`); file video tidak disentuh, tidak dipindah, dan tidak dihapus. Migrasi aman dijalankan berulang (yang sudah punya pemilik dilewati).

**Rollback ke v1.6:** cukup jalankan versi lama lagi. v1.6 mengabaikan kolom `ownerId` dan `id`, jadi semua data tetap terbaca (dan semua pengguna kembali melihat semua proyek seperti dulu). Untuk mengembalikan file persis seperti sebelum migrasi, salin isi folder `/data/backups/v1.7-owner-migration-<waktu>/` dan `/data/backups/v1.7-user-ids-<waktu>/` kembali ke `/data/`.

**Lupa password?** Jalankan perintah di bawah. Akunnya terhapus, tapi proyek dan media tidak. Setelah itu buka editor dan buat akun admin lagi.

```bash
curl -fsSL https://raw.githubusercontent.com/otongrusdiana2021-sudo/najja-editor/main/deploy/install.sh | sudo bash -s editor.domainkamu.com --reset-login
```

## Ganti token server

Jalankan installer lagi dengan `--token-baru`:

```bash
curl -fsSL https://raw.githubusercontent.com/otongrusdiana2021-sudo/najja-editor/main/deploy/install.sh | sudo bash -s editor.domainkamu.com --token-baru
```

Token server dipakai untuk membuat akun admin pertama dan sebagai token MCP milik admin pertama. Untuk AI sehari-hari, pakai **token AI pribadi** (lihat di bawah). Token lama langsung tidak berlaku, jadi perintah Claude Code perlu diperbarui. Login email tidak terpengaruh, dan data tidak berubah.

## Hubungkan AI ke editor di VPS

> Perintah AI dijalankan oleh **tab editor yang sedang terbuka di akun yang sama**. Buka editornya di browser dulu sebelum menyuruh AI.

**Paling mudah (v1.12.1): konektor Claude, tanpa token.** Di Claude (aplikasi desktop, claude.ai, atau HP) buka **Settings → Connectors → Add custom connector** (bahasa Indonesia: **Pengaturan → Konektor → Tambahkan konektor kustom**), isi alamat `https://editor.domainkamu.com/mcp`, lalu klik **Hubungkan**. Claude membuka halaman masuk Najja; masuk dengan akun kamu, lalu klik **Izinkan**. Selesai.

- Najja memakai OAuth 2.1 standar MCP: penemuan di `/.well-known/oauth-protected-resource` dan `/.well-known/oauth-authorization-server`, pendaftaran otomatis, kode + PKCE, token yang diperbarui otomatis.
- AI yang terhubung dengan cara ini hanya bisa mengedit proyek akun yang mengizinkannya, sama seperti token AI pribadi.
- Daftar aplikasi terhubung dan tombol **Putuskan** ada di menu akun → **Token AI (MCP)**. Ganti password memutus semua aplikasi.
- Server menyimpan hanya hash token di `<folder data>/oauth.json`.
- Di belakang aaPanel, nginx biasanya menahan semua jalur `/.well-known/` untuk sertifikat SSL (404 dari nginx). Itu tidak masalah: `/mcp` menunjuk ke `/oauth/protected-resource`, dan klien yang tidak menemukan metadata server memakai `/register`, `/authorize`, dan `/token`, yang semuanya dilayani Najja. Cek: `https://editor.domainkamu.com/oauth/authorization-server` harus menampilkan JSON.

**Panel AI · MCP di editor (v1.12.3):** semua cara di atas ada di tombol **MCP** di kanan atas editor, siap salin tanpa placeholder. Tab **Prompt** berisi perintah siap pakai dan tombol **Buka di Claude**. Tab **Tempel JSON** menjalankan perintah tool yang ditempel (misalnya jawaban ChatGPT) langsung di editor tanpa konektor.

**Token AI pribadi:** menu akun → **Token AI (MCP)** → **Buat token**. Token berawalan `najja_pat_`, hanya ditampilkan sekali, dan server hanya menyimpan hash-nya. AI yang memakai token ini hanya bisa mengedit proyek di akun kamu, lewat editor yang kamu buka. Bisa dicabut kapan saja dari menu yang sama. Token server (`NAJJA_TOKEN`) tetap berlaku dan bertindak sebagai admin pertama.

**Claude Code:**

```bash
claude mcp add --transport http najja-editor https://editor.domainkamu.com/mcp --header "Authorization: Bearer TOKEN_AI_KAMU"
```

**Claude Desktop atau Cursor (stdio):** simpan salinan folder `najja-editor` di laptop (cukup untuk `mcp-stdio.js`), lalu isi konfigurasi MCP:

```json
{
  "mcpServers": {
    "najja-editor": {
      "command": "node",
      "args": ["/path/di/laptop/najja-editor/mcp-stdio.js"],
      "env": {
        "NAJJA_URL": "https://editor.domainkamu.com",
        "NAJJA_TOKEN": "TOKEN_AI_KAMU"
      }
    }
  }
}
```

Dengan `NAJJA_URL` terisi, `mcp-stdio.js` hanya meneruskan perintah ke VPS dan tidak menyalakan server lokal.

## Keamanan

- Tanpa `NAJJA_TOKEN`, server **menolak** diakses dari luar localhost dan menolak berjalan di `HOST=0.0.0.0`. Ini mencegah server MCP terbuka ke internet tanpa sengaja.
- Dengan token:
  - Halaman editor butuh login. Sesi disimpan di cookie HttpOnly + Secure selama 30 hari.
  - `/mcp` butuh header `Authorization: Bearer`.
  - Login salah 10 kali dari satu IP akan diblokir selama 15 menit.
- Setiap proyek, media, upload, dan ekspor punya pemilik yang ditulis server dari sesi login/token (tidak pernah dari isi request). Data milik akun lain dijawab 404.
- Perintah MCP hanya dikirim ke editor milik akun pemilik token; hasilnya hanya diterima dari editor akun itu.
- Impor file lokal lewat AI hanya untuk admin dan dibatasi ke folder `/data/media` di server. Impor URL oleh akun editor hanya boleh ke internet publik (bukan localhost/jaringan internal VPS).
- Folder server (`exportsDir`, path `mcp-stdio.js`, path file ekspor) hanya ditampilkan ke admin.
- **Ganti token:** edit `.env`, lalu jalankan `docker compose up -d`. Semua sesi lama otomatis keluar.
- Proyek, media, dan hasil ekspor tersimpan di server kamu sendiri (volume `najja-data`), tidak di layanan luar.
- Tombol **Keluar** ada di menu akun (bulatan inisial di kanan atas), atau buka `/logout`.
- (v1.13.2) Semua halaman HTML mengirim header keamanan: situs lain tidak boleh menampilkannya di iframe (`frame-ancestors 'self'`, `X-Frame-Options: SAMEORIGIN`), referrer ke situs lain hanya berisi origin, dan semua respons memakai `X-Content-Type-Options: nosniff`.
- (v1.13.2) `Content-Security-Policy` masih **report-only**: pelanggaran hanya muncul di console browser, belum ada yang diblokir. Setelah dipantau di produksi, kebijakan ini bisa diubah jadi wajib. HSTS dipasang di nginx, bukan di app.
- (v1.13.2) Saat keluar (atau saat halaman login terbuka karena sesi habis), service worker menghapus cache tampilan aplikasi. Model AI yang sudah diunduh tetap disimpan. Draft perubahan dan salinan media di perangkat **belum** dihapus saat keluar (lihat `docs/AUDIT_REPORT.md`, S7).

## Hapus latar otomatis (v1.11)

Saat **Hapus latar otomatis** dipakai pertama kali, server Najja menyiapkan file berikut sekali:

- `registry.npmjs.org`: paket `onnxruntime-web` 1.29.0 (unduhan ±32 MB, hanya 3 file yang disimpan);
- model BiRefNet lite 512 (±190 MB): disalin dari folder model layanan AI kalau sudah ada (volume yang sama di Docker), kalau belum diunduh dari `huggingface.co`.

Versinya dikunci dan sha256-nya dicek. File disimpan di `<folder data>/vendor/` dan disajikan oleh server Najja sendiri. Browser tidak memuat apa pun dari CDN. Tiap perangkat mengunduh model ±190 MB itu sekali dari server Najja, lalu menyimpannya di cache browser.

Style Konsep (v1.12.4/v1.12.5) juga memakai `onnxruntime-web` yang sama, ditambah dua model kecil dari `huggingface.co`: detektor wajah UltraFace RFB-320 (±1,3 MB) dan MediaPipe Selfie Segmentation untuk badan orang (±0,46 MB), keduanya Apache-2.0. Keduanya diunduh sekali saat style pertama dibuat, lalu disajikan dari `/vendor/ultraface-320/` dan `/vendor/selfie-256/`. Keduanya jalan di WebAssembly, tidak butuh GPU. Kalau server tidak bisa mengunduhnya, style tetap jadi dan posisi orang ditebak.

Perangkat tanpa WebGPU memakai layanan AI di server (container `ai`). Kalau layanan itu juga tidak berjalan, sakelarnya menampilkan pesan. Fitur editor lain tidak terpengaruh.

## Masalah umum

| Gejala | Penyebab / solusi |
|---|---|
| Sertifikat tidak terbit | A record belum mengarah ke IP VPS, atau port 80/443 tertutup. Cek `docker compose logs caddy`. |
| `429 Too Many Requests` saat `docker compose up` | Batas unduhan Docker Hub. Tunggu sebentar, atau jalankan `docker login`. |
| Setelah login kembali lagi ke halaman login | Buka lewat **https://**. Cookie aman tidak dikirim lewat http. |
| AI menjawab "editor is not open" | Buka editor di browser dan pastikan sudah login. Titik di tombol **MCP** harus hijau. |
| Ekspor berhenti atau lambat | Ekspor berjalan di tab browser: biarkan tab terbuka dan terlihat. MP4 dirender cepat di Chrome/Edge (makin cepat dengan GPU; cek *Settings → System → Use graphics acceleration* aktif). File langsung terunduh; salinan ke server menyusul di background. |
| Preview video hitam di PC lain (video iPhone) | Codec HEVC tidak didukung browser PC itu. Tunggu kartu media selesai **Konversi** (salinan 720p, biasanya kurang dari durasi videonya); kalau muncul "Tidak bisa diputar", jalankan installer lagi agar ffmpeg terpasang. |
| Pakai nginx, bukan Caddy | Tambahkan `proxy_set_header Host $host;`, `proxy_set_header X-Forwarded-Proto $scheme;`, `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`, `proxy_buffering off;`, `proxy_read_timeout 1h;`, dan `client_max_body_size 2g;`. |
