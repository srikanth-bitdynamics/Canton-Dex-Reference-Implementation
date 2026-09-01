# Glossary

Key terms used across the Canton DEX docs and code. Start with **Canton and Daml
foundations** if this is your first Canton application; the second section is a
lookup for the Token Standard and exchange design. Where useful, entries link
to the defining Daml module, an executable test, or a deeper concept page.

For a connected explanation rather than isolated definitions, read the
[Canton and Daml primer](canton-daml-primer.md).

## Canton and Daml foundations

### Active Contract Set (ACS)

The contracts that have been created and not archived, as visible to the party
making the query. The ACS is current ledger state, not a globally readable
table: two parties can see different subsets. The backend indexer projects ACS
and transaction events into its off-ledger read model.

### Canton

The distributed-ledger system on which this application runs. Canton connects
participant nodes through synchronizers while preserving party-scoped
visibility; Daml defines the contracts and transactions participants process.

### Canton DevKit

An optional, separately distributed development tool that can manage a
persistent Docker-based Splice LocalNet. It is not required by the DEX source,
DARs, backend, or default live proof. If DevKit is unavailable, use the
repository's [DPM sandbox proof](../guides/localnet.md#path-a-portable-dpm-sandbox-proof).

### Choice

A named operation defined on a Daml template or interface. Exercising a choice
can fetch, create, archive, or exercise other contracts in one transaction, but
its [controller](#controller) must authorize it. A choice is consuming by
default; a `nonconsuming choice` leaves its target contract active.

### Command

A client's request to create a contract or exercise a choice. One submission
can contain multiple commands; the resulting Daml transaction either commits
atomically or fails as a whole.

### Contract / contract ID (CID)

An immutable on-ledger instance of a [template](#template). Its contract ID
identifies that exact active instance. When a consuming choice archives a
contract and creates its successor, the successor has a new ID. Values such as
`#mock-…:0` returned by Mock Wallet are UI placeholders, not Canton contract
IDs.

### Controller

The party or parties whose authority is required to exercise one Daml choice.
For example, `DexPair_SetActive` is controlled by the DEX operator. A party
that can see the contract is not necessarily its choice controller.

### Daml

The smart-contract language and ledger model used by this reference. A Daml
template declares contract data, stakeholders, and choices; the engine checks
authorization and atomic transitions.

### Daml Script

A Daml library and runner for allocating test parties, submitting commands,
querying contracts, and asserting results. `dpm test` runs this repository's
Script declarations in a Daml ledger engine. It enforces Daml semantics but
does not, by itself, start a Canton participant, backend, or browser.

### DAR (Daml Archive)

The build artifact containing compiled Daml packages and dependencies. Running
`dpm build` in `trading/` produces the DEX DAR. Uploading a DAR makes its code
available to a participant; it does not create application contracts or seed
liquidity.

### DPM sandbox

The real Canton sandbox process bundled with the Daml SDK selected by DPM. The
repository's default live proof starts it temporarily, uploads the package
closure, runs a JSON Ledger API DvP driver, and removes its state after success.
It is a one-process proof, not a persistent Splice LocalNet. See
[Local Canton](../guides/localnet.md#path-a-portable-dpm-sandbox-proof).

### JSON Ledger API

The HTTP/JSON API used by this repository's live backend adapter to submit Daml
commands and read ledger updates from a Canton participant. The local dev
server replaces this adapter with a TypeScript `InMemoryLedger`, so it does not
exercise the JSON Ledger API.

### LocalNet

A local network used for Canton/Splice development. In these docs, **DevKit
LocalNet** means the optional persistent Docker-managed environment; it is
distinct from the default throwaway [DPM sandbox](#dpm-sandbox). Neither is a
production topology.

### Observer

A contract stakeholder explicitly granted visibility without being required to
authorize its creation. Observing a contract does not automatically grant
authority to exercise its choices.

### Package / package ID

A compiled unit of Daml code with a content-derived package ID. Template IDs on
a live ledger include the package identity. The repository's package name and
version help humans find the DAR, but deployments must use the package IDs
actually uploaded and vetted on their network.

### Participant

A Canton node that hosts parties, exposes Ledger APIs, validates submissions,
and stores the ledger data visible to its hosted parties. A participant is
infrastructure; it is not the same thing as a [party](#party).

### Party

A logical on-ledger identity that can authorize Daml actions and be named as a
stakeholder. Traders, the DEX operator, the asset admin, and the LP registrar
are parties. Real Canton party IDs normally include a fingerprint such as
`alice::1220…`; `trader-demo` is only a local seed label.

### Signatory

A party that authorizes a Daml contract's creation and remains a stakeholder
with visibility while it is active. Signatories are declared in the template's
`where` block.

### Synchronizer

Canton infrastructure that coordinates transaction sequencing and confirmation
between connected participants. It does not turn every participant into a
public full node or make every contract visible to everyone.

### Template

A Daml definition containing the fields, signatories, observers, and choices
for one kind of contract. `PoolState` is a template; each live pool-state
contract is an instance with its own contract ID.

### Transaction

The atomic result of one submission: all creates, exercises, nested choices,
and archives commit together or none commit. A pool swap relies on this so
Token Standard settlement, reserve-slice updates, and `PoolState` replacement
cannot partially succeed.

## Token Standard and DEX terms

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
and the actions available to the target party. The target's wallet accepts a
request with `AllocationRequest_Accept`, which archives it and authors the
allocation; for liquidity funding the accept composes with
`AllocationFactory_Allocate`. The accept leaves acceptance evidence the later
settlement relies on, so settlement does not consume a still-live request. The
DEX's variants are
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

### Boundary slice

The last reserve slice in the ordered set that a swap or liquidity removal draws
on to cover an amount. Earlier slices in the set are consumed in full; the
boundary slice is usually only partially drawn, so its unused remainder is
re-wrapped into a fresh `PoolSlice`. Selecting an ordered prefix this way keeps
each swap touching only a few slices rather than the whole pool.

### Committed allocation
An [allocation](#allocation) authored with `committed = True`, so the authorizer
cannot unilaterally withdraw it before its deadline and the executor has an
availability guarantee. Pool reserve slices are committed. Expiring order
collateral is committed through its deadline; GTC order collateral is
uncommitted to preserve a trader-controlled exit. Field on
`AllocationSpecification`; see
[`PoolSlice`](../../trading/CantonDex/Dex/PoolSlice.daml).

### DexPair
The operator's listing record for one market: base + quote
[instrument ids](#instrumentid), the fee model (maker/taker/pool bps), the
trading mode (`TM_OrderBook`, `TM_Pool`, or `TM_Both`), and an `active` flag.
Template [`DexPair`](../../trading/CantonDex/Dex/DexPair.daml).

### DvP (delivery-versus-payment)
An atomic exchange where both legs settle together or not at all. Swaps, LP
add/remove, order fills, and matched trades all settle as DvP through
`SettlementFactory_SettleBatch`, with legs grouped per instrument admin — a swap
under one or two admins, add/remove liquidity under one to three, an order fill
under one or two. See [Liquidity & Custody](liquidity-and-custody.md);
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
next iteration via `nextIterationFunding`. Pool reserve slices and resting orders
use it so one allocation can back many settlements: a resting order is prefunded
with no legs at placement — `nextIterationFunding` covers the lock — and the
operator supplies the concrete legs at match time. The trader's swap allocations
— one per instrument admin — are terminal and sign the exact input and output
sides. Iteration is
independent of whether an allocation is committed. Enforced in
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
Template [`MatchedTrade`](../../trading/CantonDex/Dex/MatchedTrade.daml); its
allocation and batch-settlement behavior is proven in
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
holdings without that trader's allocation. The operator-mediated RFQ path is a
separate authority model in which the backend ledger user is explicitly granted
act-as rights for configured parties; it is not a public relay supplied by the
repository.

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
equals total received) across the batch. Each flow groups its legs by instrument
admin and exercises one `SettlementFactory_SettleBatch` per admin inside a single
Daml choice; swaps and liquidity reach it through a request-then-settle path,
where the request records the on-ledger allocation specs and one settle choice
batches them. Implemented in
[`Registry.V2`](../../trading/CantonDex/Registry/V2.daml); conservation proven in
[`RegistryConservationTests`](../../trading-tests/CantonDex/Tests/RegistryConservationTests.daml).

### Token Standard V2 (TSv2)
See [CIP-0112](#cip-0112).

---

**Where to read next:** [Canton and Daml primer](canton-daml-primer.md) ·
[AMM-first walkthrough](../tutorials/amm-first-walkthrough.md) ·
[Architecture](architecture.md) · [Workflows](workflows.md) ·
[Allocation Surface](../reference/allocation-surface.md) · [All docs](../README.md)
