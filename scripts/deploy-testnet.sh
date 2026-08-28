#!/usr/bin/env bash

# Deterministic Canton testnet deployment.
#
# Default phases:
#   1. Build the DEX DARs.
#   2. Upload the current DEX DAR and its embedded dependency closure.
#   3. Bootstrap Registry.V2 contracts and instrument configuration.
#
# Optional market metadata phase (DEPLOY_SEED_MARKETS=1):
#   4. Through an ALREADY-RUNNING operator backend, create a DexPair and an
#      unfunded Pool when they do not already exist.
#
# Deliberate boundaries:
#   - This script does not allocate parties. CANTON_* party values must be the
#     exact allocated party ids, and the ledger JWT must have their rights.
#   - Creating a Pool does not fund it. Use seed-testnet-pool.ts or a wallet LP
#     flow after this script.
#   - A successful or partially failed run mutates the target ledger. Run only
#     against the intended participant and inspect the printed phase boundary.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  printf '%s\n' \
    "Usage: bash scripts/deploy-testnet.sh" \
    "" \
    "Required:" \
    "  CANTON_LEDGER_URL CANTON_LEDGER_TOKEN" \
    "  CANTON_OPERATOR CANTON_LP_REGISTRAR CANTON_ADMIN" \
    "  CANTON_DEX_PACKAGE_ID" \
    "" \
    "Optional phase flags:" \
    "  DEPLOY_SKIP_BUILD=1       use existing DARs" \
    "  DEPLOY_SKIP_UPLOAD=1      packages are already uploaded/vetted" \
    "  DEPLOY_SKIP_BOOTSTRAP=1   registry already exists" \
    "  DEPLOY_SEED_MARKETS=1     create pair + unfunded pool via API" \
    "" \
    "Market phase variables:" \
    "  API_BASE (default http://localhost:8080)" \
    "  OPERATOR_ADMIN_TOKEN" \
    "  DEPLOY_BASE (default BTC), DEPLOY_QUOTE (default USDC)" \
    "  DEPLOY_LP_INSTRUMENT (default BTC-USDC-LP)" \
    "  DEPLOY_POOL_FEE_BPS (default 30)"
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi
if [[ "$#" -ne 0 ]]; then
  usage >&2
  exit 2
fi

require() {
  if [[ -z "${!1:-}" ]]; then
    printf '[deploy-testnet] missing required env var: %s\n' "$1" >&2
    exit 2
  fi
}

for required_var in \
  CANTON_LEDGER_URL CANTON_LEDGER_TOKEN \
  CANTON_OPERATOR CANTON_LP_REGISTRAR CANTON_ADMIN \
  CANTON_DEX_PACKAGE_ID; do
  require "$required_var"
done

AUTH="Authorization: Bearer ${CANTON_LEDGER_TOKEN}"

if [[ "${DEPLOY_SKIP_BUILD:-0}" != "1" ]]; then
  printf '%s\n' '==> [1/4] Building DEX DARs'
  bash "$ROOT_DIR/scripts/build-trading-surface.sh"
else
  printf '%s\n' '==> [1/4] Build skipped (DEPLOY_SKIP_BUILD=1)'
fi

upload_dar() {
  local dar="$1"
  printf '  upload %s\n' "${dar#"$ROOT_DIR"/}"
  curl -fsS -X POST \
    -H "$AUTH" \
    -H "Content-Type: application/octet-stream" \
    --data-binary "@$dar" \
    "${CANTON_LEDGER_URL%/}/v2/packages" >/dev/null
}

if [[ "${DEPLOY_SKIP_UPLOAD:-0}" != "1" ]]; then
  printf '%s\n' '==> [2/4] Uploading package closure'
  # A DAR already contains its transitive DALF dependency closure. Select the
  # exact name/version declared in daml.yaml: globbing dist/*.dar can pick up
  # stale builds whose old dependency hashes share a package name/version and
  # Canton correctly rejects that ambiguous package-vetting request.
  read -r dex_name dex_version < <(node -e '
    const fs = require("node:fs");
    const yaml = fs.readFileSync(process.argv[1], "utf8");
    const field = (name) => yaml.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1]?.trim();
    const packageName = field("name");
    const version = field("version");
    if (!packageName || !version) process.exit(1);
    process.stdout.write(`${packageName} ${version}\n`);
  ' "$ROOT_DIR/trading/daml.yaml")
  dex_dar="$ROOT_DIR/trading/.daml/dist/${dex_name}-${dex_version}.dar"
  if [[ ! -f "$dex_dar" ]]; then
    printf '[deploy-testnet] expected current DAR not found: %s\n' "$dex_dar" >&2
    printf '%s\n' '[deploy-testnet] run without DEPLOY_SKIP_BUILD to create it' >&2
    exit 1
  fi
  upload_dar "$dex_dar"
  printf '%s\n' '  uploaded 1 DAR (including its Token Standard dependency closure)'
else
  printf '%s\n' '==> [2/4] Upload skipped (DEPLOY_SKIP_UPLOAD=1)'
fi

