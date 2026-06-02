# User Guide

How traders, LPs, and RFQ counterparties use the Canton DEX.

Audience: someone who already has a Canton party id (or is willing to
use the mock wallet locally) and wants to swap, add liquidity, place an
order, or trade an RFQ block.

---

## Connecting a wallet

The Connect Wallet button in the top bar opens a provider menu. The
default is **Token Standard V2** (Canton-native signing); other
providers are available if their env vars are set.

| Provider | When to use | Required env |
|---|---|---|
| **Token Standard V2** | Production / testnet, full Canton-native signing | `VITE_CANTON_LEDGER_URL`, `VITE_CANTON_AUTH_TOKEN` |
| **WalletConnect** | External CIP-0103 wallets (mobile / hardware) | `VITE_WC_PROJECT_ID` |
| **Direct Canton** | Advanced testnet sessions with a bearer token | `VITE_CANTON_LEDGER_URL`, `VITE_CANTON_AUTH_TOKEN` |
| **Mock Wallet** | Local dev only — DEV builds only | none |

Once connected, your party id appears in the top bar. The wallet
provider persists across reloads (session is stored in `localStorage`).

---

## Swap (Trade page)

Use this when you want to swap two assets at the pool mid-price plus
fee. Goes through the constant-product pool.

```
You ──┐                                         pool roll-forward
      │ 1. lock allocation                            ▲
      │ (input)                                       │ next allocation
      ▼                                               │
  ┌───────────────────────────────────────────────────┴───┐
  │  AllocationFactory_Allocate (your authority)          │
  │      ↓                                                │
  │  PoolRules_Swap (operator)                            │
  │      ↓                                                │
  │  SettlementFactory_SettleBatch (atomic)               │
  │      ↓                                                │
  │  You receive the output instrument                    │
  └───────────────────────────────────────────────────────┘
```

**UI walkthrough**:

1. Open **Trade** → pick the input + output asset.
2. Enter an amount. The output, rate, fee, price impact, and minimum
   received update live.
3. Set slippage tolerance via the ⚙ settings button (default 0.5 %).
4. Click **Review Swap** → confirm the on-ledger sequence.
5. Click **Approve & Submit**. The dApp has already asked the operator for a
   Daml-built swap allocation spec (`PoolRules_RequestSwap`); your wallet
   signs the matching `AllocationFactory_Allocate` with the registry's choice
   context.
6. A toast banner shows each on-ledger phase as it completes. When the
   final phase ("Pool roll-forward") goes green, your holdings and the
   pool reserves refresh automatically.

**Failure modes you might hit**:

- *"Connect wallet to swap"* → use the top-bar Connect button first.
- *"Insufficient balance"* → your unlocked holdings of the input
  instrument are below the amount entered.
- *Toast stuck at phase 2 with a red dot* → the operator rejected the
  swap (price impact > slippage, factory mismatch, etc.). Check the
  error message in the toast.

---

## Add liquidity (Pools page)

Use this to provide both sides of a pool and earn LP tokens.

1. Open **Pools** → click a pool → enter the base amount.
2. The quote amount auto-fills at the current pool ratio. The card
   shows your expected LP tokens and post-add pool share %.
3. Click **Add liquidity**. The operator opens the request
   (`POST /v1/pools/add-liquidity/request`), creating a
   `LiquidityAllocationRequest`.
4. Your wallet authors the base-deposit, quote-deposit, and LP-receipt
   allocations via `AllocationFactory_Allocate`.
5. The operator and lpRegistrar settle
   (`POST /v1/pools/add-liquidity/settle`,
   `PoolLiquidityRules_SettleAddLiquidity`): your funds enter the pool and LP
   tokens are minted to you, atomically.
6. Your LP balance appears under "Your LP position" once settled.

LP tokens are **unversioned**: any holder of `BTC-USDC-LP` holds the
same instrument regardless of when they minted. See
[`docs/lp-token-versioning.md`](lp-token-versioning.md) for why.

---

## Remove liquidity (Pools page)

A DvP flow because the LP holding lives in the registry, not the DEX:

1. Operator step (driven by the UI): `POST /v1/pools/remove-liquidity/request`
   creates a `LiquidityAllocationRequest`.
2. Wallet step: your wallet authors the base-receipt, quote-receipt,
   and LP burn-sender allocations via `AllocationFactory_Allocate`.
