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
Each theme below closes with the test that pins the fix.

### Amounts are served at ledger precision

Amounts must reach the client as exact decimal strings at ledger scale, never
re-floated through IEEE-754. The fills feed no longer routes deltas through
`parseFloat().toFixed` (F13); `/v1/swaps` serves the exact stored strings rather
than re-floating them (F20); `/v1/instruments` reports each instrument's
`decimals` so a client can learn scale from the API, and pre-fix rows were
backfilled rather than left wrong (F21).

Proven by
[`decimal-money.test.ts`](../../services/operator-backend/test/decimal-money.test.ts)
(money amounts go through the BigInt decimal module, not IEEE-754) and
[`instruments-route.test.ts`](../../services/operator-backend/test/instruments-route.test.ts)
(`decimals` is decoded from the string the ledger sends, not dropped by a
`typeof === "number"` guard).

### The read API stays uniform

External clients depend on every read speaking the same shapes. The status wire
value stopped shipping a `PS_`-prefixed enum the dApp silently stripped (F11);
`/v1/orders/book` accepts `?pair=` like every other read (F15, additively); the
trades feed no longer inverts trader and dealer on buys (F16); `/v1/trades`
includes `counterparty` after the deployment was brought current with `main`
(F22); an unscoped, unauthenticated `GET /v1/rfq` that lived only on a
soon-to-be-retired branch was fixed on `main` (F23).

Proven by
[`pool-status-normalisation.test.ts`](../../services/operator-backend/test/pool-status-normalisation.test.ts)
(the read path strips `PS_` so a client typed against `Active` still sees the
pool),
[`order-route-pair-param.test.ts`](../../services/operator-backend/test/order-route-pair-param.test.ts)
(`?pair=BASE/QUOTE` is accepted on the book and matches routes, `?base=&quote=`
still works),
[`indexer-trade-parties.test.ts`](../../services/operator-backend/test/indexer-trade-parties.test.ts)
(a buy is labelled trader/dealer the right way round and its counterparty
recorded), and
[`rfq-read-scoping.test.ts`](../../services/operator-backend/test/rfq-read-scoping.test.ts)
(the unfiltered `/v1/rfq` requires the admin token).

### Funding locks only what an order needs

Two fixes concern funding and custody. Funding an order locks only what the
order needs and returns the change, so a party can place more than one order
(F12); the off-ratio liquidity add refunds the unmatched remainder, and the
hosted receipt reports the settled amounts rather than echoing the request (F25).

Proven by
[`normalize-funding.test.ts`](../../app/web/src/__tests__/normalize-funding.test.ts)
(a covering subset is locked and the surplus returned as unlocked change, with no
split handed to the wallet) and `testDvpAddOffRatioRefundsExcess` in
[`PoolLiquidityRulesTests.daml`](../../trading-tests/CantonDex/Tests/PoolLiquidityRulesTests.daml)
(the unmatched leg is refunded in the same settlement, never reaching the
reserves).

### The hosted routes are the only path in

For a walletless integrator the hosted routes are the whole surface, so a gap in
them blocks external evaluation entirely. RFQ gained a hosted cancel, so a round
trip has an exit other than expiry (F17); order matching gained a hosted,
unauthenticated trigger (`POST /v1/testnet/match`) so matching and its atomic
settlement can be verified from outside (F24); `/v1/swaps` gained `?kind=` so
liquidity events, not just swaps, are readable (F26). The whole `/v1/testnet/*`
surface and the faucet's per-IP party quota were documented with their
consequences (F14, F18).

Proven by
[`swaps-kind-filter.test.ts`](../../services/operator-backend/test/swaps-kind-filter.test.ts)
(`?kind=` returns add- and remove-liquidity rows and composes with `?pair=`) and
[`order-fill-recording.test.ts`](../../services/operator-backend/test/order-fill-recording.test.ts)
(a discovered cross settles in exactly one submission, leaving no stranded
collateral).

### Answered by design

`Holding_Split` is refused by the hosted relay because the relay exposes only a
fixed set of settlement choices, and splitting is a wallet concern it does not
surface (F19). The boundary is described in
[Non-goals: the hosted testnet is a demo surface](../concepts/non-goals.md#the-hosted-testnet-is-a-demo-surface-not-a-wallet).

### Closed after the report

One item was open at the time of the report and has since been closed: a resting
order the book published but the matcher would not pair (F27). The cause was a
self-cross — a party's own bid and ask, which can never settle. The matcher now
applies self-trade prevention in
[`matching.ts`](../../services/operator-backend/src/order/matching.ts):

```typescript
// Self-trade prevention: a party's own bid and ask must not match. The
// settle would build a transfer leg whose sender and receiver are the same
// party and abort, so this cross can never settle. Move to the next ask ...
if (buy.trader === sell.trader) {
  ai += 1;
  continue;
}
```

Proven by
[`matching.test.ts`](../../services/operator-backend/test/matching.test.ts)
("does not match a party against its own crossing order", while a bid still
crosses a different maker's ask and skips its own).

## How this loop is expected to continue

The reference tracks the same standard the ecosystem builds against, and its
hosted testnet is open for exactly this kind of evaluation. New reports open as
issues on the implementation repository; confirmed findings are fixed with a
regression test and this summary is updated.

---

**Where to read next:** [Non-goals](../concepts/non-goals.md) · [HTTP API](http-api.md) · [Testing](testing.md) · [All docs](../README.md)
