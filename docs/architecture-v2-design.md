# Daml core redesign — design note

Status: **approach agreed (Option B).** This note records the accepted
end-state and the corrections that came out of reading Digital Asset's
own Token Standard V2 sources (`vendor/splice/`). Gates DEX-40, DEX-41,
DEX-43 (and DEX-42). Implementation sequenced in the migration section.

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

## What DA's V2 sources actually do (and how it shaped this design)

Before fixing the contract set we read the upstream references vendored
under `vendor/splice/`:

- `daml/splice-amulet/daml/Splice/Amulet.daml` + `AmuletRules.daml` —
  the canonical state-vs-rules split.
- `token-standard/examples/splice-token-test-trading-app-v2/daml/Splice/Testing/Apps/TradingAppV2.daml`
  — a DvP venue built on the V2 allocation surface.
- `token-standard/splice-token-standard-v2-test/daml/Splice/Tests/TestDeliveryVersusBurnMint.daml`
  — mint/burn modelled as DvP.

Four things from that reading directly change what we build:

1. **No contract keys, anywhere.** There is not a single `key` /
   `fetchByKey` / `lookupByKey` in the whole DA token-standard tree,
   Amulet included. `AmuletRules` — the canonical singleton Rules
   contract — is reached by `readAs` + a `nonconsuming AmuletRules_Fetch`
   choice, or by passing its `ContractId` in. Canton is steering away
   from contract keys (performance, multi-synchronizer). **We follow
   suit: no keys on Pool/PoolState/PoolSlice.** This reverses the
   earlier C2 amendment that proposed `key poolId`.

2. **Contract-swap is guarded by a value, not a key.** Every
   `AmuletRules_*` choice carries `expectedDso : Optional Party`, with
   the comment that it *"must always be set to protect from malicious
   delegees swapping the AmuletRules contract out for one under their
   control."* We adopt the same guard: `PoolRules` choices take
   `expectedPoolId` (and the operator) and assert it against the
   fetched `Pool`/`PoolState`.

3. **Mint/burn is DvP, not a bespoke request handshake.**
   `TestDeliveryVersusBurnMint` models a mint as a transfer leg from a
   special `mintAccount admin`, authorized by the admin's *own*
   allocation and settled atomically in the same `SettleBatch` as the
   counterparties' legs. The test asserts non-admins cannot create that
   allocation (`allowed actors: [[admin]]`). This collapses our current
   two-step `LPMintRequest` → `LPMintRequest_AcceptAndMint` into one
   leg in the deposit batch (DEX-42).

4. **Initiation is an `AllocationRequest`, not a custom template.**
   `OTCTrade_RequestAllocations` creates `OTCTradeAllocationRequest`
   (implements `V2.AllocationRequest`); the trader's wallet accepts it
   through the standard interface, driven by
   `availableActions : Map Action [[Party]]`. Our `PoolRules`
   add-liquidity/swap initiation emits a `*AllocationRequest` so any
   CIP-0103 wallet can accept it, instead of a bespoke request only our
   own UI understands.

Honest caveat: DA's reference is an **OTC matched-trade venue, not an
AMM**. There is no upstream precedent for liquidity sharding — the
`PoolSlice` construct and the multi-slice swap below are *ours*. We say
so rather than implying they mirror a DA pattern.

## Proposed shape (Amulet-style, DA-corrected)

Three components, each a clear ownership boundary.

### 1. LP-token issuance (reuse `Registry.V2`, no parallel registry)

The LP instrument is issued/burned through the standard token-standard
interfaces with `admin = lpRegistrar`, reusing the existing
`CantonDex.Registry.V2` rather than building a second registry. The
pool/order side is a *consumer*: it requests LP mint/burn via the V2
allocation surface (see DvP mint, §4); it does not own issuance policy.

### 2. Pool state vs. Pool rules (DEX-41)

- `Pool` becomes **immutable config**:
  `{ poolId, operator, lpRegistrar, admin, baseInstrumentId,
  quoteInstrumentId, lpInstrumentId, feeBps, operatorFeeBps }`. No
  reserves, no slice list, no status — so trading ops never rewrite it.
