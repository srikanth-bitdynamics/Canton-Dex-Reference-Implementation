#!/usr/bin/env bash

# Backend HTTP smoke test. Starts the in-memory dev backend, checks a selected
# set of read/quote endpoints plus the admin auth gate, then shuts down.
# Exits non-zero on any failure.
#
# Usage: bash scripts/backend-http-smoke.sh
#
# Requires: bash, node, npm, curl, grep, and `npm ci` already run in
# services/operator-backend. Does not require a Canton participant or dApp.
# This is not a wallet, settlement, or full-stack browser test.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-18080}"
BASE="http://localhost:${PORT}"
SMOKE_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/canton-dex-http-smoke.XXXXXX")"
BACKEND_LOG="$SMOKE_TMP_DIR/backend.log"

cleanup() {
  local status=$?
  if [[ -n "${BACKEND_PID:-}" ]]; then
    kill "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
  fi
  if [[ "$status" -eq 0 ]]; then
    rm -rf "$SMOKE_TMP_DIR"
  else
    echo "backend log retained at: $BACKEND_LOG" >&2
  fi
  return "$status"
}
trap cleanup EXIT

if curl -fsS "${BASE}/v1/status" >/dev/null 2>&1; then
  echo "refusing to run: ${BASE} is already serving /v1/status; choose another PORT" >&2
  exit 1
fi

echo "==> Starting dev backend on :$PORT"
(
  cd "$ROOT_DIR/services/operator-backend"
  PORT="$PORT" exec npm run dev
) >"$BACKEND_LOG" 2>&1 &
BACKEND_PID="$!"

# Wait for the server to come up.
READY=0
for i in {1..30}; do
  if curl -fsS "${BASE}/v1/status" >/dev/null 2>&1; then
    READY=1
    break
  fi
  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    echo "backend died during startup; log:"
    cat "$BACKEND_LOG"
    exit 1
  fi
  sleep 0.5
done
if [[ "$READY" != "1" ]]; then
  echo "backend did not become ready within 15 seconds; log:"
  cat "$BACKEND_LOG"
  exit 1
fi

check_get_contains() {
  local name="$1"
  local url="$2"
  local expected="$3"
  echo "  [$name] GET $url"
  if curl -fsS "$url" | grep -qF "$expected"; then
    echo "    OK (200)"
  else
    echo "    FAIL (expected 200 containing: $expected)"
    exit 1
  fi
}

check_post_contains() {
  local name="$1"
  local url="$2"
  local body="$3"
  local expected="$4"
  echo "  [$name] POST $url"
  if curl -fsS -X POST -H 'Content-Type: application/json' -d "$body" "$url" \
      | grep -qF "$expected"; then
    echo "    OK (200)"
  else
    echo "    FAIL (expected 200 containing: $expected)"
    exit 1
  fi
}

check_status() {
  local name="$1"
  local expected="$2"
  shift 2
  local actual
  actual="$(curl -sS -o /dev/null -w '%{http_code}' "$@")"
  echo "  [$name] expected $expected, received $actual"
  if [[ "$actual" != "$expected" ]]; then
    exit 1
  fi
}

echo "==> Selected read endpoints"
check_get_contains status-preview "${BASE}/v1/status" '"network":"preview:in-memory"'
check_get_contains status-sync "${BASE}/v1/status" '"synced":true'
check_get_contains context "${BASE}/v1/context" '"operator"'
check_get_contains pools "${BASE}/v1/pools" 'Amulet'
check_get_contains pairs "${BASE}/v1/pairs" 'Amulet'
check_status orders-400 400 "${BASE}/v1/orders"
check_get_contains orders "${BASE}/v1/orders?trader=trader-demo" '['
check_get_contains holdings "${BASE}/v1/holdings?owner=trader-demo" 'USDCx'

echo "==> Quote"
POOL_ID="$(curl -fsS "${BASE}/v1/pools" | node -e '
  let input = "";
  process.stdin.on("data", chunk => input += chunk);
  process.stdin.on("end", () => {
    const poolId = JSON.parse(input)[0]?.poolId;
    if (!poolId) process.exit(1);
    process.stdout.write(poolId);
  });
')"
check_post_contains quote "${BASE}/v1/swaps/quote" \
  "{\"poolId\":\"${POOL_ID}\",\"inputInstrumentId\":\"Amulet\",\"inputAmount\":\"0.1\"}" \
  'outputAmount'

echo "==> Order book"
check_get_contains book "${BASE}/v1/orders/book?base=Amulet&quote=USDCx" 'bids'

echo "==> Prices"
check_get_contains prices "${BASE}/v1/prices?pairs=Amulet/USDCx" 'prices'

echo "==> Admin auth gate"
check_status admin-401 401 -X POST -H 'Content-Type: application/json' -d '{}' \
  "${BASE}/v1/admin/pairs"

echo "==> All backend HTTP smoke checks passed"
