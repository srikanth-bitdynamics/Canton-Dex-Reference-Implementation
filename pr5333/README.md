# PR 5333 Package

This package proves local compilation against the branch-only `AllocationV2`
surface from Splice PR 5333.

Current scope:

- import the PR-5333 API DARs built from `vendor/splice-pr5333`
- anchor the new `SettlementInfo`, `Allocation_Adjust`,
  `nextIterationFunding`, `committed`, and `nextIterationAllocationCid`
  surface
- keep a branch-native helper layer for funding deltas and iterated-allocation
  construction under `CantonDex.Pr5333.Utils`
- expose source-derived builders for prefunded allocation requests, committed
  pool-fund allocation requests, batch settlement, and rolled-forward
  allocation cancellation under `CantonDex.Pr5333.WorkflowConstructors`
- keep branch-only work isolated from the stable local V2 package

## DEX Reference Implementation

The `CantonDex.Dex.*` modules implement the full reference DEX on the PR 5333
allocation surface:

- `DexPair` — trading pair listing with fee model and trading mode
- `MatchedTrade` — PR-5333-native OTC/RFQ trade settlement (V2-only,
  no V1 bridging), adapted from the upstream TradingAppV2 pattern
- `Order` — resting bid/ask orders backed by prefunded V2.Allocation;
  uses the iterated settlement pattern for partial fills
- `Pool` — constant-product liquidity pool backed by committed
  V2.Allocations; swap execution uses adjust + batch settle + roll-forward
- `LPToken` — LP token issuance policy for pool share minting and burning
- `SwapExecution` — trader-facing swap request lifecycle
- `OrderMatchExecution` — order matching execution using the prefunded
  trade pattern (adjust both allocations, settle atomically)
