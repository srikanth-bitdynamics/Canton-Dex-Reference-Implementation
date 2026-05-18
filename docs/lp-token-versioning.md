# LP Token Versioning Strategy

## Decision

**Canton-Dex LP tokens are unversioned.** The LP token `instrumentId` for a
given pool is derived from the pool's pair (e.g., `BTC-USDC-LP`) and does
**not** include a version suffix or per-iteration discriminator.

## Rationale

This decision follows direct feedback from Simon Meier (Digital Asset) on the
trade-offs of versioning the LP instrument id:

> Versioning instrument-id means LP tokens are NOT fungible across versions.
> A v3 holder and a v5 holder can't merge without explicit rebase. Order books
> quoting LP must disambiguate versions. UX gets harder: "your v5 LP is worth
> X; rebase to v7 to claim Y fee accrual." Composability with other dApps
> that treat LP as collateral collapses unless they're version-aware.

The reference DEX prioritises:

1. **Fungibility** — all LP holders for a pool hold the same instrument and
   can transfer between each other freely. Two `BTC-USDC-LP` holdings of
   amount X are interchangeable; no rebase, no migration.
2. **Composability** — other dApps (lending markets, vaults, structured
   product builders) can treat an LP holding as collateral by checking a
   single `instrumentId`. They don't need to track per-version balance maps.
3. **UX simplicity** — the wallet shows one LP balance per pool, not a
   timeline of versioned slivers.

## Implications for the Pool Contract

The pool contract template carries `lpInstrumentId : Text` as a static field
fixed at pool creation. It MUST NOT be derived from the pool's contract id,
the current settlement iteration, or the pool's status — those all change
over a pool's life and would re-version the LP behind users' backs.

Concretely:

- `Pool_AddLiquidity` mints `lpInstrumentId` tokens at the pool's current
  proportional ratio. The minted holdings use the same `instrumentId` as
  every prior LP minted from this pool.
- `Pool_RemoveLiquidity` burns `lpInstrumentId` tokens. The pool does not
  care which iteration created them.
- The `LPTokenPolicy` registrar must accept any holding of `lpInstrumentId`
  for burn — there is no version check.

## What about settlement iterations?

PR-5333 introduces `nextIterationAllocationCid` so the pool can hand pool-
side allocations forward across settlement batches without users re-allocating.
This is an **allocation lifecycle** concern, not an instrument-versioning
concern. The LP holdings users hold are unaffected by allocation iteration.

## What about fee/rule changes?

If the admin changes the pool's fee model, the LP instrument stays the same.
Existing LP holders share in future fees at the new rate. If the change is
non-trivial and existing LPs should be honoured at old rates, the operator
must spin up a **new pool** with a **new pair of `lpInstrumentId`** — that
is a deliberate migration, not an incidental rebase.

## What about emergency upgrades?

If the LP token policy itself needs to be replaced (security fix, choice
signature change), the upgrade path is a Canton package upgrade — same
`instrumentId`, new package hash. Holders are unaffected.

## See also

- [docs/registry-prerequisites.md](registry-prerequisites.md) — for how the
  LP `InstrumentConfiguration` is registered at pool creation.
- [docs/workflows.md](workflows.md) — for the add/remove-liquidity flow.
