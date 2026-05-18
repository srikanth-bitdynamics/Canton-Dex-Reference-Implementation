#!/usr/bin/env bash

# Canton testnet deployment.
#
# Steps:
#   1. Build all DARs from source.
#   2. Upload DARs to the target Canton participant via JSON Ledger API.
#   3. Allocate parties (operator, lpRegistrar, admin, demo trader).
#   4. Run the registry bootstrap script (scripts/bootstrap-registry.ts).
#   5. Seed initial pairs and pools via the operator backend admin API.
#   6. Health check.
#
# Required env vars (see services/operator-backend/.env.example):
#   CANTON_LEDGER_URL, CANTON_LEDGER_TOKEN
#   CANTON_OPERATOR, CANTON_LP_REGISTRAR, CANTON_ADMIN
#   OPERATOR_ADMIN_TOKEN (for admin API calls)
#
# Optional:
#   DEPLOY_SKIP_BUILD=1   skip `daml build` (use existing DARs)
#   DEPLOY_SKIP_UPLOAD=1  skip DAR upload (already uploaded)
#   DEPLOY_SKIP_PARTIES=1 skip party allocation (already exist)
#   DEPLOY_SKIP_SEED=1    skip initial pair/pool seeding

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

require() {
  if [[ -z "${!1:-}" ]]; then
    echo "[deploy-testnet] missing required env var: $1" >&2
    exit 1
  fi
}

require CANTON_LEDGER_URL
require CANTON_LEDGER_TOKEN
require CANTON_OPERATOR
require CANTON_LP_REGISTRAR
require CANTON_ADMIN

AUTH="Authorization: Bearer ${CANTON_LEDGER_TOKEN}"

# 1. Build DARs ----------------------------------------------------------

if [[ "${DEPLOY_SKIP_BUILD:-0}" != "1" ]]; then
  echo "==> Building DARs"
  (cd "$ROOT_DIR" && daml build)
  echo "==> Building edge-case test DARs"
  (cd "$ROOT_DIR/trading-tests" && daml build) || true
else
  echo "==> Skipping DAR build (DEPLOY_SKIP_BUILD=1)"
fi

# 2. Upload DARs ---------------------------------------------------------

upload_dar() {
  local dar="$1"
  echo "  uploading: $dar"
  curl -fsS -X POST \
    -H "$AUTH" \
    -H "Content-Type: application/octet-stream" \
    --data-binary "@$dar" \
    "${CANTON_LEDGER_URL}/v2/packages" >/dev/null
}

if [[ "${DEPLOY_SKIP_UPLOAD:-0}" != "1" ]]; then
  echo "==> Uploading DARs to $CANTON_LEDGER_URL"
  for dar in "$ROOT_DIR"/.daml/dist/*.dar; do
    [[ -f "$dar" ]] && upload_dar "$dar"
  done
else
  echo "==> Skipping DAR upload (DEPLOY_SKIP_UPLOAD=1)"
fi

# 3. Allocate parties ----------------------------------------------------

allocate_party() {
  local hint="$1"
  echo "  allocating party hint=$hint"
  curl -fsS -X POST \
    -H "$AUTH" \
    -H "Content-Type: application/json" \
    -d "{\"partyIdHint\":\"$hint\"}" \
    "${CANTON_LEDGER_URL}/v2/parties" >/dev/null || true
}

if [[ "${DEPLOY_SKIP_PARTIES:-0}" != "1" ]]; then
  echo "==> Allocating parties (idempotent; existing parties are no-op)"
  allocate_party "$CANTON_OPERATOR"
  allocate_party "$CANTON_LP_REGISTRAR"
  allocate_party "$CANTON_ADMIN"
  allocate_party "trader-demo"
else
  echo "==> Skipping party allocation (DEPLOY_SKIP_PARTIES=1)"
fi

# 4. Registry bootstrap --------------------------------------------------

echo "==> Running registry bootstrap"
(cd "$ROOT_DIR" && node --import tsx scripts/bootstrap-registry.ts)

# 5. Seed initial pair/pool ---------------------------------------------

if [[ "${DEPLOY_SKIP_SEED:-0}" != "1" && -n "${OPERATOR_ADMIN_TOKEN:-}" ]]; then
  echo "==> Seeding BTC/USDC pair (via operator admin API)"
  API_BASE="${API_BASE:-http://localhost:8080}"
  curl -fsS -X POST \
    -H "Authorization: Bearer ${OPERATOR_ADMIN_TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{"baseInstrumentId":"BTC","quoteInstrumentId":"USDC","feeModel":{"makerFeeBps":10,"takerFeeBps":30,"poolFeeBps":30},"tradingMode":"TM_Both"}' \
    "${API_BASE}/v1/admin/pairs" || echo "  (pair may already exist; continuing)"
else
  echo "==> Skipping initial pair/pool seed"
fi

# 6. Health check --------------------------------------------------------

echo "==> Health check"
API_BASE="${API_BASE:-http://localhost:8080}"
if curl -fsS "${API_BASE}/v1/status" >/dev/null 2>&1; then
  echo "  operator backend reachable at ${API_BASE}"
else
  echo "  operator backend not reachable at ${API_BASE} (start it separately)"
fi

echo "==> Deployment complete"
