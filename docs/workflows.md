# Canton-Dex Workflow Design

## Why Workflow First

The hard part of this reference DEX is not matching Uniswap feature-for-feature.
The hard part is getting the Daml workflows right so that:

- the app contracts own market structure
- token-standard contracts own reservation and settlement
- registry contracts own asset semantics
- the production instance is operationally believable

That means we should design workflows first and let features fall out of those
workflows.

## We Do Not Need Full Uniswap Parity

A production-shaped reference DEX does not need every Uniswap V2 or V3 feature.

It does need:

- single-pool or single-hop swaps
- add liquidity and remove liquidity
- LP token mint and burn
- slippage bounds
- fees and fee accrual
- order or RFQ settlement that proves the V2 allocation story
- cancellation and expiry flows
- operational controls, observability, and failure handling

It does not need on day one:

- concentrated liquidity
- ticks and tick crossing
- NFT positions
- permissionless pool factory
- multi-hop routing
- flash swaps
- advanced oracle and TWAP machinery

Those are worthwhile later features, but they are not required to validate the
core Canton-native design.

The chosen workflows cover the dominant reference-DEX shapes without claiming
full market parity: pair listing, single-hop constant-product swaps, LP
add/remove, prefunded orders, OTC/RFQ, cancellation, and operator recovery. If
this document makes volume-coverage claims in the future, they should be backed
by current market data rather than asserted qualitatively.

## Workflow Design Principles

1. One workflow, one business object
   - orders, trades, pools, and LP issuance each get their own app contract

2. Allocations represent funds
   - not just abstract approvals

3. Settlement is explicit
   - the DEX should create matched trade or swap state before calling settlement

4. Cancellation is a first-class workflow
   - no hidden cleanup assumptions

5. Registry lifecycle stays outside market logic
   - the DEX trades `InstrumentId`; the registry explains what that means
     through V2 views, metadata, and any registry-specific context/contracts

6. Executor-controlled funds must be usage-constrained on ledger
   - if committed or iterated allocations put funds under executor-driven
     settlement control, the app contracts must validate every permitted use
   - off-chain services may choose *when* to exercise a workflow, but not
     redefine *what* the funds may be used for

7. Keep hot-path transactions shard-local
   - avoid workflow shapes that require touching every pool reserve allocation
     for ordinary swaps or redemptions
   - prefer order-local or reserve-slice-local transactions, with
     consolidation handled as an explicit maintenance path

## Actors

- `Trader`
- `LiquidityProvider`
- `DexOperator`
- `Matcher`
- `PoolOperator`
- `Registrar`

For a reference deployment, `Matcher` and `PoolOperator` may both be operated
by the `DexOperator`, but the workflows should keep their responsibilities
separate.

## Core On-Ledger Contracts

- `DexPair`
- `MatchedTrade`
- `TradeAllocationRequest`
- `Rfq`
- `RfqQuote`
- `OrderFundingRequest`
- `Order`
- `OrderAllocationRequest`
- `Pool`
- `PoolState`
- `PoolSlice`
- `PoolRules`
- `PoolLiquidityRules`
- `LiquidityAllocationRequest`
- `LPTokenPolicy`

Together these contracts separate market state, pool accounting, LP-token
policy, and token-standard allocation requests.

This is a template/module boundary, not a custom Daml-interface boundary. The
DAR implements upstream Token Standard V2 interfaces, but it does not define a
separate app-facing interface that decouples an LP-token registry package from a
venue package.

## Dependency Split

There are two distinct workflow families.

### Bilateral settlement workflows

- OTC and RFQ trade request
- matched trade settlement
- trade cancellation

### Pool and prefunded-order workflows

- resting orders backed by prefunded allocations
- pool reserves represented by committed allocations
- repeated swaps via iterated settlement
- reserve roll-forward using `FinalizedAllocation.nextIterationFunding`

This split matters because the bilateral path and the pool path share the same
token-standard settlement primitives while preserving different application
state and cancellation rules.

## Workflow 1: Pair Listing

Purpose:
- define that the DEX supports trading a given base and quote `InstrumentId`

Inputs:

- base instrument id
- quote instrument id
- fee model
- allowed trading mode
  - RFQ only
  - order book
  - pool

On-ledger flow:

1. `DexOperator` creates `DexPair`
2. `DexPair` records the supported instruments and execution policy
3. off-chain services subscribe to the pair for matching or pool operations

Current governance boundary:

