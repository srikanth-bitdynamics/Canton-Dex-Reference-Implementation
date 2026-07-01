# Glossary

Key terms used across the Canton DEX docs and code. Standard terms link to the
canonical Canton / Token Standard sources; DEX-specific terms link to the doc
that explains them in depth.

### Allocation
A Token Standard V2 contract that **locks** a holder's [holding](#holding) for a
specific settlement, so it can be settled atomically later. The DEX never moves
trader assets directly — it moves them by having the trader create allocations
and then settling a batch. See [Allocation Surface](../reference/allocation-surface.md).

### AllocationFactory / `AllocationFactory_Allocate`
The registry-provided factory choice a holder exercises to turn holdings into an
[Allocation](#allocation). The holder's own authority drives it, which is why
funding an order or adding liquidity must go through the trader's wallet.

### AllocationRequest
A V2 contract asking a party to create the allocations a settlement needs. The
party accepts by composing `AllocationFactory_Allocate` in the same submission.
The DEX uses `OrderAllocationRequest`, `LiquidityAllocationRequest`, and
`TradeAllocationRequest`.

### Choice context / disclosure
The extra arguments (`ExtraArgs`) and disclosed contracts a **registry** requires
when its factory choices are exercised. The operator backend fetches these and
attaches them to each submission. See [Choice Context](../guides/choice-context.md).

### CIP-0056
The **Canton Network Token Standard** — the base standard (holdings, transfers,
metadata) that CIP-0112 revises.

### CIP-0103
The **dApp Standard** — the wallet interaction standard used for
[prepare/sign/execute](#prepare--sign--execute) interactive submission. The dApp
hands trader-authority commands to a wallet over CIP-0103.

### CIP-0112
The **Canton Network Token Standard V2** — the privacy / performance /
traditional-accounting revision of CIP-0056, adding the allocation + settlement
surface this DEX is built on. Often written "Token Standard V2" or "TSv2".

### Committed allocation
An [allocation](#allocation) whose backing is committed to the pool so the pool
can settle against it repeatedly. Pool reserves are held as committed
allocations, one per [slice](#pool--poolstate--poolslice).

### DexPair
The listing record for a market: base + quote [instrument ids](#instrumentid),
fee model, trading mode (`OrderBook`, `Pool`, or `Both`), and an `active` flag.

### DvP (delivery-versus-payment)
An atomic exchange where both legs settle together or not at all. Swaps, LP
add/remove, and matched trades are all DvP over a `SettleBatch`. See
[Liquidity & Custody](liquidity-and-custody.md).

### FinalizedAllocation
The V2 settle-time structure that carries the concrete match legs
(`extraTransferLegSides`) and the roll-forward funding (`nextIterationFunding`)
for [iterated settlement](#iterated-settlement).

### Holding
A V2 contract representing a party's balance of an instrument. Base assets,
quote assets, and LP tokens are all holdings.

### InstrumentId
The `{admin, id}` pair that identifies a V2 instrument. Two instruments with the
same `id` but different `admin` are **different** instruments.

### Iterated settlement
Settling in steps, where each step rolls the remaining backing forward to the
next iteration via `nextIterationFunding`. Used by pool swaps and partial order
fills so a single committed allocation can back many settlements.

### LP token / `LPTokenPolicy` / lpRegistrar
The pool's liquidity-provider share is a V2 instrument (the **LP token**),
administered by the **lpRegistrar** and governed by the **`LPTokenPolicy`**
contract. The policy knows nothing about pools or orders. See
[LP Tokens](lp-tokens.md).

### MatchedTrade
The settled result of a bilateral trade (e.g. an accepted [RFQ](#rfq)), carrying
an operator-signed [`PolicyReceipt`](#policyreceipt) and settled via a
per-admin `SettleBatch`.

### Mint / burn account
Special Token Standard accounts with `owner = None`, used as the counterparty
for LP-token **mint** (issuance) and **burn** (redemption) legs.

### Operator
The venue operator: orchestrates matching, binds orders, and submits the
settlement batches it is authorized to submit. It never moves trader assets on
its own.

### Over-lock
Locking **more** backing than a settlement strictly needs. Token Standard V2
accepts `have >= needed`; the surplus is returned as unlocked change when the
batch settles.

### PolicyReceipt
An operator-signed record of the ranking/whitelist policy applied to an
[RFQ](#rfq), folded into `SettlementInfo.meta` so the decision is auditable.

### Pool / PoolState / PoolSlice
The constant-product pool is split three ways: **Pool** (immutable config),
**PoolState** (the hot reserves / LP supply / status), and **PoolSlice** (one
[committed allocation](#committed-allocation) per locality unit). Slices are
operator-authored locality units, **not** per-LP entitlement.

### prepare / sign / execute
The three steps of CIP-0103 interactive submission: the dApp **prepares** a
transaction, the wallet **signs** it, and it is **executed** on the ledger. A
prepared transaction may carry only **one** top-level command.

### Registry / Registrar
The component that defines instrument semantics and supplies
[choice context](#choice-context--disclosure). It is **external** to the DEX;
this repo ships a reference registry, but Token Standard V2 does not require that
exact one. See [Registry Integration](../guides/registry-integration.md).

### RFQ (request-for-quote)
The bilateral block-trade flow: a trader posts an RFQ, dealers quote, and a joint
`Rfq_Accept` emits a [MatchedTrade](#matchedtrade). See [Workflows](workflows.md).

### `SettlementFactory` / `SettlementFactory_SettleBatch`
The registry-provided factory that atomically settles a batch of
[allocations](#allocation), enforcing per-instrument conservation (total sent
equals total received) across the batch.

### Token Standard V2 (TSv2)
See [CIP-0112](#cip-0112).
