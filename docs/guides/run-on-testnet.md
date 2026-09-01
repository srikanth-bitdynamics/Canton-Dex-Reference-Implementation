# Run against a Canton testnet

The DEX runs as two long-lived processes against a Canton participant: the
**operator backend** (configured operator/LP authority, ledger reads, the
indexer) and the **web app** (reads plus wallet-authority commands). This guide points
both at a participant whose operator, LP registrar, and asset-admin parties are
already allocated. The repository automates package build/upload, registry
bootstrap, and optional pair/unfunded-pool creation. It deliberately does **not**
allocate parties or claim to fund a pool: party allocation is participant-
specific, and first funding requires an LP-authorized wallet flow.

One invariant throughout: tokens, concrete party ids, and validator-specific
package hashes live in the environment, never in the repo.

## Prerequisites

- Node.js 24, Java 17, DPM with the SDK pinned by `trading/daml.yaml`, and the
  backend/frontend dependencies installed with `npm ci`.
- A Canton participant JSON Ledger API URL. For a compact validator setup, its
  server-side JWT can `actAs` the operator and LP registrar and read the
  configured registrars; pool creation and LP settlement require those control
  roles. Registry bootstrap additionally needs `actAs` for each registry admin.
  In production, prefer separate least-privilege bootstrap and runtime users.
- The target network must accept the exact Token Standard V2 package hashes in
  `vendor/splice/dars/`. A production network may require its governance/vetting
  process before upload.
- Operator, LP registrar, and asset-admin parties allocated on the participant.
- The `lpRegistrar`'s `Registry.V2` and the asset admins' registry factory
  contracts created — the registry bootstrap in
  [`scripts/bootstrap-registry.ts`](../../scripts/bootstrap-registry.ts) does
  this; without the LP registry no pool can allocate a liquidity move.

## 1. Prepare the ledger

Copy the backend environment template, fill the participant values, and load it
into the current shell. `npm run testnet` does not implicitly read `.env`.

```bash
cp services/operator-backend/.env.example services/operator-backend/.env
# Edit services/operator-backend/.env. Do not commit it.

set -a
source services/operator-backend/.env
set +a
```

Use two different high-entropy HTTP API tokens:

```bash
export DEX_OPERATOR_API_TOKEN="<short-lived-operator-api-token>"
export OPERATOR_ADMIN_TOKEN="<short-lived-admin-api-token>"
```

These are credentials for the DEX HTTP service, not the participant JWT. A
full-mode testnet server refuses to start without both. For an intentional
read-only deployment, set `DEX_READ_ONLY=1`; every state-changing HTTP route
then returns 401 (the read-only `POST /v1/swaps/quote` computation remains open).

Build, upload, and bootstrap the on-ledger registries:

```bash
bash scripts/deploy-testnet.sh
```

Expected final line:

```text
==> Deployment phases completed without a suppressed error
```

The script does not allocate parties, start the backend, create a market by
default, mint holdings, or fund a pool. Each successful phase mutates the target
ledger and is not rolled back if a later phase fails.

Record the `assetRegistryCid` and `lpRegistryCid` fields printed by the final
`bootstrap complete` log. Each reference `Registry.V2` implements both factory
interfaces for its own admin, so the two values within a factory pair are the
same registry cid:

```bash
export CANTON_ALLOC_FACTORY_CID="<assetRegistryCid>"
export CANTON_SETTLE_FACTORY_CID="<assetRegistryCid>"

# Required only when CANTON_LP_REGISTRAR differs from CANTON_ADMIN:
export CANTON_LP_ALLOC_FACTORY_CID="<lpRegistryCid>"
export CANTON_LP_SETTLE_FACTORY_CID="<lpRegistryCid>"
```

The included server maps the configured asset admin and LP registrar
separately. A venue that lists additional third-party admins extends this
two-admin configuration with per-admin registry discovery via
`DEX_EXTERNAL_REGISTRIES` — the base and quote admins stay configured — as
described in [Registry integration](registry-integration.md).

## 2. Start the operator backend

The backend runs `src/testnet-server.ts`. Keep the loaded environment in this
terminal. The process reads credentials from the environment and does not write
them to disk.

```bash
cd services/operator-backend

npm run testnet
```

