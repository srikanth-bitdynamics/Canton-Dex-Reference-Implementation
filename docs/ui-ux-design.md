# Canton DEX — UI/UX Design

## Design Philosophy

The Canton DEX frontend should feel like a professional trading interface — not
a toy demo. It targets two user personas:

1. **Trader** — wants fast, clear swap/trade execution with transparent pricing
2. **Liquidity Provider** — wants to manage pool positions and track LP returns

The UI should make the on-ledger workflow visible without leaking Daml
internals. Users should understand what they're approving, what's locked, and
what's settled — without needing to know about allocations, transfer legs, or
settlement factories.

## Information Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Global Navigation                                       │
│  [Trade]  [Pools]  [Orders]  [Portfolio]  [Admin]       │
└─────────────────────────────────────────────────────────┘
```

### Primary Views

1. **Trade** — swap interface (default landing page)
2. **Pools** — pool list, add/remove liquidity
3. **Orders** — order book, resting order management
4. **Portfolio** — holdings, LP positions, transaction history
5. **Admin** — pair listing, pool creation (operator only)

## View Designs

### 1. Trade (Swap) View

The primary swap interface. Should be the simplest possible path from intent to
execution.

```
┌─────────────────────────────────────────┐
│              Canton DEX                  │
│                                         │
│  ┌───────────────────────────────────┐  │
│  │          Swap                     │  │
│  │                                   │  │
│  │  You pay                          │  │
│  │  ┌─────────────┐  ┌───────────┐  │  │
│  │  │  100.00     │  │ USDC  ▼  │  │  │
│  │  └─────────────┘  └───────────┘  │  │
│  │  Balance: 1,250.00 USDC          │  │
│  │                                   │  │
│  │           ↕ (swap direction)      │  │
│  │                                   │  │
│  │  You receive                      │  │
│  │  ┌─────────────┐  ┌───────────┐  │  │
│  │  │  ~0.0412    │  │ BTC   ▼  │  │  │
│  │  └─────────────┘  └───────────┘  │  │
│  │                                   │  │
│  │  Rate: 1 BTC = 2,427.18 USDC     │  │
│  │  Fee: 0.30%                       │  │
│  │  Slippage tolerance: 0.5%        │  │
│  │  Min received: 0.04099 BTC        │  │
│  │                                   │  │
│  │  ┌───────────────────────────┐    │  │
│  │  │       Review Swap         │    │  │
│  │  └───────────────────────────┘    │  │
│  └───────────────────────────────────┘  │
│                                         │
│  Pool reserves: 50.5 BTC / 122,572 USDC│
│  24h volume: 12.3 BTC                   │
└─────────────────────────────────────────┘
```

**Key UX decisions:**

- **Three-step DvP execution**: "Review Swap" opens a confirmation modal
  showing the exact transfer legs before the user approves. This maps to
  `PoolRules_RequestSwap` → wallet-authored `AllocationFactory_Allocate` →
  `PoolRules_Swap`.
- **Slippage controls**: expandable settings panel with preset options
  (0.1%, 0.5%, 1.0%) and custom input.
- **Real-time quote**: the "You receive" field updates live from the
  operator quote endpoint and is re-validated by `PoolRules_Swap`.
- **Balance display**: show available (unlocked) balance for the input asset.
- **Transaction status**: after submission, a toast notification tracks the
  swap through: Submitted → Allocation Created → Settled → Complete.

### 2. Pools View

Two sub-views: pool list and pool detail.

**Pool List:**

```
┌─────────────────────────────────────────────────────────┐
│  Liquidity Pools                                         │
│                                                         │
│  ┌──────────┬──────────┬──────────┬──────────┬────────┐│
│  │ Pair     │ TVL      │ 24h Vol  │ Fee      │ APR    ││
│  ├──────────┼──────────┼──────────┼──────────┼────────┤│
│  │ BTC/USDC │ $245,144 │ $29,872  │ 0.30%    │ 12.4%  ││
│  │ ETH/USDC │ $89,231  │ $15,443  │ 0.30%    │ 17.2%  ││
│  │ BTC/ETH  │ $52,018  │ $4,112   │ 0.30%    │ 8.1%   ││
│  └──────────┴──────────┴──────────┴──────────┴────────┘│
│                                                         │
│  [+ Create Pool]  (operator only)                       │
└─────────────────────────────────────────────────────────┘
```

**Pool Detail / Add Liquidity:**

```
┌─────────────────────────────────────────┐
│  BTC / USDC Pool                         │
│                                         │
│  ┌─────────────────────────────────────┐│
│  │  Add Liquidity                      ││
│  │                                     ││
│  │  BTC amount:                        ││
│  │  ┌──────────────┐  Balance: 2.5    ││
│  │  │  0.5         │                   ││
│  │  └──────────────┘                   ││
│  │                                     ││
│  │  USDC amount:                       ││
│  │  ┌──────────────┐  Balance: 1,250  ││
│  │  │  1,213.59    │  (auto-filled)   ││
│  │  └──────────────┘                   ││
│  │                                     ││
│  │  Your share of pool: 0.98%          ││
│  │  LP tokens to receive: ~24.63       ││
│  │                                     ││
│  │  [Add Liquidity]                    ││
│  └─────────────────────────────────────┘│
│                                         │
│  ┌─────────────────────────────────────┐│
│  │  Your LP Position                   ││
│  │                                     ││
│  │  LP tokens held: 15.2              ││
│  │  Pool share: 0.62%                  ││
│  │  Value: ~$1,520                     ││
│  │  Base: 0.312 BTC / Quote: 760 USDC ││
│  │                                     ││
│  │  [Remove Liquidity]                 ││
│  └─────────────────────────────────────┘│
│                                         │
│  Pool Stats                              │
│  Reserves: 50.5 BTC / 122,572 USDC      │
│  Total LP supply: 2,486.3               │
│  24h fees earned: $89.62                 │
└─────────────────────────────────────────┘
```

**Key UX decisions:**

- **Auto-fill second amount**: when the user enters one asset amount, the
  other auto-fills to match the current pool ratio.
- **LP position visibility**: always show the user's current LP position on
  the pool detail page.
- **Remove liquidity**: slider or percentage input (25%, 50%, 75%, 100%)
  with preview of assets returned.

### 3. Orders View

For the order-book trading mode.

```
┌─────────────────────────────────────────────────────────┐
│  BTC / USDC Order Book                [Pair selector ▼] │
│                                                         │
│  ┌──────────────────────┐  ┌──────────────────────────┐│
│  │  Order Book           │  │  Place Order             ││
│  │                       │  │                          ││
│  │  Asks (sells)         │  │  [Bid] [Ask]             ││
│  │  2,430.50  0.120  ██ │  │                          ││
│  │  2,429.80  0.340  ██ │  │  Limit price:            ││
│  │  2,428.20  0.890  ██ │  │  ┌──────────────┐       ││
│  │  ─── spread: 1.20 ── │  │  │  2,427.00    │       ││
│  │  2,427.00  1.200  ██ │  │  └──────────────┘       ││
│  │  2,426.50  0.450  ██ │  │                          ││
│  │  2,425.10  0.080  ██ │  │  Amount (BTC):           ││
│  │  Bids (buys)         │  │  ┌──────────────┐       ││
│  │                       │  │  │  0.5         │       ││
│  │  Last: 2,427.10       │  │  └──────────────┘       ││
│  └──────────────────────┘  │                          ││
│                             │  Total (USDC): 1,213.50 ││
│  ┌──────────────────────┐  │                          ││
│  │  My Orders            │  │  Expiry: [1h ▼]         ││
│  │                       │  │                          ││
│  │  BUY  0.3 @ 2,426.50 │  │  [Place Order]           ││
│  │  SELL 0.1 @ 2,432.00 │  │                          ││
│  │         [Cancel All]  │  └──────────────────────────┘│
│  └──────────────────────┘                               │
└─────────────────────────────────────────────────────────┘
```

**Key UX decisions:**

- **Order status indicators**: show funding status (Pending → Funded →
  PartiallyFilled) as colored badges.
- **Cancel with confirmation**: cancelling an order shows the holdings that
  will be released before confirming.
- **Fill notifications**: toast when a resting order gets partially or fully
  filled.

### 4. Portfolio View

```
┌─────────────────────────────────────────────────────────┐
│  Portfolio                                               │
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │  Holdings                                           ││
│  │                                                     ││
│  │  Asset     Available    Locked     Total    Value    ││
│  │  BTC       2.500        0.500      3.000    $7,281  ││
│  │  USDC      1,250.00     1,213.50   2,463.50 $2,463 ││
│  │  ETH       10.000       0.000      10.000   $24,500 ││
│  │  BTC/USDC  15.200       0.000      15.200   $1,520 ││
│  │  LP                                                 ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │  Recent Activity                                    ││
│  │                                                     ││
│  │  14:32  SWAP   0.5 BTC → 1,213 USDC    Settled ✓  ││
│  │  14:28  ORDER  BUY 0.3 BTC @ 2,426.50  Funded  ●  ││
│  │  13:55  LP+    0.2 BTC + 485 USDC      Settled ✓  ││
│  │  13:12  SWAP   100 USDC → 0.041 BTC    Settled ✓  ││
│  └─────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────┘
```

**Key UX decisions:**

- **Available vs Locked**: clearly separate unlocked (available for new
  operations) from locked (in active allocations).
- **LP tokens in holdings**: LP positions appear as regular holdings with
  their own instrument line.

### 5. Admin View (Operator Only)

```
┌─────────────────────────────────────────────────────────┐
│  DEX Administration                                      │
│                                                         │
│  Pairs                                                   │
│  ┌──────────┬───────────┬──────────┬──────────────────┐│
│  │ Pair     │ Mode      │ Fee      │ Actions          ││
│  ├──────────┼───────────┼──────────┼──────────────────┤│
│  │ BTC/USDC │ Both      │ 30 bps   │ [Edit] [Pause]  ││
│  │ ETH/USDC │ Pool      │ 30 bps   │ [Edit] [Pause]  ││
│  └──────────┴───────────┴──────────┴──────────────────┘│
│  [+ Add Pair]                                            │
│                                                         │
│  Pool Operations                                         │
│  ┌──────────┬───────────┬──────────┬──────────────────┐│
│  │ Pool     │ Status    │ TVL      │ Actions          ││
│  ├──────────┼───────────┼──────────┼──────────────────┤│
│  │ BTC/USDC │ Active    │ $245,144 │ [Pause] [Init]  ││
│  └──────────┴───────────┴──────────┴──────────────────┘│
│  [+ Create Pool]                                         │
└─────────────────────────────────────────────────────────┘
```

## Transaction Flow UX

Every on-ledger action follows the same three-phase pattern:

1. **Preview** — show exactly what will happen (amounts, fees, transfer legs)
2. **Approve** — user confirms; allocation is created or adjusted
3. **Result** — show settlement outcome with links to details

This maps directly to the on-ledger workflow:

```
User intent → allocation request/spec created → Allocation funded
            → Adjustment (if needed) → Settlement → Result
