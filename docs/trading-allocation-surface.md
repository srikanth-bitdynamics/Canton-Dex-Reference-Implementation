# V2 Allocation Surface (post-PR-5333)

Last updated: 2026-05-18

## Purpose

Record the exact V2 allocation surface our DEX consumes — the
extensions originally proposed as splice#5333 and now released in
the `token-standard-v2-upcoming` branch — covering prefunded orders
and allocation-backed pool funds.

Source base (single tree after the upstream merge):

- `vendor/splice/token-standard/splice-api-token-allocation-v2/daml/Splice/Api/Token/AllocationV2.daml`

## Exact Source Delta vs. the pre-PR-5333 V2 draft

The V2 allocation extensions (introduced in splice#5333, since
merged) changed `AllocationV2` in the following ways:

- `SettlementInfo`
  - removes `requestedAt`
  - removes `settleAt`
- `TransferLeg`
  - changes `instrumentId` from `HoldingV2.InstrumentId` to `Text`
- `AllocationSpecification`
  - adds top-level `admin : Party`
  - adds `nextIterationFunding : Optional (TextMap.TextMap Decimal)`
  - adds `committed : Bool`
- `AllocationAction`
  - adds `AA_Adjust`
- `Allocation` interface
  - adds `allocation_adjustImpl`
  - adds `allocation_adjustExtraObservers`
  - adds `Allocation_Adjust`
- default controllers
  - settlement controllers become `admin :: settlement.executors`
  - adjustment controllers are `settlement.executors`
- `Allocation_SettleResult`
  - adds `nextIterationAllocationCid`
- new result type
  - `Allocation_AdjustResult`
- `SettlementFactory_SettleBatchResult`
  - changes from aggregated `newHoldingCids` to ordered
    `allocationSettleResults : [Allocation_SettleResult]`

## Local Build Status

Current local status on the parallel `vendor/splice` worktree:

- the V2 API package set builds through
  `splice-api-token-transfer-events-v2`
- the local branch package under `trading/` now includes a dedicated helper
  layer for:
  - account helpers
  - authorizer grouping
  - funding delta calculation
  - prefunded and committed allocation construction
- the local branch package now also includes workflow constructors for:
  - prefunded allocation factory requests
  - committed pool-fund allocation factory requests
  - batch settlement choice arguments
  - rolled-forward allocation cancellation arguments
- the repeatable probe confirms that the upstream `TradingAppV2` source is
  unchanged on the released V2 API
- the existing upstream utility layer does not yet build unchanged on that
  surface

First concrete utility-layer blocker:

- `splice-token-standard-utils/daml/Splice/TokenStandard/Utils/Internal/Conversions.daml`
  still derives the admin from `transferLeg.instrumentId.admin`
- on the PR surface, `admin` has moved to `AllocationSpecification.admin`
- the current compiler error is at `Conversions.daml:90` and reports that
  field `admin` no longer exists on `Text`

This confirms that branch-specific DEX work should not assume the stable helper
layer can be reused unchanged.

Repeatable local probe:

- `bash scripts/probe-trading-tradingappv2-build.sh`
  - first checks that the upstream `TradingAppV2` source is unchanged
    against the released V2 surface
  - then probes whether the upstream utility layer and example package build
    unchanged

## Design Notes Present in the V2 Source

The V2 source file explicitly describes the intended use for:

- prefunded trades
  - request an allocation with funding for the next iteration
  - adjust it with the actual trade legs
  - settle it in a batch
  - cancel the next-iteration allocation to release any remainder
- liquidity-pool-style commitments
  - use committed allocations where executors need guaranteed fund
    availability until settlement or cancellation
- iterated settlement
  - settlement can roll forward a new allocation via
    `nextIterationAllocationCid`

## Immediate Impact on Local Stable Modules

The current local stable implementation in
`src/CantonDex/DexApp/OTCTradeV2.daml` cannot be reused unchanged on the PR
5333 surface because it depends on stable-only fields and result shapes:

- `mkOtcTradeSettlementInfo` sets `requestedAt` and `settleAt`
- stable trade legs use `HoldingV2.InstrumentId`
- stable settlement handling expects
  `SettlementFactory_SettleBatchResult.newHoldingCids`

## Recommended Branch-Specific Build Order

1. Build the V2 token-standard core packages.
2. Probe which upstream example packages still compile unchanged.
3. Add a branch-specific local matched-trade module only where the source
   surface requires adaptation.
4. Layer prefunded order and committed pool-fund workflows on top of the PR
   surface without introducing non-source settlement flows.
