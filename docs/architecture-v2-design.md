# Daml core redesign — design note

Status: proposal, pending review. Gates DEX-40, DEX-41, DEX-43 (and
DEX-42). No code until the approach is agreed.

## Why

The Canton team review (DEX-36) raised three structural points about the
DEX Daml core:

- **DEX-40** — the Pool carries all its committed allocations inline
  (`baseSlices : [PoolSlice]`), so every add/remove/swap rewrites the
  whole contract and it grows unbounded with depth.
- **DEX-41** — Pool is a fat template: 11 choices mutating the same
  contract that holds the reserves. State and behaviour are entangled.
  The reviewer points to the Rules pattern (Amulet / TestTokenV2):
  thin state templates + a Rules contract per domain.
- **DEX-43** — there are really two apps in one: an LP-token registry
  and pool/order-matching. Splitting them lets different order kinds
  settle against a generic pool surface.

Overarching: *make the app easy to reason about, so its behaviour is
convincing by inspection.* The three points are one workstream because
all reshape the same `Pool` contract; doing them piecemeal would churn
the same code three times.

## Current shape

```
Pool (one fat template)
 ├─ state: reserves, status, feeBps, baseSlices[], quoteSlices[], …
 └─ choices: Initialize, AddLiquidity, RemoveLiquidity, Swap,
             ComputeSwapOut, CollectOperatorFees, RecordLPSupply,
             UpdatePublicReaders, Pause, Resume
LPToken (LPTokenPolicy + LPMintRequest + LPBurnRequest) — interleaved,
   imported by Pool
Order / OrderFundingRequest / OrderMatchExecution / SwapExecution /
   Rfq / MatchedTrade — separate flows, each settling on its own
```

## Proposed shape (Amulet-style)

Three components, each a clear ownership boundary.

### 1. LP-token registry (own component)

A registry that issues/burns the LP instrument through the standard
token-standard interfaces, with no knowledge of pool internals.

- `LpRegistry` (state: instrument config, circulating supply) +
  `LpRegistryRules` (choices: mint, burn) — or reuse the existing
  `CantonDex.Registry.V2` shape, scoped to the LP instrument.
- Pool/order-matching becomes a *consumer*: it asks the registry to
  mint/burn, it doesn't own the policy logic.

### 2. Pool state vs. Pool rules (DEX-41)

- `Pool` becomes immutable config: `{ operator, lpRegistrar, admin,
  pair, feeBps, lpInstrumentId }`. No reserves, no slice list (see §3)
  — so trading ops never rewrite it. Status lives in a small separate
  contract. No trading choices on `Pool` itself.
- `PoolRules` (one per venue/admin) holds the operational choices:
  `Initialize`, `AddLiquidity`, `RemoveLiquidity`, `Swap`. Each fetches
  the `Pool` state, validates, writes the new state. Mirrors
  `AmuletRules` operating on `Amulet`.
- Governance choices (`Pause`, `Resume`, `UpdatePublicReaders`, fee
  changes) move to the rules contract too, separating market operation
  from governance.

### 3. Slices as contracts (DEX-40) — and reserves derived, not stored

**The real bottleneck is `Pool.reserves`, not the slice list.** Moving
slices out of `Pool` only shrinks the contract; if `Pool` still holds
aggregate reserves, every add/remove/swap rewrites that one contract to
update the totals, so all ops still serialize on a hot singleton.
"Slices as contracts" does **not** by itself fix contention.

We choose the no-hot-singleton end state:

- `PoolSlice` becomes a template `{ poolKey, side, allocationCid,
  amount }` (signatory operator/lpRegistrar).
- **`Pool` becomes immutable config** — `{ operator, lpRegistrar,
  admin, pair, feeBps, lpInstrumentId }`. It carries **no reserves and
  no slice list**, so it is never rewritten by trading ops. Status
  (pause/resume) moves to a separate small contract so config stays
  immutable.
- Reserves are **derived** by summing active `PoolSlice` contracts.
- Rules choices touch only the slices they modify:
  - Add creates a new `PoolSlice` (conflicts with nothing).
  - Remove archives the boundary slices passed in, re-allocates the one
    leftover.
  - Swap consumes/rolls the slice(s) it sources from.
- The operator-backend indexer tracks slices by pool and supplies the
  relevant CIDs per call.

#### The sub-decision (B) forces: how swap pricing reads reserves

Constant-product pricing needs *total* reserves (`x*y=k` uses the whole
pool). With reserves derived, a swap must read the slice set to price —
which has a consistency cost that must be named, not hidden:

- **(B1) Global curve, slices read for pricing.** A swap `fetch`es the
  active slices to compute total reserves, prices against the global
  curve, and writes only the slice(s) it sources. `fetch` is
  non-consuming, so concurrent **add/remove don't block swaps**. But a
  swap that fetched a slice another swap then archives will fail —
  **concurrent swaps that overlap on a sourced slice still conflict**.
  Net vs. (A): add/remove become concurrent; swaps serialize only when
  they touch the same slice, not globally. Pricing stays standard
  `x*y=k`. Reserve read is O(n) in slice count.
- **(B2) Sharded liquidity.** Each slice prices independently; a swap
  routes to specific slice(s); fully concurrent. But the pool is no
  longer a single global constant-product curve — it's a set of
  independent buckets, which changes the economic semantics and the LP
  share math.

