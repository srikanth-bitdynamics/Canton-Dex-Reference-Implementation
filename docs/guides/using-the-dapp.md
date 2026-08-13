# User guide

How traders, LPs, and RFQ counterparties use the Canton DEX. Every action
below is task-oriented: connect once, then swap, provide liquidity, place an
order, or trade an RFQ block. The one rule that shapes the whole surface — the
dApp never signs as you — is explained in
[How a trade is authorised](#how-a-trade-is-authorised).

Audience: someone who already has a Canton party id (or is willing to use the
mock wallet locally) and wants to trade.

---

## Connecting a wallet

The Connect Wallet button in the top bar opens the wallet picker. It
auto-detects the wallets available in this deployment — a dapp-sdk gateway,
injected/announced browser wallets, PartyLayer's catalog — and lists the
remaining providers below them, then routes your choice to its owning provider.
There is no built-in default in production or testnet builds.

| Provider | When to use | Required env |
|---|---|---|
| **Token Standard V2** | Local dev / testnet only (routes writes through the operator signing relay; dev builds only) | `VITE_API_BASE`, `VITE_CANTON_DEFAULT_PARTY` |
| **WalletConnect** | External CIP-0103 wallets (mobile / hardware) | `VITE_WC_PROJECT_ID` |
| **Direct Canton** | Advanced testnet sessions with a bearer token | `VITE_CANTON_LEDGER_URL`, `VITE_CANTON_AUTH_TOKEN` |
| **Mock Wallet** | Local dev only — DEV builds only | none |

Once connected, your party id appears in the top bar. The provider persists
across reloads (the session is stored in `localStorage`), and clicking the
connected pill disconnects.

On the public testnet at `testnet-dex.bitdynamics.cc`, testers are onboarded as
hosted parties on the operator's (BitDynamics) validator, and the traded assets
are issued locally by the deployment's own Token Standard V2 registry. This is an
interim arrangement until the general-purpose validator and wallet tooling (DA
Utilities) supports Token Standard V2, at which point users bring their own party
and V2 assets. See [Non-goals](../concepts/non-goals.md#the-hosted-testnet-is-a-demo-surface-not-a-wallet).

---

## How a trade is authorised

Read this once and the rest of the guide follows. **The dApp holds no keys and
invents nothing.** Every trader-authority action is the same three-step
handshake: the dApp asks the operator for a Daml-built spec, your wallet signs
exactly that spec (locking the funds it names), and the operator settles against
it. The wallet carries *your* authority; the operator carries *its own*.

```mermaid
sequenceDiagram
    actor W as Your wallet
    participant D as dApp
    participant O as Operator backend
    Note over W,O: Wallet holds your keys and signs trader-authority allocations.<br/>The dApp holds none; the operator orchestrates settlement.
    D->>O: 1. Ask for a Daml-built spec (e.g. PoolRules_RequestSwap)
    O-->>D: allocationSpec + settlement + disclosed factory context
    D->>W: 2. Hand off the intent (e.g. request-swap)
    W->>W: Sign AllocationFactory_Allocate
    W-->>D: Prefunded trader Allocation (or updateId)
    D->>O: 3. Settle
    O->>O: Exercise PoolRules_Swap / SettleBatch (operator authority)
    O-->>D: Atomic settlement
    Note over W,O: You receive the output; holdings and pool reserves refresh.
```

Because the settle step re-derives its own numbers on the ledger, the operator
cannot quote you one price and settle another. The exact template and choice
names behind each action are in
[Reference: what the wallet signs](#reference-what-the-wallet-signs-and-what-settles).

---

## Swap (Trade page)

Swap two assets at the pool mid-price plus fee, through the constant-product
pool. Use this when you want immediate execution at the pool's current rate.

1. Open **Trade** → pick the input + output asset.
2. Enter an amount. The output, rate, fee, price impact, and minimum received
   update live.
3. Set slippage tolerance via the ⚙ settings button (default 0.5 %).
4. Click **Review Swap** → confirm the on-ledger sequence.
5. Click **Approve & Submit**. The dApp has already asked the operator for a
   Daml-built swap allocation spec (`PoolRules_RequestSwap`); your wallet signs
   the matching `AllocationFactory_Allocate`, locking the input. The operator
   then settles with `PoolRules_Swap`.
6. A toast banner shows each on-ledger phase as it completes. When the final
   phase ("Pool roll-forward") goes green, your holdings and the pool reserves
   refresh automatically.

**Failure modes you might hit**:

- *"Connect wallet to swap"* → use the top-bar Connect button first.
- *"Insufficient balance"* → your unlocked holdings of the input instrument are
  below the amount entered.
- *Toast stuck at phase 2 with a red dot* → the operator rejected the swap
  (price impact > slippage, factory mismatch, etc.). Check the toast message.

---

## Add liquidity (Pools page)

Provide both sides of a pool at its current ratio and earn LP tokens that accrue
a share of swap fees.

1. Open **Pools** → click a pool → enter the base amount.
2. The quote amount auto-fills at the current pool ratio. The card shows your
   expected LP tokens and post-add pool share %.
3. Click **Add liquidity**. The operator opens the request
   (`POST /v1/pools/add-liquidity/request`), creating a
   `LiquidityAllocationRequest`.
4. Your wallet authors the base-deposit, quote-deposit, and LP-receipt
   allocations via `AllocationFactory_Allocate`.
5. The operator and lpRegistrar settle
   (`POST /v1/pools/add-liquidity/settle`,
   `PoolLiquidityRules_SettleAddLiquidity`): your funds enter the pool and LP
   tokens are minted to you, atomically.
6. Your LP balance appears under **Your LP position** once settled.

LP tokens are **unversioned**: any holder of `BTC-USDC-LP` holds the same
instrument regardless of when they minted. See
[LP tokens](../concepts/lp-tokens.md) for why.

---

## Remove liquidity (Pools page)

A delivery-versus-payment flow, because the LP holding lives in the registry,
not the DEX: the underlying and the LP burn move in a single atomic settlement.

1. Pool detail → scroll to **Your LP position**.
2. Use the 25 / 50 / 75 / 100 % buttons or the slider to pick how much to
   redeem. The card shows what you'll receive, with a slippage floor.
3. Click **Remove liquidity**. The toast walks three steps:
   - **Request** — the operator creates a `LiquidityAllocationRequest`
     (`POST /v1/pools/remove-liquidity/request`).
   - **Allocate** — your wallet authors the base-receipt, quote-receipt, and LP
     burn-sender allocations via `AllocationFactory_Allocate`.
   - **Settle** — `PoolLiquidityRules_SettleRemoveLiquidity` (co-signed by the
     operator and lpRegistrar) delivers base + quote to you and burns the LP
     tokens, atomically.

---

## Place an order (Orders page)

Limit orders for traders who want execution at a chosen price, not the pool mid.
Collateral is locked up front in a prefunded `Order` allocation.

1. Open **Orders** → pick BUY or SELL.
2. Set the limit price and amount. Orders are placed with no expiry.
3. Click **Place order**. This takes **two wallet approvals**: the first creates
   the order's funding request (`OrderFundingRequest`), which the operator binds
   into a live `Order`; the second locks the collateral that funds it.
4. The toast walks four phases: **Submitted → Bound → Funded → Open** (in book).
5. Your open orders appear under **My open orders**. Click ✕ to cancel; cancel
   releases the funding allocation back to available balance.

If the second approval fails, the order is *bound but unfunded* — the dApp names
the stuck order and best-effort cancels it, so no collateral is stranded.

The order book on the left shows depth aggregated across all parties (but not
which counterparty holds which order). Status colours: green = funded,
amber = partially filled.

---

## Trade an RFQ block (RFQ page)

Bilateral block trades. You publish a request, whitelisted dealers quote, you
accept one, and the trade settles as a `MatchedTrade` visible only to you and the
accepted dealer.

1. Open **RFQ** → click **+ New RFQ**.
2. Pick pair, side, size, and validity window. Select dealers from the whitelist
   on the right.
3. Send. Dealers receive your RFQ off-ledger and post quotes on-ledger; quotes
   stream into the expanded row in real time.
4. Keep the default **Operator policy** ranking, or re-sort with the Best price /
   Earliest / Trusted only buttons. Under policy `v2.0` the ranking chain is
   **trusted tier first → later expiry first → earlier posting time first →
   dealer id** as the tiebreaker — price is *not* part of the policy chain; you
   choose from the policy-ranked candidates. The policy modal shows the exact
   ranking that was applied.
5. Click **Accept** on the dealer you want. The operator and you co-sign
   `Rfq_Accept`, the trade settles, and a `PolicyReceipt` is produced as proof of
   the ranking applied.
6. The receipt appears as a clickable pill in your **Portfolio → Activity** feed.
   Click it to see the full attestation: which policy version, which rank, how
   many quotes were considered.

Settled RFQs move to the **Settled** tab; those that expire with no accept (or no
quotes) move to **Expired**.

---

## Portfolio (Portfolio page)

A snapshot of everything visible to your party:

- **Holdings** — every instrument you hold, with available / locked. Locked =
  currently backing an open order, swap, or RFQ allocation.
- **LP positions** — shown separately with pool-share % and underlying value.
- **Allocation breakdown** — what's locking your funds, with the Allocation CID +
  type (prefunded / committed).
- **Activity** — settled actions with timestamp, type, on-ledger Trade CID, and
  (for RFQs) a clickable policy-receipt pill.

Use the filter buttons (All / Swaps / Orders / LP) to narrow the feed.

---

## Credential warnings

Some instruments require the holder to present credentials (for example, a
KYC tier-1 claim). If your party doesn't hold the required credential, the UI
shows a yellow **Missing credentials** banner before you can trade, naming the
issuer and the exact `property=value` claim you need. Contact the credential
issuer to obtain the claim, then refresh.

This enforcement is on-ledger: the registry rejects mint/burn/transfer that fails
the credential check, regardless of what the dApp shows.

---

## Reference: what the wallet signs, and what settles

Every trader-authority write is the handshake from
[How a trade is authorised](#how-a-trade-is-authorised): the operator builds a
spec, your wallet authors it, the operator settles. The wallet provider knows
the disclosed factory CIDs, the package hash, and the holding CIDs to lock; the
dApp passes only the intent verb.

| UI action | Wallet intent | On-ledger result |
|---|---|---|
| Swap | `request-swap` | Prefunded input `Allocation`, then [`PoolRules_Swap`](../../trading/CantonDex/Dex/PoolRules.daml) |
| Add liquidity | `add-liquidity` | Base-deposit + quote-deposit + LP-receipt `Allocation`s, settled by [`PoolLiquidityRules_SettleAddLiquidity`](../../trading/CantonDex/Dex/PoolLiquidityRules.daml) |
| Remove liquidity | `remove-liquidity` | Base-receipt + quote-receipt + LP burn-sender `Allocation`s, settled by [`PoolLiquidityRules_SettleRemoveLiquidity`](../../trading/CantonDex/Dex/PoolLiquidityRules.daml) |
| Place order | `place-order` + `accept-allocation-request` | [`OrderFundingRequest`](../../trading/CantonDex/Dex/OrderFundingRequest.daml) → funded [`Order`](../../trading/CantonDex/Dex/Order.daml) |
| Accept RFQ | `accept-rfq` | Joint [`Rfq_Accept`](../../trading/CantonDex/Dex/Rfq.daml) exercise → [`MatchedTrade`](../../trading/CantonDex/Dex/MatchedTrade.daml) |
| Post RFQ quote (dealer) | `post-rfq-quote` | `RfqQuote` create |

The split that makes the "operator can't rewrite your price" guarantee is one
pair of choices: the request choice builds a spec and creates nothing, and the
settle choice consumes the wallet-authored allocation directly. From
[`PoolRules.daml`](../../trading/CantonDex/Dex/PoolRules.daml):

```daml
nonconsuming choice PoolRules_RequestSwap : PoolRules_RequestSwapResult
  with
    poolCid : ContractId Pool
    swapper : Party
    inputInstrumentId : Text
    inputAmount : Decimal
  ...
nonconsuming choice PoolRules_Swap : PoolRules_SwapResult
  ...
```

What your wallet actually signs is a single `AllocationFactory_Allocate`
exercise that locks the named holdings
([`commands.ts`](../../app/web/src/wallet/commands.ts)):

```ts
choice: "AllocationFactory_Allocate",
choiceArgument: {
  settlement,
  allocation: spec,
  requestedAt,
  inputHoldingCids,
  actors: [party],
  extraArgs,
},
```

**Proven on-ledger** (each line links the choice and the test that pins it):

- A swap re-derives its output from live reserves inside `PoolRules_Swap`, and
  the pool's recorded reserves always equal the real slices —
  [`PoolStateInvariantTests.daml`](../../trading-tests/CantonDex/Tests/PoolStateInvariantTests.daml).
- Add / remove liquidity move funds and mint / burn LP tokens in one atomic,
  co-controlled (operator + lpRegistrar) settlement —
  [`PoolLiquidityRulesTests.daml`](../../trading-tests/CantonDex/Tests/PoolLiquidityRulesTests.daml).
- An accepted RFQ moves each side's real funds and lands a `MatchedTrade` for the
  trader and dealer only —
  [`RfqSettlementTests.daml`](../../trading-tests/CantonDex/Tests/RfqSettlementTests.daml).
- The `PolicyReceipt` records the ranking honestly, and a trade signed by anyone
  but the venue is rejected —
  [`PolicyReceiptTests.daml`](../../trading-tests/CantonDex/Tests/PolicyReceiptTests.daml).

For how each of the four price surfaces is set and signed, see
[Pricing and price sources](../concepts/pricing.md).

---

**Where to read next:** [Getting Started](../getting-started.md) · [Overview](../concepts/overview.md) · [Pricing](../concepts/pricing.md) · [All docs](../README.md)
