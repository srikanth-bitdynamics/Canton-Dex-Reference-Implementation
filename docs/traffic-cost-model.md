# Canton DEX — Traffic Cost Model

Last updated: 2026-05-06

## Status: documented, NOT enforced on-ledger

The traffic-cost split described in this document is an **off-ledger
operational model**. It is documented in contract comments
(`OrderFundingRequest.daml`, `LiquidityRequest.daml`, `LPToken.daml`) but
the contracts themselves do not enforce it. There is no on-ledger fee-
recovery mechanism, no traffic accounting contract, and no per-choice
billing.

This is intentional. Traffic billing in Canton happens at the **participant
node level**, not at the contract level. A contract cannot observe its own
submitting party's traffic balance, cannot meter its own gas, and cannot
charge for its execution. Putting a fake fee mechanism on-ledger would
mislead readers about how the platform actually works.

## Who pays for what

| Workflow step                              | Submitting party | Why |
|--------------------------------------------|------------------|-----|
| `OrderFundingRequest` create               | trader           | Trader's intent; their submission |
| `OrderAllocationRequest` accept            | trader           | Trader's authority is needed to lock their holdings |
| `OrderFundingRequest_Bind`                 | operator         | Operator orchestration |
| `Order_Fund` (binding allocation)          | operator         | Operator orchestration |
| `Order_Adjust` (match)                     | operator         | Operator orchestration |
| `Order_Cancel`                             | operator         | Operator orchestration |
| `LiquidityDepositRequest` create           | LP               | LP's intent |
| Allocation accept for LP deposit           | LP               | LP's authority for their assets |
| `Pool_AddLiquidity` / `Pool_RemoveLiquidity` | operator       | Operator orchestration |
| `Pool_Swap` (adjust + settle + roll-fwd)   | operator         | Operator orchestration |
| `LPMintRequest` / `LPBurnRequest` create   | operator         | Part of pool orchestration |
| `LPTokenPolicy_AcceptMint` / `_AcceptBurn` | lpRegistrar      | Registry-side action |
| `MatchedTrade` create                      | venue (operator) | Operator orchestration |
| `TradeAllocationRequest` accept            | trader           | Trader's authority |
| `MatchedTrade_Settle`                      | venue (operator) | Operator orchestration |
| `InstrumentConfiguration` create / update  | asset registrar  | Registry-side action |
| Holding mint / burn                        | asset registrar  | Registry-side action |

## Operator economics

The DEX operator runs at a loss without fee revenue covering the
orchestration traffic cost. The economics are:

```
operator_24h_net = sum(swap_volume * pool_fee * operator_share)
                 + sum(matched_trade_notional * venue_fee_bps)
                 - sum(operator_submitted_tx_count * avg_tx_traffic_cost)
```

The Admin view's "Traffic cost vs revenue" panel surfaces this for the
operator. The break-even fee number is computed from observed cost and
volume.

## What the operator actually monitors

The operator's submission service emits OpenTelemetry metrics keyed by
choice name (`Pool_Swap`, `MatchedTrade_Settle`, `Allocation_Adjust`,
`SettlementFactory_SettleBatch`, etc.). These are not contracts; they are
service-layer counters. The Admin "Cost breakdown" panel in the prototype
shows the structure (Allocation_Adjust 45%, SettleBatch 40%, matching 10%,
other 5%) but the actual numbers come from the operator service, not from
on-ledger state.

## Why we don't model fee recovery on-ledger

Three reasons:

1. **Canton already meters traffic per submitting party.** Putting a
   second meter on-ledger would double-count and could disagree with the
   participant's actual billing.
2. **Fee revenue is already on-ledger** — pool fees accrue as net funding
   deltas on the committed pool allocations, and matched-trade fees can
   be added as additional transfer legs on the trade. The fee channel
   exists; we don't need a separate one.
3. **An on-ledger meter would require every submitter to participate in
   it**, which forces traders/LPs into a bookkeeping protocol they don't
   need.

## What changes if you wanted on-ledger fee recovery

If a future deployment requires on-ledger reconciliation of operator
traffic cost vs operator fee revenue, the smallest viable addition is:

- An `OperatorReceipt` template signed by the operator, created
  per-billing-period, carrying:
  - the period boundary
  - a list of `(workflow_choice, count, unit_cost_estimate)` rows
  - the matching `(workflow, fee_revenue)` rows
  - net margin

- The operator publishes these receipts as part of an audit record. They
  are signed-by-self; they are evidence, not enforcement. Counterparties
  who care can verify the receipts against their own observed transaction
  counts in their own ACS.

This is in scope for a future tranche, not the current implementation.
