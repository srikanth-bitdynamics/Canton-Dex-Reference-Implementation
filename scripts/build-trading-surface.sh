#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

bash "$ROOT_DIR/scripts/build-vendored-token-standard.sh"

echo "==> Building local canton-dex-trading surface package"
(
  cd "$ROOT_DIR/trading"
  daml build
)

echo "canton-dex-trading surface package built successfully."
