#!/usr/bin/env bash
# Najja Editor — installer otomatis untuk VPS Ubuntu/Debian.
#
# Dari folder hasil ekstrak zip:   sudo bash deploy/install.sh editor.domainkamu.com
# Langsung dari GitHub:            curl -fsSL https://raw.githubusercontent.com/otongrusdiana2021-sudo/najja-editor/main/deploy/install.sh | sudo bash -s editor.domainkamu.com
#
# Cek dulu tanpa mengubah apa pun:  ... | sudo bash -s editor.domainkamu.com --cek
# Ganti token login:                ... | sudo bash -s editor.domainkamu.com --token-baru
#
# Yang dilakukan: pasang Docker (jika belum), buat token login, jalankan Najja.
# Port 80/443 kosong → Najja + Caddy (HTTPS otomatis).
# Port 80/443 dipakai web server lain (aaPanel/nginx/apache) → Najja hanya di port lokal,
# website lain tidak diubah.
set -euo pipefail

CHECK=0
NEW_TOKEN=0
DOMAIN="${DOMAIN:-}"
for arg in "$@"; do
  case "$arg" in
    --cek|--check|--dry-run) CHECK=1 ;;
    --token-baru|--new-token) NEW_TOKEN=1 ;;
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

if [ -z "$DOMAIN" ] && [ -t 0 ]; then read -rp "Domain untuk editor (mis. editor.domainkamu.com): " DOMAIN; fi
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
  info "Akan dibuat  : folder $INSTALL_DIR + container Docker 'najja' (maks. RAM 512 MB)"
  bold "Kalau sudah oke, jalankan perintah yang sama tanpa --cek."
  exit 0
fi

bold "✦ Memasang Najja Editor untuk https://$DOMAIN"

# 1. Kode aplikasi
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo /nonexistent)"
if [ -f "$SCRIPT_DIR/../docker-compose.yml" ]; then
  APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
elif [ -f "$INSTALL_DIR/docker-compose.yml" ] && [ -z "$REPO_URL" ]; then
  APP_DIR="$INSTALL_DIR"
else
  [ -n "$REPO_URL" ] || die "Kode Najja tidak ditemukan. Jalankan dari folder hasil ekstrak zip, atau set NAJJA_REPO_URL."
  command -v git >/dev/null || { apt-get update -qq && apt-get install -y -qq --no-remove git; }
  if [ -d "$INSTALL_DIR/.git" ]; then info "Memperbarui kode di $INSTALL_DIR"; git -C "$INSTALL_DIR" pull --ff-only -q
  else info "Mengunduh kode ke $INSTALL_DIR"; git clone -q --depth 1 "$REPO_URL" "$INSTALL_DIR"; fi
  APP_DIR="$INSTALL_DIR"
fi
cd "$APP_DIR"
info "Folder aplikasi: $APP_DIR"

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
[ -f .env ] && TOKEN="$(sed -n 's/^NAJJA_TOKEN=//p' .env | head -1)"
[ -f .env ] && OLD_LPORT="$(sed -n 's/^NAJJA_LOCAL_PORT=//p' .env | head -1)"
if [ -z "$TOKEN" ] || [ "$NEW_TOKEN" = 1 ]; then
  TOKEN="$(openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  if [ "$NEW_TOKEN" = 1 ]; then info "Token login BARU dibuat — token lama tidak berlaku lagi, semua perangkat perlu login ulang"
  else info "Token login baru dibuat"; fi
fi
umask 077
printf 'DOMAIN=%s\nNAJJA_TOKEN=%s\n' "$DOMAIN" "$TOKEN" > .env
[ -n "$OLD_LPORT" ] && printf 'NAJJA_LOCAL_PORT=%s\n' "$OLD_LPORT" >> .env
umask 022

# 7. Jalankan
pull_mirror() {
  # Docker Hub sering membatasi unduhan anonim dari IP VPS bersama (HTTP 429). Ambil image yang sama dari mirror Google.
  warn "Gagal mengunduh image dari Docker Hub. Mencoba mirror.gcr.io…"
  for img in "$@"; do docker pull -q "mirror.gcr.io/library/$img" >/dev/null && docker tag "mirror.gcr.io/library/$img" "$img"; done
}
info "Membangun dan menjalankan container (1–3 menit)…"
if [ "$MODE" = caddy ]; then
  if ! docker compose up -d --build; then
    pull_mirror node:22-alpine caddy:2
    docker compose up -d --build || die "Gagal menjalankan container. Cek pesan di atas."
  fi
else
  docker compose down --remove-orphans >/dev/null 2>&1 || true
  LPORT="$(sed -n 's/^NAJJA_LOCAL_PORT=//p' .env 2>/dev/null | head -1)"
  LPORT="${LPORT:-3333}"
  LPORT="$(free_port "$LPORT")"
  sed -i '/^NAJJA_LOCAL_PORT=/d' .env
  printf 'NAJJA_LOCAL_PORT=%s\n' "$LPORT" >> .env
  COMPOSE=(docker compose -f docker-compose.yml -f deploy/compose.proxy.yml)
  if ! "${COMPOSE[@]}" up -d --build najja; then
    pull_mirror node:22-alpine
    "${COMPOSE[@]}" up -d --build najja || die "Gagal menjalankan container. Cek pesan di atas."
  fi
  info "Najja berjalan di http://127.0.0.1:$LPORT (hanya lokal)"
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

echo
bold "──────────────────────────────────────────────────────"
bold " ✦ Najja Editor terpasang"
bold "──────────────────────────────────────────────────────"
echo "  Editor     : https://$DOMAIN"
echo "  Token login: $TOKEN"
echo "  MCP        : https://$DOMAIN/mcp"
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
echo "  Token tersimpan di $APP_DIR/.env (lihat lagi: sudo cat $APP_DIR/.env)"
bold "──────────────────────────────────────────────────────"
