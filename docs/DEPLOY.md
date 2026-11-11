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
| Media (file asli, salinan H.264, thumbnail, waveform) | `/data/library/<id>/` |
| Hasil ekspor | `/data/exports/` |

Karena itu proyek bisa dibuka dari laptop, HP, atau browser mana pun setelah login. Upload video besar dipecah per 8 MB, jadi tidak terkena batas upload nginx/aaPanel.

### Salinan video di perangkat (maks. 5 GB)

Supaya refresh atau buka ulang browser tidak mengunduh video lagi, tiap perangkat menyimpan **salinan** video yang pernah dibuka di penyimpanan browser (OPFS), maksimal 5 GB per browser. VPS tetap sumber utama: salinan hanya cache.

- Unduhan pertama berjalan di background (kartu media: **Memuat xx%**), dijeda saat video diputar, dan dilanjutkan dari posisi terakhir kalau terputus.
- Kalau video di VPS dikonversi ulang, perangkat mengunduh versi baru sekali dan membuang yang lama.
- Kalau penuh, video yang paling lama tidak dibuka dihapus duluan (video di proyek yang sedang dibuka tidak ikut dihapus).
- Lihat atau hapus salinan: menu akun (bulatan inisial) → **Penyimpanan perangkat**. Salinan tetap ada setelah *Keluar*.
- Pasang editor sebagai aplikasi (PWA) supaya Chrome menandai penyimpanannya permanen dan tidak membersihkannya saat disk penuh.

### Video iPhone (HEVC) dan format lain

Video iPhone `.MOV` biasanya memakai codec HEVC (H.265). Tidak semua PC bisa memutarnya di browser: preview jadi hitam walaupun filenya ada. Karena itu server otomatis membuat **salinan MP4 H.264** untuk video seperti ini (juga AVI, video 10-bit/HDR, ProRes), lalu editor memakai salinan itu untuk preview dan ekspor.

- File asli tetap disimpan dan tidak diubah.
- Konversi berjalan sekali per video di VPS (±1,5× durasi video di 1 vCPU) dengan prioritas rendah, jadi aplikasi lain di VPS tidak terganggu. Selama proses, kartu media menampilkan **Konversi xx%**.
- Video yang sudah ada sebelum fitur ini dikonversi otomatis saat proyeknya dibuka.
- Butuh `ffmpeg`. Image Docker sudah memasangnya; installer menampilkan *Konversi video otomatis … aktif ✓*. Untuk Cara B (tanpa Docker), pasang dengan `apt install -y ffmpeg` lalu `systemctl restart najja-editor`.

**Backup** satu file ke folder home:

```bash
tar czf ~/najja-backup-$(date +%F).tgz -C "$(docker volume inspect najja-editor_najja-data --format '{{.Mountpoint}}')" .
```

Folder volume itu juga bisa dimasukkan ke jadwal backup aaPanel.

## Pasang sebagai aplikasi

Buka editornya di Chrome atau Edge, lalu klik ikon **Install** di address bar, atau buka menu ☰ di kiri atas → **Pasang sebagai aplikasi**. Najja akan punya ikon sendiri dan terbuka di jendela terpisah seperti aplikasi biasa.

## Login dengan email

Saat pertama kali membuka editor, muncul halaman **Buat akun admin**. Isi email, password, dan **token server** sekali saja (token ada di `/opt/najja-editor/.env`). Setelah itu kamu masuk dengan email dan password.

- Menu akun ada di bulatan inisial di kanan atas: **Ganti password**, **Kelola pengguna** (admin bisa menambah atau menghapus pengguna), dan **Keluar**.
- Semua pengguna memakai proyek dan media yang sama di server.

**Lupa password?** Jalankan perintah di bawah. Akunnya terhapus, tapi proyek dan media tidak. Setelah itu buka editor dan buat akun admin lagi.

```bash
curl -fsSL https://raw.githubusercontent.com/otongrusdiana2021-sudo/najja-editor/main/deploy/install.sh | sudo bash -s editor.domainkamu.com --reset-login
```

## Ganti token server

Jalankan installer lagi dengan `--token-baru`:

```bash
curl -fsSL https://raw.githubusercontent.com/otongrusdiana2021-sudo/najja-editor/main/deploy/install.sh | sudo bash -s editor.domainkamu.com --token-baru
```

Token server dipakai untuk Claude Code/MCP dan untuk membuat akun admin pertama. Token lama langsung tidak berlaku, jadi perintah Claude Code perlu diperbarui. Login email tidak terpengaruh, dan data tidak berubah.

## Hubungkan AI ke editor di VPS

> Perintah AI dijalankan oleh **tab editor yang sedang terbuka**. Buka editornya di browser dulu sebelum menyuruh AI.

**Claude Code:**

```bash
claude mcp add --transport http najja-editor https://editor.domainkamu.com/mcp --header "Authorization: Bearer TOKEN_KAMU"
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
        "NAJJA_TOKEN": "TOKEN_KAMU"
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
- Impor file lokal lewat AI dibatasi ke folder `/data/media` di server.
- **Ganti token:** edit `.env`, lalu jalankan `docker compose up -d`. Semua sesi lama otomatis keluar.
- Proyek, media, dan hasil ekspor tersimpan di server kamu sendiri (volume `najja-data`), tidak di layanan luar.
- Tombol **Keluar** ada di menu akun (bulatan inisial di kanan atas), atau buka `/logout`.

## Masalah umum

| Gejala | Penyebab / solusi |
|---|---|
| Sertifikat tidak terbit | A record belum mengarah ke IP VPS, atau port 80/443 tertutup. Cek `docker compose logs caddy`. |
| `429 Too Many Requests` saat `docker compose up` | Batas unduhan Docker Hub. Tunggu sebentar, atau jalankan `docker login`. |
| Setelah login kembali lagi ke halaman login | Buka lewat **https://**. Cookie aman tidak dikirim lewat http. |
| AI menjawab "editor is not open" | Buka editor di browser dan pastikan sudah login. Titik di tombol **MCP** harus hijau. |
| Ekspor berhenti atau lambat | Ekspor berjalan di tab browser: biarkan tab terbuka dan terlihat. MP4 dirender cepat di Chrome/Edge (makin cepat dengan GPU; cek *Settings → System → Use graphics acceleration* aktif). File langsung terunduh; salinan ke server menyusul di background. |
| Preview video hitam di PC lain (video iPhone) | Codec HEVC tidak didukung browser PC itu. Tunggu kartu media selesai **Konversi**; kalau muncul "Tidak bisa diputar", jalankan installer lagi agar ffmpeg terpasang. |
| Pakai nginx, bukan Caddy | Tambahkan `proxy_set_header Host $host;`, `proxy_set_header X-Forwarded-Proto $scheme;`, `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`, `proxy_buffering off;`, `proxy_read_timeout 1h;`, dan `client_max_body_size 2g;`. |