- `PoolState` is the **minimal hot contract**:
  `{ poolId, reserves {base, quote}, totalLpSupply, status }`. This is
  the one contract a swap must update; keeping it tiny is the point.
- `PoolSlice` is `{ poolId, side, allocationCid, amount }`, signatory
  `operator`, cid-addressed (no key).
- `PoolRules` (one per venue) holds the operational choices, all
  `nonconsuming`, signatory `operator`, mirroring `AmuletRules` over
  `Amulet`: `Initialize`, `AddLiquidity`, `RemoveLiquidity`, `Swap`,
  plus governance `Pause`, `Resume`, `SetFees`. Each choice fetches the
  `Pool` config + `PoolState` (cids passed in by the operator-backend
  indexer), asserts `expectedPoolId`, validates, writes the new
  `PoolState` and the slices it touches.

`PoolRules` holds **no per-trade mutable state** — exactly like
`AmuletRules`. The Rules pattern here is *organizational*: it groups
behaviour and gives one authority/observability surface. The real
enforcement is the signatory/controller set on `Pool`, `PoolState`, and
`PoolSlice`, not the Rules contract (C4).

### 3. Slices as contracts + reserves on `PoolState` (DEX-40)

The original bottleneck was `Pool.reserves` on the fat contract: every
op rewrote one hot singleton. Moving slices out is not enough on its
own — if aggregate reserves still live on a contract every op rewrites,
ops still serialize.

End state:

- Reserves live on the **small** `PoolState`, not on `Pool` config.
- `PoolSlice` contracts hold the committed allocations; add creates a
  new slice (conflicts with nothing), remove/swap touch only the
  slices they source.
- A constant-product swap still needs *total* reserves (`x*y=k` is
  global). Those totals are read from `PoolState` — one small contract
  — rather than recomputed by summing every slice. `add`/`remove`/`swap`
  all update `PoolState`, so they serialize on it **by design**: a CFMM
  has a single global price; you can shard the holdings (`PoolSlice`),
  you cannot shard the price. We make that serialization point as small
  as possible (`PoolState`) and honest, rather than pretending it away.

#### C1 — multi-slice swap (ours, no DA precedent)

`PoolRules.Swap` takes an ordered list of output-side `PoolSlice` cids
from the operator-backend and:

- walks them consuming until cumulative amount ≥ `amountOut`;
- asserts `sum(provided output slices) ≥ amountOut`, else aborts (this
  is the swap-size guard: a swap larger than sourced liquidity fails
  rather than under-delivering);
- re-allocates the one boundary slice for the leftover;
- appends one new input-side `PoolSlice` for the amount received;
- updates `PoolState.reserves` by both deltas.

Pricing stays standard global `x*y=k` against `PoolState`. Concurrent
swaps conflict only when they source the same output slice; add/remove
run concurrently with swaps because they don't consume output slices.

#### C3 — slice ↔ allocation lifecycle coupling

A `PoolSlice` and its underlying V2 allocation must be archived
together or the pool leaks committed funds. A single helper enforces
this at every call site:

```
resolveSlice : PoolSlice -> ExtraArgs -> Update ()
-- archives the PoolSlice AND exercises Allocation_Cancel on its
-- allocationCid; used by remove and by the swap boundary re-allocation.
```

This mirrors how `OTCTrade_Cancel` cancels each allocation alongside the
contract that referenced it.

### 4. DvP LP mint/burn (DEX-42) — collapses the two-step handshake

Following `TestDeliveryVersusBurnMint`: LP mint is a transfer leg
`mintAccount lpRegistrar → LP recipient`, authorized by an allocation
whose `authorizer = mintAccount lpRegistrar` and settled atomically in
the **same `SettleBatch`** as the LP's base+quote deposit legs. Burn is
the symmetric leg to `burnAccount lpRegistrar` in the withdrawal batch.

This retires the current `LPMintRequest` / `LPMintRequest_AcceptAndMint`
(and the burn equivalents) in `LPToken.daml`: instead of an operator
creating a request that the recipient + lpRegistrar jointly accept, the
mint is one more leg in the deposit allocation batch, atomic with the
liquidity it backs. Non-`lpRegistrar` parties cannot author the mint
leg (Daml authorization on the `mintAccount`), same property the DA
test asserts.

