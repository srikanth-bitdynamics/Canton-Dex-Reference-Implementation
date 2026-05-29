# End-to-end demo plan

Recording plan for a single walkthrough of the reference DEX,
organized by user role.

## Stack

Splice Canton LocalNet from `splice@token-standard-v2-upcoming`.

| Component | Port |
|---|---|
| Canton 3.5.1 JSON LAPI | `:5003` |
| splice-wallet-kernel gateway | `:3030` |
| mock-oauth2 IDP | `:8889` |
| operator-backend | `:8090` |
| dApp preview (`VITE_ENABLE_SDK=1`) | `:8081` |

Daml package: `canton-dex-trading 0.1.0`
(`9e7bcabde7293eedf6e667261e2b528d1a09f2b2a2ebfb34fac4f25641f1d9c7`).
Vendored Splice token-standard DARs under `vendor/splice/`.

Sanity: `bash scripts/demo-preflight.sh` must end "Demo-ready".
Bring-up steps in the Prerequisites section below.

## Personas

- **Admin / Operator** — `dexOperator` + `dexLpRegistrar` +
  `dexAdmin` (one persona, three Daml parties: venue, LP registrar,
  instrument issuer).
- **Trader Alice** — `alice`. RFQ initiator, order placer, swapper.
- **LP Bob** — `bob` (or a dedicated `lpBob`). Adds/removes
  liquidity.
- **Dealer Jump** — `jump`. Quotes RFQs.

To allocate missing parties + delegate them to the `participant_admin`
user:

```bash
TOK=$(cat /tmp/ln-token.txt)
SUF="::1220d44fc1c3ba0b5bdf7b956ee71bc94ebe2d23258dc268fdf0824fbaeff2c61424"
for HINT in lpBob jump; do
  curl -sS -X POST http://localhost:5003/v2/parties \
    -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
    -d "{\"partyIdHint\":\"$HINT\",\"identityProviderId\":\"\"}"
  curl -sS -X POST http://localhost:5003/v2/users/participant_admin/rights \
    -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
    -d "{\"userId\":\"participant_admin\",\"rights\":[{\"kind\":{\"CanActAs\":{\"value\":{\"party\":\"$HINT$SUF\"}}}}]}"
done
```

## Recording

`ffmpeg` screen capture. Window arrangement:

- Browser left — the dApp at `http://localhost:8081`.
- Terminal right — harness commands and curl probes.

```bash
ffmpeg -nostdin -hide_banner -y \
  -f avfoundation -framerate 15 -capture_cursor 1 -i "<screen-id>:none" \
  -t <duration-sec> -c:v libx264 -preset ultrafast -pix_fmt yuv420p \
  ~/Desktop/canton-dex-demo.mp4
```

Find `<screen-id>` via
`ffmpeg -f avfoundation -list_devices true -i ""`.

## Sequence

### 1. Connect

- Open the dApp. Show network badge and synced status.
- Click Connect Wallet → "Canton wallet (CIP-0103)".
- Header reflects the wallet's party.

### 2. Venue setup

- A BTC/USDC pair is already seeded for the demo. Show it via
  `curl http://localhost:8090/v1/pairs`.
- A pool shell sits in `PS_Unfunded` until §4 initializes it.

### 3. RFQ / MatchedTrade

```bash
CANTON_LEDGER_URL=http://localhost:5003 \
CANTON_LEDGER_TOKEN=$(cat /tmp/ln-token.txt) \
CANTON_SYNCHRONIZER=wallet::1220e7b23ea52eb5c672fb0b1cdbc916922ffed3dd7676c223a605664315e2d43edd \
CANTON_DEX_PACKAGE_ID=9e7bcabde7293eedf6e667261e2b528d1a09f2b2a2ebfb34fac4f25641f1d9c7 \
CANTON_ALLOC_REQUEST_PACKAGE_ID=b91d2fd9e3ab074193cf72748f311b290324a59dec669176a4169225bd2a5f31 \
CANTON_ALLOC_INSTR_PACKAGE_ID=edb6066bb457afa48db3f8e21a8a59f5e092188f0f196f167e089c7cf60e4c15 \
CANTON_USER_ID=participant_admin \
CANTON_VENUE=dexOperator$SUF CANTON_ADMIN=dexAdmin$SUF \
CANTON_ALICE=alice$SUF CANTON_BOB=bob$SUF \
npx tsx scripts/testnet-v2registry-trade.ts
```

