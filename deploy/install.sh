#!/usr/bin/env bash
# Najja Editor — installer otomatis untuk VPS Ubuntu/Debian.
#
# Dari folder hasil ekstrak zip:   sudo bash deploy/install.sh editor.domainkamu.com
# Langsung dari GitHub:            curl -fsSL https://raw.githubusercontent.com/otongrusdiana2021-sudo/najja-editor/main/deploy/install.sh | sudo bash -s editor.domainkamu.com
#
# Cek dulu tanpa mengubah apa pun:  ... | sudo bash -s editor.domainkamu.com --cek
# Ganti token server (MCP):         ... | sudo bash -s editor.domainkamu.com --token-baru
# Lupa password (hapus akun saja):  ... | sudo bash -s editor.domainkamu.com --reset-login
# Tanpa alat AI (hapus latar/upscale): ... | sudo bash -s editor.domainkamu.com --tanpa-ai
#
# Yang dilakukan: pasang Docker (jika belum), buat token login, jalankan Najja.
# Port 80/443 kosong → Najja + Caddy (HTTPS otomatis).
# Port 80/443 dipakai web server lain (aaPanel/nginx/apache) → Najja hanya di port lokal,
# website lain tidak diubah.
set -euo pipefail

# Seluruh skrip dibungkus main() dan dijalankan dengan stdin dari /dev/null: saat dipakai lewat
# `curl | bash`, bash membaca SELURUH skrip dulu, sehingga perintah seperti `docker compose exec`
# tidak bisa "menelan" sisa skrip dari stdin.
main() {

CHECK=0
NEW_TOKEN=0
RESET_LOGIN=0
NO_AI=0
DOMAIN="${DOMAIN:-}"
for arg in "$@"; do
  case "$arg" in
    --cek|--check|--dry-run) CHECK=1 ;;
    --token-baru|--new-token) NEW_TOKEN=1 ;;
    --reset-login) RESET_LOGIN=1 ;;
    --tanpa-ai|--no-ai) NO_AI=1 ;;
    -*) ;;
    *) DOMAIN="$arg" ;;
  esac
done
REPO_URL="${NAJJA_REPO_URL:-https://github.com/otongrusdiana2021-sudo/najja-editor.git}"
INSTALL_DIR="${NAJJA_DIR:-/opt/najja-editor}"
WAIT_TRIES="${NAJJA_WAIT_TRIES:-40}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '\033[36m›\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Jalankan sebagai root: sudo bash $0 $DOMAIN"

