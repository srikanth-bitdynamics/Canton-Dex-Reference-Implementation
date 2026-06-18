# Guide: Adding a new trading pair

End-to-end recipe for listing a new pair (say `ETH/USDT`) on a running
Canton-Dex deployment. Assumes the operator backend is already wired
to a participant and the base + quote assets already have registries that
produce Token Standard V2 holdings, allocation factories, and settlement
factories.

If the base or quote asset does **not** yet have a V2-compatible registry,
do that first: see
[`guide-new-lp-or-instrument.md`](guide-new-lp-or-instrument.md).

## Inputs you need

| Input | Where it comes from |
|---|---|
| `baseInstrumentId : Text` | the `id` component of the base asset's V2 `InstrumentId` in this reference API |
| `quoteInstrumentId : Text` | same, for the quote asset |
| `admin : Party` | the registry admin for the pair in this reference implementation |
| `tradingMode : "TM_OrderBook" \| "TM_Pool" \| "TM_Both"` | which surfaces are enabled |
| `feeModel : { makerFeeBps, takerFeeBps, poolFeeBps }` | fee schedule |
| `publicReaders : [Party]` (Optional) | parties that should observe the pair contract |

## Step 1. Create the `DexPair`

Operator-signed. Submitted by the operator backend:

```bash
curl -X POST http://localhost:8080/v1/pairs \
  -H 'Content-Type: application/json' \
  -d '{
    "baseInstrumentId": "ETH",
    "quoteInstrumentId": "USDT",
    "admin": "<admin-party>",
    "tradingMode": "TM_Both",
    "feeModel": {"makerFeeBps": 10, "takerFeeBps": 30, "poolFeeBps": 30},
    "active": true
  }'
```

This routes to `AdminService.createPair` in
`services/operator-backend/src/admin/index.ts`, which submits
`CreateCommand` for `CantonDex.Dex.DexPair:DexPair`.

What you get back: `{ pairCid: ContractId<DexPair> }`. Note it.

## Step 2. If `TM_Pool` or `TM_Both`: create the LP token policy

```bash
# (currently no admin endpoint; submit via the operator-backend in code)
```

```ts
// From operator-backend or a script:
await ledger.submit({
  actAs: [lpRegistrar],
  commandId: `lp-policy-eth-usdt`,
  command: {
    kind: 'create',
    templateId: 'CantonDex.Lp.Policy:LPTokenPolicy',
    argument: {
      lpRegistrar,
      operator,
      lpInstrumentId: { admin: lpRegistrar, id: 'ETH-USDT-LP' },
      totalSupply: '0.0',
      active: true,
    },
  },
});
```

The current LP policy is the LP-token component only: it owns the full
`V2.InstrumentId` and circulating supply, and it does not reference the
pool, base instrument, quote instrument, or order venue.

## Step 3. Create the `Pool`

```bash
curl -X POST http://localhost:8080/v1/pools \
  -H 'Content-Type: application/json' \
  -d '{
    "baseInstrumentId": "ETH",
    "quoteInstrumentId": "USDT",
    "lpInstrumentId": "ETH-USDT-LP",
    "lpRegistrar": "<lp-registrar-party>",
    "admin": "<admin-party>",
    "feeBps": 30
  }'
```

Pool starts in `PS_Unfunded`. No reserves until the first LP completes the
same add-liquidity DvP flow used for later funding.

## Step 4. Optional: seed the first LP

The first LP needs to:

1. Hold V2 base and quote holdings of the amounts they want to deposit.
2. Call `POST /v1/pools/add-liquidity/request`.
3. Have the wallet author the three requested allocations via
   `AllocationFactory_Allocate`:
   - base deposit
   - quote deposit
   - LP receipt
4. Call `POST /v1/pools/add-liquidity/settle`. The operator and
   `lpRegistrar` co-settle the request via `PoolLiquidityRules_SettleAddLiquidity`,
   which seeds the first pool slices, transitions the pool to `PS_Active`,
   and mints `sqrt(baseAmount * quoteAmount)` LP tokens atomically.

## Step 5. Surface in the dApp

The dApp's `/v1/pairs` endpoint will return the new pair automatically
on the next backend tick. The Pools page will show the new pool once
seeded.

If you want the pair to appear on the trader's Trade page, make sure
`active = true` and `tradingMode` is `TM_OrderBook` or `TM_Both`.

## Step 6. Verify

```bash
curl -s http://localhost:8080/v1/pairs | jq '.[] | select(.baseInstrumentId=="ETH")'
curl -s http://localhost:8080/v1/pools | jq '.[] | select(.baseInstrumentId=="ETH")'
```

After the first seed:

```bash
curl -s 'http://localhost:8080/v1/swaps?pair=ETH/USDT&limit=10'
```

## Common pitfalls

| Symptom | Cause |
|---|---|
| `/v1/pools/add-liquidity/request` or `/settle` fails with an allocation mismatch | The wallet-authored allocation triple does not match the request's expected specs; recreate the request and re-author the allocations from that payload. |
| `/v1/pools/add-liquidity/settle` fails with a quote/supply guard | The pool moved or the request expired before settle; recreate the request and have the wallet re-author fresh allocations. |
| `DexPair` created but doesn't show in `/v1/pairs` | Operator backend wasn't observing the new contract; check the backend's `operator` party matches the pair's `operator` signatory. |
| Pool created but `/v1/pools` is empty | Pool is operator + lpRegistrar observed only. The backend observes as `operator`, but if you used a different signing party the read won't see it. |
| Trades fail even though `DexPair` exists | The pair metadata is only a venue listing. The relevant registries still need to publish V2 holdings, allocation factories, settlement factories, and any choice context required for the instruments. |

## When to NOT do this

- If you're listing many pairs programmatically: write a one-shot
  script that builds all the commands in one batch, not curl loops.
- If the base or quote does not yet have a V2-compatible registry: stop and
  register or integrate it first. Pair creation may succeed, but trades will
  not flow because wallets and the operator cannot create or settle the
  required V2 holdings and allocations.
