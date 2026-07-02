# Registry Prerequisites

What the DEX assumes from an asset registry. Token Standard V2 standardizes the
holding/allocation/settlement interfaces; it does not standardize a particular
instrument-configuration or lifecycle template. This document therefore
separates hard V2 interface requirements from the reference registry's optional
configuration model in `trading/CantonDex/Instrument/`.

## What the registry guarantees

For every instrument the DEX trades, the registry must provide:

1. **A stable `InstrumentId` and admin.** The DEX keys orders, pools, RFQs, and
   matched trades by `InstrumentId`. In the reference registry this information
   lives on `InstrumentConfiguration`; another registry may expose it through
   metadata, discovery APIs, or disclosed config contracts.

2. **Holdings** as registry-side templates implementing the V2 holding
   interface. The DEX never mints or burns its own holdings (except LP
   tokens, which have their own `lpRegistrar`); it observes the
   registry's holdings.

3. **An allocation factory** implementing `V2.AllocationFactory` for
   the admin's instruments. The trader exercises
   `AllocationFactory_Allocate` under their own authority to lock
   their holdings into a `V2.Allocation`.

4. **A settlement factory** implementing `V2.SettlementFactory` for
   the admin's instruments. The DEX operator exercises
   `SettlementFactory_SettleBatch` to atomically settle batches of
   allocations.

## What the DEX assumes from those guarantees

| Assumption | Where it shows up |
|---|---|
| `instrumentId` is stable across the instrument's lifetime | Order, Pool, MatchedTrade, Rfq all key on it |
| Registry config/metadata changes are admin-controlled | Operator backend caches config/context and listens for archive/recreate cycles where the registry provides disclosed config contracts |
| Holdings can be locked / unlocked / split / merged by admin | The trader's wallet or registry handles holding selection before allocation accept |
| Allocation factory accepts arbitrary `AllocationSpecification` shapes (prefunded, with-legs, committed, with `nextIterationFunding`) | Order's prefunded model and Pool's committed model both depend on this |
| Settlement factory enforces transfer-leg consistency with allocations | OTC / matched-trade settlement and `PoolRules_Swap` rely on the factory to validate, not the DEX |

## Mint / Burn / Transfer prerequisites

For trader-facing flows (mint, burn, hold, transfer), the reference registry
exposes request/accept templates. These are not Token Standard V2 requirements;
they are one implementation pattern. The local mirror in
`CantonDex/Instrument/` defines the on-ledger shape:

- `MintRequest` — requestor-signed; admin accepts to create a
  `Holding`. Required preconditions in the reference registry:
  `InstrumentConfiguration` exists; if `issuerRequirements` is non-empty,
  requestor presents matching `Credential` claims at accept time.
- `BurnRequest` — requestor-signed with a pre-locked holding; admin
  accepts to archive the holding. Cancel/reject release the lock.
- `TransferOffer` — sender-signed with a pre-locked holding; receiver
  + admin jointly accept; both must satisfy `holderRequirements`.
- `TransferPreapproval` — receiver-signed; allows `TransferOffer_AcceptPreapproved`
  by sender + admin without explicit receiver accept, scoped to specified
  instrument ids (or all under the admin if empty).

## What the registry MUST enforce for iterated settlement

The DEX uses iterated settlement: the authorizer opts in by creating an
allocation with `nextIterationFunding = Some ...`, and the settlement
executor supplies concrete trade leg-sides in
`FinalizedAllocation.extraTransferLegSides` when calling
`SettlementFactory_SettleBatch`.

This pattern places funds under executor control between iterations. To
keep the executor from misusing those funds, the registry's settlement
implementation MUST enforce funding conservation **in Daml**, not in
operator code:

1. **Reject extra settlement leg-sides when the allocation was not
   iterated-enabled.** Iterated settlement is opt-in by the authorizer.
2. **Every extra leg-side must involve the authorizer** as sender or
   receiver. Legs between unrelated parties cannot be smuggled into the
   authorizer's allocation.
3. **Per-instrument net outflow from the authorizer must not exceed the
   current `nextIterationFunding[instrumentId]`.** Self-transfer legs
   (sender == receiver == authorizer) net to zero.
4. **Any next-iteration allocation produced by settlement must carry an
   updated `nextIterationFunding` reduced by the consumed amount per
   instrument.** This is the double-spend guard for follow-on iterations.
5. **The DEX operator (settlement executors) must be able to observe
   the allocation lifecycle** so each settlement iteration is visible to
   them and to anyone monitoring the operator's stream.

When these are enforced in Daml, a malicious operator attempting to
spend funds the authorizer never granted has to submit an **invalid
Daml transaction**, which the engine rejects regardless of operator
intent.

