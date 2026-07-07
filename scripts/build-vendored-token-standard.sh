#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOKEN_STANDARD_DIR="$ROOT_DIR/vendor/splice/token-standard"
PIN_FILE="$ROOT_DIR/vendor/splice/VENDOR_PIN.md"

# Surface the vendored pin at build start: this build targets Token Standard V2
# as merged into canton-network/splice `main`.
if [[ -f "$PIN_FILE" ]]; then
  echo "==> Vendored Token Standard pin ($PIN_FILE):"
  grep -E '^\| (Upstream repo|Branch|Commit|In-tree|Commit date)' "$PIN_FILE" || true
  echo "    (details: docs/reference/allocation-surface.md)"
else
  echo "WARNING: vendor pin file not found at $PIN_FILE" >&2
fi

packages=(
  "splice-api-token-metadata-v1"
  "splice-api-token-holding-v1"
  "splice-api-token-holding-v2"
  "splice-api-token-allocation-v1"
  "splice-api-token-allocation-v2"
  "splice-api-token-allocation-request-v1"
  "splice-api-token-allocation-request-v2"
  "splice-api-token-allocation-instruction-v1"
  "splice-api-token-allocation-instruction-v2"
  "splice-api-token-transfer-instruction-v1"
  "splice-api-token-transfer-instruction-v2"
  "splice-api-token-transfer-events-v2"
  "splice-token-standard-utils"
  "examples/splice-token-test-trading-app-v2"
  "examples/splice-test-token-v2"
)

for rel in "${packages[@]}"; do
  pkg_dir="$TOKEN_STANDARD_DIR/$rel"
  pkg_name="$(basename "$rel")"

  echo "==> Building $rel"
  (
    cd "$pkg_dir"
    daml build
  )

  dist_dir="$pkg_dir/.daml/dist"
  versioned_dar="$(
    find "$dist_dir" -maxdepth 1 -type f -name "${pkg_name}-*.dar" \
      ! -name "${pkg_name}-current.dar" | sort | tail -n 1
  )"

  if [[ -z "$versioned_dar" ]]; then
    echo "Failed to locate built DAR for $pkg_name" >&2
    exit 1
  fi

  cp "$versioned_dar" "$dist_dir/${pkg_name}-current.dar"
done

# Wallet-side utility packages live under vendor/splice/daml (not token-standard/).
# splice-util-token-standard-wallet (BatchingUtilityV2) depends on the API dars
# built above plus splice-api-featured-app-v1.
DAML_DIR="$(cd "$(dirname "$0")/.." && pwd)/vendor/splice/daml"
daml_packages=(
  "splice-api-featured-app-v1"
  "splice-util-token-standard-wallet"
)

for rel in "${daml_packages[@]}"; do
  pkg_dir="$DAML_DIR/$rel"
  pkg_name="$(basename "$rel")"

  echo "==> Building $rel"
  (
    cd "$pkg_dir"
    daml build
  )

  dist_dir="$pkg_dir/.daml/dist"
  versioned_dar="$(
    find "$dist_dir" -maxdepth 1 -type f -name "${pkg_name}-*.dar" \
      ! -name "${pkg_name}-current.dar" | sort | tail -n 1
  )"

  if [[ -z "$versioned_dar" ]]; then
    echo "Failed to locate built DAR for $pkg_name" >&2
    exit 1
  fi

  cp "$versioned_dar" "$dist_dir/${pkg_name}-current.dar"
done

echo "Vendored token-standard packages built successfully."
