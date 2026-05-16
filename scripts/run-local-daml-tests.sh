#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Running local Daml tests"
(
  cd "$ROOT_DIR"
  daml build
)
(
  cd "$ROOT_DIR/tests"
  daml test
)
