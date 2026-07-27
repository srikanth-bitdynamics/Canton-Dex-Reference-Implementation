# Testnet demo deployment

This branch carries the **testnet hosted-party onboarding flow**. It is
deliberately **not merged** into `main`, and no pull request is opened for it.
It exists to be deployed, not to become part of the reference implementation.

## Why it exists

A pool needs two assets. Canton Coin is available and implements Token Standard
V2, but no *second* V2 asset is broadly available on testnet yet — the other
testnet assets are still on V1. So this deployment mints its own V2 asset
through `CantonDex.Registry.V2` and pairs against that.

That asset lives in this repository's `canton-dex-trading` Daml package. A party
can only hold it if its participant has vetted that package. Ours has; an
arbitrary visitor's has not. Hence the onboarding flow: visitors can have a party
allocated **on this deployment's validator**, which has vetted the package, and
receive an airdrop of the minted asset.

## Retirement condition

When a second Token Standard V2 asset becomes broadly available, external
wallets can trade here directly and this flow stops being necessary. At that
point **retire this branch — do not merge it.** The onboarding endpoints and the
hosted-party wallet provider are testnet scaffolding; they are not part of the
CIP-0112 reference implementation and should not outlive their reason.

## What is testnet-only here

Both halves are off unless explicitly enabled, and neither is compiled into a
production build:

| Component | Flag | Notes |
| --- | --- | --- |
| `POST /v1/testnet/party`, `GET /v1/testnet/hosting`, `POST /v1/testnet/submit` | `DEX_TESTNET_ONBOARDING=1` | routes are not registered at all when unset |
| `testnet-hosted` wallet provider + hosting notice | `VITE_ENABLE_TESTNET_PARTY=1` | absent from the provider registry when unset |

### Building the dApp for this deployment

Vite bakes these in at build time, and every one of them silently falls back
to a wrong-but-plausible default if omitted — a build missing
`VITE_CANTON_NETWORK_ID` renders "Network: Canton devnet" on a testnet
deployment. Build with all three, every time:

```bash
VITE_ENABLE_TESTNET_PARTY=1 \
VITE_API_BASE=/api \
VITE_CANTON_NETWORK_ID=canton:testnet \
npm run build
```

Then sync `dist/` to `/opt/canton-dex/web/` (nginx serves it directly; there
is nothing to restart).

## The faucet is a public write endpoint

`POST /v1/testnet/party` allocates a party and grants ledger rights, unauthenticated,
from the open internet. Topology entries are permanent. Before enabling it, confirm:

- the allocated party id is **server-generated** — a caller-supplied id or hint
  must never influence it, or the endpoint becomes a way to obtain `CanActAs` on
  an existing party, including the operator;
- granted rights are scoped to the **newly allocated party only** — the tester's
  user gets `CanActAs` + `CanReadAs` on it, and the operator's own ledger user
  gets `CanActAs` on it as well (the airdrop mint is `controller admin, owner`,
  so it submits as both). Neither grant ever touches a pre-existing party;
- the per-IP and daily caps are set, and the per-IP cap actually sees real client
  addresses (see the proxy note below);
- airdrop amounts are capped.

## So is the submit relay

A faucet party lives on the operator's participant, so the tester's browser has
no way to submit for it — `POST /v1/testnet/submit` does that on their behalf,
also unauthenticated. It is not `/v1/wallet/submit`: that route relays arbitrary
commands under the operator's JWT and is gated by `DEX_OPERATOR_API_TOKEN`, which
cannot be shipped to a browser. The relay is safe only because the request has no
say in anything that matters. Before enabling it, confirm:

- the submission acts as **exactly the party in the request body**, and only
  after that party has been checked to (a) carry the faucet's `dex-tester-`
  prefix and (b) be hosted on this participant. `actAs`, `readAs` and `userId`
  are never read from the body;
- commands are restricted to an **allowlist** of `(template, choice)` pairs — the
  allocation and holding choices a trader needs — and capped in number per
  request. A `CreateCommand`, or any other choice, is refused with `400`;
- disclosed contracts are attached **server-side** from the operator's own
  registry, never taken from the body;
- per-IP and daily caps apply (`DEX_TESTNET_SUBMIT_IP_DAILY_CAP`,
  `DEX_TESTNET_SUBMIT_DAILY_CAP`), read through the same proxy rule as the
  faucet's;
- participant error text is summarized, not echoed: a public response must not
  quote the submitted payload back.

### Proxy note

The per-IP cap keys on the client address. Behind a reverse proxy every request
appears to come from the proxy, so the backend only trusts a forwarded address
when `DEX_TESTNET_TRUST_PROXY=1` — and the proxy must **overwrite**
`X-Forwarded-For` with the real peer rather than appending to it, or a caller can
forge the value and rotate past the cap. Both halves are required; either alone
is broken.

## Prerequisite: bootstrap the instruments

The faucet does not create instruments. The airdrop is minted with
`Registry_Mint` on the admin's `Registry.V2`, which needs an `InstrumentConfig`
for the instrument; if one is missing the endpoint answers `503` naming this
step — silent instrument creation on a public endpoint is not acceptable.
Register the airdrop instruments before enabling onboarding:

```bash
export CANTON_LEDGER_URL=... CANTON_LEDGER_TOKEN=...
export CANTON_ADMIN=... CANTON_LP_REGISTRAR=... CANTON_OPERATOR=...
node --import tsx scripts/bootstrap-registry.ts
```

The instrument list lives under `registryV2.instruments` in
`scripts/bootstrap-registry.json`; keep it in sync with `DEX_TESTNET_AIRDROP`.
The run logs the `Registry.V2` contract id, which is also the value for
`CANTON_ALLOC_FACTORY_CID` and `CANTON_SETTLE_FACTORY_CID`.

## Keeping the branch current

Because this branch is never merged, it will drift. Merge the base branch **into**
it whenever the base moves; never the reverse.

```bash
git fetch origin
git merge origin/<base-branch>
```
