# Registry Prerequisites

What the DEX assumes from the asset registry, distilled from the
Registry Utility user guide
(https://docs.digitalasset.com/utilities/devnet/overview/registry-user-guide/workflows.html)
and the local mirror of those workflows in
`trading/CantonDex/Instrument/`.

## What the registry guarantees

For every instrument the DEX trades, the registry MUST publish:

1. **An `InstrumentConfiguration`** with a stable `instrumentId : Text`
   (used as the join key from every DEX-side template), an `admin :
   Party` (the registrar), and credential requirements for holding
   (`holderRequirements`) and issuance (`issuerRequirements`). Optional
   ISIN / CUSIP for off-chain integration.

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
| `admin` is sole signatory on `InstrumentConfiguration`; updates are admin-controlled | Operator backend caches configs and listens for archive/recreate cycles |
| Holdings can be locked / unlocked / split / merged by admin | The trader's wallet or registry handles holding selection before allocation accept |
| Allocation factory accepts arbitrary `AllocationSpecification` shapes (prefunded, with-legs, committed, with `nextIterationFunding`) | Order's prefunded model and Pool's committed model both depend on this |
| Settlement factory enforces transfer-leg consistency with allocations | OTCTrade_Settle and Pool_Swap rely on the factory to validate, not the DEX |

## Mint / Burn / Transfer prerequisites

For trader-facing flows (mint, burn, hold, transfer) the registry
exposes the request/accept templates documented in the user guide. The
local mirror in `CantonDex/Instrument/` defines the on-ledger shape:

- `MintRequest` — requestor-signed; admin accepts to create a
  `Holding`. Required preconditions: `InstrumentConfiguration` exists;
  if `issuerRequirements` is non-empty, requestor presents matching
  `Credential` claims at accept time.
- `BurnRequest` — requestor-signed with a pre-locked holding; admin
  accepts to archive the holding. Cancel/reject release the lock.
- `TransferOffer` — sender-signed with a pre-locked holding; receiver
  + admin jointly accept; both must satisfy `holderRequirements`.
- `TransferPreapproval` — receiver-signed; allows `TransferOffer_AcceptPreapproved`
  by sender + admin without explicit receiver accept, scoped to specified
  instrument ids (or all under the admin if empty).

## What the registry MUST enforce in `Allocation_Adjust`

The DEX uses iterated settlement: the trader allocates an upper-bound
funding budget (`nextIterationFunding`) once, and the operator (the
settlement executor) calls `Allocation_Adjust` repeatedly to add
transfer legs as trades match.

This pattern places funds under operator control between iterations. To
keep the operator from misusing those funds, the registry's
`allocation_adjustImpl` MUST enforce funding conservation **in Daml**,
not in operator code:

1. **Reject `Allocation_Adjust` if `nextIterationFunding` is `None`.**
   Iterated adjustment is opt-in by the authorizer.
2. **Every additional leg must involve the authorizer** as sender or
   receiver. Legs between unrelated parties cannot be smuggled into the
   authorizer's allocation.
3. **Per-instrument net outflow from the authorizer (sender legs minus
   self-receiver legs) MUST NOT exceed the current
   `nextIterationFunding[instrumentId]`.** Self-transfer legs (sender
   == receiver == authorizer) net to zero.
4. **The new allocation produced by the adjustment MUST carry an
   updated `nextIterationFunding` reduced by the consumed amount per
   instrument.** This is the double-spend guard for follow-on adjusts.
5. **The DEX operator (settlement executors) MUST be in the
   allocation's observer list** so each adjustment is visible to them
   and to anyone monitoring the operator's stream.

When these are enforced in Daml, a malicious operator attempting to
spend funds the authorizer never granted has to submit an **invalid
Daml transaction**, which the engine rejects regardless of operator
intent.

The mock at [MockRegistry.daml](../trading/CantonDex/Testing/MockRegistry.daml)
implements all five rules and is covered by
`testAllocationAdjustConservation` in
[EndToEndTests.daml](../trading-tests/CantonDex/Tests/EndToEndTests.daml).
Production registries are expected to do at least the same.

## Choice-context retrieval the DEX needs

When the operator or trader builds a transaction that touches a registry
contract, the registry expects the choice arguments to include the
`InstrumentConfiguration` CID and (where required) the credential CIDs
that satisfy holder/issuer requirements. The DEX operator backend's
**registry-client** module is responsible for fetching these and
attaching them to the choice context.

See [choice-context-spec.md](./choice-context-spec.md) for the exact
inputs each registry choice expects.

## Force-upgrade for passive holders

Registry issuers reserve the right to force-upgrade holdings to a new
instrument version. Per Simon Meier (DA) on 2026-05-18:

> I'd expect that the issuer reserves the right to force-upgrade; and
> they would do so for passive holders. Issuers might not want to
> actively force-upgrade, as that impacts ongoing trading flows, and
> costs extra traffic for the issuer.

What this means in practice for a DEX integrator:

- **Active holders upgrade themselves.** The recommended pattern is
  *upgrade-on-use* — the registry's transfer/allocation factories
  rewrite the holding to the current version on any operation that
  touches it. A holder who is actively trading or otherwise moving
  their position pays for the upgrade implicitly as part of that
  operation. The DEX-side commands (allocate, transfer, settle) sit
  squarely inside this path, so any DEX-touched holding stays current
  automatically.

- **Passive holders get force-upgraded by the issuer.** A holder who
  never moves their position cannot upgrade-on-use. The issuer
  exercises a force-upgrade choice on those holdings — typically gated
  by an off-ledger event the issuer needs to crystallize (coupon
  payment, regulatory event, security-fix migration). This is an
  issuer-side action, not a DEX one.

- **Issuers do this sparingly.** Force-upgrades cost the issuer traffic
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

3. **LP holdings.** Issued by the pool itself. The AMM is the issuer
   and has no off-ledger events to crystallize. There is no
   force-upgrade event for LP tokens — see
   [docs/lp-token-versioning.md](lp-token-versioning.md).

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

See [docs/v2-migration.md](v2-migration.md) for how this connects to
the broader V1→V2 dual-implementation strategy.

## What the DEX does NOT assume

- It does not assume the registry is a single party. Multiple registrars
  can coexist; the DEX groups settlement by admin (see
  `splitLegsByAdmin` and `OTCTrade_Settle.batchesByAdmin`).
- It does not assume holding fungibility across admins. A trade with
  legs spanning two admins requires two batches.
- It does not assume holding precision is uniform. Each
  `InstrumentConfiguration` may have its own scale; the DEX treats
  amounts as `Decimal` and lets the registry enforce its own limits.
- It does not implement credential verification logic. The
  `Credentials.daml` model is a placeholder that satisfies the type
  shape; production replaces `verifyCredentials` with the registry's
  real verifier (typically calling out to a credential registry).
