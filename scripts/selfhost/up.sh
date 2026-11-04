#!/usr/bin/env bash
# Starts the self-hosted game behind a Cloudflare quick tunnel (Linux, macOS or WSL).
# Same steps as up.ps1: optional update/rebuild, migrations, background cloudflared, .env with the tunnel origin,
# server (re)start, readiness wait. Stop with scripts/selfhost/down.sh. See docs/ops/self-host-tunnel.md.
#
# Usage: scripts/selfhost/up.sh [--staging] [--update]
set -euo pipefail

staging=0
update=0
for arg in "$@"; do
  case "$arg" in
    --staging) staging=1 ;;
    --update) update=1 ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
state_dir="$root/.selfhost"
log="$state_dir/cloudflared.log"
pid_file="$state_dir/cloudflared.pid"
mkdir -p "$state_dir"

for tool in docker cloudflared curl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool is not installed or not on PATH (see docs/ops/self-host-tunnel.md)" >&2; exit 1; }
done

compose_files=(-f compose.yaml)
if [ "$staging" -eq 1 ]; then compose_files+=(-f compose.staging.yaml); fi

if [ "$update" -eq 1 ]; then git pull --ff-only; fi
if [ "$update" -eq 1 ] || [ -z "$(docker image ls -q idle-rpg-server:local)" ]; then
  docker compose build server
fi
docker compose up -d db
docker compose --profile ops run --rm migrate

# Stop a tunnel left over from a previous run (its URL is dead once it stops anyway).
if [ -f "$pid_file" ]; then
  kill "$(cat "$pid_file")" 2>/dev/null || true
  rm -f "$pid_file"
fi
rm -f "$log"

echo "Starting the Cloudflare quick tunnel..."
nohup cloudflared tunnel --no-autoupdate --url http://127.0.0.1:3000 >"$log" 2>&1 &
tunnel_pid=$!
echo "$tunnel_pid" >"$pid_file"

url=""
for _ in $(seq 1 120); do
  sleep 0.5
  kill -0 "$tunnel_pid" 2>/dev/null || { echo "cloudflared exited early; see $log" >&2; exit 1; }
  url="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$log" | head -n 1 || true)"
  [ -n "$url" ] && break
done
[ -n "$url" ] || { echo "No tunnel URL after 60 s; see $log" >&2; exit 1; }

# Keep any other settings in .env and replace only the two tunnel keys.
env_file="$root/.env"
tmp="$(mktemp)"
if [ -f "$env_file" ]; then grep -vE '^(TRUST_PROXY|ALLOWED_ORIGINS)=' "$env_file" >"$tmp" || true; fi
{ echo "TRUST_PROXY=loopback,uniquelocal"; echo "ALLOWED_ORIGINS=$url"; } >>"$tmp"
mv "$tmp" "$env_file"

docker compose "${compose_files[@]}" up -d server

echo "Waiting for the server to be ready..."
ready=0
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null --max-time 3 http://127.0.0.1:3000/health/ready; then ready=1; break; fi
  sleep 2
done
[ "$ready" -eq 1 ] || { echo "Server not ready after 120 s; check: docker compose logs server" >&2; exit 1; }

echo
echo "Ready. Open on the phone: $url"
if [ "$staging" -eq 1 ]; then echo "Staging mode: the debug panel is enabled. Keep the URL private."; fi
echo "The URL changes every time the tunnel restarts (a new URL means a new guest account on the phone)."
echo "Stop everything with: scripts/selfhost/down.sh"
