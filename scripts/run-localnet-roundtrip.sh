#!/usr/bin/env bash

# Clean-clone Canton LocalNet proof for this reference implementation.
#
# Starts (or reuses) a named canton-devkit LocalNet, resolves its JSON Ledger
# API and dev credential without printing the JWT, builds/uploads the package
# closure, and runs the repository's live DvP driver. The instance is left
# running for inspection; the final output prints the exact non-destructive
# `down` command.

set -euo pipefail
set +x  # never shell-trace the LocalNet JWT

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTANCE="${1:-canton-dex}"
VERSION="${CANTON_LOCALNET_VERSION:-0.6.12}"

if [[ "$INSTANCE" == "--help" || "$INSTANCE" == "-h" ]]; then
  printf '%s\n' \
    'Usage: bash scripts/run-localnet-roundtrip.sh [instance-name]' \
    '' \
    'Optional environment:' \
    '  CANTON_LOCALNET_VERSION=0.6.12  pinned Splice LocalNet version' \
    '  LOCALNET_SKIP_DEPLOY=1          reuse already-uploaded DARs' \
    '  DEX_LOCALNET_OPERATOR=<party>   use separate pre-authorized roles' \
    '  DEX_LOCALNET_ADMIN=<party>' \
    '  DEX_LOCALNET_TRADER=<party>' \
    '  DEX_LOCALNET_SWAPPER=<party>'
  exit 0
fi
if [[ ! "$INSTANCE" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; then
  printf 'invalid LocalNet instance name: %s\n' "$INSTANCE" >&2
  exit 2
fi

for tool in canton-devkit dpm curl node npm; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'missing prerequisite: %s\n' "$tool" >&2
    exit 2
  fi
done

printf '%s\n' '==> Checking LocalNet host prerequisites'
canton-devkit localnet doctor

printf '==> Starting/reusing LocalNet %s (Splice %s)\n' "$INSTANCE" "$VERSION"
canton-devkit localnet up --name "$INSTANCE" --version "$VERSION"

# DevKit shell output is eval-safe. --include-jwt is intentionally scoped to
# this process; the token is never printed by this script.
eval "$(canton-devkit localnet env "$INSTANCE" --format shell --include-jwt)"

if [[ -z "${CANTON_PARTICIPANT_JSON_APP_PROVIDER_PORT:-}" || \
      -z "${CANTON_APP_PROVIDER_JWT:-}" || \
      -z "${CANTON_APP_PROVIDER_USER:-}" ]]; then
  printf '%s\n' 'LocalNet did not expose the app-provider JSON API credential' >&2
  exit 1
fi

export CANTON_LEDGER_URL="http://127.0.0.1:${CANTON_PARTICIPANT_JSON_APP_PROVIDER_PORT}"
export CANTON_LEDGER_TOKEN="$CANTON_APP_PROVIDER_JWT"
export CANTON_USER_ID="$CANTON_APP_PROVIDER_USER"

user_json="$(curl -fsS \
  -H "Authorization: Bearer ${CANTON_LEDGER_TOKEN}" \
  "${CANTON_LEDGER_URL}/v2/users/${CANTON_USER_ID}")"
primary_party="$(DEX_USER_JSON="$user_json" node -e '
  const body = JSON.parse(process.env.DEX_USER_JSON || "{}");
  const party = body.user?.primaryParty;
  if (!party) process.exit(1);
  process.stdout.write(party);
')"

# DevKit is only the network lifecycle/credential adapter here; it is not a DEX
# runtime dependency. Allocate missing counterparty roles through the standard
# JSON Ledger API and grant them to the already-authenticated app-provider user.
# Explicit overrides let an integrator exercise pre-provisioned parties instead.
allocate_party() {
  local hint="$1"
  local response
  response="$(curl -fsS -X POST \
    -H "Authorization: Bearer ${CANTON_LEDGER_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"partyIdHint\":\"${hint}\",\"userId\":\"${CANTON_USER_ID}\"}" \
    "${CANTON_LEDGER_URL}/v2/parties")"
  DEX_ALLOCATED_PARTY_JSON="$response" node -e '
  const body = JSON.parse(process.env.DEX_ALLOCATED_PARTY_JSON || "{}");
  const party = body.partyDetails?.party;
  if (!party) process.exit(1);
  process.stdout.write(party);
'
}
export CANTON_OPERATOR="${DEX_LOCALNET_OPERATOR:-$primary_party}"
export CANTON_ADMIN="${DEX_LOCALNET_ADMIN:-$primary_party}"
export CANTON_LP_REGISTRAR="$CANTON_ADMIN"
export CANTON_TRADER="${DEX_LOCALNET_TRADER:-$(allocate_party "dex-lp-${RANDOM}")}"
export CANTON_SWAPPER="${DEX_LOCALNET_SWAPPER:-$(allocate_party "dex-swapper-${RANDOM}")}"
export CANTON_DEX_PACKAGE_ID="${CANTON_DEX_PACKAGE_ID:-#canton-dex-trading}"
export CANTON_ALLOC_INSTR_PACKAGE_ID="${CANTON_ALLOC_INSTR_PACKAGE_ID:-#splice-api-token-allocation-instruction-v2}"

printf '  JSON Ledger API: %s\n' "$CANTON_LEDGER_URL"
printf '  Ledger user:     %s\n' "$CANTON_USER_ID"
printf '%s\n' \
  '  Proof roles: operator/admin use app-provider primary party;' \
  '               LP/trader and swapper are separately allocated unless overridden'

printf '%s\n' '==> Installing pinned Daml SDK and Node runner dependencies'
SDK_VERSION="$(node -e '
  const fs = require("node:fs");
  const yaml = fs.readFileSync(process.argv[1], "utf8");
  const version = yaml.match(/^sdk-version:\s*(.+)$/m)?.[1]?.trim();
  if (!version) process.exit(1);
  process.stdout.write(version);
' "$ROOT_DIR/trading/daml.yaml")"
dpm install "$SDK_VERSION"
if [[ ! -x "$ROOT_DIR/services/operator-backend/node_modules/.bin/tsx" ]]; then
  (cd "$ROOT_DIR/services/operator-backend" && npm ci)
fi

if [[ "${LOCALNET_SKIP_DEPLOY:-0}" != "1" ]]; then
  printf '%s\n' '==> Building and uploading the package closure'
  DEPLOY_SKIP_BOOTSTRAP=1 \
  DEPLOY_SEED_MARKETS=0 \
    bash "$ROOT_DIR/scripts/deploy-testnet.sh"
else
  printf '%s\n' '==> Package deployment skipped (LOCALNET_SKIP_DEPLOY=1)'
fi

printf '%s\n' '==> Running the live-ledger DvP proof'
(cd "$ROOT_DIR/services/operator-backend" && npm run live:roundtrip)

printf '%s\n' \
  '' \
  'LocalNet remains running so you can inspect the created contracts:' \
  "  canton-devkit localnet status --name $INSTANCE" \
  "  canton-devkit localnet contracts --help" \
  '' \
  'Stop containers while preserving ledger volumes:' \
  "  canton-devkit localnet down --name $INSTANCE" \
  '' \
  'Destructive cleanup (removes this instance and its ledger state):' \
  "  canton-devkit localnet remove --name $INSTANCE"
