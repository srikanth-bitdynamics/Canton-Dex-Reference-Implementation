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

- `Pool` becomes thin: `{ operator, lpRegistrar, admin, pair, feeBps,
  status, reserves, lpInstrumentId }` + slice references (see §3).
  Minimal choices — archive/replace under rules authority only.
- `PoolRules` (one per venue/admin) holds the operational choices:
  `Initialize`, `AddLiquidity`, `RemoveLiquidity`, `Swap`. Each fetches
  the `Pool` state, validates, writes the new state. Mirrors
  `AmuletRules` operating on `Amulet`.
- Governance choices (`Pause`, `Resume`, `UpdatePublicReaders`, fee
  changes) move to the rules contract too, separating market operation
  from governance.

### 3. Slices as contracts (DEX-40)

- `PoolSlice` becomes a template `{ poolKey, side, allocationCid,
  amount }` (signatory operator/lpRegistrar).
- `Pool` state holds aggregate reserves + a stable pool key, not the
  slice list.
- Rules choices take the specific slice CIDs they operate on:
  - Add appends a new `PoolSlice`.
  - Remove archives the boundary slices passed in, re-allocates the
    one leftover.
  - Swap rolls the named head slice forward.
- The operator-backend indexer tracks slices by pool and supplies the
  relevant CIDs per call.

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

Doing all three at once is one big PR; instead sequence them so each is
a coherent unit and the test suite stays green throughout:

1. **DEX-40 (slices as contracts)** first — it's the most contained and
   reshapes `Pool` state in a way DEX-41 then builds on. Pool keeps its
   choices for now but operates on slice CIDs.
2. **DEX-41 (Rules pattern)** — split the choices out of `Pool` into
   `PoolRules`. Now that slices are external, `Pool` state is small.
3. **DEX-43 (component split)** — carve the LP registry out; point
   `PoolRules` mint/burn at it.
4. **DEX-42 (DvP LP mint)** — last; needs §1–§3 + DEX-37 landed.

Each step keeps `trading-tests` passing; the in-script tests are the
regression guard.

## Trade-offs / open questions for the reviewer

1. **Pool key.** Slices reference the pool by a stable key, not the
   `Pool` contract id (which rotates on every state change). Proposal: a
   `(operator, baseInstrumentId, quoteInstrumentId)` key. Acceptable, or
   should it be a dedicated `PoolId` newtype contract?
2. **Rules granularity.** One `PoolRules` per venue (all pools) vs. one
   per pool. Amulet has a single `AmuletRules`. Proposal: one per venue;
   pools are addressed by key.
3. **Swap contention.** Slices-as-contracts means a swap touches the
   head slice contract; concurrent swaps on the same pool contend on
   that one slice. Is head-slice rotation enough, or do we want a
   slice-selection strategy (largest/oldest) to spread contention?
4. **LP registry reuse.** Build a dedicated `Lp/Registry` or reuse
   `CantonDex.Registry.V2` parametrised for the LP instrument? Reuse is
   less code; a dedicated one is clearer ownership.
5. **Scope of the component split for M-series.** Is DEX-43 in scope for
   the current milestone, or is DEX-40 + DEX-41 (scalability + clarity)
   enough for now with DEX-43 deferred?

## Non-goals

- No on-chain behaviour change to settlement semantics — same V2
  allocation + SettleBatch flow, restructured.
- No smart-upgrade lineage to preserve (reference impl; see DEX-39).

## Recommendation

Land the four correctness/cleanup PRs (DEX-37/38/39/46) first. Then take
DEX-40 → DEX-41 as the next concrete work (scalability + the
state/behaviour separation the reviewer most wants), with DEX-43 and
DEX-42 gated on a second review of the result. Ask the reviewer to weigh
in on the five open questions before step 1.
