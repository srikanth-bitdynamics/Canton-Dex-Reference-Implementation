# LP tokens

An LP token is an ordinary V2 holding whose mint and burn ride the *same*
atomic settlement that moves the underlying base and quote. There is no
separate issuance lifecycle — no settle, no mint. One fungible instrument per
pool, and its value is realised only by redeeming it.

## One fungible instrument per pool

Each pool has exactly one LP instrument, fixed at pool creation as
`Pool.lpInstrumentId : V2.InstrumentId` (with `admin = lpRegistrar`). Its
identity and circulating supply live in a small `LPTokenPolicy` that knows
nothing about the pool — no base, no quote, no reserves, just the instrument id,
a `totalSupply`, and an `active` flag.

The token is **unversioned**: the `instrumentId` never carries a version suffix
or per-iteration discriminator, so two `BTC-USDC-LP` holdings of the same amount
are interchangeable — no rebase, no per-version balance map. It MUST NOT be
derived from the pool's contract id, settlement iteration, or status, all of
which change over a pool's life and would re-version the LP behind holders'
backs. (Why this matters for wallets and downstream dApps is in
[Reference](#reference-versioning-and-upgrades).)

## Mint and burn are a sibling of the settlement

Adding and removing liquidity settle through `PoolLiquidityRules` —
`PoolLiquidityRules_SettleAddLiquidity` and
`PoolLiquidityRules_SettleRemoveLiquidity`. Each choice is one atomic
transaction that runs *two* `SettlementFactory_SettleBatch` calls under
different authorities (a split-admin DvP):

- the base/quote batch under `pool.admin`, moving the real assets into or out of
  the operator-custodied reserves;
- the LP mint/burn batch under `pool.lpRegistrar`, creating or destroying the LP
  holding.

A mint and a burn are just transfer legs to and from two reserved accounts whose
`owner` is `None`. `Registry.V2` recognises exactly these as admin-authorised
issuance sources (`mintAccount` id `"cip-112/mint"`, `burnAccount` id
`"cip-112/burn"`), so a leg *from* `mintAccount` is an issuance and a leg *to*
`burnAccount` is a redemption — [`lpMintLeg` / `lpBurnLeg`](../../trading/CantonDex/Lp/Instrument.daml):

```daml
lpMintLeg _lpRegistrar recipient lpInstrumentId amount = V2.TransferLeg with
  transferLegId = "lp-mint"
  sender = Utils.mintAccount
  receiver = recipient
  amount
  instrumentId = lpInstrumentId
  meta = emptyMetadata

lpBurnLeg _lpRegistrar holder lpInstrumentId amount = V2.TransferLeg with
  transferLegId = "lp-burn"
  sender = holder
  receiver = Utils.burnAccount
  amount
  instrumentId = lpInstrumentId
  meta = emptyMetadata
```

Two things about this are non-obvious:

- **No settle, no mint.** The mint leg lives in the *same choice* as the deposit
  legs. Both batches are all-or-nothing together: you cannot receive LP tokens
  without your base+quote landing in the reserves, and you cannot pull assets out
  without your LP holding burning. The mint is a sibling of the delivery, not a
  standalone issuance step that could run on its own.
- **The mint amount is bounded, not trusted.** The LP receipt carries the
  operator's off-ledger quote, but the settle recomputes the fair entitlement
  on-ledger — `sqrt(base·quote)` at first funding, else pro-rata — and rejects a
  receipt claiming more than that beyond a `1e-6` dust tolerance. The registrar
  signs the mint; `PoolLiquidityRules` bounds it.

```mermaid
flowchart TB
  subgraph add["Add — SettleAddLiquidity (one atomic transaction)"]
    direction LR
    A1["LP"] -->|"base + quote in"| AR[("pool reserves")]
    AM(["mintAccount<br/>owner = None"]) -->|"LP-mint leg"| A1
  end
  subgraph rem["Remove — SettleRemoveLiquidity (one atomic transaction)"]
    direction LR
    RR[("pool reserves")] -->|"pro-rata base + quote out"| R1["holder"]
    R1 -->|"LP-burn leg"| RB(["burnAccount<br/>owner = None"])
  end
```

Supply is tracked in two places and kept in lockstep: `LPTokenPolicy.totalSupply`
and `PoolState.totalLpSupply`. Each settle asserts they already agree, then
`LPTokenPolicy_RecordMint` / `LPTokenPolicy_RecordBurn` moves the policy's total
while the same choice rewrites `PoolState` with the matching delta.

## Value is realised by redemption

The LP token never pays a coupon and never rebases. Swap fees stay in the pool's
reserves (see [Pricing](pricing.md)), so the reserves a fixed LP balance can
claim grow as the pool trades. Value comes out only on
`PoolLiquidityRules_SettleRemoveLiquidity`, which burns the holder's LP and pays
the current pro-rata share of reserves:

```
share   = lpTokensToRedeem / knownTotalLpSupply   -- floored
baseOut  = reserves.baseAmount  · share           -- floored
quoteOut = reserves.quoteAmount · share            -- floored
```

Because the reserves include accrued fees, redeeming a share returns more base
and quote than backed it at deposit time — that surplus *is* the LP return.
Rounding is one-directional (`floorDiv`/`floorMul`), so the pool never pays out
more than the exact share and `x·y = k` stays non-decreasing. A pool that never
traded returns exactly what went in; there is no off-ledger event a holder must
crystallise first.

---

## Reference: versioning and upgrades

The single-instrument choice buys three things a versioned LP would cost:
**fungibility** (all holders of a pool hold one instrument and transfer freely),
**composability** (a lending market or vault treats an LP holding as collateral
by checking one `instrumentId`, with no per-version balance map), and **UX
simplicity** (one LP balance per pool, not a timeline of versioned slivers).

- **Settlement iterations are not versions.** The V2 allocation API uses
  `nextIterationAllocationCid` so the pool hands pool-side allocations forward
  across settlement batches without users re-allocating. That is an allocation
  lifecycle concern; the LP holdings users hold are unaffected.
- **Fee or rule changes keep the instrument.** Existing LPs simply share future
  fees at the new rate. Honouring old LPs at old rates means the operator spins
  up a *new* pool with a new `lpInstrumentId` — a deliberate migration, never an
  incidental rebase.
- **Policy upgrades are package upgrades.** Replacing the LP policy itself
  (security fix, choice-signature change) is a Canton package upgrade: same
  `instrumentId`, new package hash; holders are unaffected.
- **Contrast with registry primitives.** A lifecycle-aware registry instrument
  may version when its external issuer must crystallise an off-ledger event
  (e.g. a coupon at epoch N paid into `v_N` before rolling to `v_{N+1}`), which
  needs upgrade-on-use plus a force-upgrade choice for passive holders. The LP
  token has no such event — its issuer is the pool's `lpRegistrar` and fee
  accrual is just reserve growth — so it stays at one stable `instrumentId` for
  the life of the pool. A wallet consuming registry primitives must handle
  upgrade-on-use; the same wallet consuming LP tokens does not. See
  [CIP-0112](https://github.com/global-synchronizer-foundation/cips/blob/main/cip-0112/cip-0112.md)
  for the V1→V2 compatibility framing.

## Tests

- [`DvpMintBurnTests.daml`](../../trading-tests/CantonDex/Tests/DvpMintBurnTests.daml)
  — `testDvpMintThenBurn` proves the mint/burn *mechanism* in isolation: a mint
  leg from `mintAccount` credits the recipient, a burn leg to `burnAccount`
  debits the holder and leaves nothing behind (the owner-`None` account is never
  credited).
- [`PoolLiquidityRulesTests.daml`](../../trading-tests/CantonDex/Tests/PoolLiquidityRulesTests.daml)
  — the same mint/burn as the sibling batch of a real add/remove:
  `testDvpAddLiquidity` (deposit + LP mint settle atomically),
  `testDvpRemoveDeliversToHolder` (reserves pay the holder, LP burns),
  `testAddRejectsOverMint` (a receipt above the on-ledger fair share is
  rejected), and `testSettleRequiresCoControl` (the settle needs both `operator`
  and `lpRegistrar`).

---

**Where to read next:** [Liquidity & Custody](liquidity-and-custody.md) · [Pricing](pricing.md) · [Add an LP or Instrument](../guides/add-lp-or-instrument.md) · [All docs](../README.md)
