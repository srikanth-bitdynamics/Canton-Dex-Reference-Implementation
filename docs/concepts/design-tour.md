# Understand the design in 15 minutes

This page is the shortest path from Daml knowledge to the Canton DEX design. It
explains which contracts carry market state, which party authorizes each step,
and where Token Standard V2 moves value. Follow the links only when you need the
detail behind a statement.

## 1. Start with the boundary

The DEX decides whether a market action is valid. A token registry owns holdings
and performs value movement.

```mermaid
flowchart LR
  W["Trader or LP wallet<br/>authorizes funding"] --> A["V2.Allocation<br/>locks holdings"]
  O["Operator<br/>proposes execution"] --> R["DEX rules choice<br/>validates market terms"]
  A --> R
  R --> S["SettlementFactory_SettleBatch<br/>moves every leg atomically"]
```

The recurring workflow is:

1. A market contract records intent or state.
2. The holder's wallet creates the exact `V2.Allocation` needed by the flow.
3. An operator-controlled DEX choice fetches the market state and validates the
   proposed action.
4. The registry's `SettlementFactory_SettleBatch` consumes all allocations and
   moves all transfer legs in one transaction.

The operator can decide when to propose an action. It cannot author a trader's
allocation or settle transfer legs outside the checks in the DEX choice.

## 2. Know the actors

| Actor | What it controls | What it cannot do alone |
|---|---|---|
| Trader or LP | Its wallet submission and holder-authored allocations | Exercise operator-controlled settlement choices |
| Operator | Pair and pool state, matching proposals, pool execution, submission | Lock a self-custodial user's holdings |
| Asset registry admin | Registry implementation, factories, context, and token policy | Change a trader's signed DEX intent |
| LP registrar | LP instrument policy and mint/burn recording | Move reserve assets without the pool settlement path |

The hosted RFQ demo is different: its relay has act-as rights for hosted parties.
That convenience is not the self-custodial authority model used by wallet-funded
orders, swaps, and liquidity.

## 3. The Token Standard settlement spine

A `Holding` is spendable token value. An `Allocation` locks holdings for one
settlement and describes the sides its authorizer permits. A
`FinalizedAllocation` supplies the exact sides used in this iteration.
`SettlementFactory_SettleBatch` checks that the batch is balanced and that each
side is authorized before value moves.

Two V2 fields matter throughout this repository:

- `committed` controls whether the authorizer may withdraw before the settlement
  deadline.
- `nextIterationFunding` allows unused locked value or received value to back a
  successor allocation in the same settlement.

The local `CantonDex.Registry.V2` is a runnable implementation of this boundary,
not a privileged registry. Production assets may come from another registry that
implements the same V2 APIs. Read [Registry Integration](../guides/registry-integration.md)
for the exact assumptions.

## 4. Pair and governance state

`DexPair` is the operator-signed listing record. It names one registry admin,
the base and quote instrument ids, enabled trading modes, and fees. The operator
creates it directly and controls its update choices. There is no separate
`DexRules` governance contract in this reference.

That is a deliberate single-operator boundary, not decentralized pair admission.
A production fork that needs proposals, voting, or threshold approval should put
that authority in a governance contract rather than copy the direct bootstrap
path.

Read:

- Contract: [`DexPair.daml`](../../trading/CantonDex/Dex/DexPair.daml)
- Workflow map: [Active workflows](workflows.md#active-workflow-map)
- Guide: [Add a trading pair](../guides/add-a-trading-pair.md)

## 5. Signed pool swaps

`PoolRules_RequestSwap` reads a precise pool snapshot and returns one allocation
specification containing both the trader's input side and every pool-to-trader
output side. The wallet signs that complete specification.

`PoolRules_Swap` then:

1. requires the same pool state, input slice, output slice list, and slippage
   minimum that the request bound;
2. recomputes the constant-product output on-ledger;
3. requires the trader allocation to match the exact input and output legs;
4. settles the trader and pool allocations atomically; and
5. replaces `PoolState` and only the reserve slices touched by the swap.

The operator cannot lower the signed output or swap against another snapshot.

Read:

- Rules: [`PoolRules.daml`](../../trading/CantonDex/Dex/PoolRules.daml)
- Math: [Pricing](pricing.md)
- Proofs: `testPoolSwapViaRequestSwap` and `testRealRegistryDvpSwapSettles`

## 6. Liquidity and pool custody

The pool is split so each concern remains small:

| Contract or module | Responsibility |
|---|---|
| `Pool` | Immutable pool configuration and stable pool id |
| `PoolState` | Aggregate reserves, LP supply, status, and fee accrual |
| `PoolSlice` | One side-specific reserve amount and its backing V2 allocation |
| `PoolRules` | Swap, pause/resume, and reconciliation choices |
| `PoolLiquidityRules` | Add/remove request and settlement choices |
| `PoolModel`, `PoolExecution` | Pure pricing, slice selection, and assembly helpers |

Add liquidity is DvP: base and quote enter the pool in the same transaction in
which the provider receives LP tokens. Remove is the reverse. If the base/quote
registry admin differs from the LP registrar, the choice performs one settlement
batch per admin and passes each registry its own choice context.

### Why pool slices have no deadline

Reserve slices are operator-authored with `committed = true` and
`settlementDeadline = None`. Under the V2 withdrawal rule this means the
authorizer cannot call `Allocation_Withdraw` later. This is intentional for the
reference's long-lived inventory: the authorizer path and an LP cannot withdraw
a routine slice. The operator remains the allocation executor and can cancel it
when recovering or shutting down the pool.

The consequence is explicit operator custody:

- the LP holder is not the reserve allocation authorizer and has no unilateral
  slice withdrawal;
- routine LP redemption requires the operator and LP registrar;
- the operator is the settlement executor and can cancel reserve allocations;
- if either service party disappears, the reference has no trustless LP exit.

Adding an arbitrary deadline would not solve holder exit. It would instead give
the operator authorizer a future withdrawal path and require a safe slice-renewal
protocol. A production fork must choose and audit its own governed execution,
allocation renewal, and emergency redemption design. See
[Liquidity and Custody](liquidity-and-custody.md#availability-and-the-lp-exit-boundary).

## 7. Prefunded orders

An order has two objects: an operator-signed `Order` containing market terms and
a trader-authored allocation containing the reserved funds.

```mermaid
flowchart LR
  I["OrderFundingRequest"] -->|Bind| P["Pending Order + allocation request"]
  P -->|wallet Allocate| A["V2.Allocation"]
  P -->|Order_Fund| F["Funded Order"]
  A --> F
  F -->|OrderMatchExecution_Execute| S["atomic fill"]
  S -->|partial| N["remainder + next allocation"]
```

`OrderMatchExecution_Execute` fetches both orders and rechecks pair, side, price,
quantity, expiry, and bound allocation. It settles the fill and creates any
remainders in the same transaction. Expiring orders are committed through their
deadline. GTC orders are uncommitted so the trader can withdraw even if the
operator disappears.

The operator still chooses which eligible orders to match and when. On-ledger
checks prevent invalid fills; they do not prove fair arrival ordering or prevent
operator censorship and reordering. See [Ordering and MEV](non-goals.md#fair-ordering-and-private-mev).

Read:

- Intent and funding: [`OrderFundingRequest.daml`](../../trading/CantonDex/Dex/OrderFundingRequest.daml)
- Order state: [`Order.daml`](../../trading/CantonDex/Dex/Order.daml)
- Atomic fill: [`OrderMatchExecution.daml`](../../trading/CantonDex/Dex/OrderMatchExecution.daml)
- Proof: `testOrderMatchRollsOrdersForwardAtomically`

## 8. RFQ and OTC settlement

An RFQ records a trader request and dealer quotes. `Rfq_Accept` jointly requires
the hosted trader and operator, records the ranking in a `PolicyReceipt`, and
creates a `MatchedTrade`. Each counterparty then authors an allocation and
`MatchedTrade_Settle` groups the transfer legs by registry admin before calling
that admin's settlement factory.

The accepted RFQ state does not mean value moved. Settlement occurs only after
both allocations exist and the matched-trade settle succeeds.

Read:

- RFQ state: [`Rfq.daml`](../../trading/CantonDex/Dex/Rfq.daml)
- Settlement: [`MatchedTrade.daml`](../../trading/CantonDex/Dex/MatchedTrade.daml)
- Real holdings proof: `testRfqBuySettlesAgainstRealHoldings`

## 9. Cross-registry settlement

Factory contract ids are not sufficient. Before a registry choice, the operator
fetches that admin's choice context and disclosed contracts off-ledger. Context is
keyed by admin, not by list position. Each per-admin batch receives only the legs,
factory, and `extraArgs` for that admin; all required disclosures accompany the
single Canton submission.

The evidence is intentionally both positive and negative:

- `testDvpSettleThreadsBothAdminContexts` succeeds with distinct contexts;
- `testDvpSettleRequiresPoolAdminContext` removes only the pool-admin context and
  must fail;
- `testDvpSettleRequiresLpRegistrarContext` removes only the LP context and must
  fail; and
- `testMatchedTradeSettlesPerAdminLegSubsets` proves each admin receives its
  exact transfer-leg subset against the upstream context-requiring registry.

Read [Choice Context](../guides/choice-context.md) for backend assembly and
submission details.

## 10. Active and compatibility surfaces

Public source can contain declarations that are not active workflow APIs. Code
comments use one of these markers:

- `[COMPAT]` means a type, field, template, or fixture remains for Daml package
  lineage. Active code does not rely on it unless the comment says otherwise.
- `[RETIRED]` means a choice remains callable in the package shape but always
  rejects and names the replacement.
- `[POLICY]` marks active behavior that deliberately ignores a field for a
  stated policy reason.

The `CantonDex.Instrument.*` module family is a `[COMPAT]` standalone lifecycle sample.
It is not Token Standard V2 and is not used by active DEX workflows. Active value
flows use `CantonDex.Registry.V2` or another V2 registry. `Order_Adjust` and
`Order_RecordPartialFill` are `[RETIRED]`; use
`OrderMatchExecution_Execute`.

## 11. Choose the next detailed page

| If you want to understand | Read next |
|---|---|
| Component and authority boundaries | [Architecture](architecture.md) |
| Every workflow step | [Workflows](workflows.md) |
| Reserve representation and LP exits | [Liquidity and Custody](liquidity-and-custody.md) |
| Registry assumptions and context | [Registry Integration](../guides/registry-integration.md) |
| What tests prove | [Testing](../reference/testing.md) |
| Deliberate limitations | [Non-goals](non-goals.md) |
