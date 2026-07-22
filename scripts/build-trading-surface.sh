#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Token-standard dependencies are the canonical Splice release DARs committed
# under vendor/splice/dars/ (see vendor/splice/VENDOR_PIN.md) — the same
# package ids the network vets — so there is nothing to build from source here.
echo "==> Building canton-dex-trading (deps: vendor/splice/dars/*.dar)"
(
  cd "$ROOT_DIR/trading"
  dpm build
)

echo "canton-dex-trading built successfully."