Creates the V2 Registry, mints alice 25 BTC, posts a MatchedTrade,
runs the V2 allocation accept on both sides, settles via
`SettlementFactory_SettleBatch`. 10 BTC moves alice → bob on the
live ledger.

In-script equivalent for review: `testMatchedTradeFullSettle`,
`testRfqAcceptProducesMatchedTradeWithReceipt` in
`trading-tests/CantonDex/Tests/EndToEndTests.daml`.

### 4. Pool / LP

```bash
# Seed a fresh PS_Unfunded pool (curl payload available in this
# repo's demo-preflight if needed), then:
CANTON_POOL_CID=<pool-cid> \
CANTON_LP_REGISTRAR=dexLpRegistrar$SUF \
# ... same other env as §3 ...
npx tsx scripts/localnet-pool-demo.ts
```

`PoolRules_Initialize` (PS_Unfunded → PS_Active, first-pool funding
via `LPMintRequest`). Subsequent liquidity adds run the two-call DvP
pair: `POST /v1/pools/add-liquidity/request` creates a
`LiquidityAllocationRequest`, the wallet authors the base-deposit,
quote-deposit, and LP-receipt allocations via
`AllocationFactory_Allocate`, then
`POST /v1/pools/add-liquidity/settle` has the operator and lpRegistrar
settle (`LpDvpRules_SettleAddLiquidity`) — funds enter the pool and LP
tokens mint to the LP atomically. Pool reserves visible in the dApp on
`/pools`.

Swap and remove-liquidity over the JSON LAPI are deferred — they
need an allocation-flow swapper that this harness doesn't include
yet. Same templates are exercised in-script by
`testPoolSwapEndToEnd`, `testPoolFullLifecycle`,
`testPoolRemoveLiquiditySliceLocal`.

### 5. Prefunded order

`composeCommands({ kind: 'place-order', ... })` produces an
`OrderFundingRequest` create command — snapshot pinned in
`app/web/src/__tests__/commands.test.ts`. UI buttons currently
go through the legacy operator-relay provider; the SDK provider
write path waits on a real wallet build (see Wallet status).

## Wallet status

- Connect via Canton wallet (CIP-0103) — works against
  splice-wallet-kernel.
- `prepareSignExecute` write path — pending an Amulet wallet
  build paired against the gateway. Connect-side validated
  2026-05-23; write-side gates Phase 3 of the wallet migration.
- Legacy operator-relay providers (token-standard,
  canton-direct, walletconnect) still serve writes via
  `/v1/wallet/submit` and remain the default in the Connect
  Wallet menu.

## Known UX gaps

- Trade page + Portfolio page crash with
  `Cannot read properties of undefined (reading 'slice')` when a
  PS_Active pool exists and a wallet is connected.
- Wallet session does not survive a page reload (SDK behaviour).

## Prerequisites

```bash
# 1. Canton LocalNet
cd /tmp/swk && yarn start:canton   # ~3 min bootstrap

# 2. Token + package id files (see scripts/demo-preflight.sh for the curl)
echo "<token>" > /tmp/ln-token.txt
echo "9e7bcabde7293eedf6e667261e2b528d1a09f2b2a2ebfb34fac4f25641f1d9c7" > /tmp/ln-pkg.txt

# 3. Operator-backend pointed at LocalNet
cd /tmp/dapp-sdk-mig/services/operator-backend
set -a; . /tmp/operator-backend.env; set +a
node --import tsx src/testnet-server.ts > /tmp/op-backend.log 2>&1 &

# 4. dApp preview
cd /tmp/dapp-sdk-mig/app/web
npm run build
npm run preview -- --port 8081 --host 127.0.0.1 > /tmp/dapp-preview.log 2>&1 &

# 5. Verify
bash /tmp/dapp-sdk-mig/scripts/demo-preflight.sh
```
