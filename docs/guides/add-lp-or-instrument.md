# Issuing a new LP token or lifecycle-rich instrument

Plain fungible assets need no new DEX Daml: register an instrument in a
compatible registry and mint it, and the DEX treats its `InstrumentId` as
opaque. Gated issuance and lifecycle behavior are different: Token Standard V2
does not define them, and the included credential verifier is only a shape
example. This page marks where the runnable reference ends and a custom registry
or application begins.

## Two layers you build on

Token Standard V2 (CIP-0112) standardizes the *holding, allocation, and
settlement* surface — how value is held, locked, and moved atomically. It does
**not** standardize instrument configuration or lifecycle. Those live in the
registry that administers the `instrumentId` — here, `CantonDex.Registry.V2`. A
different registry can publish different config and credentials and still
implement the same V2 `Holding`, `AllocationFactory`, and `SettlementFactory`
interfaces.

The reference registry's
[`InstrumentConfig`](../../trading/CantonDex/Registry/V2.daml) can encode:

- **supply caps** (`supplyCap`; enforced by `InstrumentConfig_BumpSupply`)
- **issuer requirement records** (`issuerRequirements`) — compared by the
  placeholder claim matcher, not suitable for production authorization
- **holder requirement records** (`holderRequirements`) — metadata only in the
  reference registry; allocation and transfer choices do not enforce them
- **decimals** for display precision
- **external ids** (`isin`, `cusip`)

Transfer and allocation constraints come from the `TransferFactory` /
`AllocationFactory` implementation, not from the config. All of this is
reference-registry behavior, not a Token Standard requirement.

## Pick your recipe

