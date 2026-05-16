# Production Notes — Observability, Recovery, Deployment

What an operator running this DEX needs to monitor, how they recover
from incidents, and how they deploy a new instance. Pairs with
[traffic-cost-model.md](./traffic-cost-model.md) and
[choice-context-spec.md](./choice-context-spec.md).

## Observability

### Metrics the operator emits

The operator backend (services/operator-backend) is the canonical
emitter. Every flow module emits OpenTelemetry counters + histograms
with the convention `dex.<flow>.<verb>.<state>`.

| Metric                                  | Type      | What it tells you |
|-----------------------------------------|-----------|---|
| `dex.rfq.accept.submitted_total`        | counter   | RFQ accepts submitted to the ledger |
| `dex.rfq.accept.duration_ms`            | histogram | wall-clock from operator service receipt to ledger commit |
| `dex.order.bind.submitted_total`        | counter   | Order binds (one per OrderFundingRequest) |
| `dex.order.fund.submitted_total`        | counter   | Order_Fund calls (after trader allocates) |
| `dex.order.adjust.submitted_total`      | counter   | Order_Adjust calls (per match) |
| `dex.pool.swap.submitted_total`         | counter   | Pool swaps |
| `dex.pool.swap.contention_retry_total`  | counter   | UTXO contention retries; spikes signal hot pool needing sharding |
| `dex.matched_trade.settle.submitted_total` | counter | per-batch settle calls |
| `dex.ledger.submit.error_total{kind}`   | counter   | tagged by LedgerError kind |
| `dex.registry.fetch.duration_ms{endpoint}` | histogram | per-endpoint latency |
| `dex.registry.cache.hit_ratio{kind}`    | gauge     | cache effectiveness |
| `dex.policy.receipt.signed_total`       | counter   | RFQ policy receipts produced |
| `dex.lp.mint_request.created_total`     | counter   | LP mint requests created |

### Logs

Structured JSON, every line has:

- `correlationId` — set per inbound request; propagated through every
  ledger submission.
- `commandId` — the ledger command id (also visible in the ledger's
  own audit log).
- `flow` — `rfq`, `order`, `pool`, etc.
- `verb` — choice name, e.g. `Rfq_Accept`.

Example: a swap that retries once on contention emits two log lines
with the same correlation id and command id, the second tagged
`retryAttempt: 1`.

### Traces

OpenTelemetry spans wrap each `submit` call. Span attributes:

- `command.template_id`, `command.choice` — the choice surface
- `command.party.actAs` — submitting parties
- `command.disclosure.size` — number of disclosed contracts attached

Spans nest naturally: an `accept` flow span contains a `submit` span
which contains a registry-client `fetch` span.

### Dashboards (recommended panels)

1. **Settlement throughput** — `Pool_Swap`, `MatchedTrade_Settle`
   submitted/sec and p50/p95/p99 latency.
2. **Contention** — `dex.pool.swap.contention_retry_total` derivative.
   Rising slope means a single pool is hot enough to need sharding;
   see UTXO sharding plan in [architecture.md](./architecture.md).
3. **Registry health** — fetch latency by endpoint, cache hit ratio.
4. **Receipt issuance** — `dex.policy.receipt.signed_total` /
   `dex.rfq.accept.submitted_total` should be ~1; deviations mean
   receipt generation is failing (operator integrity issue).
5. **Per-pool TVL trend** — gauge derived from `Pool` ACS observations.
6. **Order book lifecycle distribution** — Pending/Funded/PartiallyFilled
   counts; persistent Pending count means trader allocation accept is
   stalling and probably the wallet integration is down.

## Recovery

### Operator backend crashes mid-flow

Each ledger submission carries a `commandId`. Rerun is safe:

- The ledger deduplicates by command id (Canton's submission dedup
  window).
- The operator backend's flow modules are stateless; everything they
  need to recover is in the ACS.
- On startup, the backend rebuilds in-memory derived state by reading
  the ACS for: pairs, pools, open orders, open RFQs, settled trades.

Replay rule: if a flow was mid-submission when the backend crashed,
on restart it re-reads the relevant request contract (e.g.,
`OrderFundingRequest` still in ACS), and re-submits with the same
command id. The ledger either accepts (idempotent) or returns
"already submitted" which the backend treats as success.

### Stale registry CIDs

Symptom: `LedgerError(kind="contention", detail="archived: <factoryCid>")`
on a submission that uses a registry-supplied factory CID.

Recovery (already implemented in `services/registry-client/src/index.ts`):

