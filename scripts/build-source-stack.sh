#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

"$ROOT_DIR/scripts/build-vendored-token-standard.sh"

echo "==> Building local canton-dex package"
(
  cd "$ROOT_DIR"
  daml build
)

echo "==> Checking TradingAppV2 source alignment"
bash "$ROOT_DIR/scripts/check-tradingappv2-alignment.sh"

echo "==> Checking TradingAppV2 backend source alignment"
bash "$ROOT_DIR/scripts/check-tradingappv2-backend-alignment.sh"

echo "Source stack built successfully."
