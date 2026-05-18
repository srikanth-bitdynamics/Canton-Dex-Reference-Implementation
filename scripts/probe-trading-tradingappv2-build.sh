#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STABLE_TRADING_APP="$ROOT_DIR/vendor/splice/token-standard/examples/splice-token-test-trading-app-v2/daml/Splice/Testing/Apps/TradingAppV2.daml"
PR_TRADING_APP="$ROOT_DIR/vendor/splice/token-standard/examples/splice-token-test-trading-app-v2/daml/Splice/Testing/Apps/TradingAppV2.daml"
UTILS_DIR="$ROOT_DIR/vendor/splice/token-standard/splice-token-standard-utils"
TRADING_APP_DIR="$ROOT_DIR/vendor/splice/token-standard/examples/splice-token-test-trading-app-v2"

utils_log="$(mktemp)"
app_log="$(mktemp)"
trap 'rm -f "$utils_log" "$app_log"' EXIT

if diff -u "$STABLE_TRADING_APP" "$PR_TRADING_APP" > /dev/null; then
  echo "Upstream TradingAppV2 example is unchanged on PR 5333."
else
  echo "Upstream TradingAppV2 example diverged on PR 5333." >&2
  exit 1
fi

bash "$ROOT_DIR/scripts/build-vendored-token-standard.sh"

echo "==> Probing upstream PR-5333 utility layer"
if (
  cd "$UTILS_DIR"
  daml build
) >"$utils_log" 2>&1; then
  dist_dir="$UTILS_DIR/.daml/dist"
  versioned_dar="$(
    find "$dist_dir" -maxdepth 1 -type f -name "splice-token-standard-utils-*.dar" \
      ! -name "splice-token-standard-utils-current.dar" | sort | tail -n 1
  )"

  if [[ -z "$versioned_dar" ]]; then
    echo "Failed to locate built DAR for splice-token-standard-utils" >&2
    exit 1
  fi

  cp "$versioned_dar" "$dist_dir/splice-token-standard-utils-current.dar"

  echo "==> Probing upstream PR-5333 TradingAppV2 example package"
  if (
    cd "$TRADING_APP_DIR"
    daml build
  ) >"$app_log" 2>&1; then
    echo "Upstream PR-5333 TradingAppV2 example builds unchanged."
  else
    cat "$app_log" >&2
    echo "Upstream PR-5333 TradingAppV2 example does not build unchanged." >&2
    exit 1
  fi
else
  if rg -n "instrumentId\\.admin|nonexistent field .admin.|newHoldingCids" "$utils_log" > /dev/null; then
    echo "Upstream PR-5333 utility layer is still blocked by stable-field assumptions."
    rg -n "instrumentId\\.admin|nonexistent field .admin.|newHoldingCids" "$utils_log"
  else
    cat "$utils_log" >&2
    echo "Unexpected PR-5333 utility-layer failure." >&2
    exit 1
  fi
fi