if [ -z "$DOMAIN" ]; then { read -rp "Domain untuk editor (mis. editor.domainkamu.com): " DOMAIN </dev/tty; } 2>/dev/null || true; fi
DOMAIN="$(printf '%s' "$DOMAIN" | tr 'A-Z' 'a-z' | sed -e 's#^https\?://##' -e 's#/.*$##')"
[[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || die "Domain tidak valid: '$DOMAIN'"

detect() {
  DNS_IP="$( (getent ahostsv4 "$DOMAIN" 2>/dev/null || true) | awk 'NR==1{print $1}')"
  LOCAL_IPS=" $(hostname -I 2>/dev/null || true) "
  MODE=caddy; WEB=""; PANEL=""; BUSY=""
  PROJECT="$(basename "${APP_DIR:-$INSTALL_DIR}" | tr 'A-Z' 'a-z' | tr -cd 'a-z0-9_-')"
  if command -v ss >/dev/null 2>&1; then
    BUSY="$(ss -ltnpH 2>/dev/null | awk '$4 ~ /:(80|443)$/' | grep -v -e docker-proxy -e '"caddy"' || true)"
  fi
  if [ -n "$BUSY" ]; then
    MODE=proxy
    WEB="$(printf '%s\n' "$BUSY" | grep -oE 'users:\(\("[^"]+' | head -1 | sed 's/.*"//')"
  fi
  OTHER_DOCKER="$( (docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null || true) | grep -E ':(80|443)->' | grep -v "^${PROJECT}-caddy-" || true)"
  if [ -n "$OTHER_DOCKER" ]; then MODE=proxy; WEB="${WEB:-container $(printf '%s' "$OTHER_DOCKER" | awk 'NR==1{print $1}')}"; fi
  [ -d /www/server/panel ] && PANEL=aapanel
  [ -d /usr/local/CyberCP ] && PANEL=cyberpanel
  return 0
}
# Alat AI (container "ai"): batas memori & CPU dari ukuran VPS. BiRefNet (hapus latar kualitas tinggi) butuh
# ±2,4 GB sesaat; VPS kecil memakai IS-Net (±0,9 GB). Nilai yang sudah ada di .env tidak diubah.
ai_limits() {
  local mem_mb cores
  mem_mb="$(awk '/^MemTotal:/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)"
  cores="$(nproc 2>/dev/null || echo 1)"
  AI_MEM="${OLD_AI_MEM:-}"; AI_CPUS="${OLD_AI_CPUS:-}"
  [ -n "$AI_MEM" ] || { if [ "${mem_mb:-0}" -ge 6000 ]; then AI_MEM=2560m; else AI_MEM=1280m; fi; }
  [ -n "$AI_CPUS" ] || { if [ "${cores:-1}" -ge 4 ]; then AI_CPUS=2.0; else AI_CPUS=1.0; fi; }
  AI_MEM_MB="$(printf '%s' "$AI_MEM" | awk '/[gG]$/ {print int($0 * 1024); next} /[mM]$/ {print int($0); next} {print 0}')"
  if [ "${AI_MEM_MB:-0}" -ge 2400 ]; then AI_QUALITY="BiRefNet (kualitas tinggi)"; else AI_QUALITY="IS-Net (ringan; RAM VPS < 6 GB)"; fi
}
free_port() {
  local p="${1:-3333}"
  while ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${p}\$"; do p=$((p + 1)); done
  echo "$p"
}

if [ "$CHECK" = 1 ]; then
  bold "✦ Pengecekan untuk https://$DOMAIN — TIDAK ADA yang diubah"
  detect
  . /etc/os-release 2>/dev/null || true
  info "Sistem       : ${PRETTY_NAME:-tidak diketahui}, RAM bebas $(free -m 2>/dev/null | awk '/^Mem:/{print $7}') MB, disk bebas $(df -h / 2>/dev/null | awk 'NR==2{print $4}')"
  if ! command -v docker >/dev/null 2>&1; then info "Docker       : belum ada → akan dipasang (docker.io + docker compose)"
  elif ! docker compose version >/dev/null 2>&1; then info "Docker       : $(docker --version 2>/dev/null) → hanya plugin compose yang ditambah, Docker yang ada tidak diubah"
  else info "Docker       : sudah ada ($(docker compose version --short 2>/dev/null)) → tidak diubah"; fi
  if [ "$MODE" = proxy ]; then
    info "Port 80/443  : dipakai ${WEB:-web server lain}${PANEL:+ ($PANEL)} → Najja di belakangnya, port lokal 127.0.0.1:$(free_port 3333)"
    if [ "$PANEL" = aapanel ]; then info "nginx/aaPanel: TIDAK diubah oleh installer (kamu tambah reverse proxy di panel)"
    elif [ "$WEB" = nginx ] && [ -d /etc/nginx ]; then info "nginx        : akan ditambah 1 file situs baru untuk $DOMAIN (situs lain tidak diubah)"
    else info "Web server   : tidak diubah (kamu arahkan reverse proxy ke port lokal Najja)"; fi
  else
    info "Port 80/443  : kosong → Najja + Caddy (HTTPS otomatis)"
  fi
  if [ -z "$DNS_IP" ]; then warn "DNS          : $DOMAIN belum punya A record"
  elif [[ "$LOCAL_IPS" != *" $DNS_IP "* ]]; then warn "DNS          : $DOMAIN → $DNS_IP, IP VPS ini:$LOCAL_IPS"
  else info "DNS          : OK ($DOMAIN → $DNS_IP)"; fi
  info "Akan dibuat  : folder $INSTALL_DIR + container Docker 'najja' (maks. RAM 768 MB)"
  if [ "$NO_AI" = 1 ]; then info "Alat AI      : tidak dipasang (--tanpa-ai)"
  else
    OLD_AI_MEM=""; OLD_AI_CPUS=""
    [ -f "$INSTALL_DIR/.env" ] && OLD_AI_MEM="$(sed -n 's/^NAJJA_AI_MEM=//p' "$INSTALL_DIR/.env" | head -1)"
    [ -f "$INSTALL_DIR/.env" ] && OLD_AI_CPUS="$(sed -n 's/^NAJJA_AI_CPUS=//p' "$INSTALL_DIR/.env" | head -1)"
    ai_limits
    info "Alat AI      : container 'ai' (maks. RAM $AI_MEM, CPU $AI_CPUS) — hapus latar: $AI_QUALITY; model ±200 MB diunduh sekali"
  fi
  bold "Kalau sudah oke, jalankan perintah yang sama tanpa --cek."
  exit 0
fi

bold "✦ Memasang Najja Editor untuk https://$DOMAIN"

# 1. Kode aplikasi
# Dijalankan sebagai file (bash deploy/install.sh) → pakai folder kode itu apa adanya.
# Dijalankan lewat curl | bash → SELALU pakai $INSTALL_DIR dan samakan persis dengan GitHub (folder terminal tidak berpengaruh).
SELF="${BASH_SOURCE[0]:-}"
GITREV=""
if [ -n "$SELF" ] && [ -f "$SELF" ] && [ -f "$(dirname "$SELF")/../docker-compose.yml" ]; then
  APP_DIR="$(cd "$(dirname "$SELF")/.." && pwd)"
else
  [ -n "$REPO_URL" ] || die "NAJJA_REPO_URL kosong."
  command -v git >/dev/null || { apt-get update -qq && apt-get install -y -qq --no-remove git; }
  git config --global --get-all safe.directory 2>/dev/null | grep -qxF "$INSTALL_DIR" || git config --global --add safe.directory "$INSTALL_DIR" 2>/dev/null || true
  if [ -d "$INSTALL_DIR/.git" ]; then
    info "Memperbarui kode di $INSTALL_DIR"
    git -C "$INSTALL_DIR" fetch -q --depth 1 "$REPO_URL" main || die "Gagal mengunduh kode terbaru dari $REPO_URL (cek koneksi VPS ke GitHub)."
    git -C "$INSTALL_DIR" reset -q --hard FETCH_HEAD || die "Gagal memperbarui kode di $INSTALL_DIR."
  elif [ -d "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
    die "$INSTALL_DIR sudah ada tapi bukan folder git. Ganti namanya dulu (mv $INSTALL_DIR $INSTALL_DIR.lama), lalu jalankan ulang."
  else
    info "Mengunduh kode ke $INSTALL_DIR"
    git clone -q --depth 1 "$REPO_URL" "$INSTALL_DIR" || die "Gagal mengunduh kode dari $REPO_URL."
  fi
  APP_DIR="$INSTALL_DIR"
  GITREV="$(git -C "$APP_DIR" log -1 --format='%h' 2>/dev/null || true)"
fi
cd "$APP_DIR"
EXPECTED_VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json | head -1)"
info "Folder aplikasi: $APP_DIR — versi $EXPECTED_VERSION${GITREV:+ (commit $GITREV)}"

# 2. Docker — Docker yang sudah ada TIDAK pernah dipasang ulang; apt dibatalkan kalau akan menghapus paket.
export DEBIAN_FRONTEND=noninteractive
APT=(apt-get install -y -qq --no-remove)
if ! command -v docker >/dev/null 2>&1; then
  info "Memasang Docker…"
  apt-get update -qq
  "${APT[@]}" docker.io docker-compose-v2 >/dev/null 2>&1 || "${APT[@]}" docker.io docker-compose-plugin >/dev/null 2>&1 || {
    warn "Paket Docker dari apt tidak tersedia, memakai skrip resmi get.docker.com"
    curl -fsSL https://get.docker.com | sh
  }
elif ! docker compose version >/dev/null 2>&1; then
  info "Docker sudah ada — hanya menambah plugin docker compose"
  apt-get update -qq
  if dpkg -s docker-ce >/dev/null 2>&1; then "${APT[@]}" docker-compose-plugin >/dev/null 2>&1
  else "${APT[@]}" docker-compose-v2 >/dev/null 2>&1 || "${APT[@]}" docker-compose-plugin >/dev/null 2>&1
  fi || die "Gagal memasang plugin docker compose. Docker yang sudah ada tidak diubah."
fi
command -v systemctl >/dev/null 2>&1 && systemctl enable --now docker >/dev/null 2>&1 || true
docker compose version >/dev/null 2>&1 || die "docker compose tidak tersedia"

# 3–4. Cek DNS dan port 80/443
detect
if [ -z "$DNS_IP" ]; then
  warn "Domain $DOMAIN belum punya A record. HTTPS baru aktif setelah A record mengarah ke VPS ini."
elif [[ "$LOCAL_IPS" != *" $DNS_IP "* ]]; then
  warn "A record $DOMAIN → $DNS_IP, sedangkan IP di VPS ini:$LOCAL_IPS"
  warn "Kalau VPS memakai IP publik lain (NAT/Cloudflare proxy), abaikan. Kalau salah, perbaiki A record-nya."
else
  info "DNS OK: $DOMAIN → $DNS_IP"
fi
if [ "$MODE" = proxy ]; then
  info "Port 80/443 sudah dipakai ${WEB:-web server lain}${PANEL:+ ($PANEL)}. Najja dipasang di belakangnya — situs lain di VPS ini tidak diubah."
fi

# 5. Firewall — hanya kalau Najja sendiri yang memakai port 80/443
if [ "$MODE" = caddy ] && command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  info "Membuka port 80 dan 443 di ufw"
  for r in 80/tcp 443/tcp 443/udp; do ufw allow "$r" >/dev/null 2>&1 || true; done
fi

# 6. Konfigurasi (.env) — token lama dipertahankan saat install ulang
TOKEN=""
OLD_LPORT=""
OLD_AI_MEM=""
OLD_AI_CPUS=""
[ -f .env ] && TOKEN="$(sed -n 's/^NAJJA_TOKEN=//p' .env | head -1)"
[ -f .env ] && OLD_LPORT="$(sed -n 's/^NAJJA_LOCAL_PORT=//p' .env | head -1)"
[ -f .env ] && OLD_AI_MEM="$(sed -n 's/^NAJJA_AI_MEM=//p' .env | head -1)"
[ -f .env ] && OLD_AI_CPUS="$(sed -n 's/^NAJJA_AI_CPUS=//p' .env | head -1)"
if [ -z "$TOKEN" ] || [ "$NEW_TOKEN" = 1 ]; then
  TOKEN="$(openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  if [ "$NEW_TOKEN" = 1 ]; then info "Token server BARU dibuat — token lama tidak berlaku lagi untuk MCP/Claude Code"
  else info "Token server dibuat"; fi
fi
umask 077
printf 'DOMAIN=%s\nNAJJA_TOKEN=%s\n' "$DOMAIN" "$TOKEN" > .env
[ -n "$OLD_LPORT" ] && printf 'NAJJA_LOCAL_PORT=%s\n' "$OLD_LPORT" >> .env
ai_limits
printf 'NAJJA_AI_MEM=%s\nNAJJA_AI_CPUS=%s\n' "$AI_MEM" "$AI_CPUS" >> .env
umask 022

# 7. Jalankan
pull_mirror() {
  # Docker Hub sering membatasi unduhan anonim dari IP VPS bersama (HTTP 429). Ambil image yang sama dari mirror Google.
  warn "Gagal mengunduh image dari Docker Hub. Mencoba mirror.gcr.io…"
  for img in "$@"; do docker pull -q "mirror.gcr.io/library/$img" >/dev/null && docker tag "mirror.gcr.io/library/$img" "$img"; done
}
info "Membangun dan menjalankan container (1–3 menit)…"
if [ "$MODE" = caddy ]; then
  COMPOSE=(docker compose)
  if ! "${COMPOSE[@]}" up -d --build --force-recreate najja caddy; then
    pull_mirror node:22-alpine caddy:2
    "${COMPOSE[@]}" up -d --build --force-recreate najja caddy || die "Gagal menjalankan container. Cek pesan di atas."
  fi
else
  docker compose down --remove-orphans >/dev/null 2>&1 || true
  WANT="$(sed -n 's/^NAJJA_LOCAL_PORT=//p' .env 2>/dev/null | head -1)"
  WANT="${WANT:-3333}"
  # Container Najja lama (mis. dari folder/proyek lain) yang masih memegang port → hentikan.
  STALE="$(docker ps --format '{{.ID}} {{.Names}} {{.Ports}}' 2>/dev/null | grep -E "(127\.0\.0\.1|0\.0\.0\.0):${WANT}->" | grep -i najja | awk '{print $1}' || true)"
  if [ -n "$STALE" ]; then warn "Menghentikan container Najja lama yang masih memakai port $WANT"; docker rm -f $STALE >/dev/null 2>&1 || true; fi
  LPORT="$(free_port "$WANT")"
  if [ "$LPORT" != "$WANT" ]; then
    warn "Port $WANT dipakai program lain, Najja memakai port $LPORT."
    warn "WAJIB: ubah Target URL reverse proxy di aaPanel menjadi http://127.0.0.1:$LPORT"
  fi
  sed -i '/^NAJJA_LOCAL_PORT=/d' .env
  printf 'NAJJA_LOCAL_PORT=%s\n' "$LPORT" >> .env
  COMPOSE=(docker compose -f docker-compose.yml -f deploy/compose.proxy.yml)
  if ! "${COMPOSE[@]}" up -d --build --force-recreate najja; then
    pull_mirror node:22-alpine
    "${COMPOSE[@]}" up -d --build --force-recreate najja || die "Gagal menjalankan container. Cek pesan di atas."
  fi
  info "Najja berjalan di http://127.0.0.1:$LPORT (hanya lokal)"
fi

# 7a'. Alat AI (container terpisah). Gagal di sini tidak menghentikan editor: alatnya tampil "belum tersedia".
AI_OK=0
if [ "$NO_AI" = 1 ]; then
  "${COMPOSE[@]}" rm -sf ai >/dev/null 2>&1 || true
else
  info "Menyiapkan alat AI (hapus latar, upscale): container 'ai', maks. RAM $AI_MEM, CPU $AI_CPUS…"
  if "${COMPOSE[@]}" up -d --build ai || { pull_mirror python:3.12-slim; "${COMPOSE[@]}" up -d --build ai; }; then
    AI_OK=1
  else
    warn "Alat AI belum aktif (gagal membangun container 'ai'). Editor tetap berjalan; jalankan installer lagi nanti."
  fi
fi

# 7a. Pastikan versi yang BERJALAN sama dengan kode yang baru diunduh
info "Memeriksa versi yang berjalan…"
LIVE=""
for _ in $(seq 1 40); do
  LIVE="$(docker compose exec -T najja wget -qO- http://127.0.0.1:3333/healthz 2>/dev/null || true)"
  [ -n "$LIVE" ] && break
  sleep 1
done
LIVE_VERSION="$(printf '%s' "$LIVE" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
if [ "$LIVE_VERSION" = "$EXPECTED_VERSION" ]; then
  info "Container menjalankan versi $LIVE_VERSION ✓"
  if printf '%s' "$LIVE" | grep -q '"convert":true'; then
    info "Konversi video otomatis (HEVC/iPhone → MP4 H.264) aktif ✓"
  else
    warn "Konversi video nonaktif (ffmpeg gagal terpasang). Video HEVC dari iPhone hanya bisa diputar di perangkat yang mendukungnya. Jalankan installer lagi nanti."
  fi
else
  docker compose logs --tail 30 najja 2>&1 | sed 's/^/    /' || true
  die "Container belum menjalankan versi $EXPECTED_VERSION (terdeteksi: ${LIVE_VERSION:-tidak merespons}). Kirim output ini untuk dicek."
fi
if [ "$MODE" = proxy ]; then
  if curl -fsS --max-time 5 "http://127.0.0.1:$LPORT/healthz" 2>/dev/null | grep -q "\"version\":\"$EXPECTED_VERSION\""; then
    info "Port lokal 127.0.0.1:$LPORT merespons versi $EXPECTED_VERSION ✓"
  else
    warn "Port lokal 127.0.0.1:$LPORT belum merespons versi $EXPECTED_VERSION"
  fi
fi

if [ "$AI_OK" = 1 ]; then
  AI_HEALTH=""
  for _ in $(seq 1 20); do
    AI_HEALTH="$("${COMPOSE[@]}" exec -T ai python -c "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8099/health',timeout=3).read().decode())" 2>/dev/null || true)"
    [ -n "$AI_HEALTH" ] && break
    sleep 1
  done
  if printf '%s' "$AI_HEALTH" | grep -q '"ok": true'; then
    info "Alat AI aktif ✓ — hapus latar: $AI_QUALITY"
    printf '%s' "$AI_HEALTH" | grep -q '"downloading"\|"missing"' && info "Model AI sedang diunduh di latar belakang (±200 MB, sekali saja)."
  else
    warn "Container AI berjalan tapi belum menjawab. Cek: cd $APP_DIR && docker compose logs ai"
  fi
fi

if [ "$RESET_LOGIN" = 1 ]; then
  for _ in $(seq 1 20); do docker compose exec -T najja node server.js reset-login >/dev/null 2>&1 && { info "Akun login dihapus — buka editor untuk membuat akun admin baru (proyek & media tetap aman)"; break; }; sleep 1; done
fi

# 7b. Hubungkan ke web server yang sudah ada
NGINX_DONE=0
if [ "$MODE" = proxy ] && [ "$WEB" = nginx ] && [ -z "$PANEL" ] && [ -d /etc/nginx ]; then
  if [ -d /etc/nginx/sites-enabled ]; then CONF="/etc/nginx/sites-available/najja-editor.conf"; LINK="/etc/nginx/sites-enabled/najja-editor.conf"; else CONF="/etc/nginx/conf.d/najja-editor.conf"; LINK=""; fi
  if [ -f "$CONF" ] && grep -q "listen 443" "$CONF"; then
    sed -i -E "s#proxy_pass http://127\.0\.0\.1:[0-9]+;#proxy_pass http://127.0.0.1:$LPORT;#" "$CONF"
  else
    info "Menambahkan situs $DOMAIN ke nginx"
    V6=""
    grep -rqs 'listen \[::\]' /etc/nginx/sites-enabled /etc/nginx/conf.d /etc/nginx/nginx.conf && V6="listen [::]:80;"
    cat > "$CONF" <<NGINX
# Najja Editor — dibuat oleh deploy/install.sh
server {
    listen 80;
    $V6
    server_name $DOMAIN;
    client_max_body_size 2g;
    location / {
        proxy_pass http://127.0.0.1:$LPORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
NGINX
    [ -n "$LINK" ] && ln -sf "$CONF" "$LINK"
  fi
  if nginx -t >/dev/null 2>&1; then
    systemctl reload nginx 2>/dev/null || nginx -s reload
    NGINX_DONE=1
    if ! grep -q "listen 443" "$CONF"; then
      info "Memasang sertifikat HTTPS (Let's Encrypt) lewat certbot…"
      command -v certbot >/dev/null 2>&1 || apt-get install -y -qq certbot python3-certbot-nginx >/dev/null 2>&1 || true
      certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect --keep-until-expiring >/dev/null 2>&1 \
        && info "Sertifikat HTTPS terpasang" \
        || warn "Sertifikat belum bisa dibuat (biasanya DNS belum mengarah ke VPS ini). Jalankan ulang skrip ini setelah DNS benar."
    fi
  else
    rm -f "$CONF" ${LINK:+"$LINK"}
    warn "Konfigurasi nginx tidak lolos 'nginx -t', perubahan dibatalkan (situs lain tetap aman)."
  fi
fi

# 8. Tunggu HTTPS siap
READY=0
if [ "$MODE" = caddy ] || [ "$NGINX_DONE" = 1 ]; then
  info "Mengecek https://$DOMAIN …"
  for _ in $(seq 1 "$WAIT_TRIES"); do
    if curl -fsS -o /dev/null --max-time 6 "https://$DOMAIN/login" 2>/dev/null; then READY=1; break; fi
    sleep 3
  done
fi

PUBLIC_VERSION="$(curl -fsS --max-time 8 "https://$DOMAIN/healthz" 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' || true)"
[ "$PUBLIC_VERSION" = "$EXPECTED_VERSION" ] && READY=1

echo
bold "──────────────────────────────────────────────────────"
bold " ✦ Najja Editor terpasang"
bold "──────────────────────────────────────────────────────"
echo "  Editor     : https://$DOMAIN"
echo "  Login      : email + password (buat akun admin saat pertama kali membuka editor)"
echo "  Token server (untuk akun pertama & MCP): $TOKEN"
echo "  MCP        : https://$DOMAIN/mcp"
if [ "$NO_AI" = 1 ]; then echo "  Alat AI    : tidak dipasang (--tanpa-ai)"
elif [ "$AI_OK" = 1 ]; then echo "  Alat AI    : aktif — hapus latar $AI_QUALITY, upscale Real-ESRGAN (RAM maks. $AI_MEM, CPU $AI_CPUS)"
else echo "  Alat AI    : belum aktif (jalankan installer lagi)"; fi
echo
echo "  Claude Code:"
echo "    claude mcp add --transport http najja-editor https://$DOMAIN/mcp --header \"Authorization: Bearer $TOKEN\""
echo
if [ "$READY" = 1 ]; then
  echo "  HTTPS aktif ✓"
elif [ "$MODE" = proxy ] && [ "$NGINX_DONE" = 0 ]; then
  bold "  Langkah terakhir: arahkan $DOMAIN ke Najja dari web server kamu"
  if [ "$PANEL" = aapanel ]; then
    echo "  Di aaPanel (sekali saja):"
    echo "   1. Website → Add site → Domain: $DOMAIN → PHP: Static/Pure static → Submit"
    echo "   2. Buka situs itu → SSL → Let's Encrypt → centang $DOMAIN → Apply → nyalakan Force HTTPS"
    echo "   3. Reverse proxy → Add reverse proxy → Name: najja"
    echo "      Target URL: http://127.0.0.1:$LPORT   Sent Domain: \$host   → Submit"
  else
    echo "  Tambahkan reverse proxy untuk $DOMAIN ke http://127.0.0.1:$LPORT"
    echo "  (teruskan header Host, matikan buffering, timeout baca ≥ 1 jam). Contoh nginx ada di docs/DEPLOY.md."
  fi
else
  warn "HTTPS belum bisa dicek. Biasanya karena A record belum mengarah ke VPS ini atau port 80/443 diblokir provider."
  [ "$MODE" = caddy ] && warn "Setelah DNS benar, Caddy mencoba lagi otomatis. Cek log: cd $APP_DIR && docker compose logs caddy"
fi
if [ "$PUBLIC_VERSION" = "$EXPECTED_VERSION" ]; then
  echo "  https://$DOMAIN menjalankan versi $PUBLIC_VERSION ✓"
elif [ -n "$PUBLIC_VERSION" ] || [ "$READY" = 1 ]; then
  warn "https://$DOMAIN masih menjawab versi ${PUBLIC_VERSION:-lama}, bukan $EXPECTED_VERSION."
  warn "Cek Target URL reverse proxy di aaPanel: harus http://127.0.0.1:${LPORT:-3333}"
fi
echo "  Token tersimpan di $APP_DIR/.env (lihat lagi: sudo cat $APP_DIR/.env)"
bold "──────────────────────────────────────────────────────"
}

main "$@" </dev/null
