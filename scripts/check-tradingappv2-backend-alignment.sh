#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_FILE="$ROOT_DIR/tests/CantonDex/Testing/OTCTradeV2Backend.daml"
UPSTREAM_FILE="$ROOT_DIR/vendor/splice/token-standard/splice-token-standard-test-v2/daml/Splice/Testing/Apps/TradingAppV2_Backend.daml"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

LOCAL_TYPE="$TMP_DIR/local-type.daml"
UPSTREAM_TYPE="$TMP_DIR/upstream-type.daml"
LOCAL_QUERY="$TMP_DIR/local-query.daml"
UPSTREAM_QUERY="$TMP_DIR/upstream-query.daml"

awk '
  /^data TradeWithAllocations = TradeWithAllocations/ {capture=1}
  /^-- \| Find all trades for the venue together with their allocations and/ {capture=0}
  /^queryTradesWithAllocations : Party -> Script \[TradeWithAllocations\]/ {capture=0}
  capture {print}
' "$LOCAL_FILE" > "$LOCAL_TYPE"

awk '
  /^data TradeWithAllocations = TradeWithAllocations/ {capture=1}
  /^data SettleableTrade = SettleableTrade/ {capture=0}
  capture {print}
' "$UPSTREAM_FILE" > "$UPSTREAM_TYPE"

awk '
  /^queryTradesWithAllocations : Party -> Script \[TradeWithAllocations\]/ {capture=1}
  /^sourceTradeQueryAnchor :/ {capture=0}
  capture {print}
' "$LOCAL_FILE" > "$LOCAL_QUERY"

awk '
  /^queryTradesWithAllocations : Party -> Script \[TradeWithAllocations\]/ {capture=1}
  /^-- \| Find all trades for the venue that can be settled\./ {capture=0}
  capture {print}
' "$UPSTREAM_FILE" > "$UPSTREAM_QUERY"

if ! diff -u <(sed '/^[[:space:]]*$/d' "$UPSTREAM_TYPE") <(sed '/^[[:space:]]*$/d' "$LOCAL_TYPE"); then
  echo "TradingAppV2 backend type slice is out of sync with vendored upstream source." >&2
  exit 1
fi

if ! diff -u <(sed '/^[[:space:]]*$/d' "$UPSTREAM_QUERY") <(sed '/^[[:space:]]*$/d' "$LOCAL_QUERY"); then
  echo "TradingAppV2 backend query slice is out of sync with vendored upstream source." >&2
  exit 1
fi

echo "TradingAppV2 backend query body is aligned with vendored upstream source."
