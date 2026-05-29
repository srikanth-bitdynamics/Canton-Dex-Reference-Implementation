# Wallet ↔ dApp Boundary

The DEX trader experience is a composition of two interfaces:

- **The token-standard wallet** — a generic Canton Network wallet that
  understands `V2.HoldingV2`, `V2.AllocationRequest`,
  `V2.TransferInstruction`, etc. Examples: the official Canton wallet,
  any third-party wallet that ships token-standard support.
- **The DEX dApp** (`app/web/`) — a market-specific UI for swap, order
  book, RFQ, pool, portfolio, admin.

The boundary is intentional. Forcing every market action through the
dApp would re-implement features the wallet already does (and break
custody assumptions); forcing every market action through the wallet
would pre-empt the market-specific UX (depth charts, RFQ comparison,
slippage preview, fill receipts, policy receipts).

This doc nails down which actions belong on which side so neither
team builds the same thing twice.

## Wallet-native actions

The wallet owns these because they're token-standard primitives that
work the same everywhere on Canton:

| Action | Notes |
|---|---|
| Hold management (browse balances, lock/unlock, split/merge) | Custody UX |
| Receive `MintRequest` accept/reject from registrar | Generic mint flow |
| Receive `TransferOffer` accept/reject from sender | Generic transfer flow |
| Receive `BurnRequest` cancel/accept | Generic burn flow |
| Accept `V2.AllocationRequest` (`AllocationRequest_Accept`) | Generic allocation accept; no DEX-specific UI needed |
| Compose `AllocationFactory_Allocate` in the same submission as Accept | Wallet ensures the duplicate-prevention pattern |
| LP-token balance display | LP tokens are standard token-standard holdings; no special handling |
| Credential management | Credentials are token-standard claims |

## DEX dApp-native actions

The dApp owns these because they require DEX market context the wallet
doesn't have:

| Action | Why dApp |
|---|---|
| Compose RFQ (pair selection, dealer whitelist, quote validity) | Market-specific |
| Inbound quote ranking + accept choice | Operator policy + receipt visibility |
| Order book browse + place limit/market | Market depth visualization |
| Pool browse + add/remove liquidity | Pool ratio, share preview, fee model |
| Swap preview (quote, slippage, route) | Constant-product math + fee model |
| Trade confirmation modals (transfer-leg breakdown) | Market-specific labeling |
| Fill notifications + match settlement progress toasts | Market-specific event shapes |
| Portfolio: combined view across holdings + LP positions + open orders | DEX state aggregation |
| Admin: pair config, pool init, fee tuning | Operator-only controls |

## Hybrid actions (compose both)

These actions require BOTH interfaces. The dApp initiates; the wallet
authorizes.

| Action | Trader's experience |
|---|---|
| **Place an order** | (1) Trader composes order in dApp; (2) dApp calls operator backend to bind, which produces `OrderAllocationRequest`; (3) wallet receives the request, shows it for accept/reject; (4) on accept, wallet composes `AllocationFactory_Allocate`; (5) dApp shows the order as Funded once the operator binds |
| **Add liquidity** | (1) Trader composes the deposit in dApp; (2) dApp calls `POST /v1/pools/add-liquidity/request`, which has the operator create a `LiquidityAllocationRequest`; (3) wallet receives the request and authors the base-deposit, quote-deposit, and LP-receipt allocations via `AllocationFactory_Allocate`; (4) dApp calls `POST /v1/pools/add-liquidity/settle`, where operator + lpRegistrar settle (`LpDvpRules_SettleAddLiquidity`) so funds enter the pool and LP tokens mint to the LP atomically. Remove liquidity mirrors this via the `/request` + `/settle` pair (`LpDvpRules_SettleRemoveLiquidity`) |
| **Pool swap** | (1) Trader composes swap in dApp; (2) dApp creates `SwapRequest` (trader-signed) with an allocation reference; (3) wallet shows the underlying allocation; (4) operator backend exercises `Pool_Swap` |
| **Cancel order** | (1) Trader clicks Cancel in dApp; (2) operator exercises `Order_Cancel`; (3) wallet receives released-holding event, surfaces it |
| **Accept an RFQ quote** | (1) Trader picks quote in dApp; (2) dApp + operator co-submit `Rfq_Accept`; (3) wallet receives the resulting `MatchedTrade` and the corresponding `TradeAllocationRequest`; (4) wallet asks for accept; (5) on accept, wallet composes the allocation |

## Communication between dApp and wallet

The dApp does NOT bypass the wallet's submission authority for trader
actions. Concretely:

- The dApp's frontend sends a "prepare" call to the operator backend.
- The operator backend returns either a transaction the trader's
  wallet should submit, OR a request contract the wallet observes.
- The wallet UI surfaces the request and asks for the trader's
  authorization.
- On approval, the wallet submits the trader-side transaction.
- The dApp listens to the ledger event stream and updates its view.

This is the standard "the dApp can't sign for the user" pattern. The
operator backend can still submit operator-only transactions
(orchestration, settlement) directly.

## Anti-patterns to avoid

- **Re-implementing wallet UX in the dApp.** If the wallet already
  shows a `V2.AllocationRequest`, the dApp should NOT add a parallel
  list of pending requests. The dApp links out to the wallet.
- **Letting the dApp hold trader signing keys.** The wallet is the
  custodian. The dApp coordinates intent.
- **Synchronously depending on wallet UI in the operator backend.**
  The backend submits its own transactions and reads the ledger; it
  doesn't poll a wallet's UI state.
- **Building DEX-specific actions inside the wallet.** RFQ
  composition, order placement, swap quote — these are market-specific
  and belong in the dApp.

## Reference flow: trader buys via swap

1. **dApp**: trader fills swap form, hits "Review Swap"
2. **dApp**: shows transfer-leg breakdown + on-ledger sequence preview
3. **dApp → operator backend**: `prepareSwap({pair, amountIn, slippage})`
4. **operator backend → registry client**: fetch `InstrumentConfiguration` CIDs
5. **operator backend → dApp**: returns a `SwapRequest` create command for the trader's wallet
6. **dApp → wallet**: deep-link to wallet with the prepared command
7. **wallet**: shows holding selection + allocation preview + asks for trader signature
8. **wallet → ledger**: submits the create + allocation factory call
9. **ledger event stream → operator backend**: notices the new `SwapRequest`
10. **operator backend → ledger**: submits `Pool_Swap` (operator-only authority)
11. **ledger event stream → dApp + wallet**: both update their views
12. **dApp**: shows transaction toast progressing through the 4 phases

The dApp never touches the trader's allocation directly; the wallet
never has DEX market state. Each side does what it's designed for.