**Recommendation: (B1).** It removes the hot singleton (the reviewer's
actual concern) without redefining the AMM's economics. The residual
limitation — concurrent swaps sourcing the same slice conflict, and the
O(n) reserve read — is bounded and honestly stated, not hidden. (B2) is
named as a further option only if true swap parallelism is required;
it's a different product, not a refactor.

Cost note: (B) is materially more work than the original (A)-with-
smaller-contracts framing. The swap math's data dependency changes from
"read one number" to "read and validate against a slice set," and
add/remove/swap all need an explicit slice-selection input from the
operator-backend.

### 4. DvP LP mint (DEX-42, follows from §1+§2)

Once the LP registry is a clean component and choice-context threading
(DEX-37) is in place, model LP mint as delivery-versus-payment: the
LP's base+quote allocation and the registrar's LP-token delivery settle
in one batch via an iterated allocation. Reference:
`vendor/splice/token-standard/splice-token-standard-v2-test/daml/Splice/Tests/TestDeliveryVersusBurnMint.daml`.

## Target module layout (sketch)

```
trading/CantonDex/
  Lp/        Registry.daml, Rules.daml        -- DEX-43 component 1
  Pool/      Pool.daml (state), Rules.daml,   -- DEX-41
             Slice.daml                        -- DEX-40
  Order/     Order.daml, Matching.daml         -- consumes Pool/Rules
  Rfq/       Rfq.daml
  Settlement/ MatchedTrade.daml                -- shared settle surface
```

Order kinds (resting orders, RFQ, swaps) all settle against the same
`Pool/Rules` + settlement surface, rather than each re-implementing it.

## Migration path (incremental, reviewable)

Sequence so each step is a coherent unit and `trading-tests` stays green:

1. **DEX-40 (reserves derived from slices, Pool → config).** The
   biggest single step now, because of the (B) decision: slices become
   contracts, `Pool` loses its reserves + slice list, and the swap math
   moves from "read one number" to "read+validate a slice set" (B1).
   Status moves to a separate contract. This is where the hot-singleton
   contention is actually removed.
2. **DEX-41 (Rules pattern)** — split the trading choices out of the
   old Pool into `PoolRules` operating on the (now immutable) `Pool`
   config + the slice contracts.
3. **DEX-43 (component split)** — carve the LP registry out; point
   `PoolRules` mint/burn at it.
4. **DEX-42 (DvP LP mint)** — last; needs §1–§3 + DEX-37 landed.

Each step keeps `trading-tests` passing; the in-script tests are the
regression guard. Note DEX-40 is no longer "the most contained" step —
the (B) decision makes it the heaviest. DEX-40 and DEX-41 may be worth
doing as one PR since (B) already removes reserves from `Pool`, which is
most of what DEX-41 needs.

## Trade-offs / open questions for the reviewer

1. **Reserves model — DECIDED: (B).** Reserves are derived from slice
   contracts; `Pool` is immutable config with no reserves, so trading
   ops never rewrite a shared contract. This removes the hot-singleton
   contention that (A)-with-smaller-contracts left in place. Concrete
   mechanism is **(B1)**: global constant-product, swap reads the slice
   set for pricing; add/remove run concurrently with swaps; concurrent
   swaps conflict only when they source the same slice. **(B2)** (sharded
   per-slice pricing, full swap parallelism, different economics) is a
   future option, not this milestone. Reviewer: confirm B1, or push for
   B2 now?
2. **Rules granularity.** One `PoolRules` per venue (all pools) vs. one
   per pool. Amulet has a single `AmuletRules`. Proposal: one per venue;
   pools are addressed by key. Note: since `Pool` is now immutable config
   and reserves live on slices, the rules contract is stateless — this
   choice is mostly about authority/observability, not contention.
3. **LP registry reuse.** Build a dedicated `Lp/Registry` or reuse
   `CantonDex.Registry.V2` parametrised for the LP instrument? Reuse is
   less code; a dedicated one is clearer ownership.
4. **DvP LP mint (DEX-42).** Required this milestone, or acceptable as a
   refinement after DEX-40/41? Non-atomic mint today: the receipt
   holding is created directly rather than as a settlement leg.
5. **Scope of the component split for M-series.** Is DEX-43 in scope for
   the current milestone, or is DEX-40 + DEX-41 (scalability + clarity)
   enough for now with DEX-43 deferred?

## Non-goals

- No on-chain behaviour change to settlement semantics — same V2
  allocation + SettleBatch flow, restructured.
- No smart-upgrade lineage to preserve (reference impl; see DEX-39).

## Recommendation

Land the four correctness/cleanup PRs (DEX-37/38/39/46) first. Then do
**DEX-40 + DEX-41 as one PR** — the (B) decision removes reserves from
`Pool` (DEX-40), which is most of what the state/behaviour split
(DEX-41) needs, so splitting them would churn the same contract twice.
This is the heaviest single piece of the redesign and the one that
actually removes contention; budget accordingly. Gate DEX-43 and DEX-42
on a second review of the result.

Reviewer asks, in priority order: confirm the **(B1) reserves model**
(Q1), the **DEX-43 scope** (Q5), then Q2/Q3/Q4.
