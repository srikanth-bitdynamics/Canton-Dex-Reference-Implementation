# Token Standard V2 allocation surface delta

This document records the delta between the **released / stable** Token Standard
V2 allocation surface and the **pre-release** `token-standard-v2-upcoming`
surface this repo vendors and builds against. It is reconstructed from the
**actual vendored interface** so readers can audit the dependency directly.

For the architectural rationale (why the DEX leans on these extensions for pool
inventory, not just trade reservation), see
[`docs/architecture.md`](architecture.md) — section
"3. Token Standard V2 allocation surface". This document is the
factual, file-anchored delta; the architecture doc is the design context.

## Source of truth

- Vendored interface:
  [`vendor/splice/token-standard/splice-api-token-allocation-v2/daml/Splice/Api/Token/AllocationV2.daml`](../vendor/splice/token-standard/splice-api-token-allocation-v2/daml/Splice/Api/Token/AllocationV2.daml)
- Vendor pin (upstream repo, branch, commit):
  [`vendor/splice/VENDOR_PIN.md`](../vendor/splice/VENDOR_PIN.md)
- DEX consumers:
  - [`trading/CantonDex/Trading/Utils.daml`](../trading/CantonDex/Trading/Utils.daml)
    — funding arithmetic, leg→leg-side projection, allocation/spec builders.
    Together with the registry below it consumes the full vendored surface, so
    the build fails fast if a vendored package drifts.
  - [`trading/CantonDex/Registry/V2.daml`](../trading/CantonDex/Registry/V2.daml)
    — the registry that implements `AllocationFactory` / `Allocation` /
    `SettlementFactory`.

> The build does **not** target released TSV2. It targets a pre-release branch
> at a pinned commit. See the pin file above and the README dependency section.

## Why a pre-release branch

The pool design uses allocations not only as one-shot trade reservations but
also as long-lived, iterated pool inventory. That requires iterated-settlement
and committed-allocation semantics that, at the recorded pin, live only on the
`token-standard-v2-upcoming` branch and are not part of released TSV2. The
fields below are the specific surface elements that differ.

## Surface delta

The following fields/behaviours are present on the vendored upcoming surface and
are consumed directly by the DEX. Against released TSV2 they are either new or
behave differently.

### `committed` — on `AllocationSpecification`

Defined in `AllocationV2.daml` on `AllocationSpecification`
(`committed : Bool`). When `True`, the authorizer cannot withdraw the
allocation until the settlement deadline passes (or the executors
settle/cancel, or the admin expires it). This is what lets pool liquidity sit in
an allocation that an LP cannot casually pull back.

DEX usage:

- `PoolLiquidityRules.mkOperatorReceiver` and `PoolLiquidityRules.dvpSpec`
  (`trading/CantonDex/Dex/PoolLiquidityRules.daml`) build committed specs for
  pool slices and LP DvP legs.

### `nextIterationFunding` — on `AllocationSpecification`, `FinalizedAllocation`, and `Allocation_Settle`

`nextIterationFunding : Optional (TextMap.TextMap Decimal)`, keyed by instrument
id with positive amounts. Setting it to `None` disables iterated settlement (the
allocation can settle exactly once with its specified legs). An empty map
enables iterated settlement with no reserved funding. It appears in three
places on the vendored surface:

- `AllocationSpecification.nextIterationFunding` — funds reserved at allocation
  creation for the next iteration.
- `FinalizedAllocation.nextIterationFunding` — the funding to reserve for the
  next iteration at settlement time.
- `Allocation_Settle.nextIterationFunding` — same, on the settle choice;
  `None` here signals that no further iterations follow.

DEX usage:

- `Utils.netFundingDelta` / `Utils.adjustedNextIterationFunding` /
  `Utils.normalizeFunding` compute the per-instrument funding map the authorizer
  must cover.
- `Utils.mkIteratedAllocationSpecification` /
  `mkPrefundedAllocationSpecification` set it on the spec.
