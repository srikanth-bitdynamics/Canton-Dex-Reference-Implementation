# Daml design-to-test proof map

Use this page when a design statement says “proven by.” Each row links the
on-ledger choice to the smallest Daml Script that demonstrates the stated
property and gives a focused command. Run commands from `trading-tests/`.

```bash
cd trading-tests
dpm test -p <exact-test-name>
```

## Read the fixture before trusting the claim

The repository has two kinds of Daml fixture:

- The four `*WorkflowTests.daml` suites use `MockRegistry`. They prove DEX choice choreography,
  authority, contract consumption/recreation, and the allocation specification
  passed to settlement. They do **not** prove real holding balances.
- Rows that claim real value movement point to suites using
  `CantonDex.Registry.V2` holdings, including `PoolLiquidityRulesTests.daml`,
  `PoolRoundingTests.daml`, `PoolStateInvariantTests.daml`,
  `RealRegistryDvpTests.daml`, `RegistryConservationTests.daml`,
  `RfqSettlementTests.daml`, and the real-value lifecycle tests. These can prove
  locked backing, exact balance movement, release, and conservation in Daml Script.

Neither fixture starts a Canton participant or drives the HTTP API, browser, or
external wallet. Those are separate integration proofs.

## Pair listing metadata

Source: [`DexPair`](../../trading/CantonDex/Dex/DexPair.daml) and its
operator-controlled update choices.

| Claim | Executable proof | Focused command |
|---|---|---|
| Fee model, active flag, trading mode, and readers recreate one successor listing and preserve unrelated fields. | [`testDexPairLifecycleUpdates`](../../trading-tests/CantonDex/Tests/DexPairTests.daml) | `dpm test -p testDexPairLifecycleUpdates` |
| The registry admin cannot exercise the operator-controlled update on the pair. | [`testDexPairUpdatesRequireOperator`](../../trading-tests/CantonDex/Tests/DexPairTests.daml) | `dpm test -p testDexPairUpdatesRequireOperator` |
| Maker/taker fee counters accumulate the configured arithmetic; no test claims those counters move or collect assets. | [`testDexPairRecordsMatchedTradeFees`](../../trading-tests/CantonDex/Tests/DexPairTests.daml) | `dpm test -p testDexPairRecordsMatchedTradeFees` |

`active` and `tradingMode` are not settlement gates in this reference. That is
a dependency fact visible in the source: [`PoolRules`](../../trading/CantonDex/Dex/PoolRules.daml)
and [`OrderMatchExecution`](../../trading/CantonDex/Dex/OrderMatchExecution.daml)
do not fetch or accept a `DexPair` contract. The tests above intentionally prove
listing behavior only; do not cite them as pause/enforcement tests.

## AMM pool

Core sources:

- pricing and ratio math — [`ratioMatchedDeposit`](../../trading/CantonDex/Dex/PoolModel.daml)
  and [`constantProductOut`](../../trading/CantonDex/Dex/PoolModel.daml);
- exact quote construction and swap — [`PoolRules_RequestSwap`](../../trading/CantonDex/Dex/PoolRules.daml),
  [`PoolRules_Swap`](../../trading/CantonDex/Dex/PoolRules.daml);
- add/remove DvP — [`PoolLiquidityRules_SettleAddLiquidity`](../../trading/CantonDex/Dex/PoolLiquidityRules.daml),
  [`PoolLiquidityRules_SettleRemoveLiquidity`](../../trading/CantonDex/Dex/PoolLiquidityRules.daml);
- real allocation and batch implementation — [`AllocationFactory`](../../trading/CantonDex/Registry/V2.daml),
  [`SettlementFactory`](../../trading/CantonDex/Registry/V2.daml).

