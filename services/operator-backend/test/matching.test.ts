import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { aggregateBook, matchOrdersForPair } from "../src/order/matching.js";
import type { InstrumentId, Order } from "../src/types.js";

const BTC: InstrumentId = { admin: "admin", id: "BTC" };
const USDC: InstrumentId = { admin: "admin", id: "USDC" };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mkOrder(o: Record<string, any>): Order {
  return {
    contractId: o.contractId,
    operator: "op",
    trader: o.trader ?? (o.side === "Bid" ? "buyer" : "seller"),
    baseInstrumentId: o.baseInstrumentId ?? BTC,
    quoteInstrumentId: o.quoteInstrumentId ?? USDC,
    side: o.side,
    limitPrice: o.limitPrice,
    remainingQty: o.remainingQty,
    expiry: o.expiry ?? null,
    status: o.status ?? "Funded",
    allocationCid: null,
    settlementRef: { kind: "test", value: "ref-1" },
    ledgerCreatedAt: o.ledgerCreatedAt ?? null,
  } as unknown as Order;
}

const NOW = new Date("2026-01-01T12:00:00Z");

describe("matchOrdersForPair", () => {
  it("returns no matches when prices don't cross", () => {
    const orders = [
      mkOrder({ contractId: "b1", side: "Bid", limitPrice: "100", remainingQty: "1" }),
      mkOrder({ contractId: "a1", side: "Ask", limitPrice: "110", remainingQty: "1" }),
    ];
    const matches = matchOrdersForPair(orders, { base: BTC, quote: USDC });
    assert.equal(matches.length, 0);
  });

  it("does not match a party against its own crossing order", () => {
    // A self-cross can never settle -- the transfer leg's sender and receiver
    // would be the same party -- so the matcher must not propose it.
    const orders = [
      mkOrder({ contractId: "a1", trader: "alice", side: "Ask", limitPrice: "100", remainingQty: "1" }),
      mkOrder({ contractId: "b1", trader: "alice", side: "Bid", limitPrice: "110", remainingQty: "1" }),
    ];
    const matches = matchOrdersForPair(orders, { base: BTC, quote: USDC });
    assert.equal(matches.length, 0);
  });

  it("matches a bid against a different maker's ask, skipping its own", () => {
    const orders = [
      mkOrder({ contractId: "a-self", trader: "alice", side: "Ask", limitPrice: "100", remainingQty: "1", ledgerCreatedAt: "2026-01-01T10:00:00Z" }),
      mkOrder({ contractId: "a-bob", trader: "bob", side: "Ask", limitPrice: "105", remainingQty: "1", ledgerCreatedAt: "2026-01-01T10:30:00Z" }),
      mkOrder({ contractId: "b1", trader: "alice", side: "Bid", limitPrice: "110", remainingQty: "1", ledgerCreatedAt: "2026-01-01T11:00:00Z" }),
    ];
    const matches = matchOrdersForPair(orders, { base: BTC, quote: USDC }, NOW);
    assert.equal(matches.length, 1);
    assert.equal(matches[0]!.buy.contractId, "b1");
    assert.equal(matches[0]!.sell.contractId, "a-bob");
  });

  it("crosses a simple full match at the older order's limit", () => {
    const orders = [
      mkOrder({
        contractId: "a1",
        side: "Ask",
        limitPrice: "100",
        remainingQty: "1",
        ledgerCreatedAt: "2026-01-01T10:00:00Z",
      }),
      mkOrder({
        contractId: "b1",
        side: "Bid",
        limitPrice: "110",
        remainingQty: "1",
        ledgerCreatedAt: "2026-01-01T11:00:00Z",
      }),
    ];
    const matches = matchOrdersForPair(orders, { base: BTC, quote: USDC }, NOW);
    assert.equal(matches.length, 1);
    assert.equal(matches[0]!.quantity, "1.0000000000");
    assert.equal(matches[0]!.price, "100");
  });

  it("clears at the resting side's limit regardless of contract id order", () => {
    // The older order is the lex-LARGER cid, so a cid-keyed rule picks the
    // other side's limit.
    const older = {
      contractId: "zzz",
      side: "Bid",
      limitPrice: "110",
      remainingQty: "1",
      ledgerCreatedAt: "2026-01-01T10:00:00Z",
    };
    const newer = {
      contractId: "aaa",
      side: "Ask",
      limitPrice: "100",
      remainingQty: "1",
      ledgerCreatedAt: "2026-01-01T11:00:00Z",
    };
    const matches = matchOrdersForPair(
      [mkOrder(older), mkOrder(newer)],
      { base: BTC, quote: USDC },
      NOW,
    );
    assert.equal(matches.length, 1);
    assert.equal(matches[0]!.price, "110");
  });

  it("clears at the same price when the contract ids are swapped", () => {
    const price = (bidCid: string, askCid: string): string => {
      const matches = matchOrdersForPair(
        [
          mkOrder({
            contractId: bidCid,
            side: "Bid",
            limitPrice: "110",
            remainingQty: "1",
            ledgerCreatedAt: "2026-01-01T10:00:00Z",
          }),
          mkOrder({
            contractId: askCid,
            side: "Ask",
            limitPrice: "100",
            remainingQty: "1",
            ledgerCreatedAt: "2026-01-01T11:00:00Z",
          }),
        ],
        { base: BTC, quote: USDC },
        NOW,
      );
      return matches[0]!.price;
    };
    assert.equal(price("aaa", "zzz"), price("zzz", "aaa"));
  });

  it("splits the spread when both sides were created at the same instant", () => {
    const at = "2026-01-01T10:00:00Z";
    const matches = matchOrdersForPair(
      [
        mkOrder({
          contractId: "a1",
          side: "Ask",
          limitPrice: "100",
          remainingQty: "1",
          ledgerCreatedAt: at,
        }),
        mkOrder({
          contractId: "b1",
          side: "Bid",
          limitPrice: "110",
          remainingQty: "1",
          ledgerCreatedAt: at,
        }),
      ],
      { base: BTC, quote: USDC },
      NOW,
    );
    assert.equal(matches[0]!.price, "105.0000000000");
  });

  it("fills the older of two equally priced asks first", () => {
    // The older ask is the lex-larger cid, so cid order alone would reverse it.
    const orders = [
      mkOrder({
        contractId: "zz",
        side: "Ask",
        limitPrice: "100",
        remainingQty: "1",
        ledgerCreatedAt: "2026-01-01T09:00:00Z",
      }),
      mkOrder({
        contractId: "aa",
        side: "Ask",
        limitPrice: "100",
        remainingQty: "1",
        ledgerCreatedAt: "2026-01-01T10:00:00Z",
      }),
      mkOrder({
        contractId: "b1",
        side: "Bid",
        limitPrice: "110",
        remainingQty: "2",
        ledgerCreatedAt: "2026-01-01T11:00:00Z",
      }),
    ];
    const matches = matchOrdersForPair(orders, { base: BTC, quote: USDC }, NOW);
    assert.deepEqual(
      matches.map((m) => m.sell.contractId),
      ["zz", "aa"],
    );
  });

  it("supports partial fill where one side is bigger", () => {
    const orders = [
      mkOrder({ contractId: "a1", side: "Ask", limitPrice: "100", remainingQty: "0.5" }),
      mkOrder({ contractId: "b1", side: "Bid", limitPrice: "110", remainingQty: "2" }),
    ];
    const matches = matchOrdersForPair(orders, { base: BTC, quote: USDC }, NOW);
    assert.equal(matches.length, 1);
    assert.equal(matches[0]!.quantity, "0.5000000000");
  });

  it("does not match an order past its expiry", () => {
    const orders = [
      mkOrder({
        contractId: "a1",
        side: "Ask",
        limitPrice: "100",
        remainingQty: "1",
        expiry: "2026-01-01T11:00:00Z",
      }),
      mkOrder({ contractId: "b1", side: "Bid", limitPrice: "110", remainingQty: "1" }),
    ];
    assert.equal(
      matchOrdersForPair(orders, { base: BTC, quote: USDC }, NOW).length,
      0,
    );
  });

  it("still matches an order whose expiry is in the future", () => {
    const orders = [
      mkOrder({
        contractId: "a1",
        side: "Ask",
        limitPrice: "100",
        remainingQty: "1",
        expiry: "2026-01-01T13:00:00Z",
      }),
      mkOrder({ contractId: "b1", side: "Bid", limitPrice: "110", remainingQty: "1" }),
    ];
    assert.equal(
      matchOrdersForPair(orders, { base: BTC, quote: USDC }, NOW).length,
      1,
    );
  });

  it("chains matches across multiple orders by price-time priority", () => {
    const orders = [
      mkOrder({ contractId: "a1", side: "Ask", limitPrice: "100", remainingQty: "1" }),
      mkOrder({ contractId: "a2", side: "Ask", limitPrice: "101", remainingQty: "1" }),
      mkOrder({ contractId: "b1", side: "Bid", limitPrice: "110", remainingQty: "3" }),
    ];
    const matches = matchOrdersForPair(orders, { base: BTC, quote: USDC });
    assert.equal(matches.length, 2);
    assert.deepEqual(
      matches.map((m) => m.sell.contractId),
      ["a1", "a2"],
    );
  });

  it("skips pending (un-funded) orders", () => {
    const orders = [
      mkOrder({
        contractId: "a1",
        side: "Ask",
        limitPrice: "100",
        remainingQty: "1",
        status: "Pending",
      }),
      mkOrder({ contractId: "b1", side: "Bid", limitPrice: "110", remainingQty: "1" }),
    ];
    const matches = matchOrdersForPair(orders, { base: BTC, quote: USDC });
    assert.equal(matches.length, 0);
  });

  it("does not cross two instruments that share a text id under different admins", () => {
    // Same symbols, different registries: USDC@a is a distinct instrument from
    // USDC@b. A crossing bid/ask on the `@a` book must not fill against `@b`
    // orders, or funds would move between unrelated registries.
    const BTC_A: InstrumentId = { admin: "reg-a", id: "BTC" };
    const USDC_A: InstrumentId = { admin: "reg-a", id: "USDC" };
    const USDC_B: InstrumentId = { admin: "reg-b", id: "USDC" };
    const orders = [
      mkOrder({
        contractId: "ask-b",
        trader: "seller",
        side: "Ask",
        limitPrice: "100",
        remainingQty: "1",
        baseInstrumentId: BTC_A,
        quoteInstrumentId: USDC_B,
      }),
      mkOrder({
        contractId: "bid-a",
        trader: "buyer",
        side: "Bid",
        limitPrice: "110",
        remainingQty: "1",
        baseInstrumentId: BTC_A,
        quoteInstrumentId: USDC_A,
      }),
    ];
    // The prices cross, but the quote instruments differ by admin only.
    assert.equal(
      matchOrdersForPair(orders, { base: BTC_A, quote: USDC_A }).length,
      0,
    );
    assert.equal(
      matchOrdersForPair(orders, { base: BTC_A, quote: USDC_B }).length,
      0,
    );
  });
});

