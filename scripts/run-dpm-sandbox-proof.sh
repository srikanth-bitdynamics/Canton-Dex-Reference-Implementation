#!/usr/bin/env bash

# Portable live-Canton proof using only the DPM SDK pinned by this repository.
#
# This script builds the DAR, starts a throwaway `dpm sandbox` on dynamic ports,
# creates three parties plus one unrestricted LOCAL sandbox user, uploads the
# package closure, runs the live DvP driver, and stops Canton. It does not
# require canton-devkit, Splice LocalNet, a browser, or a production JWT.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/canton-dex-sandbox.XXXXXX")"
PORT_FILE="$RUN_DIR/ports.json"
LOG_FILE="$RUN_DIR/canton.log"
STDOUT_FILE="$RUN_DIR/canton.stdout.log"
SANDBOX_PID=""

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -n "$SANDBOX_PID" ]] && kill -0 "$SANDBOX_PID" 2>/dev/null; then
    kill -INT "$SANDBOX_PID" 2>/dev/null || true
    wait "$SANDBOX_PID" 2>/dev/null || true
  fi
  if [[ "$status" -eq 0 ]]; then
    case "$RUN_DIR" in
      "${TMPDIR:-/tmp}"/canton-dex-sandbox.*) rm -rf "$RUN_DIR" ;;
      *) printf 'refusing to remove unexpected temp path: %s\n' "$RUN_DIR" >&2 ;;
    esac
  else
    printf 'proof failed; Canton logs preserved at %s\n' "$RUN_DIR" >&2
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

for tool in dpm java node npm curl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'missing prerequisite: %s\n' "$tool" >&2
    exit 2
  fi
done

printf '%s\n' '==> Installing the pinned SDK and building the DEX'
SDK_VERSION="$(node -e '
  const fs = require("node:fs");
  const yaml = fs.readFileSync(process.argv[1], "utf8");
  const version = yaml.match(/^sdk-version:\s*(.+)$/m)?.[1]?.trim();
  if (!version) process.exit(1);
  process.stdout.write(version);
' "$ROOT_DIR/trading/daml.yaml")"
dpm install "$SDK_VERSION"
bash "$ROOT_DIR/scripts/build-trading-surface.sh"
if [[ ! -x "$ROOT_DIR/services/operator-backend/node_modules/.bin/tsx" ]]; then
  (cd "$ROOT_DIR/services/operator-backend" && npm ci)
fi

# Canton 3.5 cannot internally reconnect when its own ports are configured as
# zero. Reserve all six sandbox ports, release them together, and pass
# the concrete values immediately. The tiny release/start race is detected by
# the readiness check and produces preserved logs rather than a false PASS.
read -r LEDGER_PORT ADMIN_PORT JSON_PORT SEQUENCER_PORT SEQUENCER_ADMIN_PORT MEDIATOR_ADMIN_PORT < <(node -e '
  const net = require("node:net");
  const servers = [];
  const open = () => new Promise((resolve, reject) => {
    const s = net.createServer();
    servers.push(s);
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => resolve(s.address().port));
  });
  Promise.all([open(), open(), open(), open(), open(), open()]).then((ports) => {
    for (const s of servers) s.close();
    process.stdout.write(`${ports.join(" ")}\n`);
  }).catch((e) => { console.error(e.message); process.exit(1); });
')

printf '%s\n' '==> Starting throwaway Canton sandbox on reserved loopback ports'
dpm sandbox \
  --ledger-api-port "$LEDGER_PORT" \
  --admin-api-port "$ADMIN_PORT" \
  --json-api-port "$JSON_PORT" \
  --sequencer-public-port "$SEQUENCER_PORT" \
  --sequencer-admin-port "$SEQUENCER_ADMIN_PORT" \
  --mediator-admin-port "$MEDIATOR_ADMIN_PORT" \
  --canton-port-file "$PORT_FILE" \
  --log-file-name "$LOG_FILE" \
  --log-file-appender flat \
  >"$STDOUT_FILE" 2>&1 &
SANDBOX_PID=$!

