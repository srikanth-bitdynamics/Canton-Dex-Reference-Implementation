# LP liquidity custody: operator-custodied, DvP at the boundary

Status: **decided** (2026-05-28). This document defines the
operator-custodied model for LP liquidity and the boundary DvP flow.

## The model

**Operator-custodied between operations, DvP at the boundary.**

- Between operations, pool reserves are operator-authored committed
  `PoolSlice` allocations. Slices are
  **locality units, not LP entitlement units**: they exist so add/remove/
  swap touch only the slices they source, not so a slice "belongs to" an
  LP.
- An LP's entitlement is **pro-rata over the aggregate reserves**
  (`lpHeld / totalLpSupply × reserves`), sourced from selected slices.
  This is unchanged from the current pool math.
- The **boundary** (add / remove) is where assets cross between the LP
  and the pool, so it is a **delivery-versus-payment settle batch**,
  symmetric to how Swap already settles delivery to the swapper.

This explicitly **rejects** an earlier draft's per-LP slice ownership +
"cancel-the-LP's-slice-back-to-the-LP" model. Slices are not owned; there
is no `PoolSlice.owner`.

## Add (DvP at the boundary)

One Daml transaction, atomic: the LP delivers base+quote into the pool
and receives LP tokens, or nothing happens.

Because token-standard settlement is **admin-scoped** (base/quote under
`pool.admin`; the LP instrument under `pool.lpRegistrar`), this is **two
per-admin SettleBatches in the same transaction** (collapses to one only
if `pool.admin == pool.lpRegistrar`):

- **base/quote batch** (`pool.admin`): the LP's deposit legs
  (`LP → operator` base+quote) settle into **operator-authored receiver
  allocations**. `nextIterationFunding = {instrument: amount}` is applied
  on the `FinalizedAllocation` **at the settle step** (not pre-funded at
  allocate time — that would trip the coverage check in
  `Registry.V2`), exactly as `PoolRules_Swap` rolls slices forward. The
  returned next-iteration allocation cids become the new
  operator-authored `PoolSlice`s.
- **LP-mint batch** (`pool.lpRegistrar`): the lp-mint leg
  `mintAccount lpRegistrar → LP` + the LP's receipt allocation; the LP
  receives freshly-minted LP-token holdings.

The settle choice then exercises `LPTokenPolicy_RecordMint` and rewrites
`PoolState` **once** with the new reserves + `totalLpSupply`.

## Remove (DvP at the boundary, symmetric to Swap)

Compute `baseOut/quoteOut = share × aggregate reserves` (unchanged math);
draw the covering slice prefix (`drawFromSlices`, oldest-first). Then a
two-admin settle in one transaction:

- **base/quote batch** (`pool.admin`): legs `pool → holder` base+quote
  (delivery, exactly like Swap's `pool → swapper`), settled against the
  holder's pre-created receipt allocations; the sourced slices roll/drain;
  the boundary slice is re-allocated (operator-authored).
- **LP-burn batch** (`pool.lpRegistrar`): the lp-burn leg
  `holder → burnAccount lpRegistrar`, against the holder's burn-sender
  allocation.

Then `LPTokenPolicy_RecordBurn` + a single `PoolState` rewrite. The key
correctness point is that funds reach the **holder**, not the operator's
pool account.

## Choreography & authority

- The holder/LP pre-authors the boundary allocations via a directional
  `LiquidityAllocationRequest` (implements `V2.AllocationRequest`): for
  add, base+quote deposit (`pool.admin`, sender-side) + LP-token receipt
  (`pool.lpRegistrar`, receiver-side); for remove, base+quote receipt
  (`pool.admin`, receiver-side) + LP-token burn-sender
  (`pool.lpRegistrar`, sender-side).
- The settle choices live on a **new co-controlled `LpDvpRules`**
  contract (`{ operator, lpRegistrar }`, `signatory operator,
  lpRegistrar`, choices `controller operator, lpRegistrar`) — not on the
  operator-only `PoolRules`, which has no `lpRegistrar` visibility. This
  gives the settle the authority to drive both the operator-signed
  `PoolState`/`PoolSlice` writes and the lpRegistrar-controlled
  `LPTokenPolicy`/mint/burn.

## Invariants the settle choices enforce

- **Supply sync**: on entry assert `LPTokenPolicy.totalSupply ==
  PoolState.totalLpSupply`; apply the mint/burn delta; rewrite `PoolState`
  once with the new supply + reserves. Both trackers move in lockstep and
  any pre-existing divergence surfaces loudly.
- **Stale-quote rejection**: `Request*` records the quote
  (`knownTotalLpSupply`, deposit ratio / slippage bounds) + a short
  deadline; `Settle*` re-checks against current `PoolState` and aborts a
  stale request.

## What does NOT change

- Pricing / share math (`x*y=k` on aggregate reserves; pro-rata shares).
- `PoolSlice` shape (still operator-authored, no `owner`).
- `PoolRules_Swap` (already settles delivery to the swapper).
- The existing pricing and reserve model. Only the liquidity entrypoints
  changed: add/remove now run exclusively through the DvP request/settle
  flow.

## Registry prerequisite

The LP-token mint/burn legs use the special `mintAccount`/`burnAccount`
(`owner = None`). `Registry.V2` must support them at all three sites that
currently assume a real owner: the `Allocation` signatory, the settle
credit loop, and the allocate factory. `RealRegistry` already supports
these semantics.
