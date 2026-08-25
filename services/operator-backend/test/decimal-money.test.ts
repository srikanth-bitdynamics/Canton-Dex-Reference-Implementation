// On-ledger amounts must go through the BigInt decimal module, not
// IEEE-754. Pins (1) the matching-engine quote-leg amount = price*quantity at
// 10dp round-half-even, and (2) rankQuotes price ordering via exact decimal
// comparison.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import * as dec from "../src/pool/decimal.js";
import { rankQuotes, compareDecimal } from "../src/policy/index.js";
import type { RfqQuote } from "../src/types.js";

describe("quote-leg amount via decimal module", () => {
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

describe("floored decimal ops mirror the pool's payout rounding", () => {
  const d = (s: string) => dec.parseDecimal(s);

  it("steps a rounded-up product down to the exact floor", () => {
    // 0.0000000002 * 0.75 = 0.00000000015 exactly; `mul` rounds it up.
    assert.equal(dec.formatDecimal(dec.mul(d("0.0000000002"), d("0.75"))), "0.0000000002");
    assert.equal(
      dec.formatDecimal(dec.mulFloor(d("0.0000000002"), d("0.75"))),
      "0.0000000001",
    );
  });

  it("steps a rounded-up quotient down to the exact floor", () => {
    // 7000 / 1007 = 6.95134061569016…
    assert.equal(dec.formatDecimal(dec.div(d("7000"), d("1007"))), "6.9513406157");
    assert.equal(dec.formatDecimal(dec.divFloor(d("7000"), d("1007"))), "6.9513406156");
  });

  it("leaves exactly representable results alone", () => {
    assert.equal(dec.formatDecimal(dec.mulFloor(d("2.5"), d("4"))), "10.0000000000");
    assert.equal(dec.formatDecimal(dec.divFloor(d("7000"), d("1000"))), "7.0000000000");
    // The unit share a full LP redemption computes must stay exact.
    assert.equal(
      dec.formatDecimal(dec.divFloor(d("1414.2135623731"), d("1414.2135623731"))),
      "1.0000000000",
    );
  });
});

describe("compareDecimal is exact", () => {
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
  price?: string;
  postedAt?: string;
  expiresAt?: string;
  tier?: "TierTrusted" | "TierWhitelist";
}): RfqQuote {
  return {
    contractId: `#${o.dealer}:0` as never,
    dealer: o.dealer as never,
    trader: "alice" as never,
    operator: "op" as never,
    rfqId: "rfq-1",
    // Under v2.0 the ranking never reads price, so most cases have
    // no reason to state one.
    price: o.price ?? "1.00",
    expiresAt: o.expiresAt ?? "2099-01-01T00:00:00Z",
    postedAt: o.postedAt ?? "2026-01-01T00:00:00Z",
    tier: (o.tier ?? "TierTrusted") as never,
  };
}

// The operator's off-chain ranking is replayed against `policyCmp` in
// trading/CantonDex/Dex/Rfq.daml, so these pin the chain's ordering, not a
// plausible one. [POLICY] v2.0 does not rank by price or direction; the trader
// picks from the ranked candidates.
describe("rankQuotes reproduces the on-ledger policyCmp (v2.0)", () => {
  const now = "2026-01-01T00:00:00Z";

  it("ranks later expiry first — more time to act", () => {
    const quotes = [
      mkQuote({ dealer: "soon", expiresAt: "2026-01-01T01:00:00Z" }),
      mkQuote({ dealer: "latest", expiresAt: "2026-01-01T09:00:00Z" }),
      mkQuote({ dealer: "mid", expiresAt: "2026-01-01T05:00:00Z" }),
    ];
    assert.deepEqual(
      rankQuotes("RFQ_Buy", quotes, now).map((q) => q.dealer),
      ["latest", "mid", "soon"],
    );
  });

  it("ignores price entirely, in both directions", () => {
    const quotes = [
      mkQuote({ dealer: "dear", price: "99999.00" }),
      mkQuote({ dealer: "cheap", price: "1.00" }),
    ];
    // Same expiry and postedAt, so the dealer tie-break decides -- price does
    // not enter the comparison at all, and the side does not change it.
    for (const side of ["RFQ_Buy", "RFQ_Sell"] as const) {
      assert.deepEqual(
        rankQuotes(side, quotes, now).map((q) => q.dealer),
        ["cheap", "dear"],
        `${side}: ordered by dealer tie-break, not price`,
      );
    }
  });

  it("trusted tier ranks ahead of whitelist regardless of expiry", () => {
    const quotes = [
      mkQuote({
        dealer: "later-wl",
        tier: "TierWhitelist",
        expiresAt: "2026-01-01T09:00:00Z",
      }),
      mkQuote({
        dealer: "sooner-trusted",
        tier: "TierTrusted",
        expiresAt: "2026-01-01T02:00:00Z",
      }),
    ];
    assert.equal(rankQuotes("RFQ_Buy", quotes, now)[0]?.dealer, "sooner-trusted");
  });

  it("breaks an expiry tie by earlier postedAt, then by dealer", () => {
    const quotes = [
      mkQuote({ dealer: "b-late", postedAt: "2026-01-01T00:00:05Z" }),
      mkQuote({ dealer: "a-early", postedAt: "2026-01-01T00:00:01Z" }),
      mkQuote({ dealer: "c-late", postedAt: "2026-01-01T00:00:05Z" }),
    ];
    assert.deepEqual(
      rankQuotes("RFQ_Buy", quotes, now).map((q) => q.dealer),
      ["a-early", "b-late", "c-late"],
    );
  });

  it("drops quotes that have already expired", () => {
    const quotes = [
      mkQuote({ dealer: "live", expiresAt: "2026-01-01T02:00:00Z" }),
      mkQuote({ dealer: "lapsed", expiresAt: "2025-12-31T23:00:00Z" }),
    ];
    assert.deepEqual(
      rankQuotes("RFQ_Buy", quotes, now).map((q) => q.dealer),
      ["live"],
    );
  });
});