```

### Transaction Status Toast

```
┌──────────────────────────────────────┐
│  Swap: 100 USDC → BTC               │
│  ● Creating allocation...            │
│  ○ Adjusting pool reserves           │
│  ○ Settling                          │
│  ○ Complete                          │
└──────────────────────────────────────┘
```

Progresses through each stage in real-time by watching ledger events.

## Visual Design Tokens

- **Colors**: dark background (#0D1117), card surfaces (#161B22),
  accent green (#3FB950) for buys/receives, accent red (#F85149) for
  sells/pays, neutral blue (#58A6FF) for informational
- **Typography**: monospace for amounts and prices, sans-serif for labels
- **Spacing**: 8px grid system, 16px card padding, 24px section gaps
- **Borders**: 1px solid #30363D for cards, 8px border radius

## Responsive Behavior

- **Desktop (>1024px)**: full layout with side-by-side panels
- **Tablet (768-1024px)**: stacked layout, order book collapses to
  top-of-book only
- **Mobile (<768px)**: single-column, bottom navigation tabs, simplified
  order book

## Technology Stack

- **Framework**: React 18 + TypeScript
- **State**: React Query for ledger data, Zustand for local UI state
- **Styling**: Tailwind CSS with the dark trading theme
- **Charts**: Lightweight Charts (TradingView) for price history
- **Ledger connection**: Canton JSON API or gRPC-web via a service layer
- **Real-time**: WebSocket subscription for allocation and settlement events

## Contract-to-UI Mapping

| On-Ledger Contract | UI Element |
|---|---|
| `DexPair` | Pair selector dropdown, pair list in admin |
| `Order` | Order book rows, "My Orders" panel |
| `Pool` | Pool list cards, reserve display, swap pricing |
| `LPTokenPolicy` | LP position display in portfolio and pool detail |
| `PoolRules_RequestSwap` / `PoolRules_Swap` | Swap confirmation modal and transaction toast |
| `MatchedTrade` | Trade settlement status in activity feed |
| `OrderMatchExecution` | Fill notification toast |
| `V2.Allocation` (prefunded) | "Locked" column in portfolio |
| `V2.Allocation` (committed) | Pool TVL display |