The mock at [MockRegistry.daml](../../trading/CantonDex/Testing/MockRegistry.daml)
implements these conservation rules and is covered by the iterated
settlement tests in
[EndToEndTests.daml](../../trading-tests/CantonDex/Tests/EndToEndTests.daml).
Production registries are expected to do at least the same.

## Choice-context retrieval the DEX needs

When the operator or trader builds a transaction that touches a registry
contract, the registry may require extra disclosed contracts or context. In the
reference registry this includes the `InstrumentConfiguration` CID and, where
required, credential CIDs that satisfy holder/issuer requirements. The DEX
operator backend's **registry-client** module is responsible for fetching the
registry-specific context and attaching it to the choice arguments.

See [Choice Context](choice-context.md) for the exact
inputs each registry choice expects.

## Force-upgrade for passive holders

Some registries may reserve the right to force-upgrade holdings to a new
instrument version. Token Standard V2 does not standardize this lifecycle flow;
it is registry-specific.

What this means in practice for a DEX integrator:

- **Active holders upgrade themselves.** One possible pattern is
  *upgrade-on-use* — the registry's transfer/allocation factories
  rewrite the holding to the current version on any operation that
  touches it. A holder who is actively trading or otherwise moving
  their position pays for the upgrade implicitly as part of that
  operation. The DEX-side commands (allocate, transfer, settle) sit
  squarely inside this path, so any DEX-touched holding stays current
  automatically.

- **Passive holders may get force-upgraded by the issuer.** A holder who
  never moves their position cannot upgrade-on-use. The issuer
  exercises a force-upgrade choice on those holdings — typically gated
  by an off-ledger event the issuer needs to crystallize (coupon
  payment, regulatory event, security-fix migration). This is an
  issuer-side action, not a DEX one.

- **Issuers should do this sparingly.** Force-upgrades cost the issuer traffic
  and may disrupt active trades that touch a holding mid-upgrade.
  Issuers will batch them and choose moments when on-chain activity is
  low.

### DEX exposure model

The DEX has three classes of holdings to think about:

1. **Trader holdings used in active flows** (incoming for swaps,
   add-liquidity legs, order funding). These traverse the registry's
   transfer/allocation factories on every interaction and are
   upgrade-on-use covered.

2. **Pool reserves.** Reserves are held by the pool contract under the
   operator's authority. They are *not* passive — every swap rotates a
   slice of reserves through the factory paths. The pool is therefore
   effectively self-maintaining against issuer upgrades, with the one
   edge case that a pool sitting completely idle for a long stretch
   could fall behind. The pool's reserves are instrument-id-keyed, not
   holding-version-keyed, so a forced re-versioning of a reserve
   holding is mechanically transparent to the pool's accounting; the
   next swap that touches the reserve re-fetches the now-upgraded
   holding.

3. **LP holdings.** Issued through the LP registrar/policy component. The
   reference LP token has no off-ledger lifecycle event to crystallize. There
   is no force-upgrade event for LP tokens in this reference — see
   [LP Tokens](../concepts/lp-tokens.md).

### What DEX integrators should do

- Don't bake the holding contract id or the instrument version into UI
  state. Re-query holdings on the wallet provider's natural cadence
  (post-allocation, post-settlement, on focus).
- When a wallet command returns a "holding not found" or "holding
  version mismatch" error after a forced upgrade, re-fetch the holding
  list and retry rather than surfacing the error to the user.
- Treat instrument *id* (e.g., `BTC`) as the stable join key; treat the
  per-holding contract id and package hash as ephemeral.

The DEX's allocation flow already re-queries holdings on each user
action (pre-allocation greedy selection, post-settlement refresh), so
incidental force-upgrade exposure is minimal. Where it could bite is
manual replay tooling that caches a stale holding cid — the operator
backend's command path does not cache cids across requests.

## What the DEX does NOT assume

- It does not assume the registry is a single party. Multiple registrars
  can coexist; the DEX groups settlement by admin (see
  `splitLegsByAdmin` and `OTCTrade_Settle.batchesByAdmin`).
- It does not assume holding fungibility across admins. A trade with
  legs spanning two admins requires two batches.
- It does not assume holding precision is uniform. Each registry may expose its
  own display scale or amount constraints; the DEX treats amounts as `Decimal`
  and lets the registry enforce its own limits.
- It does not implement deployment-specific credential verification
  logic. The `Credentials.daml` model provides the reference type
  shape; production registries can replace `verifyCredentials` with
  their own verifier, typically backed by a credential registry.

---

**Where to read next:** [Choice Context](choice-context.md) · [Allocation Surface](../reference/allocation-surface.md) · [All docs](../README.md)