- `DexPair` is directly operator-created in this reference.
- There is no separate `DexRules` contract for pair admission yet.
- A production fork can add a rules/governance layer if pair listing needs
  multi-party approval, package-level decoupling, or decentralized operation.

Why it matters:

- it makes pair support explicit
- it is the right place to gate experimental pool support or lifecycle-rich
  assets

## Workflow 2: OTC / RFQ Trade

Purpose:
- prove the baseline token-standard-native trade flow

Primary contracts:

- `MatchedTrade`
- `TradeAllocationRequest`

On-ledger flow:

1. traders negotiate off-chain
2. `DexOperator` creates `MatchedTrade`
3. `MatchedTrade_RequestAllocations` creates one allocation request per
   authorizer, following the `TradingAppV2` pattern
4. traders accept their allocation requests
5. `DexOperator` groups allocations by admin
6. `MatchedTrade_Settle` calls `SettlementFactory_SettleBatch`
7. settlement archives requests and finalizes the trade state

Failure and unwind flow:

1. if allocations are not accepted in time, the trade expires
2. `MatchedTrade_Cancel` archives outstanding requests
3. any live allocations are cancelled and funds are released

Why it comes first:

- this is the cleanest reference workflow available today
- it teaches the core DvP pattern without depending on pool semantics

## Workflow 3: Resting Order Placement

Purpose:
- represent a bid or ask as DEX state backed by reserved funds

Primary contracts:

- `Order`
- allocation contract referenced by the order

Reason:

- a resting order is an authorization for a future match whose exact transfer
  legs are not yet known
- that is a much better fit for prefunded, adjustable allocations than for the
  one-shot bilateral allocation shape

On-ledger flow:

1. trader submits order parameters
   - pair
   - side
   - limit price
   - quantity
   - expiry
2. DEX requests or validates a prefunding allocation for the order
3. trader accepts the allocation
4. `DexOperator` creates `Order` pointing at the live allocation reference
5. order becomes matchable only once funding is confirmed

Required invariants:

- live order implies live allocation
- allocation funding must cover remaining order quantity
- order expiry must bound allocation usability

## Workflow 4: Order Match and Settlement

Purpose:
- convert two resting orders into one settled trade

Primary contracts:

- `Order`
- `MatchedTrade`

On-ledger flow:

1. `Matcher` chooses compatible orders
2. `DexOperator` creates `MatchedTrade`
3. the buy and sell allocations are adjusted with the concrete transfer legs
4. adjusted allocations are settled atomically
5. returned next-iteration allocation references are stored back on any
   partially filled orders
6. fully filled orders are archived
7. partially filled orders remain open with reduced remaining quantity

Failure and unwind flow:

1. if adjustment fails, the match is rejected before settlement
2. if settlement fails, orders remain unchanged
3. if one order expires mid-flight, the DEX cancels the match attempt

## Workflow 5: Order Cancel or Expiry

Purpose:
- release funds and remove dead liquidity

On-ledger flow:

1. `DexOperator` exercises `Order_Cancel` (the single operator-controlled
   cancellation path; it covers both trader-requested cancels relayed via
   the operator API and post-expiry cleanup)
2. the referenced allocation is cancelled
3. the order is archived
4. any residual state is recorded for auditability

Important policy choice:

- trader-requested cancel should be honoured before match
- the operator should sweep orders past their expiry time; for RFQs the
  operator-controlled `Rfq_Expire` choice enforces the deadline on-ledger

## Workflow 6: Pool Creation

Purpose:
- define a pool and its LP token

Primary contracts:

- `Pool`
- `LPTokenPolicy`

On-ledger flow:

1. `DexOperator` creates `Pool` for a `DexPair`
2. `DexOperator` or `Registrar` creates the LP token instrument definition
   required by the chosen registry; in the reference registry this is an
   `InstrumentConfiguration`
3. `Pool` stores fee policy, invariant type, and active reserve references
4. the pool starts in `Unfunded` state until first liquidity arrives

Recommended first invariant:

- constant product

Why:

- it is enough for a credible reference implementation
- it keeps the workflow challenge in Daml rather than concentrated-liquidity
  math

## Workflow 7: Add Liquidity

Purpose:
- fund the pool and mint LP shares

Primary contracts:

- `Pool`
- `PoolLiquidityRules`
- `LiquidityAllocationRequest`

On-ledger flow:

1. operator creates a `LiquidityAllocationRequest` for the deposit amounts and
   minimum LP shares (the add-liquidity request step)
2. the trader's wallet authors the base-deposit, quote-deposit, and LP-receipt
   allocations via `AllocationFactory_Allocate`
