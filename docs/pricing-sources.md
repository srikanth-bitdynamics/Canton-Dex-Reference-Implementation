# Pricing and Oracle Sources

## Short answer

**There is no on-chain price oracle in this DEX.** Every executable
price comes from one of four endogenous sources, and the codebase
contains no integration with Chainlink, Pyth, an attested feed, a TWAP
window, or any external pricing service.

## Where each price comes from

| Surface | Price source | Authority |
|---|---|---|
| AMM `Pool` (`PoolRules_Swap`) | Constant-product formula over on-chain reserves: `out = reserveOut * (in * (1 - fee)) / (reserveIn + in * (1 - fee))` | Pool reserves are signed by the `operator`; the swap re-validates against `minOutputAmount`, so the swapper sets their own price floor |
| `Order` book | Trader's `limitPrice` on the `OrderFundingRequest` | Trader-signed |
| `Rfq` / `RfqQuote` (Workflow 2) | Dealer-quoted `price` on each `RfqQuote`; the operator's `applyPolicy` ranks but never alters the quoted price | Dealer-signed (quote), trader+operator-signed (accept) |
| `MatchedTrade` (OTC) | Pre-agreed leg amounts in `transferLegs` | Bilateral, signed by both authorizers |

The quote endpoint mirrors the `constantProductOut` helper over current
reserves; it does not consult any external feed. The operator
backend's `policy/index.ts rankQuotes` ranks dealer quotes but never
substitutes a price.

## What this means in practice

- Pool prices follow reserves. A pool with stale or thin liquidity
  will quote stale prices. There is no oracle-backed "fair value"
  protection; arbitrageurs are the only mechanism that pulls pool
  prices toward broader-market prices.
- Order-book prices are whatever traders post. There is no spread
  policy or reference-price guard on the operator side beyond the
  fee-model the pair config encodes.
- RFQ prices are whatever dealers quote. The
  [PolicyReceipt](../trading/CantonDex/Dex/PolicyReceipt.daml) records
  *which* quote ranked where under which policy version, but does not
  certify that the chosen price is "good" — only that the policy was
  applied honestly.
- The fiat estimates the dApp shows next to instrument balances
  ([assets.ts](../app/web/src/primitives/assets.ts) `referencePrice`)
  are **hard-coded display values**, not live data. They are
  deliberately not used for any executable decision.

## What an oracle would change (and where it would attach)

If a future tranche introduces an oracle, the natural attachment
points are:

1. **Slippage / circuit-breaker on `PoolRules_Swap`.** Add an
   `oracleAttestation` argument with a signed price + timestamp; the
   choice asserts the realized swap price stays within a band of the
   attested price. The signer would be a separate `oracleAuthority`
   party in the choice context (production registries already follow
   this pattern for credential checks — see
   [registry-prerequisites.md](./registry-prerequisites.md)).
2. **TWAP for compliance reporting.** A separate `PoolPriceObservation`
   template the operator creates after each `PoolRules_Swap`, sampled by an
   off-chain ingestor. Pure observability, no consensus role.
3. **Fiat-display reference.** The dApp's `assets.ts` could call out
   to a public price API at the edge. This is presentation-only and
   does not need to be on-ledger.

None of the above are implemented. The current design intentionally
keeps pricing endogenous so that a malicious external feed cannot move
on-ledger funds, at the cost of the protections an oracle would
provide.
