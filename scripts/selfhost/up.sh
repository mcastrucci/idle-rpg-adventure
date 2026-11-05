#!/usr/bin/env bash
# Starts the self-hosted game behind a Cloudflare tunnel (Linux, macOS or WSL).
# Without --hostname: a quick tunnel (random URL). With --hostname: a named tunnel on your own domain (stable URL).
# Same steps as up.ps1: optional update/rebuild, migrations, background cloudflared, .env with the tunnel origin,
# server (re)start, readiness wait. Stop with scripts/selfhost/down.sh. See docs/ops/self-host-tunnel.md.
#
# Usage: scripts/selfhost/up.sh [--staging] [--update] [--hostname game.example.com [--tunnel-name idle-rpg]]
set -euo pipefail

staging=0
update=0
hostname=""
tunnel_name=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --staging) staging=1 ;;
    --update) update=1 ;;
    --hostname) [ "$#" -ge 2 ] || { echo "--hostname needs a value" >&2; exit 2; }; hostname="$2"; shift ;;
    --hostname=*) hostname="${1#--hostname=}" ;;
    --tunnel-name) [ "$#" -ge 2 ] || { echo "--tunnel-name needs a value" >&2; exit 2; }; tunnel_name="$2"; shift ;;
    --tunnel-name=*) tunnel_name="${1#--tunnel-name=}" ;;
    -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
if [ -n "$hostname" ]; then
  [ -n "$tunnel_name" ] || tunnel_name="idle-rpg"
  case "$hostname" in
    *[!A-Za-z0-9.-]*|.*|*.) echo "invalid --hostname: $hostname (expected a bare name such as game.example.com)" >&2; exit 2 ;;
  esac
  case "$tunnel_name" in
    *[!A-Za-z0-9._-]*) echo "invalid --tunnel-name: $tunnel_name" >&2; exit 2 ;;
  esac
elif [ -n "$tunnel_name" ]; then
  echo "--tunnel-name only makes sense together with --hostname" >&2; exit 2
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
state_dir="$root/.selfhost"
log="$state_dir/cloudflared.log"
pid_file="$state_dir/cloudflared.pid"
mkdir -p "$state_dir"

for tool in docker cloudflared curl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool is not installed or not on PATH (see docs/ops/self-host-tunnel.md)" >&2; exit 1; }
done

# Named tunnel: resolve the tunnel and its credentials file before touching Docker, so a missing one-time setup fails fast.
named_config="$state_dir/cloudflared-named.yml"
if [ -n "$hostname" ]; then
  setup_hint="Run the one-time setup first (docs/ops/self-host-tunnel.md): cloudflared tunnel login; cloudflared tunnel create $tunnel_name; cloudflared tunnel route dns $tunnel_name $hostname"
  tunnel_json="$(cloudflared tunnel list --output json 2>/dev/null || true)"
  # One JSON object per line, then pick the one whose name matches exactly and read its id (no jq needed).
  tunnel_id="$(printf '%s' "$tunnel_json" | tr '{' '\n' \
    | grep -E "\"name\"[[:space:]]*:[[:space:]]*\"$tunnel_name\"" \
    | sed -nE 's/.*"id"[[:space:]]*:[[:space:]]*"([0-9a-fA-F-]+)".*/\1/p' | head -n 1 || true)"
  [ -n "$tunnel_id" ] || { echo "Cloudflare tunnel '$tunnel_name' not found. $setup_hint" >&2; exit 1; }
  credentials_file="$HOME/.cloudflared/$tunnel_id.json"
  [ -f "$credentials_file" ] || { echo "Credentials file $credentials_file not found for tunnel '$tunnel_name'. $setup_hint" >&2; exit 1; }
  # A dedicated config: the global ~/.cloudflared/config.yml is never read or modified.
  cat >"$named_config" <<EOF
tunnel: $tunnel_name
credentials-file: $credentials_file
ingress:
  - hostname: $hostname
    service: http://127.0.0.1:3000
  - service: http_status:404
EOF
fi

compose_files=(-f compose.yaml)
if [ "$staging" -eq 1 ]; then compose_files+=(-f compose.staging.yaml); fi

if [ "$update" -eq 1 ]; then git pull --ff-only; fi
if [ "$update" -eq 1 ] || [ -z "$(docker image ls -q idle-rpg-server:local)" ]; then
  docker compose build server
fi
docker compose up -d db
docker compose --profile ops run --rm migrate

# Stop a tunnel left over from a previous run.
if [ -f "$pid_file" ]; then
  kill "$(cat "$pid_file")" 2>/dev/null || true
  rm -f "$pid_file"
fi
rm -f "$log"

if [ -n "$hostname" ]; then
  echo "Starting the Cloudflare named tunnel '$tunnel_name' for $hostname..."
  nohup cloudflared tunnel --no-autoupdate --config "$named_config" run "$tunnel_name" >"$log" 2>&1 &
  tunnel_pid=$!
  echo "$tunnel_pid" >"$pid_file"
  sleep 1
  kill -0 "$tunnel_pid" 2>/dev/null || { echo "cloudflared exited early; see $log" >&2; exit 1; }
  url="https://$hostname"
else
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
fi

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

if [ -n "$hostname" ]; then
  echo "Checking the public URL (DNS can lag behind a new route)..."
  public_ok=0
  for _ in $(seq 1 30); do
    if curl -fsS -o /dev/null --max-time 3 "$url/health/ready"; then public_ok=1; break; fi
    sleep 2
  done
  [ "$public_ok" -eq 1 ] || echo "WARNING: $url/health/ready did not answer within 60 s. DNS or the tunnel may still be settling; check $log" >&2
fi

echo
echo "Ready. Open on the phone: $url"
if [ "$staging" -eq 1 ]; then echo "Staging mode: the debug panel is enabled. Keep the URL private."; fi
if [ -n "$hostname" ]; then
  echo "Stable URL: it does not change on restart, so saved progress (guest account) persists."
else
  echo "The URL changes every time the tunnel restarts (a new URL means a new guest account on the phone)."
fi
echo "Stop everything with: scripts/selfhost/down.sh"
