# Canton-Dex Architecture

## Purpose

Canton-Dex is a token-standard-native reference DEX for Canton.

It is intentionally not a generic settlement engine. The goal is to show
builders how to build a real exchange directly on top of:

- Token Standard V2 allocations and batch settlement
- registry-backed `InstrumentConfiguration`
- Canton privacy, routing, and atomic transaction semantics

## Design Inputs

The architecture is based on three concrete upstream inputs.

### 1. TradingAppV2

The `TradingAppV2` example establishes the basic trading pattern we want to
reuse:

- the application owns trade state such as `OTCTrade`
- the venue or executor requests per-authorizer allocations
- allocations are grouped by admin and settled through
  `SettlementFactory_SettleBatch`
- cancellation is an application concern, not a hidden wallet concern

That example still contains V1/V2 bridging for compatibility. We can learn from
that structure without making mixed-mode support the center of this repo.

### 2. Registry workflows

The registry docs anchor the instrument model:

- a registrar creates an `InstrumentConfiguration` for each supported
  instrument
- holder credentials govern transfer eligibility
- issuer credentials govern mint and burn eligibility
- the instrument config can carry external identifiers such as ISIN or CUSIP

This means the DEX should treat `InstrumentId` as the join key into richer
instrument semantics instead of hardcoding asset families in the exchange.

### 3. Token Standard V2 allocation surface

The pool design depends on the V2 allocation extensions released in
Splice's `token-standard-v2-upcoming` branch:

- iterated settlement
- `nextIterationFunding`
- committed allocations
- `FinalizedAllocation.extraTransferLegSides` (replaces the
  draft-era `Allocation_Adjust` choice)
- settle results that return next-iteration allocation state

Those changes are what make it realistic to use allocations not only for trade
reservation but also for long-lived pool inventory.

## Core Decisions

1. Token standard first
   - the DEX should use V2 allocation primitives directly, not hide them behind
     a generic settlement abstraction

2. DEX contracts own market logic
   - orders, matched trades, pools, and LP state belong to the application

3. Allocations represent funds, not just approval
   - bids and asks are backed by allocations
   - pool inventory is represented by committed and iterated allocations

4. Arbitrary `InstrumentId` pairs
   - the DEX should support any pair the registry exposes, not just
     "cash vs asset" flows

5. Instrument lifecycle stays standard
   - bonds, options, escrow obligations, margin-like positions, and LP tokens
     should all remain token-standard holdings whose semantics come from
     instrument configuration and lifecycle facilities

6. LP token is first-class
   - pool shares should be their own instrument and be holdable, transferable,
     and eventually tradable

7. Workflow-first design
   - the shape of Daml choices and state transitions matters more than chasing
     full feature parity with existing AMMs

8. Executor-controlled funds need on-ledger guardrails
   - once iterated or committed allocations exist, the executor can drive
     their settlement path
   - therefore every permitted use of those funds should be validated by Daml
     contract state and choice logic, not only by an off-ledger service

## System Model

```text
┌──────────────────────────────────────────────────────────────┐
│                        Client Layer                          │
│    UI / API clients / market makers / LP operators          │
└──────────────────────────────┬───────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────┐
│                  Off-Chain Service Layer                     │
│  order matching · pool math · quote generation              │
│  registry lookups · lifecycle automation · observability    │
└──────────────────────────────┬───────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────┐
│                    DEX Application Layer                     │
│  orders · matched trades · pools · LP issuance              │
│  reserve accounting · fee accounting · cancellations        │
└──────────────────────────────┬───────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────┐
│                 Token Standard / Registry Layer              │
│  HoldingV2 · AllocationV2 · AllocationRequestV2             │
│  SettlementFactory · InstrumentConfiguration                │
└──────────────────────────────┬───────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────┐
│                        Canton Layer                          │
│   participants · routing · privacy · atomic execution       │
└──────────────────────────────────────────────────────────────┘
```

## Workflow-First Reading

The best way to read this architecture is through the workflows:

- pair listing
- OTC / RFQ trade settlement
- resting order placement and matching
- pool creation
- add liquidity and remove liquidity
- pool swap
- lifecycle-driven instrument migration

Those workflows are described in [workflows.md](./workflows.md). The contracts
should be shaped around those state transitions, not the other way around.

## On-Ledger Model

### Instrument layer

The instrument layer defines what is being traded.

Expected concepts:

- `InstrumentConfiguration`
- registry-managed transfer rules and credentials
- versioned instrument semantics
- optional external identifiers such as ISIN or CUSIP

The DEX should not understand a bond, option, or margin position by special
case. It should understand that it trades an `InstrumentId`, and the registry
should explain what that instrument means.

### Order and trade layer

Orders should be represented by DEX contracts plus allocations.

A practical model is:

- `Order` or `Quote` stores side, pair, price, remaining quantity, and expiry
- one or more `V2.Allocation` contracts prove that the order is prefunded
- a matcher creates `MatchedTrade` or similar application state
- settlement uses the matched trade plus the referenced allocations

Important nuance:

- the order contract is the market object
- the allocation is the reserved-funds object

That keeps price-time priority and cancellation in app logic while still making
fund reservation standard-native.

### Pool layer

The pool should also be represented by DEX contracts plus allocations.

A practical model is:

- `Pool` defines the pair, fee model, executor, and accounting policy
- LP deposits create or refresh pool-managed committed allocations
- pool reserves are tracked in application state for pricing purposes
- the actual locked pool funds live in committed and iterated allocations
- each swap adjusts those allocations, settles them, and rolls forward the
  next-iteration allocations

This is the critical architectural move from the Simon guidance: pool inventory
should be allocation-native, not a custom internal balance model with a
different settlement bridge behind it.

### Executor-control constraint