describe("aggregateBook", () => {
  it("groups by price and counts orders", () => {
    const orders = [
      mkOrder({ contractId: "b1", side: "Bid", limitPrice: "100", remainingQty: "1" }),
      mkOrder({ contractId: "b2", side: "Bid", limitPrice: "100", remainingQty: "2" }),
      mkOrder({ contractId: "a1", side: "Ask", limitPrice: "110", remainingQty: "1.5" }),
    ];
    const book = aggregateBook(orders, NOW);
    assert.equal(book.bids.length, 1);
    // Ledger scale, not the float form: price is served at 10dp and size must
    // match it.
    assert.equal(book.bids[0]!.size, "3.0000000000");
    assert.equal(book.bids[0]!.count, 2);
    assert.equal(book.asks.length, 1);
    assert.equal(book.asks[0]!.price, "110");
  });

  it("drops expired orders from the depth ladder", () => {
    const orders = [
      mkOrder({ contractId: "b1", side: "Bid", limitPrice: "100", remainingQty: "1" }),
      mkOrder({
        contractId: "b2",
        side: "Bid",
        limitPrice: "100",
        remainingQty: "2",
        expiry: "2026-01-01T11:00:00Z",
      }),
    ];
    const book = aggregateBook(orders, NOW);
    assert.equal(book.bids[0]!.size, "1.0000000000");
    assert.equal(book.bids[0]!.count, 1);
  });
});