- `Registry.V2.allocationFactory_allocateImpl` validates that the locked input
  holdings cover the sender-side legs **plus** `nextIterationFunding`
  (`required = sideRequired ∪ funding`).
- `Registry.V2.allocation_settleImpl` rolls `arg.nextIterationFunding` forward
  into a fresh allocation with `numIterations + 1`.

### `nextIterationAllocationCid` — via `AllocationResult_Settled`

On the released surface a settle result does not carry a forward pointer to a
next-iteration allocation. The vendored surface's
`AllocationResult_Output = AllocationResult_Settled with nextIterationAllocationCid : Optional (ContractId Allocation)`
returns the allocation created for the next iteration (or `None` when fully
settled).

DEX usage:

- `Registry.V2.allocation_settleImpl` populates
  `AllocationResult_Settled next`, where `next` is the freshly created
  next-iteration allocation when `nextIterationFunding` is set.
- `Utils.nextIterationAllocationCids` reads these back out of a
  `SettlementFactory_SettleBatchResult` (order-preserving; `Some` when the
  allocation rolled forward, `None` when fully settled). Partial fills rely on
  this to roll the resting order forward.

### `FinalizedAllocation.extraTransferLegSides`

`FinalizedAllocation.extraTransferLegSides : [TransferLegSide]` lets executors
supply the concrete transfer leg sides to authorize **in this settlement
iteration**, on top of the legs fixed at allocation creation. They MUST be empty
unless the authorizer enabled iterated settlement. The matching
`Allocation_Settle.extraTransferLegSides` choice argument carries them into the
settle path.

DEX usage:

- `Utils.mkFinalizedAllocation`
  builds a `FinalizedAllocation` carrying extra leg sides + optional funding;
  `Utils.finalAllocation` is the settle-as-is form (no extra legs, no next
  iteration).
- `OrderMatchExecution` supplies concrete match legs as
  `extraTransferLegSides` at batch-settlement time (see
  `docs/quickstart.md` section C and `trading/CantonDex/Dex/OrderMatchExecution.daml`).
- `Registry.V2.allocation_settleImpl` appends `arg.extraTransferLegSides` to the
  spec's fixed `transferLegSides` (`allSides = spec.transferLegSides ++ arg.extraTransferLegSides`)
  and credits receiver-side holdings for the authorizer.
- `Registry.V2.settlementFactory_settleBatchImpl` threads each
  `FinalizedAllocation`'s `extraTransferLegSides` and `nextIterationFunding`
  into the per-allocation `Allocation_Settle`.

### Retirement of `Allocation_Adjust`

The vendored `AllocationV2.daml` `Allocation` interface exposes exactly three
state-changing choices: `Allocation_Settle`, `Allocation_Cancel`, and
`Allocation_Withdraw`. There is **no** `Allocation_Adjust` choice on the
upcoming surface. Earlier/alternative designs adjusted an allocation's
authorized amounts in place via a dedicated choice; on this surface that role is
subsumed by iterated settlement — `Allocation_Settle` carries
`extraTransferLegSides` and `nextIterationFunding` and emits a next-iteration
allocation via `nextIterationAllocationCid`, so the funding "adjustment" happens
as part of settle rather than as a separate choice.

This is why the conservation test was renamed: the former
`testAllocationAdjustConservation` is succeeded by
`testFinalizedAllocationFundingConservation` in
[`trading-tests/CantonDex/Tests/EndToEndTests.daml`](../trading-tests/CantonDex/Tests/EndToEndTests.daml).
(That test is being filled in separately; the name reflects the surface, not its
current coverage.)

## Migration commitment

This is **not** a long-term fork. When the iterated-settlement and
committed-allocation semantics above land in a released Token Standard V2, the
repo will re-pin `vendor/splice/` to that release and drop the
`token-standard-v2-upcoming` dependency. Until then the pin in
[`vendor/splice/VENDOR_PIN.md`](../vendor/splice/VENDOR_PIN.md) is the
authoritative record of exactly what the build targets.
