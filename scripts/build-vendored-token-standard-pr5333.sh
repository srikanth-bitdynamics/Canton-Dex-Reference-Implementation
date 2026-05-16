#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOKEN_STANDARD_DIR="$ROOT_DIR/vendor/splice-pr5333/token-standard"

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
)

for rel in "${packages[@]}"; do
  pkg_dir="$TOKEN_STANDARD_DIR/$rel"
  pkg_name="$(basename "$rel")"

  echo "==> Building PR-5333 core package $rel"
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

echo "Vendored PR-5333 token-standard API packages built successfully."
