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

// A pair segment is a display symbol, optionally admin-qualified as `id@admin`
// so the same symbol under two registries selects the intended pool. The admin
// is optional; a bare symbol keeps the display-only, first-match behaviour.
interface PairSide {
  id: string;
  admin?: string;
}

function parseSide(s: string): PairSide {
  const at = s.indexOf("@");
  return at >= 0 ? { id: s.slice(0, at), admin: s.slice(at + 1) } : { id: s };
}

function parsePair(pair: string): { base: PairSide; quote: PairSide } | undefined {
  const parts = pair.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
  return { base: parseSide(parts[0]), quote: parseSide(parts[1]) };
}

export class PoolPriceSource implements PriceSource {
  constructor(private readonly poolsFn: () => Promise<Pool[]>) {}

  async quote(pair: string): Promise<PriceQuote | undefined> {
    const parsed = parsePair(pair);
    if (!parsed) return undefined;
    const pools = await this.poolsFn();
    // Select by full instrument identity when an admin is supplied, so two
    // registries' same-symbol pairs do not collide; a bare symbol keeps the
    // first-match display behaviour.
    const sideMatches = (
      side: Pool["baseInstrumentId"],
      want: PairSide,
    ): boolean =>
      side.id === want.id && (want.admin === undefined || side.admin === want.admin);
    const p = pools.find(
      (x) =>
        sideMatches(x.baseInstrumentId, parsed.base) &&
        sideMatches(x.quoteInstrumentId, parsed.quote),
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