| Variable | Required | Purpose |
|---|---|---|
| `CANTON_LEDGER_URL` | yes | JSON Ledger API base URL of the participant. |
| `CANTON_LEDGER_TOKEN` | yes | Server-side JWT with the read/actAs rights required by the enabled operator and LP flows. |
| `CANTON_OPERATOR` | yes | Operator (venue) party id. |
| `CANTON_LP_REGISTRAR` | yes | LP registrar party id. |
| `CANTON_ADMIN` | yes | Asset-admin party id. |
| `DEX_OPERATOR_API_TOKEN` | yes in full mode | Bearer token for every non-admin HTTP write. |
| `OPERATOR_ADMIN_TOKEN` | yes in full mode | Separate bearer token for `/v1/admin/*` writes. |
| `DEX_READ_ONLY` | optional | Set `1` to start without API tokens and reject every state-changing route. |
| `CANTON_SYNCHRONIZER` | recommended | Synchronizer id, e.g. `global-domain::1220...`. `submit-and-wait` requires it on a shared synchronizer. |
| `CANTON_DEX_PACKAGE_ID` | yes | Template-id prefix. Use the vetted concrete package hash, or `#canton-dex-trading-v2` only where package-name resolution is acceptable. |
| `CANTON_NETWORK` | optional | Display label surfaced by `/v1/status` (default `canton:devnet`). |
| `CANTON_ALLOC_FACTORY_CID`, `CANTON_SETTLE_FACTORY_CID` | yes in full mode | Asset-admin Registry cid, repeated because it implements both interfaces. |
| `CANTON_LP_ALLOC_FACTORY_CID`, `CANTON_LP_SETTLE_FACTORY_CID` | yes in full mode when LP registrar differs | LP registrar's Registry cid, again repeated for both interfaces. |
| `ALLOWED_ORIGINS` | yes for cross-origin browser access | Exact comma-separated web origins. Unset is default-deny. |
| `DEX_CALLER_JWT_SECRET`, `DEX_CALLER_JWT_AUDIENCE` | optional | Bind private reads and trader-subject writes to `X-Caller-Token.sub` in a multi-user deployment. |
| `DEX_HOSTED_RFQ_RELAY` | optional, default `0` | Custodial RFQ create/cancel/accept under hosted trader authority; enabling it requires caller binding and participant rights for those traders. |
| `DEX_EXTERNAL_REGISTRIES` | optional | JSON map of third-party instrument-admin party id to that admin's CIP-112 registry base URL. Unset keeps every instrument on the bootstrap-configured registrars. |
| `DEX_EXTERNAL_REGISTRY_TOKEN` | optional | Bearer token sent to the external registry HTTP APIs. |
| `DEX_AMULET_SCAN_URL` | optional | Trusted Scan node URL. Registers the live DSO party as an external registry for the Amulet (CC) leg, and switches `/v1/status`'s slot to the latest open Amulet mining round. |
| `DEX_AMULET_REGISTRY_BASE` | optional | Overrides the Amulet registry mount (default `<DEX_AMULET_SCAN_URL>/api/scan`). |

The exact variable contract is the header of
[`testnet-server.ts`](../../services/operator-backend/src/testnet-server.ts);
the full list with defaults is
[`services/operator-backend/.env.example`](../../services/operator-backend/.env.example).

Verify the backend before opening a browser:

```bash
curl -fsS http://localhost:8080/v1/status
```

Do not continue unless the response contains `"synced":true`. HTTP 200 with
`synced:false` means the most recent participant ledger-end probe failed; check
the URL, participant token, and startup/indexer logs.

## 3. Start the web app

The dApp reads its public network/backend settings at build time. A production
build deliberately excludes Mock, Direct Canton, and the operator command
relay, so **choose and configure at least one real wallet provider**. This
example enables PartyLayer; replace the wallet ids with adapters supported by
your target network. The alternatives are the dApp SDK gateway
(`VITE_ENABLE_SDK=1`) or WalletConnect (`VITE_WC_PROJECT_ID=...`).

```bash
cd app/web

VITE_API_BASE="http://localhost:8080" \
VITE_CANTON_NETWORK_ID="canton:testnet" \
VITE_CANTON_SYNCHRONIZER="<synchronizer-id>" \
VITE_ENABLE_PARTYLAYER=1 \
VITE_PARTYLAYER_NETWORK="canton:testnet" \
VITE_PARTYLAYER_WALLET_IDS="console,nightly,send" \
VITE_DOCS_URL="https://srikanth-bitdynamics.github.io/Canton-Dex-Reference-Implementation/" \
npm run build

npm run preview
```

Open <http://localhost:4173>. The backend must allow this exact origin:

```bash
export ALLOWED_ORIGINS="http://localhost:4173"
```

Set `ALLOWED_ORIGINS` before starting (or restart) the backend. The header
should show the configured network, `/v1/status` should report `synced: true`,
and **Connect Wallet** should list the provider you deliberately enabled. If it
lists no production-capable provider, stop—the browser cannot author the
trader allocations required by the flow. The full frontend variable list is
[`app/web/.env.example`](../../app/web/.env.example).

### Authorize protected writes in the validator browser

Open **Admin → API session credentials** and enter short-lived copies of
`DEX_OPERATOR_API_TOKEN` and `OPERATOR_ADMIN_TOKEN`. They are stored only in
that tab's `sessionStorage`, never in the built JavaScript. Trader settle calls
use the operator token; `/v1/admin/*` calls use the admin token. If per-caller
binding is enabled, also enter the caller JWT issued for the connected party.

