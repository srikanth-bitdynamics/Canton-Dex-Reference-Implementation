// Price source abstraction.
//
// Three sources in priority order:
//   1. Pool-derived: mid-price from constant-product reserves
//      (`quoteReserve / baseReserve` for spot)
//   2. Static config: PRICES env var, JSON map of pair → price
//   3. Fallback: undefined (caller decides whether that's an error)
//
// External price feeds (Pyth, Chainlink, custodian quotes) would
// plug in here as additional sources behind the same interface.
//
// Pair strings are canonical "<BASE>/<QUOTE>" e.g., "BTC/USDC".

import type { Pool } from "../types.js";

export interface PriceQuote {
  pair: string;
  price: string;
  source: "pool" | "static" | "feed";
  asOf: string;
}

export interface PriceSource {
  /** Return undefined when the source has no opinion. */
  quote(pair: string): Promise<PriceQuote | undefined>;
}

function parsePair(pair: string): { base: string; quote: string } | undefined {
  const parts = pair.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
  return { base: parts[0], quote: parts[1] };
}

export class PoolPriceSource implements PriceSource {
  constructor(private readonly poolsFn: () => Promise<Pool[]>) {}

  async quote(pair: string): Promise<PriceQuote | undefined> {
    const parsed = parsePair(pair);
    if (!parsed) return undefined;
    const pools = await this.poolsFn();
    const p = pools.find(
      (x) =>
        x.baseInstrumentId === parsed.base &&
        x.quoteInstrumentId === parsed.quote,
    );
    if (!p) return undefined;
    const base = Number(p.reserves.baseAmount);
    const quote = Number(p.reserves.quoteAmount);
    if (base <= 0) return undefined;
    return {
      pair,
      price: (quote / base).toString(),
      source: "pool",
      asOf: new Date().toISOString(),
    };
  }
}

export class StaticPriceSource implements PriceSource {
  private readonly prices: Record<string, string>;
  constructor(raw: string | undefined) {
    if (!raw) {
      this.prices = {};
      return;
    }
    try {
      this.prices = JSON.parse(raw) as Record<string, string>;
    } catch {
      this.prices = {};
    }
  }

  async quote(pair: string): Promise<PriceQuote | undefined> {
    const p = this.prices[pair];
    if (!p) return undefined;
    return { pair, price: p, source: "static", asOf: new Date().toISOString() };
  }
}

export class PriceService {
  constructor(private readonly sources: PriceSource[]) {}

  async quote(pair: string): Promise<PriceQuote | undefined> {
    for (const s of this.sources) {
      const q = await s.quote(pair);
      if (q) return q;
    }
    return undefined;
  }

  async quoteMany(pairs: string[]): Promise<PriceQuote[]> {
    const results = await Promise.all(pairs.map((p) => this.quote(p)));
    return results.filter((q): q is PriceQuote => !!q);
  }
}
