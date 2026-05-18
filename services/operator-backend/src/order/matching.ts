// Order matching engine: price-time priority.
//
// Pure functions over Order rows. The operator service polls open
// orders and runs `match()` to discover crossing bid/ask pairs; the
// returned matches are then sent through the TradingAppV2 settlement
// pattern (`OTCTrade_RequestAllocations` → `OTCTrade_Settle`).
//
// Why pure functions: matching is decisive but read-only against the
// ACS. Putting the algorithm here makes it trivially unit-testable
// without a ledger. The service module wires it to actual ledger writes.

import type { Order } from "../types.js";

export interface Match {
  buy: Order;
  sell: Order;
  /** Decimal price string at which the trade clears (resting order's price). */
  price: string;
  /** Decimal quantity filled in this match. */
  quantity: string;
}

interface PairKey {
  base: string;
  quote: string;
}

function eqPair(a: PairKey, b: PairKey): boolean {
  return a.base === b.base && a.quote === b.quote;
}

function num(s: string): number {
  return Number(s);
}

/**
 * Match open orders for a single pair. Greedy price-time priority:
 *   1. Bids sorted desc(price), asc(createdAt) — best buy first
 *   2. Asks sorted asc(price), asc(createdAt) — best sell first
 *   3. While best bid >= best ask: cross at the resting (older) order's
 *      price; consume min(bidQty, askQty) from both sides.
 *
 * Returns the list of matches to settle. Orders are not mutated; the
 * caller is responsible for posting the resulting OTCTrades and
 * updating remainingQty on partial fills.
 */
export function matchOrdersForPair(
  orders: Order[],
  pair: PairKey,
): Match[] {
  const eligible = orders.filter(
    (o) =>
      eqPair({ base: o.baseInstrumentId, quote: o.quoteInstrumentId }, pair) &&
      (o.status === "Funded" || o.status === "PartiallyFilled") &&
      num(o.remainingQty) > 0,
  );

  // Time priority approximated by contract id lex order. Production
  // should use the ledger's create timestamp from the event stream.
  const bids = eligible
    .filter((o) => o.side === "Bid")
    .sort((a, b) => num(b.limitPrice) - num(a.limitPrice) || a.contractId.localeCompare(b.contractId));
  const asks = eligible
    .filter((o) => o.side === "Ask")
    .sort((a, b) => num(a.limitPrice) - num(b.limitPrice) || a.contractId.localeCompare(b.contractId));

  const matches: Match[] = [];
  // Track remaining qty mutably across multiple matches.
  const remaining = new Map<string, number>();
  for (const o of eligible) remaining.set(o.contractId, num(o.remainingQty));

  let bi = 0;
  let ai = 0;
  while (bi < bids.length && ai < asks.length) {
    const buy = bids[bi]!;
    const sell = asks[ai]!;
    if (num(buy.limitPrice) < num(sell.limitPrice)) break;
    const buyRem = remaining.get(buy.contractId) ?? 0;
    const sellRem = remaining.get(sell.contractId) ?? 0;
    const qty = Math.min(buyRem, sellRem);
    if (qty <= 0) {
      // Exhausted side advances.
      if (buyRem <= 0) bi += 1;
      if (sellRem <= 0) ai += 1;
      continue;
    }
    // Cross at the price of the order that was resting longer
    // (smaller contractId in our lex approximation).
    const resting = buy.contractId.localeCompare(sell.contractId) < 0 ? buy : sell;
    matches.push({
      buy,
      sell,
      price: resting.limitPrice,
      quantity: qty.toString(),
    });
    remaining.set(buy.contractId, buyRem - qty);
    remaining.set(sell.contractId, sellRem - qty);
    if (buyRem - qty <= 0) bi += 1;
    if (sellRem - qty <= 0) ai += 1;
  }
  return matches;
}

/**
 * Aggregate an order book into bid/ask depth ladders.
 */
export interface BookLevel {
  price: string;
  size: string;
  count: number;
}

export function aggregateBook(orders: Order[]): {
  bids: BookLevel[];
  asks: BookLevel[];
} {
  const accum = (rows: Order[]): BookLevel[] => {
    const byPrice = new Map<string, { size: number; count: number }>();
    for (const o of rows) {
      if (o.status !== "Funded" && o.status !== "PartiallyFilled") continue;
      const k = o.limitPrice;
      const cur = byPrice.get(k) ?? { size: 0, count: 0 };
      cur.size += num(o.remainingQty);
      cur.count += 1;
      byPrice.set(k, cur);
    }
    return Array.from(byPrice.entries()).map(([price, v]) => ({
      price,
      size: v.size.toString(),
      count: v.count,
    }));
  };
  const bids = accum(orders.filter((o) => o.side === "Bid")).sort(
    (a, b) => num(b.price) - num(a.price),
  );
  const asks = accum(orders.filter((o) => o.side === "Ask")).sort(
    (a, b) => num(a.price) - num(b.price),
  );
  return { bids, asks };
}
