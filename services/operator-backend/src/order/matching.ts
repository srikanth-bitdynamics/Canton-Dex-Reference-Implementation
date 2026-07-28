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
import * as dec from "../pool/decimal.js";

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

function priceOf(o: Order): bigint {
  return dec.parseDecimal(o.limitPrice);
}

function cmpBigint(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Ledger create time in epoch ms, or null when the driver reports none. */
function restingSince(o: Order): number | null {
  if (!o.ledgerCreatedAt) return null;
  const t = Date.parse(o.ledgerCreatedAt);
  return Number.isNaN(t) ? null : t;
}

function isExpired(o: Order, nowMs: number): boolean {
  if (!o.expiry) return false;
  const t = Date.parse(o.expiry);
  // An unparseable expiry must not silently pull a funded order off the book;
  // only a value that can actually be compared against `now` expires one.
  return !Number.isNaN(t) && t <= nowMs;
}

/** Funded (or partly filled) and not past its good-till time. */
export function isOpenAt(o: Order, nowMs: number): boolean {
  return (
    (o.status === "Funded" || o.status === "PartiallyFilled") &&
    !isExpired(o, nowMs)
  );
}

// Time priority off the ledger create time. Orders whose create time the
// driver cannot report queue behind those it can; the contract id breaks only
// exact ties, so the sort is total without a content hash setting priority.
function byRestingTime(a: Order, b: Order): number {
  const ta = restingSince(a);
  const tb = restingSince(b);
  if (ta !== null && tb !== null && ta !== tb) return ta - tb;
  if (ta === null && tb !== null) return 1;
  if (ta !== null && tb === null) return -1;
  return a.contractId.localeCompare(b.contractId);
}

// The aggressor crosses at the resting order's limit. Absent a strictly older
// side there is no aggressor, so split the spread rather than hand one side
// the other's limit: the midpoint of a crossing pair always lies within
// [ask, bid], so both limits still hold.
function clearingPrice(buy: Order, sell: Order): string {
  const tb = restingSince(buy);
  const ts = restingSince(sell);
  if (tb !== null && ts !== null && tb !== ts) {
    return tb < ts ? buy.limitPrice : sell.limitPrice;
  }
  return dec.formatDecimal(
    dec.div(priceOf(buy) + priceOf(sell), 2n * dec.SCALE),
  );
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
 * recording the fill against both orders.
 */
export function matchOrdersForPair(
  orders: Order[],
  pair: PairKey,
  now: Date = new Date(),
): Match[] {
  const nowMs = now.getTime();
  const eligible = orders.filter(
    (o) =>
      eqPair({ base: o.baseInstrumentId, quote: o.quoteInstrumentId }, pair) &&
      isOpenAt(o, nowMs) &&
      dec.parseDecimal(o.remainingQty) > 0n,
  );

  const bids = eligible
    .filter((o) => o.side === "Bid")
    .sort((a, b) => cmpBigint(priceOf(b), priceOf(a)) || byRestingTime(a, b));
  const asks = eligible
    .filter((o) => o.side === "Ask")
    .sort((a, b) => cmpBigint(priceOf(a), priceOf(b)) || byRestingTime(a, b));

  const matches: Match[] = [];
  // Track remaining qty mutably across multiple matches. Scaled BigInt, not
  // floats: this quantity is submitted as the on-ledger `filledQty`, and a
  // 0.30000000000000004 would trip the choice's remaining-qty assertion.
  const remaining = new Map<string, bigint>();
  for (const o of eligible) {
    remaining.set(o.contractId, dec.parseDecimal(o.remainingQty));
  }

  let bi = 0;
  let ai = 0;
  while (bi < bids.length && ai < asks.length) {
    const buy = bids[bi]!;
    const sell = asks[ai]!;
    if (priceOf(buy) < priceOf(sell)) break;
    const buyRem = remaining.get(buy.contractId) ?? 0n;
    const sellRem = remaining.get(sell.contractId) ?? 0n;
    const qty = dec.min(buyRem, sellRem);
    if (qty <= 0n) {
      // Exhausted side advances.
      if (buyRem <= 0n) bi += 1;
      if (sellRem <= 0n) ai += 1;
      continue;
    }
    matches.push({
      buy,
      sell,
      price: clearingPrice(buy, sell),
      quantity: dec.formatDecimal(qty),
    });
    remaining.set(buy.contractId, buyRem - qty);
    remaining.set(sell.contractId, sellRem - qty);
    if (buyRem - qty <= 0n) bi += 1;
    if (sellRem - qty <= 0n) ai += 1;
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

export function aggregateBook(
  orders: Order[],
  now: Date = new Date(),
): {
  bids: BookLevel[];
  asks: BookLevel[];
} {
  const nowMs = now.getTime();
  const accum = (rows: Order[]): BookLevel[] => {
    const byPrice = new Map<string, { size: number; count: number }>();
    for (const o of rows) {
      if (!isOpenAt(o, nowMs)) continue;
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
