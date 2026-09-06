#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$root"

signaling_bind_addr="${SIGNALING_BIND_ADDR:-127.0.0.1:8787}"
signaling_health_url="${SIGNALING_HEALTH_URL:-http://127.0.0.1:8787/health}"
demo_bind_addr="${DEMO_BIND_ADDR:-127.0.0.1}"
demo_port="${DEMO_PORT:-5173}"

cleanup() {
  if [[ -n "${service_pid:-}" ]]; then
    kill "$service_pid" 2>/dev/null || true
    wait "$service_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

BIND_ADDR="$signaling_bind_addr" cargo run --locked &
service_pid=$!

SIGNALING_HEALTH_URL="$signaling_health_url" python3 - <<'PY'
import os
import time
from urllib.error import URLError
from urllib.request import urlopen

health_url = os.environ["SIGNALING_HEALTH_URL"]
for _ in range(120):
    try:
        with urlopen(health_url, timeout=0.2) as response:
            if response.status == 200:
                break
    except (URLError, TimeoutError):
        time.sleep(0.25)
else:
    raise SystemExit(f"signaling service did not become ready at {health_url}")
PY

printf 'Local multiplayer demos: http://%s:%s/\n' "$demo_bind_addr" "$demo_port"
if [[ "$demo_bind_addr" != "127.0.0.1" && "$demo_bind_addr" != "localhost" ]]; then
  printf '%s\n' 'For other devices, open the demo host address and append ?api=http://<host>:8787.'
fi
python3 -m http.server "$demo_port" --bind "$demo_bind_addr" --directory web