| Claim | Executable proof | Focused command |
|---|---|---|
| Swap output rounds down and does not reduce `x*y` through decimal overpayment. | [`testSwapOutputRoundsDownToKeepConstantProduct`](../../trading-tests/CantonDex/Tests/PoolRoundingTests.daml) | `dpm test -p testSwapOutputRoundsDownToKeepConstantProduct` |
| The Daml-built request specification reaches `PoolRules_Swap` and its mock settlement choice against the same bound state and slices. | [`testPoolSwapViaRequestSwap`](../../trading-tests/CantonDex/Tests/PoolWorkflowTests.daml) | `dpm test -p testPoolSwapViaRequestSwap` |
| A context-requiring V2 registry consumes actual trader backing and creates the output holding; a changed signed output is rejected. | [`testRealRegistryDvpSwapSettles`](../../trading-tests/CantonDex/Tests/RealRegistryDvpTests.daml) | `dpm test -p testRealRegistryDvpSwapSettles` |
| A stale add-liquidity quote cannot settle against a successor pool state. | [`testStaleQuoteRejected`](../../trading-tests/CantonDex/Tests/PoolLiquidityRulesTests.daml) | `dpm test -p testStaleQuoteRejected` |
| Add liquidity moves real base/quote backing and mints real LP holdings in one DvP flow. | [`testDvpAddLiquidity`](../../trading-tests/CantonDex/Tests/PoolLiquidityRulesTests.daml) | `dpm test -p testDvpAddLiquidity` |
| Off-ratio excess is returned rather than donated or used to mint shares. | [`testDvpAddOffRatioRefundsExcess`](../../trading-tests/CantonDex/Tests/PoolLiquidityRulesTests.daml) | `dpm test -p testDvpAddOffRatioRefundsExcess` |
| Complete LP redemption drains multiple slices, returns real assets, burns every LP holding, and changes state to `Unfunded`. | [`testDvpMultiSliceRemove`](../../trading-tests/CantonDex/Tests/PoolLiquidityRulesTests.daml) | `dpm test -p testDvpMultiSliceRemove` |
| Pool initialization, pause, and resume are actual state transitions; pause rejects a swap and resume preserves reserve and LP-supply accounting. | [`testPoolFullLifecycle`](../../trading-tests/CantonDex/Tests/PoolWorkflowTests.daml) | `dpm test -p testPoolFullLifecycle` |
| Aggregate reserves equal the active slice sums after add, swap, and complete remove. | [`testReconcileAfterAddSwapRemove`](../../trading-tests/CantonDex/Tests/PoolStateInvariantTests.daml) | `dpm test -p testReconcileAfterAddSwapRemove` |
| Liquidity settlement requires both operator and LP registrar authority. | [`testSettleRequiresCoControl`](../../trading-tests/CantonDex/Tests/PoolLiquidityRulesTests.daml) | `dpm test -p testSettleRequiresCoControl` |

## Resting orders

Source path: [`OrderFundingRequest_Bind`](../../trading/CantonDex/Dex/OrderFundingRequest.daml)
→ [`Order_Fund`](../../trading/CantonDex/Dex/Order.daml) →
[`OrderMatchExecution_Execute`](../../trading/CantonDex/Dex/OrderMatchExecution.daml)
or [`Order_Cancel`](../../trading/CantonDex/Dex/Order.daml).

| Claim | Executable proof | Focused command |
|---|---|---|
| Trader intent becomes an operator-bound pending order, then a trader-authored allocation is attached to it. | [`testOrderFundingFlow`](../../trading-tests/CantonDex/Tests/OrderWorkflowTests.daml) | `dpm test -p testOrderFundingFlow` |
| A match outside either signed limit fails. | [`testOrderMatchEnforcesLimitPrice`](../../trading-tests/CantonDex/Tests/OrderWorkflowTests.daml) | `dpm test -p testOrderMatchEnforcesLimitPrice` |
| Settlement and both partial-order roll-forwards occur atomically. | [`testOrderMatchRollsOrdersForwardAtomically`](../../trading-tests/CantonDex/Tests/OrderWorkflowTests.daml) | `dpm test -p testOrderMatchRollsOrdersForwardAtomically` |
| A real partial fill can spend only the funding budget carried into its next allocation iteration. | [`testPartialFillUsesRolledFundingBudget`](../../trading-tests/CantonDex/Tests/RegistryConservationTests.daml) | `dpm test -p testPartialFillUsesRolledFundingBudget` |
| Cancelling a funded order consumes the real allocation and returns its locked holding unlocked. | [`testOrderCancelReleasesRealFunding`](../../trading-tests/CantonDex/Tests/LifecycleChoiceTests.daml) | `dpm test -p testOrderCancelReleasesRealFunding` |
| Trader controls pre-bind cancel; operator controls reject. | [`testOrderFundingRequestCancelAndRejectAuthority`](../../trading-tests/CantonDex/Tests/LifecycleChoiceTests.daml) | `dpm test -p testOrderFundingRequestCancelAndRejectAuthority` |
| Operator can abort an unexecuted match proposal without touching referenced orders or allocations. | [`testOrderMatchExecutionAbort`](../../trading-tests/CantonDex/Tests/LifecycleChoiceTests.daml) | `dpm test -p testOrderMatchExecutionAbort` |

## RFQ and OTC

