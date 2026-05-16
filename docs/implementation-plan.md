# Canton-Dex Implementation Plan

## Goal

Build a token-standard-native reference DEX on Canton that teaches builders how
to:

- trade arbitrary pairs of `InstrumentId`
- reserve bid and ask funds with `V2.Allocation`
- settle matched trades through `SettlementFactory`
- represent liquidity-pool inventory with `V2.Allocation`
- issue an LP token as a normal registry-backed instrument
- model rich asset lifecycle through versioned instrument configuration

## Source-Based Constraints

This plan is not starting from a blank architectural space.

### From TradingAppV2

We should reuse the core structure:

- app-owned trade contracts
- per-authorizer allocation requests
- admin-grouped settlement
- explicit app-level cancel and cleanup handling

### From registry workflows

We should treat registry contracts as the canonical place for:

- instrument identity
- holder credential rules
- issuer credential rules
- external identifiers
- lifecycle handoff points

### From PR 5333

We should assume pool funding is only correct on a branch that supports:

- iterated settlement
- committed allocations
- `Allocation_Adjust`
- rolled-forward next-iteration allocations in settle results

## Reference Outcome

The target deliverable is a reference DEX that clearly separates:

1. application contracts that express market structure
2. token-standard contracts that express reservation and settlement
3. registry contracts that express what the assets are

The educational value matters as much as the code. Builders should be able to
read the repo and understand where each concern belongs.

This should be approached as a workflow-design exercise first. The contract
model should be derived from the workflows in [workflows.md](./workflows.md),
not from a feature checklist borrowed from Uniswap.

## Non-Goals

The first versions should not attempt to:

- preserve `Lockable` compatibility as a primary architecture
- rebuild the older CCDS generic settlement model
- hide token-standard concepts behind a new universal wrapper
- solve every market type before the OTC and pool paths are clear
- treat synchronizer choreography as the product story

## Delivery Plan

### Phase 0 - Docs and dependency baseline

Objective:
- lock the design inputs and dependency assumptions before code spreads

Tasks:

- update `README.md`
- update `docs/architecture.md`
- update `docs/implementation-plan.md`
- add `docs/workflows.md`
- document the exact upstream dependency split:
  current `TradingAppV2` surface for trade flows and PR 5333 style branch for
  pool flows
- record the core data model for orders, matched trades, pools, and LP tokens
- record the canonical ledger workflows before implementing contracts

Exit criteria:

- the public design story is coherent
- the repo clearly states what is possible today and what depends on PR 5333

### Phase 1 - OTC and RFQ settlement core

Objective:
- prove the minimal matched-trade lifecycle directly on top of V2

Why this comes first:

- it follows the strongest upstream example
- it exercises allocation request, approval, settlement, and cancellation
- it avoids AMM complexity while validating the settlement substrate

Scope:

- arbitrary `InstrumentId` pair
- `TradeIntent`, `MatchedTrade`, and allocation-request flow
- one happy-path settlement
- one cancel or expiry path
- admin-partitioned settlement batches

Suggested on-ledger contracts:

- `TradeIntent`
- `MatchedTrade`
- `TradeAllocationRequest`

Suggested dependencies:

- `HoldingV2`
- `AllocationV2`
- `AllocationRequestV2`
- `SettlementFactory`

Exit criteria:

- two parties can reserve funds and settle a matched trade end to end
- the flow is documented as the canonical DEX trade settlement path

### Phase 2 - Prefunded order book

Objective:
- use allocations to represent live bids and asks, not just one-shot RFQ
  settlement

This phase should be built only against a branch that includes the PR 5333
semantics or their landed equivalent.

Scope:

- `Order` contracts for resting liquidity
- prefunded bid and ask model using allocations
- partial fill handling
- order cancel flow that releases or rolls forward funding
- off-chain matcher that produces `MatchedTrade`

Important design stance:

- the order contract is the market-facing object
- the allocation is the reserved-funds object

Exit criteria:

- a resting order can be posted, partially filled, fully filled, and cancelled
- the order book has a clear invariant tying live orders to live reserved funds

### Phase 3 - Pool-backed trading on PR 5333 branch

Objective:
- use allocations to represent pool inventory

This phase should be built only against a branch that includes the PR 5333
semantics or their landed equivalent.

Scope:

- `Pool` contract
- LP deposit and withdrawal flow tied to pool-managed allocations
- committed pool allocations
- iterated settlement for repeated swaps
- allocation adjustment before swap settlement
- rolled-forward next-iteration allocations after settlement

Expected model:

- pool reserves are priced from app state
- pool funds are actually locked in allocations
- each swap updates both the app accounting and the allocation chain

Exit criteria:

- one pool-backed swap works end to end
- pool liquidity is represented allocation-natively rather than by custom escrow

### Phase 4 - LP token and instrument lifecycle example

Objective:
- demonstrate that the DEX can issue its own tradable instrument and that richer
  asset families still fit the same standard model

Scope:

- LP token instrument configuration
- LP mint and burn on deposit and withdrawal
- one lifecycle-rich instrument example in addition to the LP token
- versioning guidance for lifecycle changes

Recommended examples:

- LP token as the first mandatory example
- bond-like instrument as the second example

This phase should explicitly answer:

- how does `instrumentId` point to instrument semantics?
- how do lifecycle changes produce a new tradable version?
- how do DEX contracts coexist with registry lifecycle facilities?

Exit criteria:

- LP shares can be held as a normal instrument
- at least one rich-asset example shows lifecycle without leaving the standard

### Phase 5 - Builder guide and production-shaped reference

Objective:
- make the repo teachable and believable as the foundation for a real app

Docs and operational items to add:

- quickstart
- how to add a new trading pair
- how to add a new instrument family
- how to issue a new LP token
- how allocations map to orders and pools
- how lifecycle versioning works in practice
- operator runbook and failure handling notes

Exit criteria:

- an external builder can follow the guide and explain the architecture
- the reference feels like a production-shaped learning artifact, not only a
  demo

## Architecture Decisions To Hold Constant

1. Token-standard-native first
   - no generic settlement wrapper as the primary path

2. DEX owns market logic
   - order book, matched trades, pools, and LP logic stay in app contracts

3. Registry owns asset semantics
   - `InstrumentConfiguration` and lifecycle facilities explain what is traded

4. Allocations are the reservation primitive
   - for orders today, for pools once PR 5333 semantics are available

5. Pairing stays instrument-agnostic
   - the app should support any `InstrumentId` pair that satisfies registry
     rules

## Upstream Dependency Gate

Before Phase 2 starts, answer these explicitly:

1. Has the PR 5333 allocation model landed, or do we intentionally build on a
   fork or branch?
2. What is the final upstream shape for iterated settlement and committed
   allocations?
3. Do we want the first public runnable release to be OTC plus order book only,
   with pool support marked experimental?

My current recommendation:

- use Phase 1 as the immediate runnable baseline on the current surface
- build the first production-shaped order-book or pool release on a
  PR-5333-compatible branch

## Suggested Initial File Backlog

### First Daml files

- `daml/dex/TradeIntent.daml`
- `daml/dex/MatchedTrade.daml`
- `daml/dex/Order.daml`
- `daml/dex/Pool.daml`
- `daml/dex/LPToken.daml`
- `daml/instrument/DexInstrumentConfiguration.daml`
- `daml/tests/OtcFlows.daml`
- `daml/tests/PoolFlows.daml`

### First service files

- `services/registry-client/README.md`
- `services/matching-engine/README.md`
- `services/pool-operator/README.md`
