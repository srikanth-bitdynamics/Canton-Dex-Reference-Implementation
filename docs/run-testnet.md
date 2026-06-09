# Run Against a Canton Testnet

This guide shows how to point the operator backend and web app at a Canton
participant that already has the required DEX and token-standard packages
uploaded and vetted.

Use your own participant URL, synchronizer id, party ids, package id, and JWT.
Do not commit tokens, concrete party ids, or validator-specific package hashes.

## Prerequisites

- A Canton participant JSON Ledger API URL.
- A JWT that can `actAs` the operator party and any bootstrap parties used by
  the commands you submit.
- Uploaded and vetted DARs for:
  - `canton-dex-trading`
  - the Token Standard V2 packages under `vendor/splice/token-standard`
- Operator, LP registrar, and asset-admin parties allocated on the participant.
- Registry factory contracts for the asset admins the DEX will touch.

## Start the Operator Backend

```bash
cd services/operator-backend

export CANTON_LEDGER_TOKEN="<participant-jwt>"

CANTON_LEDGER_URL="https://<participant-host>" \
CANTON_OPERATOR="<operator-party>" \
CANTON_LP_REGISTRAR="<lp-registrar-party>" \
CANTON_ADMIN="<asset-admin-party>" \
CANTON_NETWORK="canton:testnet" \
CANTON_SYNCHRONIZER="<synchronizer-id>" \
CANTON_DEX_PACKAGE_ID="<canton-dex-trading-package-id>" \
PORT=8080 \
npm run testnet
```

The backend reads the token from the environment and does not write it to disk.

## Start the Web App

```bash
cd app/web

VITE_API_BASE="http://localhost:8080" \
VITE_CANTON_NETWORK_ID="canton:testnet" \
VITE_CANTON_SYNCHRONIZER="<synchronizer-id>" \
npm run build

npm run preview
```

Open <http://localhost:4173>. The header should show the configured network and
the backend status should report `synced: true`.

## PartyLayer Wallet Live Probe

PartyLayer support is integrated into the main web app; no separate probe app is
needed. Use this checklist when validating a submit-capable wallet adapter
against a live Canton network.

### Enable the connector

Set the PartyLayer env vars before building or previewing the frontend:

```bash
cd app/web

VITE_ENABLE_PARTYLAYER=1 \
VITE_PARTYLAYER_NETWORK="canton:testnet" \
VITE_PARTYLAYER_WALLET_IDS="console,nightly,send" \
VITE_PARTYLAYER_CONNECT_TIMEOUT_MS=180000 \
VITE_API_BASE="http://localhost:8080" \
npm run build

npm run preview
```

If you are validating a specific adapter, set `VITE_PARTYLAYER_WALLET_IDS`
to just that adapter id. Optional registry overrides are documented in
`app/web/.env.example`.

### Validate the flow

1. Open the app, click **Connect Wallet**, and select **PartyLayer**.
   Approve the connection in the wallet and confirm the connected party is the
   party that owns the test holdings.
2. Confirm holdings load in **Portfolio**. The PartyLayer provider reads
   holdings through its `ledgerApi` bridge for the connected party.
3. Run a small trader-authority action, such as:
   - **Trade** → small pool swap
   - **Pools** → add liquidity or remove liquidity
   - **Orders** → place a prefunded order
4. Confirm the wallet approval returns an `updateId`. PartyLayer receipts may
   not include created contract ids directly; the operator backend recovers the
   created `Allocation`, `LiquidityAllocationAcceptance`, or order-funding
   evidence by reading the committed transaction tree for that `updateId`.
5. Confirm the operator settle step completes and the app refreshes holdings,
   pool reserves, orders, or activity from the backend/indexer.

### What to record

For each wallet adapter tested, record:

- adapter id and network
- connected party
- action submitted
- returned `updateId`
- whether operator discovery recovered the created contract ids
- final on-ledger result: swap settled, LP add/remove settled, or order funded

If discovery fails, capture the operator backend error and the transaction-tree
lookup response. The usual causes are missing operator visibility on the
created contracts, a wallet receipt without `updateId`, or a party mismatch
between the connected wallet and the holdings being spent.

## Smoke Checks

```bash
curl -s http://localhost:8080/v1/status  | python3 -m json.tool
curl -s http://localhost:8080/v1/context | python3 -m json.tool
curl -s http://localhost:8080/v1/pairs   | python3 -m json.tool
curl -s http://localhost:8080/v1/pools   | python3 -m json.tool
```

Expected:

- `/v1/status` returns the configured network and a live slot.
- `/v1/context` returns operator/admin/LP registrar parties and factory CIDs.
- `/v1/pairs` and `/v1/pools` return the on-ledger contracts visible to the
  operator party.

## Bootstrap a Pair and Pool

Use the admin endpoints in [operator-guide.md](operator-guide.md):

- `POST /v1/admin/pairs`
- `POST /v1/admin/pools`

New pools start in `PS_Unfunded`. The first LP funds the pool through the same
add-liquidity request/allocate/settle flow used for later deposits.

## Package Hash Alignment

If DAR upload or vetting fails with package-version/hash errors, confirm that
all local DARs were built against the same upstream Token Standard package
hashes already accepted by the target network. Rebuild the dependent packages
against the vetted upstream DARs, then rebuild `trading` and `trading-tests`.

## Wallet Boundary

Operator-authority calls go through the backend. Trader-authority calls, such as
authoring allocations for add/remove liquidity, swaps, and order funding, must
go through a wallet or another user-authorized submitter. The backend should not
sign as traders.
