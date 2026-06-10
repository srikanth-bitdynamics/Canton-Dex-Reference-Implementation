// DEX-106: on-ledger amounts must go through the BigInt decimal module, not
// IEEE-754. Pins (1) the matching-engine quote-leg amount = price*quantity at
// 10dp round-half-even, and (2) rankQuotes price ordering via exact decimal
// comparison.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import * as dec from "../src/pool/decimal.js";
import { rankQuotes, compareDecimal } from "../src/policy/index.js";
import type { RfqQuote } from "../src/types.js";

describe("DEX-106: quote-leg amount via decimal module", () => {
  // The matching engine computes the quote leg as price*quantity. A naive
  // Number(price)*Number(quantity) drifts in the low digits; the decimal
  // module's mul/format is exact at 10dp round-half-even.
  function legAmount(price: string, quantity: string): string {
    return dec.formatDecimal(
      dec.mul(dec.parseDecimal(price), dec.parseDecimal(quantity)),
    );
  }

  it("exact for clean inputs", () => {
    assert.equal(legAmount("60510.00", "5.0"), "302550.0000000000");
  });

  it("matches the decimal-module multiply for low-digit-sensitive inputs", () => {
    const price = "0.1000000001";
    const quantity = "0.1000000001";
    // The on-ledger Decimal product, rounded half-even to 10dp.
    const expected = dec.formatDecimal(
      dec.mul(dec.parseDecimal(price), dec.parseDecimal(quantity)),
    );
    assert.equal(legAmount(price, quantity), expected);
    // And it is the round-half-even of the true product to 10dp.
    assert.equal(expected, "0.0100000000");
  });

  it("round-half-even at the 10dp boundary", () => {
    // 0.00000000005 -> round to even (…0). price*qty = 5e-11 here.
    assert.equal(legAmount("0.0000000001", "0.5"), "0.0000000000");
  });
});

describe("DEX-106: compareDecimal is exact", () => {
  it("orders by decimal value, not float", () => {
    assert.equal(compareDecimal("60510.00", "60530.00"), -1);
    assert.equal(compareDecimal("60530.00", "60510.00"), 1);
    assert.equal(compareDecimal("1.0", "1.0000000000"), 0);
    // A pair where float subtraction could lose precision but decimal must not.
    assert.equal(compareDecimal("0.1000000001", "0.1000000002"), -1);
  });
});

function mkQuote(o: {
  dealer: string;
  price: string;
  postedAt?: string;
  tier?: "TierTrusted" | "TierWhitelist";
}): RfqQuote {
  return {
    contractId: `#${o.dealer}:0` as never,
    dealer: o.dealer as never,
    trader: "alice" as never,
    operator: "op" as never,
    rfqId: "rfq-1",
    price: o.price,
    expiresAt: "2099-01-01T00:00:00Z",
    postedAt: o.postedAt ?? "2026-01-01T00:00:00Z",
    tier: (o.tier ?? "TierTrusted") as never,
  };
}

describe("DEX-106: rankQuotes ordering uses decimal comparison", () => {
  const now = "2026-01-01T00:00:00Z";

  it("RFQ_Buy: cheapest first (decimal order)", () => {
    const quotes = [
      mkQuote({ dealer: "a", price: "60530.00" }),
      mkQuote({ dealer: "b", price: "60510.00" }),
      mkQuote({ dealer: "c", price: "60509.50" }),
    ];
    const ranked = rankQuotes("RFQ_Buy", quotes, now);
    assert.deepEqual(
      ranked.map((q) => q.dealer),
      ["c", "b", "a"],
    );
  });

  it("RFQ_Sell: highest first", () => {
    const quotes = [
      mkQuote({ dealer: "a", price: "60530.00" }),
      mkQuote({ dealer: "b", price: "60510.00" }),
    ];
    const ranked = rankQuotes("RFQ_Sell", quotes, now);
    assert.deepEqual(
      ranked.map((q) => q.dealer),
      ["a", "b"],
    );
  });

  it("trusted tier ranks ahead of whitelist regardless of price", () => {
    const quotes = [
      mkQuote({ dealer: "cheap-wl", price: "1.0", tier: "TierWhitelist" }),
      mkQuote({ dealer: "dear-trusted", price: "9.0", tier: "TierTrusted" }),
    ];
    const ranked = rankQuotes("RFQ_Buy", quotes, now);
    assert.equal(ranked[0]?.dealer, "dear-trusted");
  });

  it("distinguishes prices that differ only in the 10th decimal", () => {
    const quotes = [
      mkQuote({ dealer: "hi", price: "1.0000000002" }),
      mkQuote({ dealer: "lo", price: "1.0000000001" }),
    ];
    const ranked = rankQuotes("RFQ_Buy", quotes, now);
    assert.deepEqual(
      ranked.map((q) => q.dealer),
      ["lo", "hi"],
    );
  });
});
