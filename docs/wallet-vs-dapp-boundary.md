# Wallet ↔ dApp Boundary

> For which concrete wallets/providers can drive which flows (including PartyLayer
> as a connector and the DvP recovery requirement), see
> [`wallet-providers.md`](./wallet-providers.md).

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
| **Add liquidity** | (1) Trader composes the deposit in dApp; (2) dApp calls `POST /v1/pools/add-liquidity/request`, which has the operator create a `LiquidityAllocationRequest`; (3) wallet receives the request and authors the base-deposit, quote-deposit, and LP-receipt allocations via `AllocationFactory_Allocate` with the registry's choice context; (4) dApp calls `POST /v1/pools/add-liquidity/settle`, where operator + lpRegistrar settle (`PoolLiquidityRules_SettleAddLiquidity`) so funds enter the pool and LP tokens mint to the LP atomically. Remove liquidity mirrors this via the `/request` + `/settle` pair (`PoolLiquidityRules_SettleRemoveLiquidity`) |
| **Pool swap** | (1) Trader composes swap in dApp; (2) dApp calls `POST /v1/pools/swap/request`, where `PoolRules_RequestSwap` builds the exact input-allocation spec and settlement descriptor; (3) wallet authors that single `AllocationFactory_Allocate` with the registry's choice context; (4) dApp calls `POST /v1/pools/swap`, where the operator exercises `PoolRules_Swap` with the created allocation CID |
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
3. **dApp → operator backend**: `POST /v1/pools/swap/request`
4. **operator backend → Daml**: `PoolRules_RequestSwap` builds the settlement
   descriptor and input-allocation spec
5. **operator backend → registry client**: fetch allocation factory CID,
   choice context, and disclosures for the pool admin
6. **operator backend → dApp**: returns the allocation spec, settlement,
   factory CID, choice context, and disclosures
7. **dApp → wallet**: hands over a `request-swap` intent
8. **wallet → ledger**: submits `AllocationFactory_Allocate`
9. **wallet → dApp**: returns the created allocation CID
10. **dApp → operator backend**: `POST /v1/pools/swap`
11. **operator backend → ledger**: exercises `PoolRules_Swap`
12. **ledger event stream → dApp + wallet**: both update their views

The dApp never touches the trader's allocation directly; the wallet
never has DEX market state. Each side does what it's designed for.
