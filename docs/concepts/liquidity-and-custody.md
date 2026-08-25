# Liquidity and custody

A pool keeps its liquidity in two forms: a `Decimal` reserve figure it prices
against, and the actual assets, which sit in committed allocations the operator
holds on the pool's behalf. This page explains where the value physically
lives, the invariant that ties the two forms together, and why every flow moves
them as one.

## Reserves are accounting; slices are custody

`PoolState.reserves` is a `PoolReserves { baseAmount, quoteAmount }` — two
`Decimal`s. It is *derived* state: the pool keeps it only so a constant-product
swap can price against the global totals in a single transaction. It custodies
nothing.

The assets live on `PoolSlice` contracts — one committed allocation each, one
side (base or quote) each. A slice pairs a committed `V2.Allocation`, which
locks real holdings, with a cached `amount`:

```daml
template PoolSlice with
    poolId : PoolId
    operator : Party
    side : Side
      -- ^ Which pool leg (base or quote) this slice funds.
    allocationCid : ContractId V2.Allocation
      -- ^ The committed allocation holding this slice's funds.
    amount : Decimal
      -- ^ Cached funded amount; reconciled against the allocation by the
      --   choice that writes the slice.
  where
    signatory operator
```

Two things here are specific to this design:

- **Slices are locality units, not LP shares.** A slice does not belong to an
  LP — there is no `PoolSlice.owner`. The `operator` is the sole signatory, and
  the operator-backend indexer tracks slices by `poolId` and hands the relevant
  `ContractId`s to each choice. Remove and swap touch only the slices they
  source, so the slice set does not have to travel through one growing state
  contract. All reserve-changing operations still serialize on the small
  `PoolState`; slices reduce state size and settlement input, not that global
  pricing dependency.
- **`amount` is a cache, not the source of truth.** The committed allocation
  holds the funds; `amount` is stored alongside so the rules choices can walk
  slices without a `fetch` per slice, and it is reconciled against the
  allocation by the choice that writes the slice. That the committed allocation
  really locks holdings worth its funding is proved in
  [`RegistryConservationTests.daml`](../../trading-tests/CantonDex/Tests/RegistryConservationTests.daml)
  (a settle can never move more than the locked backing; a roll-forward carries
  real locked holdings worth its funding; surplus returns to the authorizer
  unlocked).

## The invariant: reserves equal the sum of slice funding

Per instrument, the reserve equals the sum of the active slices' amounts on
that side: the sum of active base `PoolSlice.amount` equals
`reserves.baseAmount`, and likewise for quote. The slices are authoritative; the
reserve is their aggregate. Two on-ledger mechanisms keep the two from drifting:

- **Per-choice delta conservation.** Every `PoolRules` / `PoolLiquidityRules`
  choice that rewrites `reserves` asserts, in that same choice, that its reserve
  delta equals the net slice-amount change it just performed — for example
  `PoolLiquidityRules_SettleAddLiquidity` asserts `"add: base reserve delta must
  equal created base slice amount"`. A code change cannot silently move one
  without the other.
- **Global reconciliation.** The nonconsuming `PoolRules_ReconcileState` choice
  re-derives both side totals from the full active slice set and asserts each
  equals the recorded reserve (`baseTotal == state.reserves.baseAmount`). It
  writes no state and is intended for off-hot-path checks. A concurrent pool
  update may invalidate its reads, in which case the caller retries. Completeness
  of the slice list is the caller's responsibility — pair the call with the
  indexer's active-slice count.

Both are exercised by
[`PoolStateInvariantTests.daml`](../../trading-tests/CantonDex/Tests/PoolStateInvariantTests.daml):
reconcile stays clean across a full add → swap → remove lifecycle at every
stage, and fails on an omitted slice, a slice from another pool, or a
fabricated, desynced `PoolState`.

```mermaid
flowchart TB
  subgraph PS["PoolState — pricing figure"]
    R["reserves.baseAmount<br/>reserves.quoteAmount"]
  end
  subgraph SL["PoolSlices — where the value lives (signatory: operator)"]
    BS["base slice(s)<br/>amount + allocationCid"]
    QS["quote slice(s)<br/>amount + allocationCid"]
  end
  BH[("committed V2.Allocation<br/>locked base holdings")]
  QH[("committed V2.Allocation<br/>locked quote holdings")]
  R -.->|"= sum of base slice amounts"| BS
  R -.->|"= sum of quote slice amounts"| QS
  BS --> BH
  QS --> QH
```

## Every flow moves holdings and reserves together

Because the assets are real committed allocations, moving them is settlement,
not bookkeeping. Add, remove, and swap each run as a delivery-versus-payment
`SettlementFactory_SettleBatch` and rewrite `PoolState` once, inside one Daml
transaction — so holdings and reserves change co-atomically, or nothing changes.

- **Add.** The LP's base and quote deposits settle into operator-authored
  receiver allocations, which roll forward (via `nextIterationFunding`) into the
  two new slices; the registrar mints LP tokens to the LP; `PoolState` is
  rewritten once with the new reserves and supply. Base/quote settle under
  `pool.admin` and the LP mint under `pool.lpRegistrar`, so this is two
  per-admin batches in the same transaction.
