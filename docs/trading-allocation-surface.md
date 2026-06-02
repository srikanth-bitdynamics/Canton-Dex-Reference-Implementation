# V2 Allocation Surface

Last updated: 2026-06-02

## Purpose

Record the exact Token Standard V2 allocation surface the DEX consumes from
Splice's `token-standard-v2-upcoming` branch.

Source base:

- `vendor/splice/token-standard/splice-api-token-allocation-v2/daml/Splice/Api/Token/AllocationV2.daml`
- `vendor/splice/token-standard/splice-api-token-allocation-instruction-v2/daml/Splice/Api/Token/AllocationInstructionV2.daml`

## Surface The DEX Uses

- `AllocationFactory_Allocate` for trader-authored prefunded allocations,
  operator-authored committed pool allocations, and LP receipt allocations.
- `SettlementFactory_SettleBatch` for atomic settlement of matched trades,
  pool swaps, and LP add/remove DvP flows.
- `FinalizedAllocation.extraTransferLegSides` for settlement-time leg sides
  supplied by the app workflow.
- `FinalizedAllocation.nextIterationFunding` and
  `Allocation_SettleResult.nextIterationAllocationCid` for iterated settlement
  and pool-slice roll-forward.
- `Allocation_Cancel` and `Allocation_Withdraw` for release/cancel paths.
- `ExtraArgs` plus disclosed contracts for registry-specific choice context.

The DEX does not define a new token-standard choice. It defines app-level
contracts (`Order`, `MatchedTrade`, `PoolRules`, `PoolLiquidityRules`, etc.)
that assemble and exercise the V2 choices above.

## Workflow Use

- **Prefunded orders** lock a trader's budget in a V2 allocation. A match
  finalizes both sides with the concrete trade leg-sides and batch-settles
  them. Partial fills roll forward through next-iteration allocation CIDs.
- **Pool reserves** live as committed V2 allocations referenced by
  `PoolSlice` contracts. Swaps and liquidity operations settle the relevant
  slices and write new slice CIDs for any next iteration.
- **LP add/remove** uses two authority domains: base/quote reserve settlement
  under the pool asset admin, and LP mint/burn settlement under the LP
  registrar. Each domain receives its own `ExtraArgs`.

## Compatibility Guardrails

- Fetch choice context off-ledger before calling registry choices.
- Do not rely on contract IDs as stable UI labels; they are ephemeral.
- Keep DEX pricing/order logic in DEX templates; keep token movement in the
  V2 allocation and settlement interfaces.
- Re-run Daml tests and backend wallet-composition tests whenever the
  vendored V2 branch changes.
