# Token Standard V2 allocation surface

This document is the file-anchored reference for the Token Standard **V2
(CIP-0112)** allocation features the DEX consumes: committed allocations,
iterated settlement, and the exact DEX code that uses each one.

The DEX uses allocations for two jobs. The obvious one is reserving funds for a
single trade. The load-bearing one is holding **long-lived, iterated inventory**:
a bid, an ask, and each side of pool liquidity are backed by an allocation that
stays live and rolls forward across many settlements. Pool slices and
deadline-bounded orders use commitment; GTC orders use iteration without
commitment so the trader retains a unilateral exit. These jobs pull in the
allocation and iterated-settlement parts of the standard catalogued below.

For the architectural rationale (why the pool leans on these features rather
than a custom balance with an escrow bridge behind it), see
[`../concepts/architecture.md`](../concepts/architecture.md), section
["What settles value: the Token Standard V2 spine"](../concepts/architecture.md#what-settles-value-the-token-standard-v2-spine).
That page is the design context; this page is the field-by-field reference.

## Source of truth

- Standard interface (vendored):
  [`vendor/splice/token-standard/splice-api-token-allocation-v2/daml/Splice/Api/Token/AllocationV2.daml`](../../vendor/splice/token-standard/splice-api-token-allocation-v2/daml/Splice/Api/Token/AllocationV2.daml)
- Vendor pin (upstream repo, branch, commit):
  [`../../vendor/splice/VENDOR_PIN.md`](../../vendor/splice/VENDOR_PIN.md)
- DEX consumers:
  - [`trading/CantonDex/Trading/Utils.daml`](../../trading/CantonDex/Trading/Utils.daml)
    — funding arithmetic, leg→leg-side projection, allocation/spec builders.
    Together with the registry below it exercises every field listed here, so
    the build fails fast if a re-pin changes the surface.
  - [`trading/CantonDex/Registry/V2.daml`](../../trading/CantonDex/Registry/V2.daml)
    — the reference registry implementing `AllocationFactory` / `Allocation` /
    `SettlementFactory`.

## Surface features

The following fields and behaviours are the Token Standard V2 allocation-surface
elements the DEX consumes directly. Each is defined in `AllocationV2.daml`; the
"DEX usage" notes point at the code that reads or sets it.

### `committed` — on `AllocationSpecification`

`committed : Bool` on `AllocationSpecification`. When `True`, the authorizer
cannot withdraw the allocation until the settlement deadline passes (or the
executors settle/cancel it, or the admin expires it). This lets pool liquidity
sit in an allocation that an LP cannot casually pull back:

```daml
committed : Bool
  -- ^ Whether the authorizer commits to the allocation until either
  --   - the executors settle allocation,
  ...
  --   - the admin expires the allocation.
  -- If set to `True`, then the authorizer cannot withdraw the allocation
  -- until the settlement deadline.
```

The matching enforcement is on `Allocation_Withdraw`: "For committed allocations
(i.e., `committed` set to `True`), this choice can only be exercised once the
settlement deadline has passed."

DEX usage:

- `PoolLiquidityRules.mkOperatorReceiver` and `PoolLiquidityRules.dvpSpec`
  (`trading/CantonDex/Dex/PoolLiquidityRules.daml`) build committed specs for
  pool slices and LP DvP legs.
- `Order.orderFundingSpecification` commits an expiring order only through its
  deadline. A GTC order has no bounded deadline, so it is deliberately
  uncommitted and its trader can exercise `Allocation_Withdraw` at any time.
- Swap allocations are terminal and uncommitted. If the bound pool snapshot is
  stale before settlement, the trader can withdraw the allocation.

### `nextIterationFunding` — on `AllocationSpecification`, `FinalizedAllocation`, and `Allocation_Settle`

`nextIterationFunding : Optional (TextMap.TextMap Decimal)`, keyed by instrument
id with positive amounts. Setting it to `None` disables iterated settlement (the
allocation settles exactly once, with its specified legs). An empty map enables
iterated settlement with no reserved funding. It appears in three places on the
surface:

- `AllocationSpecification.nextIterationFunding` — funds reserved at allocation
  creation for the next iteration.
- `FinalizedAllocation.nextIterationFunding` — the funding to reserve for the
  next iteration at settlement time.
- `Allocation_Settle.nextIterationFunding` — same, on the settle choice; `None`
  here signals that no further iterations follow.

DEX usage:

- `Utils.netFundingDelta` / `Utils.adjustedNextIterationFunding` /
  `Utils.normalizeFunding` compute the per-instrument funding map the authorizer
  must cover.
- `Utils.mkIteratedAllocationSpecification` /
  `Utils.mkPrefundedAllocationSpecification` set it on the spec.
- `Registry.V2.allocationFactory_allocateImpl` validates that the locked input
  holdings cover the sender-side legs **plus** `nextIterationFunding`
  (`required = Utils.textMapUnionWith (+) sideRequired funding`).
- `Registry.V2.allocation_settleImpl` rolls `arg.nextIterationFunding` forward
  into a fresh allocation with `numIterations + 1`.

### `nextIterationAllocationCid` — via `AllocationResult_Settled`

A settle result carries a forward pointer to the allocation created for the next
iteration:

```daml
| AllocationResult_Settled
    with
      nextIterationAllocationCid : Optional (ContractId Allocation)
        -- ^ The new allocation created for the next settlement iteration, if any.
```

It is `None` when the allocation is fully settled.

DEX usage:

- `Registry.V2.allocation_settleImpl` returns
  `AllocationResult_Settled nextCid`, where `nextCid` is the freshly created
  next-iteration allocation when `nextIterationFunding` is set, and `None`
  otherwise.
- `Utils.nextIterationAllocationCids` reads these back out of a
  `SettlementFactory_SettleBatchResult` (order-preserving; `Some` when the
  allocation rolled forward, `None` when fully settled). Partial fills rely on
  this to roll the resting order forward.

### `FinalizedAllocation.extraTransferLegSides`

`FinalizedAllocation.extraTransferLegSides : [TransferLegSide]` lets executors
supply the concrete transfer leg sides to authorize in this settlement
iteration, on top of the legs fixed at allocation creation. Per the standard,
they "MUST be empty unless iterated settlement was enabled by the allocation's
authorizer." The matching `Allocation_Settle.extraTransferLegSides` choice
argument carries them into the settle path.

DEX usage:

- `Utils.mkFinalizedAllocation` builds a `FinalizedAllocation` carrying extra
  leg sides + optional funding; `Utils.finalAllocation` is the settle-as-is form
  (no extra legs, no next iteration).
- `OrderMatchExecution` supplies concrete match legs as `extraTransferLegSides`
  at batch-settlement time (see the prefunded-order tour in
  [`../guides/builder-guide.md`](../guides/builder-guide.md) and
  `trading/CantonDex/Dex/OrderMatchExecution.daml`).
- `Registry.V2.allocation_settleImpl` appends `arg.extraTransferLegSides` to the
  spec's fixed `transferLegSides`
  (`allSides = spec.transferLegSides ++ arg.extraTransferLegSides`) and credits
  receiver-side holdings for the authorizer.
- `Registry.V2.settlementFactory_settleBatchImpl` threads each
  `FinalizedAllocation`'s `extraTransferLegSides` and `nextIterationFunding`
  into the per-allocation `Allocation_Settle`.

### Order funding rolls forward during settlement

For a partial fill, `Allocation_Settle` carries `extraTransferLegSides` and
`nextIterationFunding`, then returns the next allocation through
`nextIterationAllocationCid`. The order remainder is created in that same
transaction and references the returned allocation. There is no separate
funding-mutation step between settlement and order roll-forward.

`testOrderRemainderFundingArithmetic` in
[`trading-tests/CantonDex/Tests/EndToEndTests.daml`](../../trading-tests/CantonDex/Tests/EndToEndTests.daml)
checks the matcher-side residual calculation. The real-holding conservation
checks are in
[`RegistryConservationTests.daml`](../../trading-tests/CantonDex/Tests/RegistryConservationTests.daml),
where `SettleBatch` enforces that spent plus rolled-forward funding cannot exceed
the allocation's locked backing.

## Vendoring

This repo commits released Token Standard V2 DARs under
[`vendor/splice/dars/`](../../vendor/splice/dars/) for reproducible builds. The
source tree is retained for readable API and example-code reference, but it is
not compiled into the DEX. The authoritative dependency record is
[`vendor/splice/VENDOR_PIN.md`](../../vendor/splice/VENDOR_PIN.md).

---

**Where to read next:** [Architecture](../concepts/architecture.md) · [Registry Integration](../guides/registry-integration.md) · [All docs](../README.md)
