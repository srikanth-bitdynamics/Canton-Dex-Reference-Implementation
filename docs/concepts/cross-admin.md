# Cross-admin settlement

The DEX settles trades whose instruments are administered by two different
Token Standard V2 registries — for example Canton Coin (admin = the DSO) against
USDCx (admin = its registrar). All three flows — RFQ/OTC block trades, AMM
swaps, and the order book — share one settlement model.

## Model

A `V2.TransferLeg` names its instrument by text id only; the registry admin
lives on the `AllocationSpecification` and the `SettlementFactory`, not on the
leg. Cross-admin settlement therefore:

1. Groups the trade's legs by instrument **admin**.
2. Builds one `SettlementFactory_SettleBatch` per admin, each covering exactly
   that admin's legs and the allocations authorizing both sides of those legs.
3. Exercises every per-admin batch inside **one** Daml choice, so the whole
   trade commits atomically or not at all.

A single-admin trade is the degenerate case: one admin key, one batch, the
pre-cross-admin behavior unchanged.

The registry enforces the shape (`splice-token-standard-utils`
`fetchAndValidateAllocations`): every batch's allocations must carry
`admin == factory.admin`, and must authorize both the sender and the receiver
side of every leg in the batch, with no missing or superfluous authorizations.

## Instrument identity

`InstrumentId = { admin : Party, id : Text }` is the identity of an asset
everywhere internally — Daml records, matching keys, HTTP payloads, indexer
schema, pricing keys, wallet balances, UI routes, and history. Text symbols are
display labels only; two registries may both issue an asset called `USDC`, so a
bare id never identifies an instrument. `InstrumentId` derives `Ord`, so it is a
valid `Map` key; amount tables keyed by instrument (fees, notionals) use
`Map InstrumentId Decimal`, never a text-serialized key.

## Shared invariants

These hold for every flow.

- **Derive and verify.** A settlement choice derives the expected admins and
  legs from on-ledger state (the trade, pool, or matched orders) and the signed
  quote/price binding. It rejects a supplied admin it did not expect and a
  missing admin it did. It never settles caller-supplied transfer legs.
- **One shared settlement domain.** All allocations for one trade reference the
  same admin-independent `SettlementInfo`, whose `executors = [operator]`. A
  batch under admin A and a batch under admin B settle the same domain.
- **Disclosures, not `readAs`.** The operator does not hold `readAs` rights on
  an external registrar (USDCx). Every per-admin batch settles on the
  registry-returned disclosures merged into the transaction plus the operator's
  existing allocation visibility. No flow reads as an external admin.
- **Bind by view, not position.** Allocations created by a wallet batch are
  associated to their role by fetching each allocation view and matching
  `{admin, authorizer, settlement, authorized leg sides}` — never by
  transaction-tree event order. Settlement results are mapped back to their
  allocations through a tagged batch plan, never by raw list position.
- **Atomic multi-allocation cleanup.** When a settlement aborts (a stale quote,
  a withdrawn allocation), every allocation involved is cancellable in one
  operation, each with its own per-admin choice context; one missing context or
  failed cancel rolls the whole cleanup back.

## RFQ / OTC (implemented, `3c165e3`)

`MatchedTrade` holds `tradeLegs : [TradeLeg]` where
`TradeLeg = { admin : Party, leg : V2.TransferLeg }`. `MatchedTrade_Settle`
derives the expected admins via `splitLegsBy (.admin)`, requires exactly one
`SettlementBatchV2` per admin, and rejects missing or unexpected admins. `Rfq`
carries full `baseInstrumentId`/`quoteInstrumentId : InstrumentId`; the dApp
resolves each leg's admin from the listed venue pair.

## AMM swaps and liquidity

`Pool` carries `baseInstrumentId`, `quoteInstrumentId`, `lpInstrumentId :
InstrumentId`. `PoolSlice` stores `instrumentId : InstrumentId`, and every
settle/reconcile path validates the slice allocation view against it.

Swap and liquidity settle through admin-keyed batches:

```
data RegistryBatchInput = RegistryBatchInput with
  traderAllocationCids : [ContractId V2.Allocation]
  factoryCid : ContractId V2.SettlementFactory
  extraArgs : ExtraArgs

choice PoolRules_Swap with batchesByAdmin : Map Party RegistryBatchInput
```

Base, quote, and LP resolve to one, two, or three distinct admins; the choice
groups legs and allocations by admin into a `Map Party` and settles one batch
per key. Add/remove liquidity use the same grouping rather than fixed
base/quote/LP batch fields.

