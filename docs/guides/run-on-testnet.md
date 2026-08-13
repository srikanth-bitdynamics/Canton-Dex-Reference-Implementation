# Run against a Canton testnet

The DEX runs as two long-lived processes against a Canton participant: the
**operator backend** (operator-authority commands, ledger reads, the indexer)
and the **web app** (reads plus wallet-authority commands). This guide points
both at a participant that already has the DEX and Token Standard V2 packages
uploaded and vetted, and its parties allocated. The one-time build, upload,
party allocation, registry bootstrap, and pair/pool seeding are automated by
[`scripts/deploy-testnet.sh`](../../scripts/deploy-testnet.sh) — run that first,
or perform its steps by hand, then use this guide to bring up and verify the two
processes.

One invariant throughout: tokens, concrete party ids, and validator-specific
package hashes live in the environment, never in the repo.

## Prerequisites

- A Canton participant JSON Ledger API URL and a JWT that can `actAs` the
  operator party and any bootstrap parties used by the commands you submit.
- Uploaded and vetted DARs for `canton-dex-trading` (built from `trading/`) and
  the Token Standard V2 packages under `vendor/splice/token-standard`.
- Operator, LP registrar, and asset-admin parties allocated on the participant.
- The `lpRegistrar`'s `Registry.V2` and the asset admins' registry factory
  contracts created — the registry bootstrap in
  [`scripts/bootstrap-registry.ts`](../../scripts/bootstrap-registry.ts) does
  this; without the LP registry no pool can allocate a liquidity move.

## Start the operator backend

The backend runs `src/testnet-server.ts`. It requires five variables and reads
the rest with defaults. Pass the token through the environment; the process
reads it and does not write it to disk.

```bash
cd services/operator-backend

export CANTON_LEDGER_TOKEN="<participant-jwt>"

CANTON_LEDGER_URL="https://<participant-host>" \
CANTON_OPERATOR="<operator-party>" \
CANTON_LP_REGISTRAR="<lp-registrar-party>" \
CANTON_ADMIN="<asset-admin-party>" \
CANTON_NETWORK="canton:testnet" \
CANTON_SYNCHRONIZER="<synchronizer-id>" \
CANTON_DEX_PACKAGE_ID="#canton-dex-trading" \
PORT=8080 \
npm run testnet
```

| Variable | Required | Purpose |
|---|---|---|
| `CANTON_LEDGER_URL` | yes | JSON Ledger API base URL of the participant. |
| `CANTON_LEDGER_TOKEN` | yes | Bearer JWT that can `actAs` the operator party. |
| `CANTON_OPERATOR` | yes | Operator (venue) party id. |
| `CANTON_LP_REGISTRAR` | yes | LP registrar party id. |
| `CANTON_ADMIN` | yes | Asset-admin party id. |
| `CANTON_SYNCHRONIZER` | recommended | Synchronizer id, e.g. `global-domain::1220...`. `submit-and-wait` requires it on a shared synchronizer. |
| `CANTON_DEX_PACKAGE_ID` | recommended | Template-id prefix. A concrete package hash, or `#canton-dex-trading` to resolve by package name. |
| `CANTON_NETWORK` | optional | Display label surfaced by `/v1/status` (default `canton:devnet`). |
| `CANTON_ALLOC_FACTORY_CID`, `CANTON_SETTLE_FACTORY_CID` | optional | Registry factory CIDs from the bootstrap; set them before the allocation/settlement flows (add/remove liquidity, swaps, order funding) can run. See [Deployment](deployment.md#environment-variables). |

The exact variable contract is the header of
[`testnet-server.ts`](../../services/operator-backend/src/testnet-server.ts);
the full list with defaults is
[`services/operator-backend/.env.example`](../../services/operator-backend/.env.example).

## Start the web app

The dApp reads its network and backend base URL at build time.

```bash
cd app/web

VITE_API_BASE="http://localhost:8080" \
VITE_CANTON_NETWORK_ID="canton:testnet" \
VITE_CANTON_SYNCHRONIZER="<synchronizer-id>" \
npm run build

npm run preview
```

Open <http://localhost:4173>. The header should show the configured network and
the backend status should report `synced: true`. The full frontend variable list
is [`app/web/.env.example`](../../app/web/.env.example).

## Smoke checks

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

## Bootstrap a pair and pool

Use the admin endpoints in [operator-guide.md](operator-guide.md):

- `POST /v1/admin/pairs`
- `POST /v1/admin/pools`

New pools start in `PS_Unfunded`. The first LP funds the pool through the same
add-liquidity request/allocate/settle flow used for later deposits.

## Wallet boundary

Operator-authority calls go through the backend. Trader-authority calls — such
as authoring allocations for add/remove liquidity, swaps, and order funding —
must go through a wallet or another user-authorized submitter. The backend must
not sign as traders.

---

## Reference

### PartyLayer wallet live probe

PartyLayer support is integrated into the main web app; no separate probe app is
needed. Use this checklist when validating a submit-capable wallet adapter
against a live Canton network.

**Enable the connector.** Set the PartyLayer env vars before building or
previewing the frontend:

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

To validate a specific adapter, set `VITE_PARTYLAYER_WALLET_IDS` to just that
adapter id. Optional registry overrides are documented in
[`app/web/.env.example`](../../app/web/.env.example).

**Validate the flow.**

1. Open the app, click **Connect Wallet**, and select **PartyLayer**. Approve
   the connection in the wallet and confirm the connected party is the party
   that owns the test holdings.
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

**What to record.** For each wallet adapter tested:

- adapter id and network
- connected party
- action submitted
- returned `updateId`
- whether operator discovery recovered the created contract ids
- final on-ledger result: swap settled, LP add/remove settled, or order funded

If discovery fails, capture the operator backend error and the transaction-tree
lookup response. The usual causes are missing operator visibility on the created
contracts, a wallet receipt without `updateId`, or a party mismatch between the
connected wallet and the holdings being spent.

### Package hash alignment

If DAR upload or vetting fails with package-version/hash errors, confirm that all
local DARs were built against the same upstream Token Standard package hashes
already accepted by the target network. Rebuild the dependent packages against
the vetted upstream DARs, then rebuild `trading` and `trading-tests`.

### Running against Amulet assets

If a pair uses Amulet (CC) as an asset, note the Splice 0.6.11+ requirements:

- The validator node (yours or your wallet provider's) must run a version that
  supports the Token Standard V2 APIs, and the Amulet DARs must be at the
  V2-capable versions (`amulet` 0.1.21+, `wallet` 0.1.22+; see the
  [Splice release notes](https://docs.canton.network/global-synchronizer/release-notes/splice)).
- Amulet enforces `tokenStandardMaxTTL` (default 90 days) on allocations and
  instructions. See
  [Registry Integration](registry-integration.md#allocation-lifetime-caps).
- Known upstream limitation: the **Splice Amulet Wallet UI** can only create
  multiple requested allocations in a single transaction for *Amulet*
  allocations. The DEX sidesteps this for its own flows by having one Daml choice
  author all allocations of a request in a single command.

---

**Where to read next:** [Deployment](deployment.md) · [Validator Test Plan](validator-test-plan.md) · [All docs](../README.md)
