#!/usr/bin/env bash
# Stops the Cloudflare quick tunnel and the game server started by up.sh. The database and its data are kept.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
pid_file="$root/.selfhost/cloudflared.pid"

if [ -f "$pid_file" ]; then
  kill "$(cat "$pid_file")" 2>/dev/null || true
  rm -f "$pid_file"
  echo "Tunnel stopped."
else
  echo "No tunnel started by up.sh is running."
fi
docker compose stop server
echo "Server stopped. The database keeps running; stop it with: docker compose stop db"