The swapper authorizes through a `SwapAllocationRequest` implementing
`V2.AllocationRequest`, one specification per `(swapper, admin)`, accepted and
authored in one wallet command via `BatchingUtilityV2` — the path liquidity
already uses. Allocation-factory context is resolved per admin (or per
allocation) with its own factory and disclosures; that is distinct from the
per-batch settlement context.

Registry admins are not made `Pool` observers: a settlement factory does not
need visibility of the pool contract.

## Order book

An order holds `allocationCidsByAdmin : Map Party (ContractId V2.Allocation)`.
A single-admin pair has one entry — one allocation that locks the funding and
authorizes both future sides. A cross-admin pair has two: the lock-admin
allocation funds the locked side, and the counter-admin allocation is a
zero-funding receipt authorization (`transferLegSides = []`,
`nextIterationFunding = Some TextMap.empty`), which iterated settlement permits.

For a bid on `BASE@A / QUOTE@B`:

| Admin | Initial funding | Fill authorization |
|-------|-----------------|--------------------|
| A     | empty           | receive base       |
| B     | quote budget    | send quote         |

For an ask the rows swap. When `A == B` each pair of rows collapses to one
allocation and one batch.

- **Commitment parity.** The receiver allocation matches the funding
  allocation's commitment: an expiring order commits both with the same
  deadline; a GTC order leaves both uncommitted for unilateral exit. Otherwise
  the trader could withdraw the receiver authorization while funding stays
  locked.
- **One request, all specs.** `OrderAllocationRequest` exposes one spec per
  distinct admin; the wallet authors all allocations atomically through
  `BatchingUtilityV2`.
- **Viable-remainder roll-forward.** A fill first determines whether the order
  remains open — quote budget can exhaust through price and rounding even with
  base quantity left. If it stays open, every admin allocation rolls (the
  lock-admin allocation with the remaining funding, the others with
  `Some TextMap.empty`); otherwise all finalize with `nextIterationFunding =
  None` and the order closes.
- **Tagged results.** `OrderMatchExecution_Execute` takes
  `batchesByAdmin : Map Party RegistrySettlementInput`
  (`RegistrySettlementInput = { factoryCid, extraArgs }`), builds a tagged batch
  plan, and zips each `SettleBatchResult` back to its allocations to produce
  `nextAllocationCidsByAdmin`. It never reads results by position.
- **Atomic cancel.** `Order_Cancel` cancels every allocation in
  `allocationCidsByAdmin`, all-or-nothing.

### Settlement domain

All of an order's allocations — across both admins and across the fills that
roll them forward — share one iterated settlement domain identified by
`(operator, base InstrumentId, quote InstrumentId, policy version)`, independent
of any admin. Every resting and matched order on that book settles that domain,
which is what lets the operator supply concrete leg sides at match time under
allocations funded earlier.

### Operator trust boundary

A prefunded iterated allocation authorizes its executor (the operator) to supply
concrete legs at settlement. `OrderMatchExecution` constrains those legs to the
matched price, quantity, pair, and ownership, but the registry itself cannot
prove the operator entered through that choice rather than another. This is the
operator trust the order book already relies on; cross-admin support does not
widen it. Self-custody wallets that authorize their own allocations bound this
trust to a single fill.

## Deployment cutover

The record and choice changes are not valid smart upgrades of the deployed
`canton-dex-trading` lineage. They ship in the new package lineage
`canton-dex-trading-v2` (see `scripts/check-upgrade-compat.sh`). Cutover on a
running deployment:

1. Pause and drain existing pools; cancel resting orders and their allocations.
2. Cancel outstanding pool slices and any live allocations.
3. Deploy the `canton-dex-trading-v2` DAR.
4. Update template package ids to `#canton-dex-trading-v2`.
5. Recreate pools and the order book against the new package.

## Registry prerequisites

Both registries in a cross-admin trade must:

- Implement the V2 allocation and settlement factories.
- Permit the pool's or order's committed iterated allocations.
- Be reachable on one synchronizer, so a single Daml transaction settles both.
- Supply operation-specific choice contexts and disclosures for allocation and
  settlement.

## Build sequence

1. Package lineage and cutover — done (`canton-dex-trading-v2 1.0.0`).
2. Full `InstrumentId` identity across Daml, backend, indexer, and UI.
3. Reusable admin-grouping helpers shared by every flow.
4. Split add/remove liquidity custody settlement by admin.
5. `SwapAllocationRequest` plus `BatchingUtilityV2` wallet batching.
6. Split swap settlement by admin.
7. Order funding by admin, tagged roll-forward, atomic cancel, per-admin execute.
8. Cleanup/recovery and cross-admin tests for every flow.
9. Live-test USDCx/CC against both real registries.
