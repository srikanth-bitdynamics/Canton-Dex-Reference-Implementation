#!/usr/bin/env bash
# Demo preflight. Checks LocalNet services, token validity, seeded
# contracts, DAR build outputs, and demo scripts. See docs/e2e-demo-plan.md.

set -e
RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[0;33m'
RESET=$'\033[0m'

PASS=0
FAIL=0
WARN=0

ok()   { echo "  ${GREEN}✓${RESET} $1"; PASS=$((PASS+1)); }
fail() { echo "  ${RED}✗${RESET} $1"; FAIL=$((FAIL+1)); }
warn() { echo "  ${YELLOW}!${RESET} $1"; WARN=$((WARN+1)); }

section() { echo; echo "=== $1 ==="; }

section "Services"
for entry in "5003:Canton 3.5.1 JSON LAPI" "3030:wallet gateway" "8889:mock-oauth2 IDP" "8090:operator-backend" "8081:dApp preview"; do
  PORT="${entry%%:*}"
  NAME="${entry#*:}"
  if lsof -iTCP:"$PORT" -sTCP:LISTEN -n -P >/dev/null 2>&1; then
    ok "$NAME on :$PORT"
  else
    fail "$NAME on :$PORT — bring it up before recording"
  fi
done

section "Canton version"
VER=$(curl -sS http://localhost:5003/v2/version 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin)['version'])" 2>/dev/null || echo "")
if [[ "$VER" == 3.5.1-* ]]; then
  ok "Canton $VER"
else
  fail "Canton version unexpected: '$VER' (want 3.5.1-snapshot.*)"
fi

section "OAuth token"
if [[ -f /tmp/ln-token.txt ]]; then
  TOK=$(cat /tmp/ln-token.txt)
  CODE=$(curl -sS -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TOK" http://localhost:5003/v2/state/ledger-end)
  if [[ "$CODE" == "200" ]]; then
    ok "token at /tmp/ln-token.txt is valid"
  else
    fail "token at /tmp/ln-token.txt rejected by Canton (HTTP $CODE) — re-mint with the audience claim"
  fi
else
  fail "/tmp/ln-token.txt missing — see Prerequisites in docs/demo-walkthrough.md"
fi

section "Operator-backend read paths"
for EP in /v1/status /v1/pairs /v1/pools /v1/context; do
  CODE=$(curl -sS -o /tmp/.preflight.out -w "%{http_code}" "http://localhost:8090$EP")
  if [[ "$CODE" == "200" ]]; then
    SIZE=$(wc -c < /tmp/.preflight.out | tr -d ' ')
    ok "GET $EP → 200 ($SIZE bytes)"
  else
    fail "GET $EP → HTTP $CODE"
  fi
done

section "Seeded contracts"
PAIRS=$(curl -sS http://localhost:8090/v1/pairs | python3 -c "import sys,json;print(len(json.load(sys.stdin)))" 2>/dev/null || echo "?")
POOLS=$(curl -sS http://localhost:8090/v1/pools | python3 -c "import sys,json;d=json.load(sys.stdin);print(f'{len(d)} pools, statuses=[{ \",\".join(p[\"status\"] for p in d) }]')" 2>/dev/null || echo "?")
if [[ "$PAIRS" == "1" ]] || [[ "$PAIRS" -ge 1 ]] 2>/dev/null; then
  ok "$PAIRS DexPair(s) visible to operator-backend"
else
  fail "DexPair not visible — re-seed (see docs/demo-walkthrough.md Prerequisites)"
fi
ok "Pools: $POOLS"

section "DAR build artefacts"
for DAR in \
  "/tmp/dapp-sdk-mig/trading/.daml/dist/canton-dex-trading-0.1.0.dar" \
  "/tmp/dapp-sdk-mig/vendor/splice/token-standard/splice-api-token-allocation-v2/.daml/dist/splice-api-token-allocation-v2-1.0.0.dar"; do
  if [[ -f "$DAR" ]]; then
    ok "$(basename "$DAR") present"
  else
    fail "missing: $DAR — run scripts/build-trading-surface.sh and scripts/build-vendored-token-standard.sh"
  fi
done

section "Demo scripts present"
for S in \
  "scripts/testnet-v2registry-trade.ts" \
  "scripts/localnet-pool-demo.ts" \
  "docs/demo-walkthrough.md"; do
  if [[ -f "/tmp/dapp-sdk-mig/$S" ]]; then
    ok "$S"
  else
    fail "missing: $S"
  fi
done

section "Summary"
echo "  PASS: $PASS, FAIL: $FAIL, WARN: $WARN"
if [[ $FAIL -gt 0 ]]; then
  echo
  echo "${RED}Not demo-ready yet.${RESET} Fix the ${RED}✗${RESET} items above, then re-run."
  exit 1
else
  echo
  echo "${GREEN}Demo-ready.${RESET} Walkthrough: docs/demo-walkthrough.md"
  exit 0
fi