Source path: [`Rfq_Accept`](../../trading/CantonDex/Dex/Rfq.daml) creates a
`MatchedTrade`; [`MatchedTrade_RequestAllocations`](../../trading/CantonDex/Dex/MatchedTrade.daml)
and [`MatchedTrade_Settle`](../../trading/CantonDex/Dex/MatchedTrade.daml)
move its value, while [`MatchedTrade_Cancel`](../../trading/CantonDex/Dex/MatchedTrade.daml)
is the abandoned-trade exit.

| Claim | Executable proof | Focused command |
|---|---|---|
| RFQ accept ranks quotes and records a policy receipt on the resulting trade; it does not move balances yet. | [`testRfqAcceptProducesMatchedTradeWithReceipt`](../../trading-tests/CantonDex/Tests/TradeWorkflowTests.daml) | `dpm test -p testRfqAcceptProducesMatchedTradeWithReceipt` |
| Accepted RFQ terms settle against real holdings with exact balance deltas and no stranded locks. | [`testRfqBuySettlesAgainstRealHoldings`](../../trading-tests/CantonDex/Tests/RfqSettlementTests.daml) | `dpm test -p testRfqBuySettlesAgainstRealHoldings` |
| The inherited RFQ deadline blocks later settlement; the failed transaction leaves the allocations and locked funds unchanged. | [`testExpiryBetweenAcceptAndSettleBlocksTheSettle`](../../trading-tests/CantonDex/Tests/RfqSettlementTests.daml) | `dpm test -p testExpiryBetweenAcceptAndSettleBlocksTheSettle` |
| A cross-admin OTC trade uses per-admin batches but remains one atomic Daml transaction. | [`testMatchedTradeSettlesPerAdminLegSubsets`](../../trading-tests/CantonDex/Tests/RealRegistryDvpTests.daml) | `dpm test -p testMatchedTradeSettlesPerAdminLegSubsets` |
| Cancelling a proposed trade archives its requests/allocations and returns real sender backing without executing the leg. | [`testMatchedTradeCancelReleasesRealFunding`](../../trading-tests/CantonDex/Tests/LifecycleChoiceTests.daml) | `dpm test -p testMatchedTradeCancelReleasesRealFunding` |
| Trader controls RFQ cancellation; dealer controls quote withdrawal. | [`testRfqCancelAndQuoteWithdrawAuthority`](../../trading-tests/CantonDex/Tests/LifecycleChoiceTests.daml) | `dpm test -p testRfqCancelAndQuoteWithdrawAuthority` |

## Token Standard safety properties used by every surface

| Claim | Executable proof | Focused command |
|---|---|---|
| Executor-supplied extra legs cannot exceed locked allocation backing. | [`testExtraLegBeyondBackingRejected`](../../trading-tests/CantonDex/Tests/RegistryConservationTests.daml) | `dpm test -p testExtraLegBeyondBackingRejected` |
| Roll-forward carries actual locked backing, not an accounting-only budget. | [`testRollForwardCarriesLockedBacking`](../../trading-tests/CantonDex/Tests/RegistryConservationTests.daml) | `dpm test -p testRollForwardCarriesLockedBacking` |
| An uncommitted allocation is withdrawable only by its authorizer. | [`testUncommittedAllocationWithdrawsOnlyAsAuthorizer`](../../trading-tests/CantonDex/Tests/RegistryConservationTests.daml) | `dpm test -p testUncommittedAllocationWithdrawsOnlyAsAuthorizer` |
| A committed allocation is authorizer-withdrawable after its deadline, but not before. | [`testCommittedAllocationWithdrawsOnlyAfterDeadline`](../../trading-tests/CantonDex/Tests/RegistryConservationTests.daml) | `dpm test -p testCommittedAllocationWithdrawsOnlyAfterDeadline` |
| A deadline-free committed pool allocation is not unilaterally withdrawable. | [`testCommittedAllocationWithoutDeadlineCannotBeWithdrawn`](../../trading-tests/CantonDex/Tests/RegistryConservationTests.daml) | `dpm test -p testCommittedAllocationWithoutDeadlineCannotBeWithdrawn` |

## Run by module, then run everything

```bash
cd trading-tests
dpm test --files CantonDex/Tests/DexPairTests.daml
dpm test --files CantonDex/Tests/LifecycleChoiceTests.daml
dpm test --files CantonDex/Tests/PoolLiquidityRulesTests.daml
dpm test --files CantonDex/Tests/RealRegistryDvpTests.daml
dpm test
```

The final command is the release check. A focused test explains one invariant;
the complete suite catches interactions between workflows.

**Where to read next:** [Builder guide](../guides/builder-guide.md) ·
[Workflow design](../concepts/workflows.md) ·
[Testing reference](testing.md)
