#!/usr/bin/env bash
# Najja Editor — installer otomatis untuk VPS Ubuntu/Debian.
#
# Dari folder hasil ekstrak zip:   sudo bash deploy/install.sh editor.domainkamu.com
# Langsung dari GitHub:            curl -fsSL https://raw.githubusercontent.com/otongrusdiana2021-sudo/najja-editor/main/deploy/install.sh | sudo bash -s editor.domainkamu.com
#
# Yang dilakukan: pasang Docker (jika belum), buat token login, buka port 80/443,
# jalankan Najja + Caddy (HTTPS otomatis), lalu tampilkan URL dan token.
set -euo pipefail

DOMAIN="${1:-${DOMAIN:-}}"
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

bold "✦ Memasang Najja Editor untuk https://$DOMAIN"

# 1. Kode aplikasi
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo /nonexistent)"
if [ -f "$SCRIPT_DIR/../docker-compose.yml" ]; then
  APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
elif [ -f "$INSTALL_DIR/docker-compose.yml" ] && [ -z "$REPO_URL" ]; then
  APP_DIR="$INSTALL_DIR"
else
  [ -n "$REPO_URL" ] || die "Kode Najja tidak ditemukan. Jalankan dari folder hasil ekstrak zip, atau set NAJJA_REPO_URL."
  command -v git >/dev/null || { apt-get update -qq && apt-get install -y -qq git; }
  if [ -d "$INSTALL_DIR/.git" ]; then info "Memperbarui kode di $INSTALL_DIR"; git -C "$INSTALL_DIR" pull --ff-only -q
  else info "Mengunduh kode ke $INSTALL_DIR"; git clone -q --depth 1 "$REPO_URL" "$INSTALL_DIR"; fi
  APP_DIR="$INSTALL_DIR"
fi
cd "$APP_DIR"
info "Folder aplikasi: $APP_DIR"

# 2. Docker
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  info "Memasang Docker…"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq docker.io docker-compose-v2 >/dev/null 2>&1 || apt-get install -y -qq docker.io docker-compose-plugin >/dev/null 2>&1 || {
    warn "Paket Docker dari apt tidak tersedia, memakai skrip resmi get.docker.com"
    curl -fsSL https://get.docker.com | sh
  }
fi
command -v systemctl >/dev/null 2>&1 && systemctl enable --now docker >/dev/null 2>&1 || true
docker compose version >/dev/null 2>&1 || die "docker compose tidak tersedia"

# 3. Cek DNS (A record harus mengarah ke VPS ini)
DNS_IP="$( (getent ahostsv4 "$DOMAIN" 2>/dev/null || true) | awk 'NR==1{print $1}')"
LOCAL_IPS=" $(hostname -I 2>/dev/null || true) "
if [ -z "$DNS_IP" ]; then
  warn "Domain $DOMAIN belum punya A record. HTTPS baru aktif setelah A record mengarah ke VPS ini."
elif [[ "$LOCAL_IPS" != *" $DNS_IP "* ]]; then
  warn "A record $DOMAIN → $DNS_IP, sedangkan IP di VPS ini:$LOCAL_IPS"
  warn "Kalau VPS memakai IP publik lain (NAT/Cloudflare proxy), abaikan. Kalau salah, perbaiki A record-nya."
else
  info "DNS OK: $DOMAIN → $DNS_IP"
fi

# 4. Port 80/443 harus bebas (bukan dipakai nginx/apache)
if command -v ss >/dev/null 2>&1; then
  BUSY="$(ss -ltnpH 2>/dev/null | awk '$4 ~ /:(80|443)$/' | grep -v -e docker-proxy -e '"caddy"' || true)"
  [ -z "$BUSY" ] || die "Port 80/443 sedang dipakai program lain:
$BUSY
Hentikan dulu (mis. systemctl disable --now nginx apache2), lalu jalankan ulang skrip ini."
fi

# 5. Firewall
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  info "Membuka port 80 dan 443 di ufw"
  ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw allow 443/udp >/dev/null
fi

# 6. Konfigurasi (.env) — token lama dipertahankan saat install ulang
TOKEN=""
[ -f .env ] && TOKEN="$(sed -n 's/^NAJJA_TOKEN=//p' .env | head -1)"
if [ -z "$TOKEN" ]; then
  TOKEN="$(openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  info "Token login baru dibuat"
fi
umask 077
printf 'DOMAIN=%s\nNAJJA_TOKEN=%s\n' "$DOMAIN" "$TOKEN" > .env
umask 022

# 7. Jalankan
info "Membangun dan menjalankan container (1–3 menit)…"
if ! docker compose up -d --build; then
  # Docker Hub sering membatasi unduhan anonim dari IP VPS bersama (HTTP 429). Ambil image yang sama dari mirror Google.
  warn "Gagal mengunduh image dari Docker Hub. Mencoba mirror.gcr.io…"
  for img in node:22-alpine caddy:2; do
    docker pull -q "mirror.gcr.io/library/$img" >/dev/null && docker tag "mirror.gcr.io/library/$img" "$img"
  done
  docker compose up -d --build || die "Gagal menjalankan container. Cek pesan di atas."
fi

# 8. Tunggu HTTPS siap
info "Menunggu sertifikat HTTPS dari Let's Encrypt…"
READY=0
for _ in $(seq 1 "$WAIT_TRIES"); do
  if curl -fsS -o /dev/null --max-time 6 "https://$DOMAIN/login" 2>/dev/null; then READY=1; break; fi
  sleep 3
done

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
else
  warn "HTTPS belum bisa dicek. Biasanya karena A record belum mengarah ke VPS ini atau port 80/443 diblokir provider."
  warn "Setelah DNS benar, Caddy mencoba lagi otomatis. Cek log: cd $APP_DIR && docker compose logs caddy"
fi
echo "  Token tersimpan di $APP_DIR/.env (lihat lagi: sudo cat $APP_DIR/.env)"
bold "──────────────────────────────────────────────────────"
