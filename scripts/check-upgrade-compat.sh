#!/usr/bin/env bash
#
# Fails when canton-dex-trading is not a valid smart upgrade of the version
# already deployed. `dpm upgrade-check --both` runs the compiler check and the
# participant's own PackageUpgradeValidator, so a package that passes here
# uploads.
#
# The baseline is the deployed DAR itself, committed under
# trading/upgrade-baseline/. Replace it (removing the previous one) once a new
# version has actually been deployed, never when merely bumping the version.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASELINE_DIR="$ROOT_DIR/trading/upgrade-baseline"

shopt -s nullglob
baselines=("$BASELINE_DIR"/*.dar)
shopt -u nullglob
if [ "${#baselines[@]}" -ne 1 ]; then
  echo "Expected exactly one baseline DAR in $BASELINE_DIR, found ${#baselines[@]}." >&2
  exit 1
fi
baseline="${baselines[0]}"

bash "$ROOT_DIR/scripts/build-trading-surface.sh"

version="$(sed -n 's/^version: *//p' "$ROOT_DIR/trading/daml.yaml")"
current="$ROOT_DIR/trading/.daml/dist/canton-dex-trading-$version.dar"
if [ ! -f "$current" ]; then
  echo "No built DAR at $current." >&2
  exit 1
fi

echo "==> Upgrade check: $(basename "$current") over $(basename "$baseline")"
if dpm upgrade-check --both "$baseline" "$current"; then
  echo "canton-dex-trading $version upgrades $(basename "$baseline") cleanly."
  exit 0
fi

cat >&2 <<EOF

==> canton-dex-trading $version cannot upgrade the deployed
    $(basename "$baseline"). Uploading it would be rejected with
    NOT_VALID_UPGRADE_PACKAGE.

Daml smart upgrading permits only additions: new templates, choices, data
types and constructors, plus new record fields that are Optional and come
after the existing ones. It forbids removing a field or a choice, reordering
fields, and changing the type of an existing field -- widening one to Optional
counts as a change.

Read the errors above and fix them at the source:

  * a field added to a template or a choice result must be Optional, with
    every construction and consumption site updated to match;
  * a field or choice that was removed has to come back with its original
    name and type -- if the code no longer needs it, keep it unused;
  * a change that genuinely cannot be expressed as an addition needs a new
    package name, not a version bump.

Run this script to check again.
EOF
exit 1