3. operator and `lpRegistrar` settle with `PoolLiquidityRules_SettleAddLiquidity`:
   funds enter the pool, reserve state is updated, pool-managed committed
   allocations are refreshed, and LP tokens are minted to the provider —
   atomically in one settlement

Important note:

- LP deposits do not need concentrated-liquidity position NFTs
- fungible LP shares are enough for the first production-shaped reference

## Workflow 8: Remove Liquidity

Purpose:
- burn LP shares and return the provider's proportional reserves

On-ledger flow:

1. operator creates a `LiquidityAllocationRequest` for the LP amount to redeem
   and minimum asset outputs (the remove-liquidity request step)
2. the wallet authors the holder's base-receipt and quote-receipt allocations
   plus the LP burn-sender allocation via `AllocationFactory_Allocate`
3. operator and `lpRegistrar` settle with `PoolLiquidityRules_SettleRemoveLiquidity`:
   base and quote are delivered to the holder, the LP tokens burn to the burn
   account, pool reserve allocations are adjusted down, and reserve references
   are rolled forward — atomically in one settlement

Required invariants:

- no over-redemption
- reserve updates and LP burn must stay atomic
- routine withdrawals must not touch every reserve allocation. `Pool` holds a
  list of `PoolSlice` per side and removal settlement walks slices from
  the front. Only slices needed to cover the redemption are cancelled; the
  boundary slice (if any) is re-allocated for its leftover; all slices beyond
  the boundary are untouched. Operator pays for at most ONE re-allocation per
  side, never one per existing slice

## Workflow 9: Pool Swap

Purpose:
- execute a trader swap against the pool

Primary contracts:

- `Pool`
- `PoolRules`
- `PoolSlice`

On-ledger flow:

1. trader submits swap parameters
   - asset in
   - amount in or amount out target
   - slippage bound
   - deadline
2. DEX computes quote from the current reserve state
3. DEX requests or validates trader funding allocation
4. DEX adjusts the pool reserve allocations for the exact swap legs
5. DEX settles trader and pool allocations atomically
6. returned next-iteration pool allocation references are stored on the pool
7. fees are reflected in reserve accounting
8. swap action is archived with result metadata

Executor-control note:

- because the executor can drive iterated settlement on the pool allocations,
  the pool contract state must fully determine which reserve slice is being
  consumed, the permitted transfer legs, and the resulting reserve update
- this is why reserve references belong on ledger and why swap settlement
  should touch only the specific reserve slices participating in the trade

Failure and unwind flow:

1. if slippage bound is violated, no settlement happens
2. if trader funding disappears, swap action expires or is cancelled
3. if pool reserve references are stale, the operator must refresh state before
   retrying

## Workflow 10: Asset Lifecycle Interaction

Purpose:
- let lifecycle-rich instruments trade without making the DEX own their
  lifecycle semantics

Token Standard V2 does not standardize lifecycle transitions for bonds,
options, escrow obligations, or similar assets. This workflow describes how a
DEX can stay compatible with registries that implement those behaviours
themselves.

On-ledger flow:

1. registrar or lifecycle service applies a registry-specific lifecycle
   transition
   - coupon event
   - maturity event
   - exercise event
2. a new instrument version or registry metadata record becomes the tradable
   reference
3. the DEX updates pair or pool eligibility rules if needed
4. old orders or pools can be paused, migrated, or settled out according to
   policy

Important boundary:

- the DEX should not calculate coupons or option exercise
- it should only respond to registry-published tradable instrument versions or
  metadata updates

## Implemented Reference Scope

The reference implementation covers:

1. pair listing
2. OTC / RFQ trade settlement
3. constant-product pools
4. add liquidity
5. remove liquidity
6. single-hop swaps with slippage bounds
7. LP token issuance
8. cancellation, expiry, and operator observability

It deliberately defers:

1. concentrated liquidity
2. multi-hop routing
3. permissionless pool creation
4. advanced oracle surfaces
5. NFT-style LP positions

## Contract Boundary Summary

Keep the market objects (`DexPair`, `Order`, `MatchedTrade`, `Rfq`) separate
from the pool accounting objects (`Pool`, `PoolState`, `PoolSlice`) and the
LP-token policy (`LPTokenPolicy`). The shared boundary is the token-standard
allocation and settlement surface, not a custom internal escrow system.

The current reference stops at that shared Token Standard boundary. It does not
yet introduce custom Daml interfaces or a separate `DexRules` contract to
govern pair creation.