if [[ "${DEPLOY_SKIP_BOOTSTRAP:-0}" != "1" ]]; then
  printf '%s\n' '==> [3/4] Bootstrapping Registry.V2 contracts'
  # tsx is a backend dependency; running from this directory makes a clean
  # clone work without a nonexistent root node_modules. Install the locked
  # dependency tree only when it is not already present.
  if [[ ! -x "$ROOT_DIR/services/operator-backend/node_modules/.bin/tsx" ]]; then
    (cd "$ROOT_DIR/services/operator-backend" && npm ci)
  fi
  (cd "$ROOT_DIR/services/operator-backend" && \
    node --import tsx ../../scripts/bootstrap-registry.ts)
else
  printf '%s\n' '==> [3/4] Bootstrap skipped (DEPLOY_SKIP_BOOTSTRAP=1)'
fi

if [[ "${DEPLOY_SEED_MARKETS:-0}" == "1" ]]; then
  require OPERATOR_ADMIN_TOKEN
  API_BASE="${API_BASE:-http://localhost:8080}"
  BASE="${DEPLOY_BASE:-BTC}"
  QUOTE="${DEPLOY_QUOTE:-USDC}"
  LP_INSTRUMENT="${DEPLOY_LP_INSTRUMENT:-${BASE}-${QUOTE}-LP}"
  POOL_FEE_BPS="${DEPLOY_POOL_FEE_BPS:-30}"

  printf '%s\n' '==> [4/4] Creating pair and unfunded pool through operator API'
  # This is a precondition, not an informational health check: market seeding
  # cannot work until the fail-closed backend is running.
  curl -fsS "${API_BASE%/}/v1/status" >/dev/null

  pairs_json="$(curl -fsS "${API_BASE%/}/v1/pairs")"
  pair_exists="$(PAIRS_JSON="$pairs_json" BASE="$BASE" QUOTE="$QUOTE" node -e '
    const rows = JSON.parse(process.env.PAIRS_JSON || "[]");
    process.stdout.write(rows.some((p) => p.baseInstrumentId === process.env.BASE && p.quoteInstrumentId === process.env.QUOTE) ? "1" : "0");
  ')"
  if [[ "$pair_exists" == "0" ]]; then
    pair_payload="$(CANTON_ADMIN="$CANTON_ADMIN" BASE="$BASE" QUOTE="$QUOTE" \
      POOL_FEE_BPS="$POOL_FEE_BPS" node -e '
      process.stdout.write(JSON.stringify({
        admin: process.env.CANTON_ADMIN,
        baseInstrumentId: process.env.BASE,
        quoteInstrumentId: process.env.QUOTE,
        feeModel: {
          makerFeeBps: 10,
          takerFeeBps: 30,
          poolFeeBps: Number(process.env.POOL_FEE_BPS),
        },
        tradingMode: "TM_Both",
        active: true,
      }));
    ')"
    curl -fsS -X POST \
      -H "Authorization: Bearer ${OPERATOR_ADMIN_TOKEN}" \
      -H "Content-Type: application/json" \
      --data-binary "$pair_payload" \
      "${API_BASE%/}/v1/admin/pairs" >/dev/null
    printf '  created pair %s/%s\n' "$BASE" "$QUOTE"
  else
    printf '  pair %s/%s already exists\n' "$BASE" "$QUOTE"
  fi

  pools_json="$(curl -fsS "${API_BASE%/}/v1/pools")"
  pool_exists="$(POOLS_JSON="$pools_json" BASE="$BASE" QUOTE="$QUOTE" node -e '
    const rows = JSON.parse(process.env.POOLS_JSON || "[]");
    process.stdout.write(rows.some((p) => p.baseInstrumentId === process.env.BASE && p.quoteInstrumentId === process.env.QUOTE) ? "1" : "0");
  ')"
  if [[ "$pool_exists" == "0" ]]; then
    pool_payload="$(CANTON_LP_REGISTRAR="$CANTON_LP_REGISTRAR" \
      CANTON_ADMIN="$CANTON_ADMIN" BASE="$BASE" QUOTE="$QUOTE" \
      LP_INSTRUMENT="$LP_INSTRUMENT" POOL_FEE_BPS="$POOL_FEE_BPS" node -e '
      process.stdout.write(JSON.stringify({
        lpRegistrar: process.env.CANTON_LP_REGISTRAR,
        admin: process.env.CANTON_ADMIN,
        baseInstrumentId: process.env.BASE,
        quoteInstrumentId: process.env.QUOTE,
        lpInstrumentId: process.env.LP_INSTRUMENT,
        feeBps: Number(process.env.POOL_FEE_BPS),
      }));
    ')"
    curl -fsS -X POST \
      -H "Authorization: Bearer ${OPERATOR_ADMIN_TOKEN}" \
      -H "Content-Type: application/json" \
      --data-binary "$pool_payload" \
      "${API_BASE%/}/v1/admin/pools" >/dev/null
    printf '  created UNFUNDED pool %s/%s; fund it through an LP wallet flow\n' "$BASE" "$QUOTE"
  else
    printf '  pool %s/%s already exists\n' "$BASE" "$QUOTE"
  fi
else
  printf '%s\n' '==> [4/4] Market metadata skipped (set DEPLOY_SEED_MARKETS=1 after backend startup)'
fi

printf '%s\n' '==> Deployment phases completed without a suppressed error'