- **Remove** is symmetric to swap: the sourced slices deliver base and quote to
  the holder (exactly as `PoolRules_Swap` delivers to the swapper), each fully
  drawn slice drains, the boundary slice re-wraps its leftover, the holder's LP
  tokens burn, and `PoolState` drops by the same amounts.
- **Swap** pays the input into one side's slice and delivers the output from the
  other, updating both reserves in the same choice.

[`PoolLiquidityRulesTests.daml`](../../trading-tests/CantonDex/Tests/PoolLiquidityRulesTests.daml)
drives these end to end against the reference registry: an add funds base+quote
and mints the LP holding in one flow; a remove delivers base+quote to the
*holder* (not the operator) and burns the LP tokens; a stale supply quote aborts
the settle.

The mint/burn legs and the co-controlled `PoolLiquidityRules` contract are what
give a settle the authority to touch both the operator-signed slice state and
the registrar-controlled LP tokens at once; that machinery is covered in
[LP Tokens](lp-tokens.md).

## Worked example: one full cycle

Concrete numbers make the flow easier to hold. Take a fresh `BTC/USDC` pool with
a 30 bps fee (`feeBps = 30`); every figure is what the on-ledger `Decimal` math
(scale 10, floored) produces.

1. **Alice funds the pool** with `10.0 BTC` and `200,000.0 USDC`. That creates
   two slices (one per side) and mints her the first LP supply,
   `sqrt(10 · 200,000) = 1,414.2135623730` LP. Reserves: `10.0 BTC` /
   `200,000.0 USDC`.
2. **Bob swaps `1.0 BTC`.** The fee is taken on the input, so `0.997 BTC` drives
   the curve: `Δout = floor(0.997 · 200,000 / (10 + 0.997)) = 18,132.2178776029
   USDC`. The full `1.0 BTC`, fee included, stays in the pool.
3. **Reserves after the swap:** `11.0 BTC` / `181,867.7821223971 USDC`. The
   product `x · y` has grown, and that growth is the fee — now owned by the LPs.
4. **Alice redeems.** She is the only LP, so burning all `1,414.2135623730` LP
   returns the entire current reserves: `11.0 BTC` + `181,867.7821223971 USDC`.
   She deposited `10 BTC + 200,000 USDC` and withdrew `11 BTC + 181,867.78 USDC`;
   the difference is Bob's fee.

[`PoolRoundingTests.daml`](../../trading-tests/CantonDex/Tests/PoolRoundingTests.daml)
guarantees the pool never pays out more than the exact floored amount, so these
figures are reproducible on-ledger.

## Availability and the LP exit boundary

The atomic remove flow protects correctness when it runs; it does not make
redemption permissionless. An LP holder owns LP tokens, while reserve
allocations are authored for the pool operator and the remove-rules contract is
co-signed by the operator and LP registrar. Consequently:

- routine redemption requires both operator and registrar availability;
- a holder cannot withdraw a reserve slice through `Allocation_Withdraw`,
  because the holder is not that allocation's authorizer;
- each slice is `committed = true` with `settlementDeadline = None`, so the V2
  withdrawal rule also prevents its operator authorizer from using
  `Allocation_Withdraw`;
- the operator is the settlement executor and can cancel a reserve allocation,
  while the LP holder cannot cancel or withdraw it.

This single-operator liveness dependency is intentional in the reference and
is not suitable as an unstated production custody assumption. A production
fork should add its chosen governed/threshold execution and emergency-exit
model, then audit that model separately. Giving slices a deadline alone would
not create an LP-holder exit; it would create an operator withdrawal and slice
renewal problem. See [Non-goals](non-goals.md#lp-redemption-has-an-explicit-liveness-dependency).

---

### Reference / details

- **Residual trust boundary.** `PoolState`, `PoolSlice`, and the reserve
  allocation account are operator-controlled. A malicious operator could
  fabricate a parallel state or cancel reserve allocations; an unavailable
  operator can block LP redemption. `PoolRules_ReconcileState` detects
  accounting drift against live slices, but it does not provide governance or
  liveness. Production hardening must replace this single-party boundary with
  the deployment's governed execution and emergency-exit design.
- **Slices are long-lived, and some registries cap that.** The committed
  allocations backing slices persist between operations. A registry may bound
  allocation lifetime — Amulet enforces `tokenStandardMaxTTL` (default
  **90 days**) from Splice 0.6.11 — so against such a registry the operator must
  roll slices into fresh allocations before the cap expires. See
  [Registry Integration](../guides/registry-integration.md#allocation-lifetime-caps).
- **Mint/burn accounts.** The LP-token legs use the special
  `mintAccount`/`burnAccount` (`owner = None`); the registry must support them
  at the `Allocation` signatory, settlement crediting, and allocate-factory
  sites. `Registry.V2` already does.
- **Off-ratio adds don't inflate reserves.** LP tokens are minted against the
  limiting side, so only the ratio-matched part of a deposit enters the slices;
  the unmatched excess is refunded to the provider in the same batch and never
  reaches `reserves`.

**Where to read next:** [LP Tokens](lp-tokens.md) · [Pricing](pricing.md) · [Registry Integration](../guides/registry-integration.md) · [All docs](../README.md)
