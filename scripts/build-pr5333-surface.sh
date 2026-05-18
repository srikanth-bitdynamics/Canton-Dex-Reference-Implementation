#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

bash "$ROOT_DIR/scripts/build-vendored-token-standard.sh"

echo "==> Building local PR-5333 surface package"
(
  cd "$ROOT_DIR/pr5333"
  daml build
)

echo "PR-5333 surface package built successfully."