The V2 allocation extensions make long-lived, iterated allocations workable for orders and pools,
but it also raises a control question:

- once funds sit in committed / iterated allocations, the executor is the party
  that can drive their settlement path

That is acceptable only if the DEX application layer constrains what those
funds may be used for.

The intended model is:

- `Order`, `MatchedTrade`, `Pool`, and related app contracts define the exact
  business state that authorizes a use of funds
- `Allocation_Adjust` and `SettlementFactory_SettleBatch` are only exercised as
  part of those app-owned workflows
- the off-chain operator proposes actions, but the ledger-visible contracts
  validate the quantity, pair, expiry, side, and reserve references being used

This also means we should avoid designs where a routine action touches every
pool allocation at once. The implementation now follows this for all hot-path
flows:

- one prefunded allocation per order
- a sharded set of committed reserve slices per pool side, each carrying its
  own allocation CID and tracked amount
- `PoolRules_Swap` adjusts only the input-side slice and the output-side
  covering prefix, settles them, and re-wraps the next-iteration allocations;
  other slices are untouched
- remove-liquidity settlement (`PoolLiquidityRules_SettleRemoveLiquidity`) walks the
  slice list from the front, cancels only the slices it needs to cover the
  redemption, and re-allocates at most ONE boundary slice per side for the
  leftover; slices beyond the boundary are untouched
- long-tail maintenance actions such as consolidation or migration stay
  explicit and exceptional

The data carrier is the standalone `PoolSlice` contract:
`{ poolId, side, allocationCid, amount }`. The operator indexer supplies
ordered slice contract IDs to the rules choices; the immutable `Pool` no
longer stores an unbounded slice list.
template. The slice's `amount` is reconciled with the underlying allocation's
funding on every choice that touches it.

### LP token layer

The DEX should mint its own LP token instrument.

Expected characteristics:

- LP token has its own `InstrumentConfiguration`
- deposit and withdraw mint and burn LP supply under DEX rules
- LP positions can be held like any other token-standard instrument
- the LP instrument definition should explain redemption policy and pool
  identity

## Token Standard Usage

### For OTC and RFQ

The `TradingAppV2` pattern is the right starting point:

- create matched trade state in the app
- request allocations from each authorizer
- split settlement by admin as required by the token standard
- settle with `SettlementFactory_SettleBatch`
- archive or cancel outstanding requests as part of app cleanup

This should be the first runnable path because it proves the core settlement
story with minimal market-structure complexity.

### For bids and asks

Orders should be prefunded using allocations:

- production-grade resting orders also require V2-style prefunded and
  adjustable allocation semantics, because the exact matched transfer legs are
  not known at order placement time

- bid order locks the quote-side asset
- ask order locks the base-side asset
- partial fills should either shrink the order while releasing excess funding or
  roll the funding forward using iterated allocation semantics once available

This gives the order book a clean "resting order equals live reserved funds"
story.

### For pools

Pool funds require the V2 allocation shape.

The design assumes:

- allocations may be committed so LP liquidity cannot be casually withdrawn
- allocations may fund future iterations
- executors may adjust the transfer legs before each swap settlement
- settlement returns the rolled-forward allocation for the next iteration

Without those semantics, a pool-backed design would drift back toward custom
escrow or off-ledger reserve tracking, which is exactly what this repo is trying
to avoid.

## Admin and Pairing Model

The DEX should support arbitrary trading pairs of `InstrumentId`, but
allocations still need to respect token-standard admin boundaries.

That implies:

- a trade or swap may need separate allocation tracks per admin
- the app should group settlement work by admin, as in `TradingAppV2`
- pool state should store active allocation references in a way that makes
  admin partitioning explicit

This is an important design constraint, not an implementation detail.

## Rich Asset Lifecycle Model

The standard holding model remains fungible:

- amount
- instrument
- owner

Richer asset semantics should be attached through the instrument configuration
referenced by `instrumentId`.

Examples:

- a bond config can carry CUSIP, maturity, coupon schedule, and callability
- an option config can carry strike, expiry, and exercise style
- an escrow obligation can point to the deal or obligation definition
- a margin-like position can point to the loan or trade configuration
- an LP token config can point to the pool and redemption semantics

Lifecycle management then becomes a versioning problem:

- create a new instrument-config version when stateful semantics change
- encode or derive the new instrument identity from that version
- use registry-specific facilities to apply lifecycle side effects such as
  coupon payments, exercise outcomes, or maturity transitions

In other words, the registry side should be able to take one instrument version
in and hand back a new version with the lifecycle side effects applied.

The important point is that the traded asset remains a standard holding even
when its lifecycle is rich.

## Off-Chain Services

Off-chain services are still necessary, but their job is narrower than in older
generic-settlement architectures.

They should focus on:

- order matching and quote generation
- pool pricing and fee computation
- registry discovery and choice-context lookup
- lifecycle automation for versioned instruments
- transaction submission, retries, and observability

They should not become the main abstraction for moving value around. The token
standard remains the settlement substrate.

## Dependency Boundary

The reference architecture has a deliberate split:

- OTC and RFQ flows can be implemented against the current `TradingAppV2`
  surface
- pool-backed liquidity should be implemented only against a branch that
  includes the V2-style allocation changes

If the upstream API shape changes before landing, this repo should preserve the
same design intent even if field names or result structures move.

## Repository Shape

```text
Canton-Dex/
  docs/
    architecture.md
    implementation-plan.md
  daml/
    dex/
      Order.daml
      MatchedTrade.daml
      Pool.daml
      Lp/Policy.daml
      Lp/Instrument.daml
    instrument/
      DexInstrumentConfiguration.daml
      Lifecycle.daml
    tests/
      OtcFlows.daml
      PoolFlows.daml
  services/
    matching-engine/
    pool-operator/
    registry-client/
```
