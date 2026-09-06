#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$root"

cleanup() {
  if [[ -n "${service_pid:-}" ]]; then
    kill "$service_pid" 2>/dev/null || true
    wait "$service_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

cargo run --locked &
service_pid=$!

python3 - <<'PY'
import time
from urllib.error import URLError
from urllib.request import urlopen

for _ in range(120):
    try:
        with urlopen("http://127.0.0.1:8787/health", timeout=0.2) as response:
            if response.status == 200:
                break
    except (URLError, TimeoutError):
        time.sleep(0.25)
else:
    raise SystemExit("signaling service did not become ready")
PY

printf '%s\n' 'Local multiplayer demos: http://127.0.0.1:5173/'
python3 -m http.server 5173 --bind 127.0.0.1 --directory web
