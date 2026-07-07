# Operator Runbook

Deployment, recovery, and observability guidance for the operator roles
defined by the reference DEX. It describes the contract surface and the
off-chain responsibilities that follow from it. Specific cluster topology
(cantond / participants / synchronizer config) belongs in your Canton
operational documentation, not here.

## Roles and party model

The reference deployment expects four distinct parties. Keeping them logically
separate is part of the design — collapsing them is acceptable for a single-
operator dev instance but should not be the production posture.

| Party         | Owns                                                                          | Signs                                                               |
| ------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `operator`    | `DexPair`, `Order`, `MatchedTrade`, `Pool`, `PoolState`, `PoolSlice`, `PoolRules`, `OrderMatchExecution` | All DEX-side market state                                          |
| `lpRegistrar` | `LPTokenPolicy`, LP registry config (reference: `InstrumentConfiguration`) | Mint/burn supply and LP-token policy                               |
| `admin`       | Base/quote registry config (reference: `InstrumentConfiguration`), `AllocationFactory`, `SettlementFactory` | Allocations, settlement batches, registry-side mint/burn/transfer |
| `trader` / `lp` | `OrderFundingRequest`, `Rfq`, and the deposit/receipt/burn allocations they author against a `LiquidityAllocationRequest` | Their own intents and allocation accepts                          |

The traffic-cost split (called out in module headers) follows the role
ownership: each role pays for the transactions it submits.

## Deployment checklist

In rough order of dependency:

1. **Allocate parties.** `operator`, `lpRegistrar`, base-asset `admin`,
   quote-asset `admin`, and any traders / LPs you want to onboard.
2. **Bring up registries.** For each `admin`, create:
   - `MockAllocationFactory` (or the production registry's allocation
     factory) with `users` = the parties that will exercise on it
   - `MockSettlementFactory` (or production) with the same `users`
   - the registry-specific instrument definition for each instrument the admin
     manages. In the reference registry this is `InstrumentConfiguration`, with
     the credential requirements you want enforced
3. **List trading pairs.** Operator creates a `DexPair` per pair with the
   chosen `tradingMode` and `feeModel`. Pairs are toggled `active` to gate
   trading without archiving the pair record.
4. **Create LP infrastructure (per pool).**
   - `lpRegistrar` creates the LP token's registry-specific instrument
     definition. In the reference registry this is one `InstrumentConfiguration`
     per pool
   - `lpRegistrar` creates the `LPTokenPolicy` for the full
     `{ admin = lpRegistrar, id = lpInstrumentId }` instrument identity
5. **Create pools.** Operator creates the immutable `Pool`, the hot
   `PoolState` in `PS_Unfunded`, and the operator-side `PoolRules` /
   co-controlled `PoolLiquidityRules`. The first LP uses the same
   add-liquidity DvP request/allocate/settle flow as later LPs; the settle
   creates the first `PoolSlice` contracts and transitions the state to
   `PS_Active`.
6. **Open the order book / swap surface.** Once pools are funded and pairs
   are active, traders may submit `OrderFundingRequest`, liquidity adds/removes
   via the DvP `/request` flow, `Rfq`, etc.

The dev / testnet path in `trading-tests/CantonDex/Tests/EndToEndTests.daml`
walks every step above against the mock registry. Treat it as the canonical
bring-up script.

## Recovery and operator-driven cleanup

Iterated allocations put settlement authority in the executor's hands, so the
DEX application layer must constrain every permitted use. The recovery
choices below are app-owned cleanup hooks; an operator service drives them
on a schedule.

### Stale or expired orders

- `Order_Cancel` (operator-driven) — cancels the bound allocation via
  `Allocation_Cancel`, releasing the trader's locked holdings back to their
  authorizer account. The operator's sweep uses it both for orders past
  `expiry` (checked off-ledger when scheduling the cancel) and for
  operator-initiated takedowns (compliance, fat-finger cancels, pair
  de-listing).

### Stale RFQs and quotes

- An RFQ past `expiresAt` is inert: `Rfq_Accept` asserts
  `currentTime < expiresAt`, so nothing can settle against it. Quote
  contracts stay until their own `expiresAt`; the operator sweep exercises
  `RfqQuote_Withdraw` (dealer-driven) or lets quotes age out.
- `Rfq_Cancel` (trader-driven) — the trader retracts before any quote
  acceptance.

### Stuck matched trades

