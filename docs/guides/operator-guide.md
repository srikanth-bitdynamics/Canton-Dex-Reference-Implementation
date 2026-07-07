# Operator Guide

How the DEX operator (admin) deploys, configures, and runs the venue.

The operator is the party that owns the trading venue — sets up pairs
and pools, observes settlement events, runs the matching engine,
collects fees, and recovers from incidents.

This guide is the operational counterpart to the user-facing
[`using-the-dapp.md`](using-the-dapp.md). For the design rationale behind these
flows, see [`../concepts/workflows.md`](../concepts/workflows.md).

---

## Operator identity

The operator is a single Daml party. In the reference deployment:

- `CANTON_OPERATOR` — DEX market venue party. Signatory on `DexPair`,
  `Pool`, `Order`. Observer on `Holding` (so the indexer can read).
- `CANTON_LP_REGISTRAR` — separate party that holds the
  `LPTokenPolicy` and accepts LP mint/burn. Logically distinct so the
  operator can hand off LP custody to a regulated custodian later.
- `CANTON_ADMIN` — asset admin / registrar. Owns
  the registry-side definition for the underlying instruments. In the
  reference registry this is `InstrumentConfiguration`; Token Standard V2 does
  not require that exact template.

In production these are typically three different parties for
separation of concerns. For local dev they can be the same party.

---

## First-time deployment

### 1. Build the DARs

```bash
bash scripts/build-vendored-token-standard.sh
bash scripts/build-trading-surface.sh
```

Outputs `.daml/dist/canton-dex-*.dar`.

### 2. Upload DARs + allocate parties + bootstrap registry

```bash
export CANTON_LEDGER_URL=https://your-participant:7575
export CANTON_LEDGER_TOKEN=$(...)         # JWT for ledger-api-user
export CANTON_OPERATOR=op::1220::...
export CANTON_LP_REGISTRAR=lp::1220::...
export CANTON_ADMIN=admin::1220::...

./scripts/deploy-testnet.sh
```

This script is idempotent. It uploads DARs, allocates the parties if
they don't exist, runs `bootstrap-registry.ts` to create
reference-registry `InstrumentConfiguration` contracts for BTC / USDC / ETH and
the LP instruments, and (if `OPERATOR_ADMIN_TOKEN` is set) seeds an initial
BTC/USDC pair.

Skip flags for re-runs:
- `DEPLOY_SKIP_BUILD=1`
- `DEPLOY_SKIP_UPLOAD=1`
- `DEPLOY_SKIP_PARTIES=1`
- `DEPLOY_SKIP_SEED=1`

### 3. Start the operator backend

```bash
cd services/operator-backend
cp .env.example .env
# Fill in: CANTON_LEDGER_URL, CANTON_LEDGER_TOKEN, party ids,
#          OPERATOR_ADMIN_TOKEN, ALLOWED_ORIGINS, DB_PATH
npm install
npm start
```

Production checklist:
- `OPERATOR_ADMIN_TOKEN` set to a strong random value (gates
  `/v1/admin/*` writes).
- `ALLOWED_ORIGINS` narrowed to your dApp host (not `*`).
- `DB_PATH` on persistent storage (the indexer carries trade history
  and idempotency keys).
- TLS termination by a reverse proxy in front of `:8080`.
- Logs scraped from stdout / stderr (JSON, one event per line).

### 4. Verify the deployment

```bash
curl -fsS $CANTON_LEDGER_URL/v2/state/active-contracts ...
curl -fsS http://localhost:8080/v1/status
curl -fsS http://localhost:8080/v1/context
curl -fsS http://localhost:8080/v1/pools
```

See [`validator-test-plan.md`](validator-test-plan.md)
for the full live-validation checklist (10 phases, all the way through
wallet flows and resilience tests).

---

## Day-to-day operations

### Create a new trading pair

In the **Admin** page → **Pairs** section → **+ Add pair**.

Or via the HTTP API directly:

```bash
curl -X POST http://localhost:8080/v1/admin/pairs \
  -H "Authorization: Bearer $OPERATOR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "baseInstrumentId":"BTC",
    "quoteInstrumentId":"USDC",
    "feeModel":{"makerFeeBps":10,"takerFeeBps":30,"poolFeeBps":30},
    "tradingMode":"TM_Both"
  }'
```

Trading mode is one of `TM_OrderBook`, `TM_Pool`, `TM_Both`. The fee model
ships maker / taker / pool fees in basis points.

Once created, the pair appears in `GET /v1/pairs`. Pause / resume / update
fee model from the Admin UI; the underlying choice exercises are
`DexPair_SetActive`, `DexPair_UpdateFeeModel`, `DexPair_UpdateTradingMode`.

### Create a new pool

Admin → **Pool operations** → **+ Create pool**, or:

```bash
curl -X POST http://localhost:8080/v1/admin/pools \
  -H "Authorization: Bearer $OPERATOR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "baseInstrumentId":"BTC",
    "quoteInstrumentId":"USDC",
    "lpInstrumentId":"BTC-USDC-LP",
    "feeBps":30
  }'
```

The new pool starts in `PS_Unfunded`. First trader to add liquidity
completes the add-liquidity request/allocate/settle flow, which mints the initial LP supply at
`sqrt(baseAmount * quoteAmount)`.

### Order matching

The reference matching engine is a pure-function price-time-priority
matcher (`services/operator-backend/src/order/matching.ts`). To run a
matching pass:

```bash
curl -X POST http://localhost:8080/v1/orders/match \
  -H "Content-Type: application/json" \
  -d '{"base":"BTC","quote":"USDC"}'
```

This returns the list of matches. The operator is responsible for
driving each match through the TradingAppV2-style allocation-request and
per-admin settlement pattern.

Production deployments typically run matching on a tick (every 1-5
seconds) plus on order-placement events.

### Stale RFQ cleanup

`RfqService.sweepExpired(now)` cancels RFQs whose `expiresAt` has
passed. A periodic task (cron or systemd timer) should call the
backend maintenance entrypoint hourly from an authenticated operator
environment.

### Fee accrual + revenue

Admin → **Fee accrual** shows per-pool 24h volume and fees. The entire
swap fee (`feeBps` on each pool) accrues to LPs via the constant-product
(`x*y=k`) invariant; there is no operator fee split in this reference
implementation.

### Pause / resume

Pair-level pause: Admin → **Pairs** → **Pause**. Underlying:
`DexPair_SetActive { newActive = False }`.

Pool-level pause: the operator stops accepting new operator-driven
writes against the pool while leaving the contract in place. To make a
pool fully read-only, archive it and re-create when the venue is ready
to resume.

---

## Monitoring

### Logs

Operator backend emits structured JSON, one event per line. Required
fields: `ts`, `level`, `msg`. Errors go to stderr; everything else to
stdout. Scrape both.

Example:
```
{"ts":"2026-05-17T14:18:23Z","level":"info","msg":"request completed",
 "component":"http","requestId":"...","method":"POST","path":"/v1/swaps/quote",
 "status":200,"durationMs":12}
```

### Status endpoint

`GET /v1/status` returns network label, current ledger slot, and sync
state. Wire this to your uptime monitor with a 5-second poll.

### Indexer health

The SQLite indexer is a single file at `$DB_PATH`. Back it up on a
schedule (it carries idempotency keys + trade history). Check its
mtime if you suspect the indexer has stalled.

---

## Incident response

### Operator backend crashes mid-submission

The `IdempotentLedger` records `commandId` before submitting and the
result after. On restart, in-flight commands are de-duplicated — a
re-submitted `commandId` returns the cached result instead of
double-spending. Crashes during a multi-step operator flow are safe to
retry.

### Pool DvP recovery: slice CIDs rolled forward without an observed event

The pool's slice CIDs may have rolled forward on-ledger without the
operator backend observing the event. Check the participant's ACS for
the pool's latest contract id, update `Pool#xxx` references, and
resume.

### Stale idempotency keys

`IdempotentLedger.sweep()` runs hourly to drop keys older than 24h.
Manual sweep: run the operator backend's maintenance command from an
authenticated operational environment.

### Recovering a forgotten admin token

The token is configured via the `OPERATOR_ADMIN_TOKEN` env var. If
lost, set a new one and restart the operator backend. Existing admin
writes that haven't settled won't be replayable (different token
hash) — re-submit them via the new token.

---

## Roles and responsibilities

| Role | What they do | UI surface |
|---|---|---|
| **Trader** | Swap, place orders, accept RFQs | Trade / Orders / RFQ / Portfolio |
| **LP** | Provide liquidity, harvest fees | Pools / Portfolio |
| **Dealer** | Post quotes on RFQs | RFQ (dealer view, not in this repo's frontend) |
| **Operator** | Run the venue, settle trades | Admin |
| **Asset admin** | Govern instruments, accept mint/burn | Out-of-band |
| **LP registrar** | Accept LP mint/burn | Out-of-band |

The reference dApp's frontend serves **Trader**, **LP**, and **Operator**
roles directly. **Dealer** and registrar workflows are scripted /
operator-tooled.

---

## See also

- [`../concepts/architecture.md`](../concepts/architecture.md) — design rationale
- [`registry-integration.md`](registry-integration.md)
- [`operator-runbook.md`](operator-runbook.md) — incident playbook
- [`../reference/http-api.md`](../reference/http-api.md) — every HTTP endpoint
- [`validator-test-plan.md`](validator-test-plan.md)

---

**Where to read next:** [Operator Runbook](operator-runbook.md) · [Deployment](deployment.md) · [Run on a Testnet](run-on-testnet.md) · [All docs](../README.md)