3. Settle step: `POST /v1/pools/remove-liquidity/settle`
   (`PoolLiquidityRules_SettleRemoveLiquidity`, co-signed by the operator and
   lpRegistrar) delivers base + quote to you and burns the LP tokens to
   the burn account, atomically.

**UI walkthrough**:

1. Pool detail → scroll to **Your LP position**.
2. Use the 25 / 50 / 75 / 100 % buttons or the slider to pick how much
   to redeem. The card shows what you'll receive.
3. Click **Remove liquidity** → toast walks the request, allocation,
   and settle steps.

---

## Place an order (Orders page)

Limit orders for traders who want execution at a price, not a pool
mid. Uses prefunded `Order` allocations.

1. Open **Orders** → pick BUY or SELL.
2. Set the limit price, size, and expiry (10m / 1h / 4h / GTC).
3. Click **Place Order**. Your wallet signs an `OrderFundingRequest`;
   the operator binds + funds it on-ledger.
4. Toast walks: submitted → bound → funded → in book.
5. Your open orders appear under **My open orders**. Click ✕ to
   cancel. Cancel releases the funding allocation back to available
   balance.

The order book on the left shows depth aggregated across all parties
(but not which counterparty holds which order). Status colours:
green = funded, amber = partially filled.

---

## Trade an RFQ block (RFQ page)

Bilateral block trades. You publish a request, whitelisted dealers
quote, you accept the best one, and the trade settles as a
MatchedTrade visible only to you and the accepted dealer.

1. Open **RFQ** → click **+ New RFQ**.
2. Pick pair, side, size, expiry window. Select dealers from the
   whitelist on the right.
3. Send. Dealers receive your RFQ off-ledger and post quotes
   on-ledger; quotes stream into the expanded row in real time.
4. Inspect the **Operator policy** modal to see how quotes are ranked
   (tier → price → posting time → tiebreaker).
5. Click **Accept** on the dealer you want. The operator + you
   co-sign `Rfq_Accept`, the trade settles, and a `PolicyReceipt` is
   produced as proof of the ranking applied.
6. The receipt appears as a clickable pill in your **Portfolio →
   Activity** feed. Click it to see the full attestation: which
   policy version, which rank, how many quotes were considered.

Settled RFQs move to the **Settled** tab. Expired (no accept, or no
quotes) move to **Expired**.

---

## Portfolio (Portfolio page)

Snapshot of everything visible to your party:

- **Holdings** — every instrument you hold, with available / locked.
  Locked = currently backing an open order, swap, or RFQ allocation.
- **LP positions** — shown separately with pool-share % and underlying
  value.
- **Allocation breakdown** — what's locking your funds, with the
  Allocation CID + type (prefunded / committed).
- **Activity** — every settled action with timestamp, type, on-ledger
  Trade CID, and (for RFQs) a clickable policy receipt pill.

Use the filter buttons (All / Swaps / Orders / LP) to narrow the feed.

---

## Credential warnings

Some instruments require the holder to present credentials (e.g., a
KYC tier-1 claim). If your party doesn't hold the required credential,
the UI shows a yellow warning banner before you can trade. Contact the
relevant credential issuer to obtain the claim, then refresh.

This enforcement is on-ledger: the registry rejects mint/burn/transfer
that fails the credential check, regardless of what the dApp shows.

---

## What the wallet actually signs

The dApp never signs as your party. Every trader-authority action
above goes through your wallet provider:

| UI action | Wallet intent | On-ledger result |
|---|---|---|
| Swap | `request-swap` | Prefunded input `Allocation`, then `PoolRules_Swap` |
| Add liquidity | `add-liquidity` | Base-deposit + quote-deposit + LP-receipt `Allocation`s (settled by `PoolLiquidityRules_SettleAddLiquidity`) |
| Remove liquidity | `remove-liquidity` | Base-receipt + quote-receipt + LP burn-sender `Allocation`s (settled by `PoolLiquidityRules_SettleRemoveLiquidity`) |
| Place order | `place-order` | `OrderFundingRequest` |
| Accept RFQ | `accept-rfq` | Joint `Rfq_Accept` exercise |
| Post RFQ quote (dealer) | `post-rfq-quote` | `RfqQuote` create |

The wallet provider knows the disclosed factory CIDs, the package hash,
and the holding CIDs to lock; the dApp passes only the intent verb.
See [`docs/wallet-vs-dapp-boundary.md`](wallet-vs-dapp-boundary.md) for
the architectural rationale.
