# Ecosystem feedback and resulting design changes

This page records how the reference implementation was evaluated by external
parties, what they found, and what changed as a result. It is maintained as the
single summary of that loop.

## External integration (reuse proof point)

The reference DEX is integrated as an adapter in
[**canton-trading-toolkit**](https://github.com/olevasyliev/canton-trading-toolkit),
an independent, open-source, venue-agnostic trading client for the Canton
Network. The toolkit is live-validated on mainnet against an unrelated spot AMM
(Cantex) and connects to a perpetuals testnet (Ekiden); this DEX is a third
adapter (`DexRefAdapter`). The same client code that
trades on an unrelated mainnet venue drives quotes, swaps, orders, matching, RFQ
and liquidity on this one, entirely through the hosted testnet routes: the only
path open to a party with no wallet of its own.

The integration is reproducible from outside with no operator credentials:

```
git clone https://github.com/olevasyliev/canton-trading-toolkit
cd canton-trading-toolkit && pip install -e .
PYTHONPATH=src python3 scripts/dexref_testnet_report.py            # reads only
PYTHONPATH=src python3 scripts/dexref_testnet_report.py --execute  # trades
```

The client allocates its own parties from the public faucet and exercises every
flow against `https://testnet-dex.bitdynamics.cc`. An external developer built a
working integration against the hosted testnet, from the public repository, and
published it.

## Evaluation and feedback

The integrator ran six rounds against the hosted testnet between 2026-07-27 and
2026-07-29, plus an earlier round against the repository's local demo mode. Each
round is a scripted run of dozens of assertions measured through the public
routes. The reports are public:

- Hosted testnet report:
  [srikanth-bitdynamics/Canton-Dex-Reference-Implementation#126](https://github.com/srikanth-bitdynamics/Canton-Dex-Reference-Implementation/issues/126)
- Local demo mode report:
  [canton-dev-fund#312 comment](https://github.com/canton-foundation/canton-dev-fund/issues/312#issuecomment-5044174855)

Because the integrator has no privileged access, the findings are exactly what any
external builder would hit.

## Findings and resulting changes

Every finding from the six rounds was addressed. They fall into a few themes.

Amounts must be served at ledger precision as
exact decimal strings, not re-floated. Fixes: the fills feed no longer routes
deltas through `parseFloat().toFixed` (F13); `/v1/swaps` serves the exact strings
rather than re-floating them (F20); `/v1/instruments` reports each instrument's
`decimals`, so a client can learn scale from the API; pre-fix rows were backfilled
rather than left wrong (F21).

External clients depend on the read API being
uniform. Fixes: the status wire value stopped shipping a `PS_`-prefixed enum the
dApp silently stripped (F11); `/v1/orders/book` accepts `?pair=` like every other
read (F15, additively); the trades feed no longer inverts trader and dealer on
buys (F16); `/v1/trades` includes `counterparty` after the deployment was brought
current with `main` (F22); an unscoped, unauthenticated `GET /v1/rfq` that lived
only on a soon-to-be-retired branch was fixed on `main` (F23).

Two fixes concern funding and custody: funding an order locks only what the
order needs and returns the change, so a party can place more than one order
(F12); the off-ratio liquidity add refunds the unmatched remainder and the hosted
receipt reports the settled amounts rather than echoing the request (F25).

The hosted routes are the only path for a
walletless integrator, so gaps in them block external evaluation entirely. Fixes:
RFQ gained a hosted cancel, so a round trip has an exit other than expiry (F17);
order matching gained a hosted, unauthenticated trigger (`POST /v1/testnet/match`)
so matching and its atomic settlement can be verified from outside (F24);
`/v1/swaps` gained `?kind=` so liquidity events, not just swaps, are readable
(F26). The whole `/v1/testnet/*` surface and the faucet's per-IP party quota were
documented with their consequences (F14, F18).

Some reports were answered by design:
`Holding_Split` is refused by the hosted relay because the relay admits only a
fixed choice allowlist, and splitting is a wallet concern the relay does not
expose (F19).

One item remained open at the time of the report and has since been closed: a
resting order the book published but the matcher would not pair (F27). The cause
was a self-cross (a party's own bid and ask) which can never settle. The matcher
now applies self-trade prevention and no longer proposes it.

## How this loop is expected to continue

The reference tracks the same standard the ecosystem builds against, and its
hosted testnet is open for exactly this kind of evaluation. New reports open as
issues on the implementation repository; confirmed findings are fixed with a
regression test and this summary is updated.