- `MatchedTrade_Cancel` (venue-driven) — archives outstanding
  `TradeAllocationRequest` contracts AND exercises `Allocation_Cancel` on
  any allocations that have already been created. Use when one leg's
  authorizer rejects or times out before settlement.

### Pool maintenance

- `PoolRules_Pause` (operator) — halts new swaps and liquidity actions while
  leaving reserve allocations in place. Useful for upgrades and incident
  response.
- `PoolRules_Resume` (operator) — exits Paused back to Active.
- Remove-liquidity is slice-local: the `PoolLiquidityRules_SettleRemoveLiquidity`
  settle sources a routine withdrawal from at most ONE boundary
  re-allocation per side. The architecture and workflows docs describe the
  invariant; the liquidity rules tests exercise the boundary case.

### LP supply reconciliation

- `PoolState_RecordLPSupply` (lpRegistrar) — pushes the registrar-owned LP
  supply ledger back into the pool's pricing state. Run after each
  mint/burn accept so add-liquidity quoting stays accurate.

## Observability

The contract surface deliberately puts the audit-relevant facts on-ledger so
operators do not need a parallel database to explain a trade.

| Question                                              | Where to look on-ledger                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Why did this RFQ accept go to this dealer?            | `MatchedTrade.policyReceipt`, also folded into `SettlementInfo.meta` via `dex.policy.*` keys           |
| What pair / fee policy applied at trade time?         | `DexPair.feeModel`, `DexPair.tradingMode`, `DexPair.active` at the trade's `createdAt`                 |
| Where did this pool's reserves come from?             | Each `PoolSlice` is an `Allocation` CID, each carrying its admin, authorizer, and committed funding    |
| What's the current head slice / boundary candidate?   | each active `PoolSlice` for the pool (query the ACS by `poolId`); the aggregate is `PoolState.reserves.baseAmount`/`quoteAmount`                                            |
| Did this trader's funding accept?                     | The `OrderAllocationRequest` archive event plus the corresponding `Allocation` create event           |
| Why is this `PoolRules_Swap` failing slippage?        | Call the quote endpoint before swap; the on-ledger choice re-validates against current reserves and `minOutputAmount` |
| Did this LP mint actually run?                        | `PoolLiquidityRules_SettleAddLiquidity` mints against the LP receipt allocation and records the resulting supply on `LPTokenPolicy` |

Off-chain telemetry the operator should also collect:

- **Latency** per workflow (`OrderFundingRequest_Bind` → `Order_Fund`,
  `Rfq_Accept` → `MatchedTrade_Settle`, `PoolRules_Swap` end-to-end).
- **Failure counts** per choice, especially slippage rejections, allocation
  conservation failures, and credential-requirement rejections.
- **Slice-count distributions** per pool side, to flag when consolidation
  maintenance would help reduce the slice list's length.
- **Pending request age**: how long `OrderAllocationRequest`,
  `LiquidityAllocationRequest`, and `MintRequest` records have been open
  without a downstream accept.

### Indexer-backed endpoints (v0.1.0+)

The operator backend ships with a polling indexer that projects ledger
state into a local SQLite database (`data/operator.db` by default).
Surfaces:

| Endpoint | Returns |
|---|---|
| `GET /v1/trades?trader=&pair=&limit=` | Matched-trade history including archived contracts |
| `GET /v1/swaps?pair=&limit=` | Per-swap base/quote deltas + price after |
| `GET /v1/rfq/history?trader=&limit=` | RFQ lifecycle events (open / accepted / closed) |
| `GET /v1/admin/config` | Operator KV (read open by default) |
| `PUT /v1/admin/config` (Bearer auth) | Set a KV key |

The indexer is single-flight and tolerant of restarts: it reconciles
from the current ACS on every tick, so a missed tick doesn't corrupt
state. Set `INDEXER_INTERVAL_MS` to tune polling cadence (default 5s).

### Idempotency cache

Every command submission is keyed by `commandId` and stored in
`command_submissions(commandId PK, submittedAt, status, resultJson)`.
A retry with the same `commandId`:
- returns the cached result if status='ok'
- rejects if status='pending' and submittedAt < 60s ago
- overwrites if stale-pending or 'error'

The cache survives operator restarts and is the recommended defence
against double-fire across crash/replay boundaries. Sweep the table
once an hour to discard rows older than the 24h TTL.

## Recovery procedures

The most likely operational pains for a single-operator deployment:

### Operator backend crash / restart