1. The error path invalidates the cache entry for that admin's factories.
2. `retryOnContention` in the ledger module retries the whole
   submission; the second attempt fetches a fresh factory CID.

If retry fails 5 times, alert the operator: the registry is in an
extended state of churn and human intervention may be needed.

### Settlement batch rejected

Symptom: `LedgerError(kind="validation", ...)` from
`SettlementFactory_SettleBatch`.

Cause: the legs and allocations don't match. The operator backend
should never produce this; if it does, surface the trade to a "stuck"
queue and alert. Recovery is `MatchedTrade_Cancel` + manual
reconciliation.

### LP mint/burn drift

Symptom: `Pool_RecordLPSupply` is called but the lpRegistrar's
`LPTokenPolicy.totalSupply` doesn't match the operator's
expectation.

Cause: an LP mint request was processed by the registrar but the
follow-up `Pool_RecordLPSupply` failed. The pool's view of supply is
now wrong, which corrupts swap pricing.

Recovery: read the policy's actual supply from the lpRegistrar's
ACS, then submit `Pool_RecordLPSupply` with the correct value. The
choice is idempotent for the same target value.

### Trade-side allocation never created

Symptom: `OrderAllocationRequest` or `TradeAllocationRequest` sits in
ACS for >5 minutes without trader accept.

Cause: trader's wallet is offline or the trader changed their mind.

Recovery: archive the request via its withdraw choice (operator-
controlled). For orders, also archive the corresponding `Order` (still
in `Pending`) via `Order_Cancel`.

## Deployment

### Layers

```
                            ┌─────────────────────┐
                            │  Trader wallet UI   │  (off-the-shelf)
                            └──────────┬──────────┘
                                       │  (deep links + ledger reads)
                            ┌──────────▼──────────┐
                            │   DEX dApp UI       │  app/web/
                            └──────────┬──────────┘
                                       │  (HTTP/WebSocket)
       ┌─────────────────────┐         │
       │  Asset registry     │◄────────┤
       │  (per admin)        │         │
       └─────────────────────┘  ┌──────▼──────────┐
                                │ Operator        │  services/operator-backend/
                                │ backend         │
                                └──────┬──────────┘
                                       │  (Ledger JSON API or gRPC)
                                ┌──────▼──────────┐
                                │  Canton ledger  │
                                │  (participant)  │
                                └─────────────────┘
```

### Deployment artifacts

Per-environment we ship:

| Artifact | Where | Notes |
|---|---|---|
| `canton-dex-pr5333-0.0.1.dar` | Canton participant | Uploaded once per release |
| `services/operator-backend` (Docker image) | Operator's infra | Stateless; horizontal scaling by sharding hot pools |
| `services/registry-client` (library) | Embedded in operator backend | Not a standalone service |
| `app/web/dist` (static bundle) | CDN | Wired to a backend URL via env |
| Daml party allocations | Canton participant | Operator, lpRegistrar, observer parties |

### Per-pool sharding

When swap throughput on a single pool saturates the operator's
submitter, shard:

1. Create N `Pool` contracts for the same pair (each with its own
   committed allocations).
2. The `DexPair` contract becomes a router that lists the shard CIDs.
3. The operator backend's `pool` module picks a shard per swap
   (round-robin or by least-contended).
4. Periodic rebalancing across shards uses self-transfer swaps to
   normalize reserves.

This is documented in [architecture.md](./architecture.md) under
"UTXO contention". The operator backend has stub support already; the
sharding policy module is the next implementation tranche.

### Day-2 ops

- **Bumping the policy version** (e.g., to v1.5): change
  `POLICY_VERSION` and `POLICY_HASH` in
  `services/operator-backend/src/policy/index.ts` and the matching
  `Rfq.daml`. Both must change in lockstep; tests verify the on-chain
  and off-chain rankers agree.
- **Adding a new pair**: operator submits `DexPair` create through
  the admin module (not yet implemented in the prototype; manual via
  `daml ledger submit-request` for now).
- **Rotating the lpRegistrar**: not supported in the current
  contracts. A future tranche needs an `LPTokenPolicy_RotateRegistrar`
  choice with a propose-accept pattern.

### Disaster recovery

- The operator backend has no durable state of its own; restart from
  scratch is safe.
- The registry's disclosed contracts cache is rebuilt by querying.
- The ledger's ACS is the source of truth; nothing the operator does
  is lost if the backend dies.
- Lost in-flight submissions: covered by command id dedup +
  `retryOnContention`; idempotent across crashes.
