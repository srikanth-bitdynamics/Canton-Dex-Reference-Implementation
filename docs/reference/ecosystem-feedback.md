# Ecosystem feedback and resulting design changes

This page records how the reference implementation was evaluated by external
parties, what they found, and what changed as a result. It is maintained as the
single summary of that loop.

> **Status of the old hosted integration.** The evaluation below used a
> separately operated deployment during a historical feedback round. This
> repository does **not** provision a public hostname, public party faucet, or
> `/v1/testnet/*` API, and it does not promise that the old deployment remains
> available. Treat the linked reports as provenance for the feedback—not as
> current setup instructions. The API implemented in this tree is listed in
> [HTTP API](http-api.md); run it against a participant you control by following
> the [local live-ledger guide](../guides/localnet.md).

## External integration (reuse proof point)

During that feedback round, the reference DEX was integrated as an adapter in
[**canton-trading-toolkit**](https://github.com/olevasyliev/canton-trading-toolkit),
an independent, open-source, venue-agnostic trading client for the Canton
Network. Its `DexRefAdapter` supplied useful independent feedback on quotes,
swaps, orders, matching, RFQ, and liquidity. The adapter and the reports are
external artifacts. Their deployment wrapper—including any party provisioning,
rate limits, or convenience endpoints—is not implemented by this repository.

## Evaluation and feedback

The integrator reported six rounds against the separately operated deployment
between 2026-07-27 and 2026-07-29, plus an earlier round against the
repository's local demo mode. The reports are public:

- Hosted testnet report:
  [srikanth-bitdynamics/Canton-Dex-Reference-Implementation#126](https://github.com/srikanth-bitdynamics/Canton-Dex-Reference-Implementation/issues/126)
- Local demo mode report:
  [canton-dev-fund#312 comment](https://github.com/canton-foundation/canton-dev-fund/issues/312#issuecomment-5044174855)

The reports document what that external client observed at the time. The
regression tests named below are the durable evidence for behavior in the
current repository.

## Findings and resulting changes

The findings that changed this repository fall into a few themes. Changes made
only in the old external deployment wrapper are not presented as current API
features. Each theme below closes with the checked-in test that pins the fix.

### Amounts are served at ledger precision

Amounts must reach the client as exact decimal strings at ledger scale, never
re-floated through IEEE-754. The indexer derives reserve deltas with the
fixed-point decimal module, stores them as strings, and `/v1/swaps` serves those
exact strings. In addition,
`/v1/instruments` reports each instrument's `decimals` so a client can learn
scale from the API. Existing projection rows can be reindexed after an upgrade.

Proven by
[`decimal-money.test.ts`](../../services/operator-backend/test/decimal-money.test.ts)
(money amounts go through the BigInt decimal module, not IEEE-754) and
[`instruments-route.test.ts`](../../services/operator-backend/test/instruments-route.test.ts)
(`decimals` is decoded from the string the ledger sends, not dropped by a
`typeof === "number"` guard).

### The read API stays uniform

External clients depend on every read speaking the same shapes. The status wire
value uses the public enum without a `PS_` prefix; `/v1/orders/book` accepts
`?pair=` like every other read; the trades feed derives trader and dealer from
the signed receipt rather than leg direction; `/v1/trades` includes
`counterparty`; and an unscoped `GET /v1/rfq` requires the admin token.

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
at a time. An off-ratio liquidity add refunds the unmatched remainder, and the
settlement result reports settled amounts rather than echoing requested amounts.

Proven by
[`normalize-funding.test.ts`](../../app/web/src/__tests__/normalize-funding.test.ts)
(a covering subset is locked and the surplus returned as unlocked change, with no
split handed to the wallet) and `testDvpAddOffRatioRefundsExcess` in
[`PoolLiquidityRulesTests.daml`](../../trading-tests/CantonDex/Tests/PoolLiquidityRulesTests.daml)
(the unmatched leg is refunded in the same settlement, never reaching the
reserves).

### External clients need a complete, documented API

The feedback exposed missing operations in the external deployment wrapper.
The corresponding capabilities that remain in this repository use the normal
operator API: `POST /v1/rfq/:cid/cancel`, operator-authenticated
`POST /v1/orders/match`, and `GET /v1/swaps?kind=`. The first two are writes and
therefore require the appropriate operator and caller authority described in
[HTTP API](http-api.md#authorization). There is no
`/v1/testnet/*` namespace or public faucet in this tree.

Proven by
[`swaps-kind-filter.test.ts`](../../services/operator-backend/test/swaps-kind-filter.test.ts)
(`?kind=` returns add- and remove-liquidity rows and composes with `?pair=`) and
[`order-fill-recording.test.ts`](../../services/operator-backend/test/order-fill-recording.test.ts)
(a discovered cross settles in exactly one submission, leaving no stranded
collateral).

### Answered by design

Holding preparation is a wallet concern in self-custodial flows. The only
generic command relay in this repository is the explicitly development-only
`POST /v1/wallet/submit`; it is disabled by default, requires an operator token,
and restricts `actAs` parties when enabled. It is not a public onboarding or
custody service. The boundary is described in
[Non-goals: the development relay is not a wallet](../concepts/non-goals.md#the-development-relay-is-not-a-wallet).

### Self-trade prevention

A party's own bid and ask cannot settle because the resulting transfer legs
would be self-transfers. The matcher therefore applies self-trade prevention in
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

The reference tracks the same standard the ecosystem builds against. Integrators
can evaluate a checkout with the repository's local live-ledger proof or deploy
their own instance, then open a reproducible issue on the implementation
repository. Confirmed findings should be fixed with a regression test and this
summary updated.

---

**Where to read next:** [Non-goals](../concepts/non-goals.md) · [HTTP API](http-api.md) · [Testing](testing.md) · [All docs](../README.md)