| You want to issue | Recipe | New Daml? |
|---|---|---|
| An LP token for a pool | [A](#a-vanilla-lp-token--already-built) | none — the add-liquidity DvP mints it |
| A plain fungible base/quote asset | [B](#b-a-fresh-base-or-quote-instrument) | none — register + `Registry_Mint` |
| A whitelisted / accredited-only asset | [C](#c-gated-issuance-requires-a-real-verifier) | yes — integrate a registry that verifies issuer-authorized evidence |
| A token that unlocks over time | [D](#d-vested-lp-custom-lifecycle) | yes — custom registry or application workflow |
| A token that pays dividends | [E](#e-dividend-paying-instrument) | yes — custom distribution or claim workflow |

## A. Vanilla LP token — already built

The add-liquidity DvP flow already mints an LP token; there is nothing extra to
write. Its `instrumentId` is `"<BASE>-<QUOTE>-LP"` by convention — the pool and
policy enforce only a non-empty id whose `admin = lpRegistrar` — and it is a real
V2 `Holding` — fungible with other V2 holdings, usable as `TransferInstruction`
input, and lockable into an `Allocation`, so LP tokens can themselves back orders
or pools.

Mint and burn ride the V2 allocation surface as ordinary transfer legs to and
from two reserved accounts whose `owner` is `None`. An account with no owner is
never credited on settlement, so it is a sink for burns and a source for mints:

```mermaid
flowchart LR
  MA(["mintAccount<br/>owner = None"]) -->|"lp-mint leg"| R["recipient<br/>credited fresh LP"]
  H["holder<br/>locks LP"] -->|"lp-burn leg"| BA(["burnAccount<br/>owner = None"])
```

The legs are pure constructors in
[`Lp/Instrument.daml`](../../trading/CantonDex/Lp/Instrument.daml):

```daml
lpMintLeg recipient lpInstrumentId amount = V2.TransferLeg with
  transferLegId = "lp-mint"
  sender = Utils.mintAccount
  receiver = recipient
  ...
lpBurnLeg holder lpInstrumentId amount = V2.TransferLeg with
  transferLegId = "lp-burn"
  sender = holder
  receiver = Utils.burnAccount
  ...
```

`PoolLiquidityRules_SettleAddLiquidity` settles the mint leg and bumps the
[`LPTokenPolicy`](../../trading/CantonDex/Lp/Policy.daml) supply;
`PoolLiquidityRules_SettleRemoveLiquidity` settles the burn leg and draws it
back down. The policy tracks circulating LP supply on its own; it is
bookkeeping, not a cap. `LPTokenPolicy` has no supply cap: the LP mint path
drives `LPTokenPolicy_RecordMint`, which only bumps `totalSupply`. An
`InstrumentConfig` `supplyCap` would not bound LP supply — it bounds only tokens
minted through `Registry_Mint` / `InstrumentConfig_BumpSupply`, which the LP mint
path never touches.

## B. A fresh base or quote instrument

Register the instrument, then mint to a holder. Both are choices on the
[`Registry`](../../trading/CantonDex/Registry/V2.daml) template:

```ts
// 1. Register the instrument
const configCid = await ledger.submit({
  actAs: [admin],
  command: {
    kind: 'exercise',
    templateId: 'CantonDex.Registry.V2:Registry',
    contractId: registryCid,
    choice: 'Registry_RegisterInstrument',
    argument: {
      instrumentId: 'USDC',
      decimals: 6,
      supplyCap: null,          // unbounded
      holderRequirements: [],
      issuerRequirements: [],   // open issuance
      isin: null,
      cusip: null,
    },
  },
});

// 2. Mint to a holder (controller is admin + owner; both go in actAs)
await ledger.submit({
  actAs: [admin, alice],
  command: {
    kind: 'exercise',
    templateId: 'CantonDex.Registry.V2:Registry',
    contractId: registryCid,
    choice: 'Registry_Mint',
    argument: { configCid, owner: alice, amount: '100000.0', issuerClaims: [] },
  },
});
```

The `admin, owner` joint authority is a property of this reference registry's
`Registry.V2`: a receiver must consent to receive a token, so the operator
backend cannot mint to `alice` without her wallet co-signing. In a real deployment this is a CIP-0103 prepare/execute
round-trip through the trader's wallet. On-ledger, `Registry_Mint` bumps supply
and creates the holding:

```daml
nonconsuming choice Registry_Mint : ContractId Holding
  with configCid; owner; amount; issuerClaims
  controller admin, owner
  do
    config <- fetch configCid
    ...
    exercise configCid InstrumentConfig_BumpSupply with delta = amount
    create Holding with admin; owner; instrumentId = config.instrumentId; amount; locked = False
```

`InstrumentConfig_BumpSupply` is consuming, so each mint archives the config and
creates its successor with the new `circulatingSupply` — **re-read the config cid
before each mint** rather than caching it. It is also where the cap bites:

```daml
forA_ supplyCap $ \cap ->
  assertMsg ("mint exceeds supply cap " <> show cap) (next <= cap)
```

## C. Gated issuance requires a real verifier

The reference `InstrumentConfig` records `holderRequirements` and
`issuerRequirements`, but its `verifyCredentials` helper compares
caller-supplied records. It does not fetch issuer-signed contracts and must not
be used as an authorization boundary.

A gated instrument therefore needs a registry integration that:

1. resolves credential evidence controlled by the declared issuer;
2. verifies the subject, property, value, expiry, and revocation state;
3. enforces holder eligibility in allocation and transfer choices, not only at
   mint time; and
4. returns any required evidence through registry choice context and disclosed
   contracts.

Those rules remain behind the V2 registry boundary. The DEX continues to trade
the resulting `InstrumentId` without embedding credential policy in orders or
pools.

## D. Vested LP (custom lifecycle)

Token Standard V2 has no first-class vesting. A production design must decide
whether vesting is enforced by the asset registry's transfer/allocation rules or
by a separate application contract that controls when a holder may request a
standard transfer. In either design, specify the authority that can release the
asset, how cancellation and revocation work, and how wallets discover the
claimable amount. This repository does not ship or validate such a workflow.

## E. Dividend-paying instrument

Neither pattern ships in the reference. Common designs include:

1. **Admin-pushed distribution** — a script queries current holders (the
   `Holding` ACS filtered by `instrumentId`) and creates pro-rata payout
   `TransferInstruction`s. Simple, off-ledger logic; cost falls on the admin.
2. **Pull-based claim** — the admin posts a per-period rate and each holder
   exercises a `Claim` choice for their share. Cheaper for the admin, more
   contracts on-ledger.

## Reference — what needs a registry extension

- **Native rebasing.** V2 holdings have a fixed `amount`; rebases would mean ACS
  rewrites the standard does not support. Expose a rebasing *view* over a wrapper
  instead.
- **Predicates the credential model can't express** (e.g. "holder in
  jurisdiction X but not Y") need a custom registry or a custom `TransferFactory`.
- **Multi-asset baskets in one holding.** V2 holdings are single-instrument; a
  basket is a wrapper template.

## Where to look in this repo

- [`Registry/V2.daml`](../../trading/CantonDex/Registry/V2.daml) — the reference
  registry: `InstrumentConfig`, `Registry_RegisterInstrument`, `Registry_Mint`,
  and the V2 interface instances. *Proves the register-then-mint path in B and C.*
- [`Lp/Instrument.daml`](../../trading/CantonDex/Lp/Instrument.daml) — the LP
  mint/burn legs and allocation specs. *Proves how the LP token in A rides the V2
  allocation surface (mint = leg from `mintAccount`, burn = leg to
  `burnAccount`).*
- [`Lp/Policy.daml`](../../trading/CantonDex/Lp/Policy.daml) — `LPTokenPolicy`,
  the LP supply component. *Proves LP supply tracking is separate from
  `InstrumentConfig` caps.*
- [`Registry/V2.daml`](../../trading/CantonDex/Registry/V2.daml) also contains
  the reference credential primitive and `verifyCredentials`; the latter is an
  explicit example placeholder, not production credential verification.
- [`PoolLiquidityRulesTests.daml`](../../trading-tests/CantonDex/Tests/PoolLiquidityRulesTests.daml)
  — `testDvpAddLiquidity` proves deposit and LP mint settle atomically;
  `testDvpRemoveDeliversToHolder` proves a partial burn returns the proportional
  reserves and leaves the unredeemed LP balance unlocked; and
  `testMintRequiresAdmin` proves a non-admin cannot author the mint side.

---

**Where to read next:** [LP Tokens](../concepts/lp-tokens.md) · [Add a Trading Pair](add-a-trading-pair.md) · [All docs](../README.md)
