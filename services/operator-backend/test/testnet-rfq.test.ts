// Pure arithmetic and validation behind the testnet RFQ routes.
//
// These are the parts a caller must never be able to influence: the price a
// demo dealer quotes, the pair text the Rfq carries, and how long it stays
// open. Pinned here because the orchestration around them cannot be exercised
// until dealer parties exist on a deployment.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_RFQ_MINUTES,
  MIN_RFQ_MINUTES,
  TestnetRfqRejectedError,
  dealerQuotePrice,
  dealerSpreadBps,
  rfqExpiry,
  rfqPairString,
  rfqSize,
} from "../src/testnet-onboarding/rfq.ts";
import { isDecimalString } from "../src/http/validate.ts";

describe("dealerQuotePrice", () => {
  const MID = "95000.0000000000";

  it("quotes above mid on a buy and below on a sell", () => {
    const buy = dealerQuotePrice(MID, "RFQ_Buy", 10);
    const sell = dealerQuotePrice(MID, "RFQ_Sell", 10);
    assert.equal(buy, "95095.0000000000");
    assert.equal(sell, "94905.0000000000");
    // The spread is always against the trader, as it would be from a real
    // market maker -- never a gift in either direction.
    assert.ok(parseFloat(buy) > parseFloat(MID));
    assert.ok(parseFloat(sell) < parseFloat(MID));
  });

  it("stays exact at the 10dp Daml scale", () => {
    // 1 bps of a price whose bps lands beyond float precision. Going through
    // IEEE-754 here would produce a trailing-digit drift that the ledger then
    // rejects as a malformed Decimal.
    const p = dealerQuotePrice("0.0000000007", "RFQ_Buy", 10000);
    assert.match(p, /^\d+\.\d{10}$/);
    assert.equal(p, "0.0000000014");
  });

  it("returns mid exactly at a zero spread", () => {
    assert.equal(dealerQuotePrice(MID, "RFQ_Buy", 0), MID);
    assert.equal(dealerQuotePrice(MID, "RFQ_Sell", 0), MID);
  });
});

describe("dealerSpreadBps", () => {
  it("quotes a trusted dealer tighter than a whitelisted one", () => {
    assert.ok(dealerSpreadBps(0, true) < dealerSpreadBps(0, false));
  });

  it("is deterministic per dealer, so the book is stable across RFQs", () => {
    assert.equal(dealerSpreadBps(2, true), dealerSpreadBps(2, true));
    assert.notEqual(dealerSpreadBps(0, true), dealerSpreadBps(1, true));
  });
});

describe("rfqPairString", () => {
  it("builds the base/quote text Rfq_Accept splits into leg instruments", () => {
    assert.equal(rfqPairString("dBTC", "dUSD"), "dBTC/dUSD");
  });
});

describe("rfqSize", () => {
  it("accepts a well-formed positive decimal", () => {
    assert.equal(rfqSize("0.5000000000", isDecimalString), "0.5000000000");
  });

  it("refuses a non-decimal before parsing it", () => {
    // parseDecimal assumes a well-formed string; the shape check has to come
    // first or this throws something the route cannot map to a 400.
    for (const bad of [undefined, "", "abc", "1e5", "0x10", "1,5"]) {
      assert.throws(
        () => rfqSize(bad as string | undefined, isDecimalString),
        TestnetRfqRejectedError,
        `${String(bad)} must be refused`,
      );
    }
  });

  it("refuses zero and negative sizes", () => {
    for (const bad of ["0.0000000000", "-1.0000000000"]) {
      assert.throws(() => rfqSize(bad, isDecimalString), TestnetRfqRejectedError);
    }
  });
});

describe("rfqExpiry", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");

  it("defaults to an hour", () => {
    assert.equal(rfqExpiry(now, undefined), "2026-01-01T01:00:00.000Z");
  });

  it("clamps rather than rejecting, at both ends", () => {
    // A too-short expiry is the dangerous one: Rfq_Accept copies it onto the
    // MatchedTrade's settlementDeadline, and Allocation_Settle aborts once it
    // passes -- so an unclamped 1-minute RFQ fails inside the settle for a
    // reason that looks nothing like the expiry the caller chose.
    assert.equal(
      rfqExpiry(now, 1),
      new Date(now.getTime() + MIN_RFQ_MINUTES * 60_000).toISOString(),
    );
    assert.equal(
      rfqExpiry(now, 99_999),
      new Date(now.getTime() + MAX_RFQ_MINUTES * 60_000).toISOString(),
    );
  });

  it("floors a fractional request", () => {
    assert.equal(rfqExpiry(now, 30.9), "2026-01-01T00:30:00.000Z");
  });
});
