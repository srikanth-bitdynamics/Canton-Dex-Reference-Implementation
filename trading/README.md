# `canton-dex-trading` Package

The DEX Daml package, built on Token Standard V2 (CIP-0056) released
in Splice's `token-standard-v2-upcoming` branch.

Current scope:

- import the V2 API DARs built from `vendor/splice/token-standard/`
- anchor the released V2 `SettlementInfo`, `FinalizedAllocation`,
  `extraTransferLegSides`, and `nextIterationFunding` surface
- keep a helper layer for funding deltas and iterated-allocation
  construction under `CantonDex.Trading.Utils`
- expose source-derived builders for prefunded allocation requests,
  committed pool-fund allocation requests, batch settlement, and
  rolled-forward allocation cancellation under
  `CantonDex.Trading.WorkflowConstructors`

## DEX reference implementation

The `CantonDex.Dex.*` modules implement the full reference DEX on the
V2 allocation surface:

- `DexPair` — trading pair listing with fee model and trading mode
- `MatchedTrade` — V2-native OTC/RFQ trade settlement, adapted from
  the upstream TradingAppV2 pattern
- `Order` — resting bid/ask orders backed by prefunded `V2.Allocation`;
  uses the iterated settlement pattern for partial fills
- `Pool`, `PoolState`, and `PoolSlice` — constant-product liquidity
  pool config, hot reserve accounting, and slice-local committed
  allocations
- `PoolRules` and `PoolLiquidityRules` — swap plus DvP liquidity
  request/settle choices over the pool state and slices
- `CantonDex.Lp.Policy` / `CantonDex.Lp.Instrument` — LP-token
  issuance policy and mint/burn leg construction
- `OrderMatchExecution` — order matching execution using the prefunded
  trade pattern (adjust both allocations, settle atomically)
