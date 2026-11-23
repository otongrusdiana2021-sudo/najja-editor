#!/usr/bin/env bash
# Deploy Najja Editor ke VPS produksi dari Mac ini, satu perintah (seperti deploy/deploy.sh di proyek ecom).
#
#   npm run deploy                 # = ./deploy/deploy-vps.sh najja-vps
#   DRY_RUN=1 npm run deploy       # hanya memeriksa; tidak push, tidak mengubah VPS
#
# Urutan: test lokal → push main ke GitHub (cadangan + CI) → tunggu CI hijau → di VPS: cadangkan image yang jalan,
# git fast-forward, build najja (container lama tetap melayani), ganti container → cek port 127.0.0.1:3333 dan
# /healthz. Gagal → kembali otomatis ke image cadangan. Data (volume Docker) tidak disentuh.
set -euo pipefail
TARGET="${1:-najja-vps}"
REPO="otongrusdiana2021-sudo/najja-editor"
APP_DIR=/opt/najja-editor
DRY="${DRY_RUN:-}"
cd "$(dirname "$0")/.."
say() { printf '\n▶ %s\n' "$*"; }
die() { printf '\n✖ %s\n' "$*" >&2; exit 1; }

say "Memeriksa kode lokal"
[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || die "Pindah ke branch main dulu (sekarang: $(git rev-parse --abbrev-ref HEAD))."
[ -z "$(git status --porcelain)" ] || die "Ada perubahan yang belum di-commit."
git fetch -q origin main
git merge-base --is-ancestor origin/main HEAD || die "main lokal tertinggal dari GitHub: git pull --ff-only dulu."
SHA=$(git rev-parse --short HEAD)
echo "versi yang dipasang: $SHA ($(git log -1 --format=%s | cut -c1-70))"

say "Test lokal"
npm test >/tmp/najja-deploy-test.txt 2>&1 || { grep -E "^✖|^not ok" /tmp/najja-deploy-test.txt | head -20; die "Test gagal; tidak di-deploy."; }
grep -E "^ℹ (pass|fail)" /tmp/najja-deploy-test.txt | tr '\n' ' '; echo

if [ -n "$DRY" ]; then echo "(DRY_RUN: tidak push)"; else
  say "Push ke GitHub (main)"
  git push -q origin HEAD:main
fi

say "Menunggu CI untuk $SHA"
ci=""
for _ in $(seq 1 60); do
  ci=$(curl -s "https://api.github.com/repos/$REPO/actions/runs?head_sha=$(git rev-parse HEAD)" | python3 -c "import json,sys;r=(json.load(sys.stdin).get('workflow_runs') or [None])[0];print('none' if not r else (r['conclusion'] or r['status']))")
  case "$ci" in success) break;; failure|cancelled|timed_out) die "CI $ci untuk $SHA; tidak di-deploy.";; esac
  [ -n "$DRY" ] && [ "$ci" = none ] && break
  sleep 10
done
echo "CI: $ci"
[ "$ci" = success ] || [ -n "$DRY" ] || die "CI belum selesai setelah 10 menit."

say "Deploy di $TARGET"
ssh -o BatchMode=yes "$TARGET" DRY="$DRY" SHA="$SHA" APP_DIR="$APP_DIR" bash -s <<'REMOTE'
set -euo pipefail
cd "$APP_DIR"
[ -z "$(git status --porcelain)" ] || { echo "✖ Ada perubahan lokal di VPS; berhenti."; exit 1; }
grep -q '^COMPOSE_FILE=' .env || { echo "✖ COMPOSE_FILE tidak ada di .env (port 127.0.0.1:3333 akan hilang); berhenti."; exit 1; }
OLD=$(git rev-parse --short HEAD)
echo "VPS: $OLD → $SHA"
if [ -n "$DRY" ]; then
  echo "(DRY_RUN) service: $(docker compose config --services | sort | tr '\n' ' ')"
  docker ps --format '{{.Names}} | {{.Ports}} | {{.Status}}' | grep najja
  exit 0
fi
docker tag najja-editor-najja:latest "najja-editor-najja:backup-$OLD"
git fetch -q origin main && git merge --ff-only -q FETCH_HEAD
[ "$(git rev-parse --short HEAD)" = "$SHA" ] || { echo "✖ VPS tidak sampai ke $SHA"; exit 1; }
docker compose build -q najja
docker compose up -d najja
ok=""
for _ in $(seq 1 30); do
  if docker ps --format '{{.Ports}}' --filter name=najja-editor-najja-1 | grep -q '127.0.0.1:3333->3333' \
     && [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3333/healthz)" = 200 ]; then ok=1; break; fi
  sleep 1
done
if [ -z "$ok" ]; then
  echo "✖ Port/health gagal: kembali ke backup-$OLD"
  docker tag "najja-editor-najja:backup-$OLD" najja-editor-najja:latest
  git checkout -q "$OLD"
  docker compose up -d najja
  exit 1
fi
echo "✔ $SHA berjalan; port $(docker ps --format '{{.Ports}}' --filter name=najja-editor-najja-1); error di log: $(docker compose logs --since 1m najja 2>&1 | grep -ciE 'error|exception|fail')"
REMOTE

say "Cek dari luar"
for p in /healthz /login /.well-known/oauth-authorization-server; do printf '%-42s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' "https://editor.najja.id$p")"; done
echo; echo "Selesai: $SHA"
