#!/usr/bin/env bash
# Refresh vendor/splice/dars/ with the canonical Splice Token Standard release
# DARs. These carry the exact package ids the network vets, so canton-dex-trading
# built against them deploys to and interoperates on a real participant.
#
# Usage: scripts/fetch-splice-dars.sh [SPLICE_VERSION]   (default: 0.6.12)
set -euo pipefail
VERSION="${1:-0.6.12}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT_DIR/vendor/splice/dars"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
echo "==> downloading Splice $VERSION splice-node bundle"
gh release download "v$VERSION" --repo digital-asset/decentralized-canton-sync \
  --pattern '*splice-node*' -D "$TMP"
echo "==> refreshing $(cd "$DEST" && ls *.dar | wc -l | tr -d ' ') DARs from the bundle"
tar xzf "$TMP"/*splice-node*.tar.gz -C "$TMP"
for name in $(cd "$DEST" && ls *.dar); do
  src="$(find "$TMP" -type f -name "$name" | head -1)"
  if [ -n "$src" ]; then cp "$src" "$DEST/$name"; echo "  refreshed $name";
  else echo "  WARN: $name not found in Splice $VERSION"; fi
done
echo "done. Rebuild: (cd trading && dpm build)"
