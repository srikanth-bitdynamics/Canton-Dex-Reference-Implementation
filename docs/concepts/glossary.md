# Glossary

Key terms used across the Canton DEX docs and code. Each entry is a one-line
definition; where it helps, it links to the Daml module that defines the term,
the test that exercises it, and the concept doc that covers it in depth. Source
paths are relative to the repo root (`trading/`, `trading-tests/`).

### Allocation
A Token Standard V2 contract that locks a holder's [holding](#holding) for one
specific settlement, so the batch can settle it atomically later. The DEX never
moves trader assets directly — the trader authors allocations and the venue
settles a batch. Template
[`Allocation`](../../trading/CantonDex/Registry/V2.daml); see
[Allocation Surface](../reference/allocation-surface.md).

### AllocationFactory / `AllocationFactory_Allocate`
The registry factory choice a holder exercises to turn holdings into an
[Allocation](#allocation). It runs under the holder's own authority, which is why
funding an order or adding liquidity must go through the trader's wallet.
Implemented in [`Registry.V2`](../../trading/CantonDex/Registry/V2.daml).

### AllocationRequest
A V2 contract that publishes the allocation specifications a settlement needs
and the actions available to the target party. Liquidity funding composes
request acceptance with `AllocationFactory_Allocate`; order funding uses the
request as a correlation record and consumes it when the resulting allocation
is bound. The DEX's variants are
[`OrderAllocationRequest`](../../trading/CantonDex/Dex/Order.daml),
[`LiquidityAllocationRequest`](../../trading/CantonDex/Dex/LiquidityAllocationRequest.daml),
and [`TradeAllocationRequest`](../../trading/CantonDex/Dex/MatchedTrade.daml).

### Choice context / disclosure
The extra arguments (`ExtraArgs`) and disclosed contracts a
[registry](#registry--registrar) requires when its factory choices are
exercised. The operator backend fetches these and attaches them to each
submission. See [Choice Context](../guides/choice-context.md).

### CIP-0056
The Canton Network Token Standard: the base standard (holdings, transfers,
metadata) that CIP-0112 revises.

### CIP-0103
The dApp Standard: the wallet-interaction standard behind
[prepare/sign/execute](#prepare--sign--execute). The dApp hands trader-authority
commands to a wallet over CIP-0103.

### CIP-0112
The Canton Network Token Standard V2: the privacy / performance /
traditional-accounting revision of CIP-0056 that adds the allocation +
settlement surface this DEX is built on. Often written "Token Standard V2" or
"TSv2".

### Committed allocation
An [allocation](#allocation) authored with `committed = True`, so the authorizer
cannot unilaterally withdraw it and the venue can settle against it repeatedly.
Pool reserves and resting-order collateral are committed; each pool
[slice](#pool--poolstate--poolslice) wraps one. Field on `AllocationSpecification`;
see [`PoolSlice`](../../trading/CantonDex/Dex/PoolSlice.daml).

### DexPair
The operator's listing record for one market: base + quote
[instrument ids](#instrumentid), the fee model (maker/taker/pool bps), the
trading mode (`TM_OrderBook`, `TM_Pool`, or `TM_Both`), and an `active` flag.
Template [`DexPair`](../../trading/CantonDex/Dex/DexPair.daml).

### DvP (delivery-versus-payment)
An atomic exchange where both legs settle together or not at all. Swaps, LP
add/remove, and matched trades all settle as DvP through
`SettlementFactory_SettleBatch`. See [Liquidity & Custody](liquidity-and-custody.md);
proven in
[`PoolLiquidityRulesTests`](../../trading-tests/CantonDex/Tests/PoolLiquidityRulesTests.daml)
(an add funds base+quote and mints LP tokens in one flow).

### FinalizedAllocation
The V2 settle-time structure that carries a match's concrete leg sides
(`extraTransferLegSides`) and the roll-forward funding (`nextIterationFunding`)
for [iterated settlement](#iterated-settlement). Built by
[`mkFinalizedAllocation`](../../trading/CantonDex/Trading/Utils.daml) and consumed
by [`OrderMatchExecution`](../../trading/CantonDex/Dex/OrderMatchExecution.daml).

### Holding
A V2 contract representing a party's balance of one instrument. Base assets,
quote assets, and LP tokens are all holdings. Template
[`Holding`](../../trading/CantonDex/Registry/V2.daml).

### InstrumentId
The `{admin, id}` pair that identifies a V2 instrument. Two instruments with the
same `id` but a different `admin` are different instruments. The DEX stores the
`id` component per pair/pool and pins its `admin` alongside.

### Iterated settlement
Settling in steps, where each step rolls the remaining backing forward to the
next iteration via `nextIterationFunding`. Pool swaps and partial order fills use
it so one [committed allocation](#committed-allocation) can back many
settlements. Enforced in
[`Registry.V2`](../../trading/CantonDex/Registry/V2.daml); proven in
[`RegistryConservationTests`](../../trading-tests/CantonDex/Tests/RegistryConservationTests.daml)
(roll-forward stays within the locked backing).

### LP token / `LPTokenPolicy` / lpRegistrar
The pool's liquidity-provider share is a V2 instrument (the LP token),
administered by the lpRegistrar and governed by the
[`LPTokenPolicy`](../../trading/CantonDex/Lp/Policy.daml) contract, which tracks
only supply and knows nothing about pools or orders. See [LP Tokens](lp-tokens.md).

### MatchedTrade
The venue-signed trade contract [`Rfq_Accept`](#rfq-request-for-quote) emits: it
carries the transfer legs plus an optional operator-signed
[`PolicyReceipt`](#policyreceipt) and settles via a per-admin `SettleBatch`.
Template [`MatchedTrade`](../../trading/CantonDex/Dex/MatchedTrade.daml); proven
end-to-end in
[`RfqSettlementTests`](../../trading-tests/CantonDex/Tests/RfqSettlementTests.daml).

### Mint / burn account
Special Token Standard accounts with `owner = None`, the counterparty for
LP-token mint (issuance) and burn (redemption) legs. `Registry.V2` recognizes
exactly these two as admin-authorized mint/burn sources:

```daml
mintAccountId = "cip-112/mint"
burnAccountId = "cip-112/burn"
...
mintAccount = HoldingV2.Account None None mintAccountId
burnAccount = HoldingV2.Account None None burnAccountId
```

Defined in [`Trading.Utils`](../../trading/CantonDex/Trading/Utils.daml); the
mint/burn mechanism is proven as part of atomic add/remove settlement in
[`PoolLiquidityRulesTests`](../../trading-tests/CantonDex/Tests/PoolLiquidityRulesTests.daml).

### Operator
The venue operator: it orchestrates matching, binds orders, and submits the
settlement batches it is authorized to submit. It cannot settle a trader's
holdings without that trader's allocation. The hosted RFQ relay is a separate
authority model in which the backend ledger user is explicitly granted act-as
rights for hosted parties.

### Over-lock
Locking more backing than a settlement strictly needs. Token Standard V2 accepts
`have >= needed`; the surplus is returned as unlocked change when the batch
settles. Proven in
[`RegistryConservationTests`](../../trading-tests/CantonDex/Tests/RegistryConservationTests.daml)
(surplus backing returns to the authorizer).

### PolicyReceipt
An operator-signed record of the ranking/whitelist policy applied to an
[RFQ](#rfq-request-for-quote), folded into `SettlementInfo.meta` so the decision
travels on-ledger and stays auditable. Type
[`PolicyReceipt`](../../trading/CantonDex/Dex/PolicyReceipt.daml); proven in
[`PolicyReceiptTests`](../../trading-tests/CantonDex/Tests/PolicyReceiptTests.daml).

### Pool / PoolState / PoolSlice
The constant-product pool is split three ways:
[`Pool`](../../trading/CantonDex/Dex/Pool.daml) (immutable config),
[`PoolState`](../../trading/CantonDex/Dex/PoolState.daml) (the hot reserves / LP
supply / status), and [`PoolSlice`](../../trading/CantonDex/Dex/PoolSlice.daml)
(one [committed allocation](#committed-allocation) per side). Slices are
operator-authored inventory units, not per-LP entitlement. Swap and remove use
only a covering slice set, while every reserve-changing operation still updates
the singleton `PoolState`. Reserves↔slices integrity is proven in
[`PoolStateInvariantTests`](../../trading-tests/CantonDex/Tests/PoolStateInvariantTests.daml).

### prepare / sign / execute
The three steps of CIP-0103 interactive submission: the dApp prepares a
transaction, the wallet signs it, and it is executed on the ledger. CIP-0103
does not itself limit the number of top-level commands; some wallet gateways do.

### Registry / Registrar
The component that defines instrument semantics and supplies
[choice context](#choice-context--disclosure). It is external to the DEX; this
repo ships a reference
[`Registry.V2`](../../trading/CantonDex/Registry/V2.daml), but Token Standard V2
does not require that exact one. See
[Registry Integration](../guides/registry-integration.md).

### RFQ (request-for-quote)
The bilateral block-trade flow: a trader posts an `Rfq`, whitelisted dealers post
`RfqQuote`s, and a joint `Rfq_Accept` (trader + operator) emits a
[MatchedTrade](#matchedtrade). Source
[`Rfq`](../../trading/CantonDex/Dex/Rfq.daml); see [Workflows](workflows.md).

### `SettlementFactory` / `SettlementFactory_SettleBatch`
The registry factory that atomically settles a batch of
[allocations](#allocation), enforcing per-instrument conservation (total sent
equals total received) across the batch. Implemented in
[`Registry.V2`](../../trading/CantonDex/Registry/V2.daml); conservation proven in
[`RegistryConservationTests`](../../trading-tests/CantonDex/Tests/RegistryConservationTests.daml).

### Token Standard V2 (TSv2)
See [CIP-0112](#cip-0112).

---

**Where to read next:** [Architecture](architecture.md) · [Workflows](workflows.md) · [Allocation Surface](../reference/allocation-surface.md) · [All docs](../README.md)
