# LP Token Versioning Strategy

## Decision

**Canton DEX LP tokens are unversioned.** The LP token `instrumentId` for a
given pool is derived from the pool's pair (e.g., `BTC-USDC-LP`) and does
**not** include a version suffix or per-iteration discriminator.

## Rationale

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

The pool contract template carries `lpInstrumentId : V2.InstrumentId` as a
static field fixed at pool creation. It MUST NOT be derived from the pool's
contract id, the current settlement iteration, or the pool's status — those
all change over a pool's life and would re-version the LP behind users' backs.

Concretely:

- `PoolLiquidityRules_SettleAddLiquidity` mints `lpInstrumentId` tokens at the pool's
  current proportional ratio. The minted holdings use the same `instrumentId`
  as every prior LP minted from this pool.
- `PoolLiquidityRules_SettleRemoveLiquidity` burns `lpInstrumentId` tokens. The pool
  does not care which iteration created them.
- The `LPTokenPolicy` registrar must accept any holding of `lpInstrumentId`
  for burn — there is no version check.

## What about settlement iterations?

The V2 allocation API introduces `nextIterationAllocationCid` so the pool can hand pool-
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

## Why one LP instrument per pool

- The LP registrar/policy component is the issuer of the LP token for the
  pool. Fee accrual is reserve growth on the underlying assets, not a separate
  coupon event that needs to be crystallized into a new instrument version.
- There is no off-ledger lifecycle event that LP holders need to settle
  out before continuing to trade. A pool's fee revenue accumulates in its
  reserves; redeem-by-burn always pays out the current ratio.

## Why this is separate from registry primitive versioning

Some lifecycle-aware registry-side instruments may version when their issuer
makes a breaking change — e.g., a coupon payment at epoch N that needs to be
paid into v_N holdings before they roll forward to v_{N+1}. That is a
fundamentally different shape of problem from the LP token:

- **Registry primitives** have an external issuer who occasionally needs
  to crystallize an off-ledger event onto the on-chain instrument. One
  registry-specific pattern is upgrade-on-use inside the transfer/allocation
  factories, plus a force-upgrade choice for passive holders who never touch
  their balance.
- **LP tokens** have the pool's LP registrar/policy as the issuer. The
  reference LP token has no off-ledger event to crystallize against a passive
  holder's balance. So upgrade-on-use plus force-upgrade does not apply in this
  reference — the LP token simply stays at one stable `instrumentId` for the
  life of the pool.

That means a wallet, lending market, or vault that consumes registry
primitives needs to handle upgrade-on-use behavior; the same wallet
consuming LP tokens does not. The two surfaces look fungible-equivalent
externally but have different upgrade semantics under the hood, and
that's by design.

See [CIP-0112](https://github.com/global-synchronizer-foundation/cips/blob/main/cip-0112/cip-0112.md)
for the canonical V1→V2 compatibility framing — V1 instruments continue
to exist alongside V2 implementations rather than being bulk-migrated.

## See also

- [docs/registry-prerequisites.md](../guides/registry-integration.md) — for how the
  LP registry config is registered at pool creation in the reference registry,
  and for the registry-specific force-upgrade pattern some assets may exercise.
- [docs/workflows.md](workflows.md) — for the add/remove-liquidity flow.

---

**Where to read next:** [Liquidity & Custody](liquidity-and-custody.md) · [Add an LP or Instrument](../guides/add-lp-or-instrument.md) · [All docs](../README.md)
