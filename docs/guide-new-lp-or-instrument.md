# Guide: Issuing a new LP token or lifecycle-rich instrument

How to mint a new asset on Canton-Dex that follows Token Standard V2
(CIP-0056). This covers both the simple case (fungible LP token) and
the lifecycle-rich case (vested, dividend-paying, restricted).

## What "lifecycle-rich" means here

A V2 instrument is more than a number of holdings. Its
`InstrumentConfiguration` can encode:

- supply caps (`maxSupply`; `BumpSupply` enforces them)
- issuer credential requirements (`issuerRequirements : [CredentialClaim]`):
  only holders who present the right credentials can be minted to
- decimals for display
- transfer constraints (via the chosen `TransferFactory` implementation)
- allocation constraints (via the `AllocationFactory`)
- upgrade hooks for migrating to a future version of the instrument

`Registry.V2` exposes all of this. A lifecycle-rich instrument is the
composition of: a `RegistryConfig`, a per-instrument `InstrumentConfig`,
and optionally issuer-signed `Credential` contracts that the recipient
must present at mint time.

## Case A. Vanilla LP token (the common case)

This is what the add-liquidity DvP flow already does. Nothing extra to write.
The LP token:

- has `instrumentId = "<BASE>-<QUOTE>-LP"`
- has `admin = lpRegistrar`
- is created when `PoolLiquidityRules_SettleAddLiquidity` settles the LP receipt
  against the registry-side mint allocation
- is a real `Registry.V2.Holding`: fungible with other V2 holdings,
  usable as input to `V2.TransferInstruction`, lockable into a
  `V2.Allocation` (so LP tokens can themselves back orders or pools)

If you want supply caps on the LP token, create an `InstrumentConfig`
for the LP instrument with `maxSupply = Some 10_000_000.0`. The
`LPTokenPolicy_RecordMint` choice will respect it once the config
check is plumbed through (today it's policy-side bookkeeping only).

## Case B. Issuing a fresh base or quote instrument

```ts
// 1. Register the instrument
const configCid = await ledger.submit({
  actAs: [admin],
  commandId: `register-${instrumentId}`,
  command: {
    kind: 'exercise',
    templateId: 'CantonDex.Registry.V2:Registry',
    contractId: registryCid,
    choice: 'Registry_RegisterInstrument',
    argument: {
      instrumentId: 'USDC',
      decimals: 6,
      maxSupply: null, // unbounded
      issuerRequirements: [], // open issuance
    },
  },
});

// 2. Mint to a holder (controller: admin, owner; needs both in actAs)
await ledger.submit({
  actAs: [admin, alice],
  commandId: `mint-${alice}-USDC-100000`,
  command: {
    kind: 'exercise',
    templateId: 'CantonDex.Registry.V2:Registry',
    contractId: registryCid,
    choice: 'Registry_Mint',
    argument: {
      configCid,
      owner: alice,
      amount: '100000.0',
      issuerClaims: [], // no credential reqs
    },
  },
});
```

The `admin, owner` joint authority is by V2 design: receivers must
consent to receive a token. The operator-backend cannot mint to
`alice` without `alice`'s wallet co-signing. In a real deployment
this lands as a CIP-0103 prepare/execute round-trip through the
trader's wallet.

## Case C. Gated issuance (credential-required)

For a security token or whitelisted-investor LP:

```ts
// 1. Issuer signs a Credential template for the holder
const credCid = await ledger.submit({
  actAs: [credentialIssuer],
  commandId: `cred-${alice}-accredited`,
  command: {
    kind: 'create',
    templateId: 'CantonDex.Registry.V2:Credential',
    argument: {
      issuer: credentialIssuer,
      subject: alice,
      claim: 'accredited-investor',
      issuedAt: nowIso(),
      expiresAt: null,
    },
  },
});

// 2. Register the instrument with the credential requirement
const configCid = await ledger.submit({
  actAs: [admin],
  command: {
    kind: 'exercise',
    templateId: 'CantonDex.Registry.V2:Registry',
    contractId: registryCid,
    choice: 'Registry_RegisterInstrument',
    argument: {
      instrumentId: 'PRIVATE-EQUITY',
      decimals: 0,
      maxSupply: '1000000.0',
      issuerRequirements: [{ issuer: credentialIssuer, claim: 'accredited-investor' }],
    },
  },
});

// 3. Mint, supplying the credential
await ledger.submit({
  actAs: [admin, alice],
  command: {
    kind: 'exercise',
    templateId: 'CantonDex.Registry.V2:Registry',
    contractId: registryCid,
    choice: 'Registry_Mint',
    argument: {
      configCid,
      owner: alice,
      amount: '100.0',
      issuerClaims: [credCid],
    },
  },
});
```

If alice's credential is missing or wrong-issuer, `verifyCredentials`
in `Registry.V2` will reject the mint.

## Case D. Vested LP (custom lifecycle)

V2 doesn't have first-class vesting. The recommended pattern is a
custom template that owns the V2 holding:

```daml
template VestedLP with
    holder : Party
    admin : Party
    underlying : ContractId V2.Holding  -- the actual LP holding (locked)
    cliffAt : Time
    fullyVestedAt : Time
  where
    signatory admin, holder

    choice VestedLP_Claim : ContractId V2.Holding
      controller holder
      do
        now <- getTime
        assertMsg "not yet cliff" (now >= cliffAt)
        -- Transfer the underlying to the holder via TransferInstruction
        ...
```

The `underlying` holding stays locked (admin-controlled) until
`VestedLP_Claim` releases it. This composes with the rest of the
reference: the vested LP can still appear in `/v1/holdings` because
it's still a V2.Holding under the covers; the wrapper just gates
transfer.

## Case E. Dividend-paying instrument

Two patterns:

1. **Periodic distribution by the admin**: admin runs a script that
   queries all current holders (`V2.Holding` ACS filtered by
   `instrumentId`) and creates corresponding USDC `TransferInstruction`
   contracts pro-rata. Simple, off-chain logic.

2. **Pull-based via a `DividendClaim` template**: admin posts a
   per-period dividend rate; each holder exercises `Claim` to mint
   their share. Cheaper for admin, more contracts.

The reference doesn't ship either; build them in your fork.

## What you cannot do without extending the reference

- Native rebasing tokens: V2 holdings have a fixed `amount`;
  rebases require ACS rewrites which the standard doesn't support
  natively. Use a wrapper that exposes a rebasing view.
- Token-bound permissions that don't fit credentials: V2's
  `issuerRequirements` are claim-based. More complex predicates
  (e.g. "holder must be in jurisdiction X but not Y") require
  a custom `TransferFactory`.
- Multi-asset baskets in a single holding: V2 holdings are
  single-instrument. Baskets are a wrapper template.

## Where to look in this repo

- `trading/CantonDex/Registry/V2.daml`: full CIP-0056 surface
- `trading/CantonDex/Instrument/Credentials.daml`: credential primitive
- `trading/CantonDex/Lp/Policy.daml`: LP-token policy component
  driving V2 mints/burns
- `trading-tests/CantonDex/Tests/InstrumentTests.daml`: registration,
  mint, transfer, burn flows in Daml Script
