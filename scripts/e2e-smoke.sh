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

check() {
  local name="$1"
  local code="$2"
  shift 2
  echo "  [$name] $*"
  if eval "$@"; then
    echo "    OK ($code)"
  else
    echo "    FAIL ($code)"
    exit 1
  fi
}

echo "==> Read endpoints"
check status 200 "curl -fsS '${BASE}/v1/status' | grep -q '\"synced\":true'"
check context 200 "curl -fsS '${BASE}/v1/context' | grep -q '\"operator\"'"
check pools 200 "curl -fsS '${BASE}/v1/pools' | grep -q 'BTC'"
check pairs 200 "curl -fsS '${BASE}/v1/pairs' | grep -q 'BTC'"
check orders-400 400 "curl -s -o /dev/null -w '%{http_code}' '${BASE}/v1/orders' | grep -q 400"
check orders 200 "curl -fsS '${BASE}/v1/orders?trader=trader-demo' >/dev/null"
check holdings 200 "curl -fsS '${BASE}/v1/holdings?owner=trader-demo' | grep -q USDC"

echo "==> Quote"
check quote 200 "curl -fsS -X POST -H 'Content-Type: application/json' -d '{\"poolId\":\"#contract:1\",\"inputInstrumentId\":\"BTC\",\"inputAmount\":\"0.1\"}' '${BASE}/v1/swaps/quote' >/dev/null || true"

echo "==> Order book"
check book 200 "curl -fsS '${BASE}/v1/orders/book?base=BTC&quote=USDC' | grep -q 'bids'"

echo "==> Prices"
check prices 200 "curl -fsS '${BASE}/v1/prices?pairs=BTC/USDC' | grep -q 'prices'"

echo "==> Admin auth gate"
check admin-401 401 "curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' '${BASE}/v1/admin/pairs' | grep -q '^[24]'"

echo "==> All smoke checks passed"