Reference:
`vendor/splice/token-standard/splice-token-standard-v2-test/daml/Splice/Tests/TestDeliveryVersusBurnMint.daml`.

## Target module layout (sketch)

```
trading/CantonDex/
  Pool/   Id.daml      -- PoolId
          Pool.daml    -- immutable config           (DEX-41)
          State.daml   -- PoolState (reserves/status) (DEX-40/41)
          Slice.daml   -- PoolSlice                   (DEX-40)
          Rules.daml   -- PoolRules (nonconsuming)    (DEX-41)
  Lp/     Instrument.daml -- LP issuance via Registry.V2 (DEX-43)
  Order/  Order.daml, Matching.daml   -- consumes Pool/Rules
  Rfq/    Rfq.daml
  Settlement/ MatchedTrade.daml       -- shared settle surface
  Registry/ V2.daml                   -- existing token-standard registry
```

Order kinds (resting orders, RFQ, swaps) all settle against the same
`Pool/Rules` + settlement surface, rather than each re-implementing it.

## Migration path (incremental, reviewable)

Each step keeps `trading-tests` green; the behavioural guard tests are
the regression net and stay stable across all five steps. DEX-40 adds
two cases: swap larger than the head slice fills across slices; swap
larger than total reserves aborts.

1. **PoolId + Pool config split.** Introduce `PoolId`; strip `Pool` to
   immutable config. Reserves/status move to a new `PoolState`.
2. **PoolState + PoolSlice (DEX-40).** Slices become contracts; swap
   math reads totals from `PoolState`; multi-slice swap (C1);
   `resolveSlice` helper (C3). This is where contention is actually
   removed and is the heaviest step.
3. **PoolRules (DEX-41).** Move trading + governance choices into a
   `nonconsuming` `PoolRules` over `Pool` + `PoolState` + slices, with
   the `expectedPoolId` guard (Amulet `expectedDso` pattern).
4. **Lp/Instrument via Registry.V2 (DEX-43).** Carve LP issuance into
   its own module; point pool deposit/withdrawal at it.
5. **DvP LP mint/burn (DEX-42).** Replace the `LPMintRequest` /
   `LPBurnRequest` handshake with mint/burn legs in the settle batch.

DEX-40 and DEX-41 are worth doing as one PR: step 1+2 already remove
reserves from `Pool`, which is most of what the state/behaviour split
needs, so splitting them would churn the same contract twice.

## Trade-offs / open questions for the reviewer

1. **Reserves model — DECIDED: Option B.** Reserves live on a minimal
   `PoolState`; `Pool` is immutable config. Swaps serialize on
   `PoolState` by design (a CFMM has one global price); add/remove run
   concurrently with swaps. Sharded per-slice pricing (different
   economics) is explicitly out of scope.
2. **No contract keys — DECIDED.** Cid-addressing + `expectedPoolId`
   value guard, matching DA's Amulet `expectedDso`. (Reverses the
   earlier key-based amendment.)
3. **Rules granularity.** One `PoolRules` per venue (pools addressed by
   `poolId`), matching the single `AmuletRules`. Since `Pool` is
   immutable config and reserves live on `PoolState`, the rules
   contract is stateless — this is about authority/observability, not
   contention.
4. **LP issuance reuse.** Reuse `CantonDex.Registry.V2` with
   `admin = lpRegistrar`; no parallel registry.
5. **DvP mint scope.** Modelled as DvP per the DA reference; lands as
   migration step 5.

## Non-goals

- No on-chain behaviour change to settlement semantics — same V2
  allocation + SettleBatch flow, restructured.
- No smart-upgrade lineage to preserve (reference impl; see DEX-39).
- No liquidity sharding of the price curve (B2). Slices shard holdings,
  not the global constant-product price.

## Recommendation

Land the correctness/cleanup PRs (DEX-37/38/39/46) first. Then do
**DEX-40 + DEX-41 as one PR** — Option B removes reserves from `Pool`
(DEX-40), which is most of what the state/behaviour split (DEX-41)
needs. This is the heaviest single piece and the one that actually
removes contention; budget accordingly. Gate DEX-43 (Lp/Instrument
carve-out) and DEX-42 (DvP mint) on a second review of the result.
