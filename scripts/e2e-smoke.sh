#!/usr/bin/env bash

# End-to-end smoke test. Starts the dev backend, hits every key endpoint,
# verifies responses, then shuts down. Exits non-zero on any failure.
#
# Usage: ./scripts/e2e-smoke.sh
#
# Requires: node, curl. Does not require a Canton participant (uses
# InMemoryLedger).

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-18080}"
BASE="http://localhost:${PORT}"

cleanup() {
  if [[ -n "${BACKEND_PID:-}" ]]; then
    kill "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "==> Starting dev backend on :$PORT"
(
  cd "$ROOT_DIR/services/operator-backend"
  PORT="$PORT" npm run dev >/tmp/e2e-smoke-backend.log 2>&1 &
  echo $! > /tmp/e2e-smoke-backend.pid
)
BACKEND_PID="$(cat /tmp/e2e-smoke-backend.pid)"

# Wait for the server to come up.
for i in {1..30}; do
  if curl -fsS "${BASE}/v1/status" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    echo "backend died during startup; log:"
    cat /tmp/e2e-smoke-backend.log
    exit 1
  fi
  sleep 0.5
done

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

echo "==> Read endpoints"
check_get_contains status "${BASE}/v1/status" '"synced":true'
check_get_contains context "${BASE}/v1/context" '"operator"'
check_get_contains pools "${BASE}/v1/pools" 'BTC'
check_get_contains pairs "${BASE}/v1/pairs" 'BTC'
check_status orders-400 400 "${BASE}/v1/orders"
check_get_contains orders "${BASE}/v1/orders?trader=trader-demo" '['
check_get_contains holdings "${BASE}/v1/holdings?owner=trader-demo" 'USDC'

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
  "{\"poolId\":\"${POOL_ID}\",\"inputInstrumentId\":\"BTC\",\"inputAmount\":\"0.1\"}" \
  'outputAmount'

echo "==> Order book"
check_get_contains book "${BASE}/v1/orders/book?base=BTC&quote=USDC" 'bids'

echo "==> Prices"
check_get_contains prices "${BASE}/v1/prices?pairs=BTC/USDC" 'prices'

echo "==> Admin auth gate"
check_status admin-401 401 -X POST -H 'Content-Type: application/json' -d '{}' \
  "${BASE}/v1/admin/pairs"

echo "==> All smoke checks passed"
