#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Running local Daml tests"

bash "$ROOT_DIR/scripts/build-trading-surface.sh"

(
  cd "$ROOT_DIR/trading-tests"
  dpm test
)

(
  cd "$ROOT_DIR/examples/stable-pool"
  dpm test
)
