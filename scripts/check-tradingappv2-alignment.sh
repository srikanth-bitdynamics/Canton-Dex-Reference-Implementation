#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_FILE="$ROOT_DIR/src/CantonDex/DexApp/OTCTradeV2.daml"
VENDOR_FILE="$ROOT_DIR/vendor/splice/token-standard/examples/splice-token-test-trading-app-v2/daml/Splice/Testing/Apps/TradingAppV2.daml"

local_tmp="$(mktemp)"
vendor_tmp="$(mktemp)"
trap 'rm -f "$local_tmp" "$vendor_tmp"' EXIT

sed -n '/^-- | A request to a single trading account/,$p' "$LOCAL_FILE" \
  | sed '/^sourceHoldingAnchor :/,$d' \
  | sed '/^[[:space:]]*$/d' > "$local_tmp"

sed -n '/^-- | A request to a single trading account/,$p' "$VENDOR_FILE" \
  | sed '/^[[:space:]]*$/d' > "$vendor_tmp"

if diff -u "$vendor_tmp" "$local_tmp"; then
  echo "TradingAppV2 workflow body is aligned with vendored upstream source."
else
  echo "TradingAppV2 workflow body diverged from vendored upstream source." >&2
  exit 1
fi