1. SQLite WAL is durable; the indexer state survives.
2. On reboot, `Indexer.start()` reconciles from current ACS (no replay
   needed). Anything new shows up on the next tick.
3. The idempotency cache prevents the dApp's retry-on-restart from
   double-submitting commands that completed pre-crash.
4. If `data/operator.db` is corrupted, delete it: the next tick
   rebuilds from the live ledger. Cost: trade history older than the
   ACS-archive cutoff is gone (since it lives only in the indexer DB).

### Participant / synchronizer outage

1. The JSON LAPI returns 5xx; the indexer logs the error and tries
   again next tick.
2. Operator-driven writes (pair create, pool init, settle) fail with
   `transport` errors; the idempotency cache marks them 'error'.
3. When the participant recovers, retry from the dApp.

### Smart-upgrade lineage break (lost upgrade compatibility)

Symptom: `NOT_VALID_UPGRADE_PACKAGE` on DAR upload.

Either:
- Revert the offending change (add removed choices back as deprecated
  stubs, make new fields Optional, move new fields to the end of the
  record).
- Rename the package (e.g. `canton-dex-trading` to `canton-dex`). All
  existing contracts from the old name remain queryable but cannot be
  upgraded.

See the "Upgrade discipline" section of `docs/guides/builder-guide.md` for smart-upgrade lineage guidance.

### LP supply drift

`LPTokenPolicy.totalSupply` and `PoolState.totalLpSupply` are kept in
lock-step: the DvP liquidity settles
(`PoolLiquidityRules_SettleAddLiquidity`/`_SettleRemoveLiquidity`) rewrite both
inline and assert they match on entry. If they diverge, the settle's
supply-sync guard aborts. Recovery: query the policy supply and re-run
`PoolState_RecordLPSupply` with `newSupply = policy.totalSupply`.

### Lost trader holdings

V2 holdings are admin+owner signed. If a trader claims a missing
holding, check the registry's `Registry_RegisterInstrument` /
`Registry_Mint` events for that party. The `splice-api-token-transfer-events-v2`
package exposes an `EventLog` interface for replayable audit.

## Backup

The on-ledger state is the source of truth and is replicated by the
synchronizer. The operator backend's local SQLite is rebuildable from
the ledger and does **not** need to be backed up for correctness; back
it up only if you care about historical query performance during
rebuild. Operator config in the `operator_kv` table IS worth backing
up. It carries dealer whitelist, RFQ policy parameters, and similar
runtime knobs that are not encoded on-ledger.

## Failure modes and remediation

| Symptom                                                   | Likely cause                                                                                       | Remediation                                                                                  |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `FinalizedAllocation extra leg-sides exceed funding budget` | Operator tried to settle more than the authorizer pre-committed                                | Re-quote: the swap or match math drifted from the budget. Fix off-chain quoting state         |
| `Pool has no base slices` / `... no quote slices`         | Pool drained to empty by Remove without entering Unfunded state                                    | Inspect the slice list and reserves; if mismatched, escalate (the contract should prevent this) |
| `LP tokens below minimum`                                 | LP's `minLpTokens` slippage bound too tight                                                        | LP resubmits with a looser bound or smaller deposit                                          |
| `Output below slippage minimum`                           | Reserve drift between quote time and submit                                                        | Trader resubmits with a looser bound, or operator routes through a different pool             |
| `Head output slice cannot cover swap`                     | Head slice on the output side is smaller than `amountOut`                                          | Operator should run consolidation, or split the swap across multiple smaller swaps            |
| `Pool must be Active`                                     | Pool was Paused (planned) or Unfunded (last LP exited)                                             | If Paused: `PoolRules_Resume` after maintenance. If Unfunded: a new LP needs to complete add-liquidity request/allocate/settle |

## Single-operator dev shortcut

For local exploration, collapse `operator` / `lpRegistrar` / `admin` into one
party. Tests under `trading-tests/` show the multi-party shape, but the same
contracts compile and run with one party signing everything. Production
should keep the parties distinct so audit-trail and key-management
responsibilities stay decoupled.

## Out of scope for this document

- Cluster topology (cantond, participants, synchronizers, sequencers)
- Backup, key custody, and HSM policy
- KMS / secrets management for the operator submission key
- Network ingress and rate limiting

These are operational concerns inherited from the underlying Canton
deployment and are not constrained by the DEX contract surface.

---

**Where to read next:** [Operator Guide](operator-guide.md) · [Deployment](deployment.md) · [All docs](../README.md)
