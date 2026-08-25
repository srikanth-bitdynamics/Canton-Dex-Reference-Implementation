# Operator Guide

The operator owns the trading venue: it lists pairs, creates pools, runs the
matching engine, and keeps the backend healthy. This guide covers the two
things an operator does — **stand the venue up once**, then **run it day to
day**. It stops where the deep incident work begins; that lives in the
[Operator Runbook](operator-runbook.md), which this guide hands off to
whenever recovery gets involved.

For the design rationale behind these flows, see
[`../concepts/workflows.md`](../concepts/workflows.md); for the trader-facing
side, [`using-the-dapp.md`](using-the-dapp.md).

---

## Operator identity

The operator is a single Daml party, but the reference deployment splits venue,
LP custody, and asset governance across three parties so those
responsibilities can be handed to different custodians later:

- `CANTON_OPERATOR` — DEX market venue party. Signatory on `DexPair`,
  `Pool`, `Order`. Observer on `Holding` (so the indexer can read).
- `CANTON_LP_REGISTRAR` — holds the `LPTokenPolicy` and accepts LP
  mint/burn. Logically distinct so the operator can hand off LP custody to a
  regulated custodian later.
- `CANTON_ADMIN` — asset admin / registrar. Owns the registry-side definition
  for the underlying instruments. In the reference registry this is
  `InstrumentConfig`; Token Standard V2 does not require that exact
  template.