This manual token handoff is for a validator/operator acceptance run. A public
multi-user dApp should obtain scoped, expiring credentials from its authenticated
BFF/session service. Do not distribute the venue's long-lived shared tokens to
ordinary traders and do not create `VITE_*` token variables—Vite embeds them in
public assets.

## 4. Smoke checks

```bash
curl -s http://localhost:8080/v1/status  | python3 -m json.tool
curl -s http://localhost:8080/v1/context | python3 -m json.tool
curl -s http://localhost:8080/v1/pairs   | python3 -m json.tool
curl -s http://localhost:8080/v1/pools   | python3 -m json.tool
```

Expected:

- `/v1/status` returns the configured network and a live slot (the participant
  ledger-end offset, or the latest open Amulet mining round when
  `DEX_AMULET_SCAN_URL` is set).
- `/v1/context` returns exactly the operator, LP registrar, and asset-admin
  parties plus the network label. It carries no factory CIDs; those are
  discovered per operation via `POST /v1/registry/allocation-factory`.
- `/v1/pairs` and `/v1/pools` return the on-ledger contracts visible to the
  operator party.

## 5. Create a pair and an unfunded pool

With the backend still running, use a second terminal that has the same
environment loaded:

```bash
set -a
source services/operator-backend/.env
set +a

DEPLOY_SKIP_BUILD=1 \
DEPLOY_SKIP_UPLOAD=1 \
DEPLOY_SKIP_BOOTSTRAP=1 \
DEPLOY_SEED_MARKETS=1 \
bash scripts/deploy-testnet.sh
```

This phase first requires `/v1/status` to succeed. It queries existing pairs and
pools, creates the pair/pool metadata only if missing, and stops on any HTTP
failure. The base/quote symbols default to the placeholders `BTC`/`USDC` (both on
`CANTON_ADMIN`); override them with `DEPLOY_BASE`, `DEPLOY_QUOTE`, and
`DEPLOY_LP_INSTRUMENT` to seed a differently named pair — still under
`CANTON_ADMIN`, since real external assets are wired through the registry settings
(`DEX_AMULET_SCAN_URL`, `DEX_EXTERNAL_REGISTRIES`), not these symbols. It creates
an **unfunded** pool; it does not fabricate reserves or LP holdings.

Expected checkpoint:

```bash
curl -fsS http://localhost:8080/v1/pairs
curl -fsS http://localhost:8080/v1/pools
```

The pair should be present, and the pool should report an unfunded/zero-reserve
state. The first LP must next run the same wallet-authorized
request → allocations → settle flow used for later deposits. Exact admin curl
alternatives are in [Operator Guide](operator-guide.md).

## 6. Wallet and HTTP authorization boundaries

Operator/LP-authority calls go through the backend. Trader-authority calls —
such as authoring allocations for add/remove liquidity, swaps, and order
funding — must go through a wallet or another user-authorized submitter. The
arbitrary command relay cannot be enabled in the deployed server.

The RFQ HTTP create/cancel/accept endpoints are a separate custodial exception:
they submit as the RFQ trader and are disabled by default in
`testnet-server.ts`. A deployment that deliberately enables
`DEX_HOSTED_RFQ_RELAY=1` must give its participant user rights for each hosted
trader and configure `DEX_CALLER_JWT_SECRET` so `X-Caller-Token.sub` binds every
request to that trader. Its production UI controls also require
`VITE_ENABLE_HOSTED_RFQ=1`; leaving either side off keeps writes disabled. Do
not describe that mode as self-custodial.

The browser's follow-up request to the backend is still a protected HTTP write:
it carries the operator API token entered for this tab. That token authorizes
the backend client; it does not replace the wallet's on-ledger authorization.
When per-caller binding is enabled, `X-Caller-Token.sub` must also equal the
trader party named by the request. The dApp sends the same token on its scoped
orders, holdings, balances, trades, and RFQ reads; an admin token may bypass the
party comparison for operational inspection.

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

1. In **Admin → API session credentials**, configure the short-lived operator
   token and, when enabled, the connected party's caller JWT.
2. Open the app, click **Connect Wallet**, and select **PartyLayer**. Approve
   the connection in the wallet and confirm the connected party is the party
   that owns the test holdings.
3. Confirm holdings load in **Portfolio**. The PartyLayer provider reads
   holdings through its `ledgerApi` bridge for the connected party.
4. Run a small trader-authority action, such as:
   - **Trade** → small pool swap
   - **Pools** → add liquidity or remove liquidity
   - **Orders** → place a prefunded order
5. Confirm the wallet approval returns an `updateId`. PartyLayer receipts may
   not include created contract ids directly; the operator backend recovers the
   created `Allocation`, `LiquidityAllocationAcceptance`, or order-funding
   evidence by reading the committed transaction tree for that `updateId`.
6. Confirm the operator settle step completes and the app refreshes holdings,
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