JSON_PORT=""
for _ in $(seq 1 120); do
  if ! kill -0 "$SANDBOX_PID" 2>/dev/null; then
    printf '%s\n' 'Canton exited before becoming ready' >&2
    tail -n 80 "$STDOUT_FILE" >&2 || true
    exit 1
  fi
  if [[ -s "$PORT_FILE" ]]; then
    JSON_PORT="$(node -e '
      const fs = require("node:fs");
      const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (body.sandbox?.jsonApi) process.stdout.write(String(body.sandbox.jsonApi));
    ' "$PORT_FILE")"
    if [[ -n "$JSON_PORT" ]] && \
       curl -fsS "http://127.0.0.1:${JSON_PORT}/v2/state/ledger-end" >/dev/null 2>&1; then
      break
    fi
  fi
  sleep 1
done
if [[ -z "$JSON_PORT" ]] || \
   ! curl -fsS "http://127.0.0.1:${JSON_PORT}/v2/state/ledger-end" >/dev/null 2>&1; then
  printf '%s\n' 'Canton did not become ready within 120 seconds' >&2
  tail -n 80 "$STDOUT_FILE" >&2 || true
  exit 1
fi

export CANTON_LEDGER_URL="http://127.0.0.1:${JSON_PORT}"
export CANTON_LEDGER_TOKEN="sandbox-auth-disabled"
export CANTON_USER_ID="ledger-api-user"

parties_json="$(curl -fsS "${CANTON_LEDGER_URL}/v2/parties")"
primary_party="$(DEX_PARTIES_JSON="$parties_json" node -e '
  const body = JSON.parse(process.env.DEX_PARTIES_JSON || "{}");
  const party = body.partyDetails?.find((p) => p.isLocal)?.party;
  if (!party) process.exit(1);
  process.stdout.write(party);
')"

# The sandbox has authentication disabled, but command submission still names a
# ledger user. Give this throwaway user unrestricted rights inside this process
# only. Never copy this user policy to a shared or production participant.
curl -fsS -X POST \
  -H "Content-Type: application/json" \
  -d "{\"user\":{\"id\":\"${CANTON_USER_ID}\",\"primaryParty\":\"${primary_party}\",\"isDeactivated\":false,\"identityProviderId\":\"\",\"metadata\":{\"resourceVersion\":\"\",\"annotations\":{}}},\"rights\":[{\"kind\":{\"CanExecuteAsAnyParty\":{\"value\":{}}}},{\"kind\":{\"CanReadAsAnyParty\":{\"value\":{}}}},{\"kind\":{\"ParticipantAdmin\":{\"value\":{}}}}]}" \
  "${CANTON_LEDGER_URL}/v2/users" >/dev/null

# A liquidity deposit and a swap both move value between the operator and a
# counterparty, so neither counterparty can be the operator itself. Allocate a
# distinct LP/trader and swapper. The sandbox user's CanExecuteAsAnyParty right
# is deliberately scoped to this throwaway process, so no production-style
# permission is implied here.
allocate_party() {
  local hint="$1"
  local response
  response="$(curl -fsS -X POST \
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
trader_party="$(allocate_party "dex-lp-${RANDOM}")"
swapper_party="$(allocate_party "dex-swapper-${RANDOM}")"

export CANTON_OPERATOR="$primary_party"
export CANTON_ADMIN="$primary_party"
export CANTON_LP_REGISTRAR="$primary_party"
export CANTON_TRADER="$trader_party"
export CANTON_SWAPPER="$swapper_party"
export CANTON_DEX_PACKAGE_ID="#canton-dex-trading-v2"
export CANTON_ALLOC_INSTR_PACKAGE_ID="#splice-api-token-allocation-instruction-v2"
unset CANTON_SYNCHRONIZER

printf '  JSON Ledger API: %s\n' "$CANTON_LEDGER_URL"
printf '%s\n' \
  '  Auth model: local sandbox only; unrestricted throwaway ledger user' \
  '  Roles: operator/admin share the bootstrap party; LP/trader and swapper are distinct'

printf '%s\n' '==> Uploading the package closure'
DEPLOY_SKIP_BUILD=1 \
DEPLOY_SKIP_BOOTSTRAP=1 \
DEPLOY_SEED_MARKETS=0 \
  bash "$ROOT_DIR/scripts/deploy-testnet.sh"

printf '%s\n' '==> Running the live-Canton DvP proof'
(cd "$ROOT_DIR/services/operator-backend" && npm run live:roundtrip)

printf '%s\n' \
  '==> PASS: portable live-Canton proof completed' \
  '    The throwaway sandbox is now stopping; no persistent ledger state remains.'