In production these are typically three different parties for separation of
concerns. For local dev they can be the same party — see the
[single-operator dev shortcut](operator-runbook.md#single-operator-dev-shortcut)
in the runbook. The runbook's
[roles and party model](operator-runbook.md#roles-and-party-model) table maps
each party to the contracts it signs.

---

## First-time deployment

### 1. Build the DARs

```bash
bash scripts/fetch-splice-dars.sh
bash scripts/build-trading-surface.sh
```

Outputs `.daml/dist/canton-dex-*.dar`.

### 2. Upload DARs, allocate parties, bootstrap the registry

```bash
export CANTON_LEDGER_URL=https://your-participant:7575
export CANTON_LEDGER_TOKEN=$(...)         # JWT for ledger-api-user
export CANTON_OPERATOR=op::1220::...
export CANTON_LP_REGISTRAR=lp::1220::...
export CANTON_ADMIN=admin::1220::...

./scripts/deploy-testnet.sh
```

The script is idempotent. It uploads DARs, allocates the parties if they don't
exist, runs `bootstrap-registry.ts` to create reference-registry
`InstrumentConfig` contracts for BTC / USDC / ETH and the LP
instruments, and (if `OPERATOR_ADMIN_TOKEN` is set) seeds an initial BTC/USDC
pair.

Skip flags for re-runs: `DEPLOY_SKIP_BUILD=1`, `DEPLOY_SKIP_UPLOAD=1`,
`DEPLOY_SKIP_PARTIES=1`, `DEPLOY_SKIP_SEED=1`.

### 3. Start the operator backend

```bash
cd services/operator-backend
cp .env.example .env
# Fill in: CANTON_LEDGER_URL, CANTON_LEDGER_TOKEN, party ids,
#          OPERATOR_ADMIN_TOKEN, DEX_OPERATOR_API_TOKEN,
#          ALLOWED_ORIGINS, DB_PATH
npm install
npm start
```

**Production checklist:**

- **Both write tokens set to strong random values.** The HTTP surface has two
  fail-closed bearer gates ([`src/http/auth.ts`](../../services/operator-backend/src/http/auth.ts)):
  `OPERATOR_ADMIN_TOKEN` gates writes to `/v1/admin/*` (pair and pool
  administration), and `DEX_OPERATOR_API_TOKEN` gates every other
  state-changing route — swaps, liquidity settles, order fund/bind/cancel,
  RFQ, matched-trade settle, and the matching pass. With either token unset,
  its routes reject writes with 401 (there is no open default on the testnet
  server; `DEX_DEV_OPEN=1` bypasses the operator gate on the in-memory dev
  server only).
- `ALLOWED_ORIGINS` narrowed to your dApp host (not `*`). CORS
  default-denies when it is unset.
- `DB_PATH` on persistent storage (the indexer carries trade history and
  idempotency keys).
- TLS termination by a reverse proxy in front of `:8080`.
- Logs scraped from stdout / stderr (JSON, one event per line).

### 4. Verify the deployment

```bash
curl -fsS $CANTON_LEDGER_URL/v2/state/active-contracts ...
curl -fsS http://localhost:8080/v1/status
curl -fsS http://localhost:8080/v1/context
curl -fsS http://localhost:8080/v1/pools
```

Reads (`/v1/status`, `/v1/context`, `/v1/pools`, `/v1/pairs`) are ungated. See
[`validator-test-plan.md`](validator-test-plan.md) for the full live-validation
checklist (10 phases, through wallet flows and resilience tests).

---

## Day-to-day operations

Every write below is issued either from the **Admin** page or against the HTTP
API. Admin routes carry `OPERATOR_ADMIN_TOKEN`; the matching pass carries
`DEX_OPERATOR_API_TOKEN`. The reference implementations for the admin routes
live in [`services/operator-backend/src/admin/index.ts`](../../services/operator-backend/src/admin/index.ts) —
each HTTP route maps 1:1 to a method there and to one Daml choice.

### Create a trading pair

**Admin** page → **Pairs** → **+ Add pair**, or:

```bash
curl -X POST http://localhost:8080/v1/admin/pairs \
  -H "Authorization: Bearer $OPERATOR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "admin":"admin::1220::...",
    "baseInstrumentId":"BTC",
    "quoteInstrumentId":"USDC",
    "feeModel":{"makerFeeBps":10,"takerFeeBps":30,"poolFeeBps":30},
    "tradingMode":"TM_Both"
  }'
```

The body is the `CreatePairInput` shape from `admin/index.ts`. Trading mode and
the fee model are the two knobs that define a pair:

```ts
export type TradingMode = "TM_OrderBook" | "TM_Pool" | "TM_Both";

export interface FeeModel {
  makerFeeBps: number;
  takerFeeBps: number;
  poolFeeBps: number;
}
```

`active` defaults to `true`. Once created, the pair appears in
`GET /v1/pairs`.

### Update a pair

Pause / resume and re-tune a pair from the Admin UI, or via the cid-suffixed
admin routes. Each maps to one choice on `DexPair`:

| Action | Route | Choice |
|---|---|---|
| Pause / resume trading | `POST /v1/admin/pairs/:cid/active` | `DexPair_SetActive { newActive }` |
| Change fees | `POST /v1/admin/pairs/:cid/fee-model` | `DexPair_UpdateFeeModel { newFeeModel }` |
| Change order-book / pool mode | `POST /v1/admin/pairs/:cid/trading-mode` | `DexPair_UpdateTradingMode { newTradingMode }` |

Pausing toggles the `active` flag without archiving the pair record, so a
paused pair keeps its history and fee policy and can be resumed in place.

### Create a pool

Admin → **Pool operations** → **+ Create pool**, or:

```bash
curl -X POST http://localhost:8080/v1/admin/pools \
  -H "Authorization: Bearer $OPERATOR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "lpRegistrar":"lp::1220::...",
    "admin":"admin::1220::...",
    "baseInstrumentId":"BTC",
    "quoteInstrumentId":"USDC",
    "lpInstrumentId":"BTC-USDC-LP",
    "feeBps":30
  }'
```

`createPool` creates four contracts in one flow: the immutable `Pool`, the hot
`PoolState` in `PS_Unfunded`, the per-venue `PoolRules` /
co-controlled `PoolLiquidityRules` (created once and reused across pools), and
the matching `LPTokenPolicy` signed by `lpRegistrar`. The pool starts empty;
the first LP completes the same add-liquidity request/allocate/settle DvP flow
as every later LP, and that settle mints the initial LP supply at
`sqrt(baseAmount * quoteAmount)` and transitions the state to `PS_Active`.

### Run a matching pass

The reference matcher is a pure price-time-priority function in
[`services/operator-backend/src/order/matching.ts`](../../services/operator-backend/src/order/matching.ts).
A pass settles each crossing pair atomically as it finds it:

```bash
curl -X POST http://localhost:8080/v1/orders/match \
  -H "Authorization: Bearer $DEX_OPERATOR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"base":"BTC","quote":"USDC"}'
```

Each match runs one `OrderMatchExecution_Execute`, which re-checks the fill
against both orders' own terms, runs the settle batch that consumes both
funding allocations, rolls each order onto the allocation that batch minted,
and records the fill as a `SettledTrade` for `GET /v1/trades`. The response
carries `{ matches, settled, failed }`; because runMatching catches per match,
one bad pair cannot stop the rest, so the status is **200** when all settled,
**207** when some failed, **502** when every one did.

A fill whose spend exhausts the side's committed budget closes that order out
even when quantity remains: the residual has no collateral behind it and no
later fill could back it. Production deployments run matching on a tick (every
1–5 seconds) plus on order-placement events.

*Proven by* [`test/matching.test.ts`](../../services/operator-backend/test/matching.test.ts):
the matcher clears at the resting side's limit, never crosses a party against
its own order, fills older orders first at equal price, and skips expired or
unfunded orders.

### Stale RFQ cleanup

`RfqService.sweepExpired(now)` cancels RFQs whose `expiresAt` has passed. Run
it on a schedule (cron or systemd timer) from an authenticated operator
environment. The runbook's
[stale RFQs and quotes](operator-runbook.md#stale-rfqs-and-quotes) section
covers the choice-level behavior — an RFQ past `expiresAt` is already inert,
because `Rfq_Accept` asserts `currentTime < expiresAt`.

### Fees and revenue

Admin → **Fee accrual** shows per-pool 24h volume and fees. The entire swap fee
(`feeBps` on each pool) accrues to LPs through the constant-product (`x·y=k`)
invariant — the fee is retained in the reserve, so `k` is non-decreasing across
a swap. There is no operator fee split in this reference implementation; see
[`../concepts/pricing.md`](../concepts/pricing.md#how-the-pool-prices-a-swap)
for how the pool prices and where the fee lands.

---

## Monitoring

### Logs

The backend emits structured JSON, one event per line. Required fields: `ts`,
`level`, `msg`. Errors go to stderr; everything else to stdout. Scrape both.

```
{"ts":"2026-05-17T14:18:23Z","level":"info","msg":"request completed",
 "component":"http","requestId":"...","method":"POST","path":"/v1/swaps/quote",
 "status":200,"durationMs":12}
```

### Status endpoint

`GET /v1/status` returns network label, current ledger slot, and sync state.
Wire it to your uptime monitor with a 5-second poll.

### Indexer health

The SQLite indexer is a single file at `$DB_PATH` (default
`./data/operator.db`). It reconciles from the current ACS on every tick, so a
missed tick doesn't corrupt state, but it carries the only copy of trade
history older than the ACS-archive cutoff plus the idempotency keys. Back it up
on a schedule and check its mtime if you suspect the indexer has stalled. Tune
the cadence with `INDEXER_INTERVAL_MS` (default 5s).

The runbook's [observability](operator-runbook.md#observability) section maps
each audit question ("why did this RFQ accept go to this dealer?", "where did
this pool's reserves come from?") to the on-ledger fact that answers it.

---

## When something breaks

These are the quick operator actions. For the full playbook — participant
outages, upgrade-lineage breaks, LP-supply drift, the failure-mode table — go
to the runbook's [recovery procedures](operator-runbook.md#recovery-procedures).

- **Backend crashed mid-submission.** Safe to retry. `IdempotentLedger`
  records `commandId` before submitting and the result after, so a re-submitted
  command returns the cached result instead of double-spending. On restart the
  indexer reconciles from the live ACS — no replay needed.
- **A DvP liquidity or swap receipt came back with only an `updateId`.** The
  operator can recover the created allocation cids from the update tree:
  `POST /v1/pools/recover-dvp-allocations` with the `updateId`. This is the
  operator-discovery path for wallet flows that returned before the backend
  observed the allocations.
- **Stale idempotency keys.** `IdempotentLedger.sweep()` drops keys older than
  the 24h TTL; run it hourly from an authenticated operational environment.
- **Forgotten admin token.** Set a new `OPERATOR_ADMIN_TOKEN` (or
  `DEX_OPERATOR_API_TOKEN`) and restart. In-flight admin writes that hadn't
  settled aren't replayable under the new token — re-submit them.

---

## Roles at the UI

| Role | What they do | UI surface |
|---|---|---|
| **Trader** | Swap, place orders, accept RFQs | Trade / Orders / RFQ / Portfolio |
| **LP** | Provide liquidity, harvest fees | Pools / Portfolio |
| **Dealer** | Post quotes on RFQs | RFQ (dealer view, not in this repo's frontend) |
| **Operator** | Run the venue, settle trades | Admin |
| **Asset admin** | Govern instruments, accept mint/burn | Out-of-band |
| **LP registrar** | Accept LP mint/burn | Out-of-band |

The reference dApp serves **Trader**, **LP**, and **Operator** roles directly.
**Dealer** and registrar workflows are scripted / operator-tooled. For the
on-ledger ownership behind these roles — which party signs which contract — see
the runbook's [roles and party model](operator-runbook.md#roles-and-party-model).

---

**Where to read next:** [Operator Runbook](operator-runbook.md) · [Deployment](deployment.md) · [Run on a Testnet](run-on-testnet.md) · [HTTP API](../reference/http-api.md) · [All docs](../README.md)
