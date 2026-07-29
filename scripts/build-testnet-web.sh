#!/usr/bin/env bash

# Builds the dApp exactly as testnet-dex.bitdynamics.cc serves it.
#
# The wallet picker is flag-gated: a provider whose flag is unset is not
# registered at all, so a build that omits one silently drops that option
# from the UI. Build through this script rather than by hand.
#
# VITE_ENABLE_PARTYLAYER and VITE_ENABLE_SDK are deliberately unset — those
# providers have never been enabled on this deployment. Turning either on is
# a deliberate change, not a default.
#
# Deploy with:
#   rsync -az --delete app/web/dist/ <host>:/opt/canton-dex/web/

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR/app/web"

VITE_API_BASE="/api" \
VITE_CANTON_NETWORK_ID="canton:testnet" \
VITE_CANTON_SYNCHRONIZER="global-domain::1220f22a8b8f2d813c25b9a684dc4dd52b532a0174d8e73a13cdf2baabfff7518337" \
VITE_CANTON_DEX_PACKAGE_ID="#canton-dex-trading" \
VITE_ENABLE_TESTNET_PARTY="1" \
npm run build

echo
echo "Built $(ls dist/assets/*.js | wc -l | tr -d ' ') js chunk(s):"
ls dist/assets/
