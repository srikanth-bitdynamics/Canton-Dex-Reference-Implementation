# Registry Prerequisites

What the DEX assumes from the asset registry, distilled from the
Registry Utility user guide
(https://docs.digitalasset.com/utilities/devnet/overview/registry-user-guide/workflows.html)
and the local mirror of those workflows in
`pr5333/CantonDex/Instrument/`.

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

The mock at [MockRegistry.daml](../pr5333/CantonDex/Testing/MockRegistry.daml)
implements all five rules and is covered by
`testAllocationAdjustConservation` in
[EndToEndTests.daml](../pr5333-tests/CantonDex/Tests/EndToEndTests.daml).
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
