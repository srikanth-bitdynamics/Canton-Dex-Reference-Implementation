import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { aggregateBook, matchOrdersForPair } from "../src/order/matching.js";
import type { Order } from "../src/types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mkOrder(o: Record<string, any>): Order {
  return {
    contractId: o.contractId,
    operator: "op",
    trader: o.trader ?? "alice",
    admin: "admin",
    baseInstrumentId: o.baseInstrumentId ?? "BTC",
    quoteInstrumentId: o.quoteInstrumentId ?? "USDC",
    side: o.side,
    limitPrice: o.limitPrice,
    remainingQty: o.remainingQty,
    expiry: null,
    status: o.status ?? "Funded",
    allocationCid: null,
    settlementRef: { kind: "test", value: "ref-1" },
  } as unknown as Order;
}

describe("matchOrdersForPair", () => {
  it("returns no matches when prices don't cross", () => {
    const orders = [
      mkOrder({ contractId: "b1", side: "Bid", limitPrice: "100", remainingQty: "1" }),
      mkOrder({ contractId: "a1", side: "Ask", limitPrice: "110", remainingQty: "1" }),
    ];
    const matches = matchOrdersForPair(orders, { base: "BTC", quote: "USDC" });
    assert.equal(matches.length, 0);
  });

  it("crosses a simple full match at the resting price", () => {
    const orders = [
      mkOrder({ contractId: "a1", side: "Ask", limitPrice: "100", remainingQty: "1" }),
      mkOrder({ contractId: "b1", side: "Bid", limitPrice: "110", remainingQty: "1" }),
    ];
    const matches = matchOrdersForPair(orders, { base: "BTC", quote: "USDC" });
    assert.equal(matches.length, 1);
    assert.equal(matches[0]!.quantity, "1");
    // Resting order is the lex-smaller cid (a1).
    assert.equal(matches[0]!.price, "100");
  });

  it("supports partial fill where one side is bigger", () => {
    const orders = [
      mkOrder({ contractId: "a1", side: "Ask", limitPrice: "100", remainingQty: "0.5" }),
      mkOrder({ contractId: "b1", side: "Bid", limitPrice: "110", remainingQty: "2" }),
    ];
    const matches = matchOrdersForPair(orders, { base: "BTC", quote: "USDC" });
    assert.equal(matches.length, 1);
    assert.equal(matches[0]!.quantity, "0.5");
  });

  it("chains matches across multiple orders by price-time priority", () => {
    const orders = [
      mkOrder({ contractId: "a1", side: "Ask", limitPrice: "100", remainingQty: "1" }),
      mkOrder({ contractId: "a2", side: "Ask", limitPrice: "101", remainingQty: "1" }),
      mkOrder({ contractId: "b1", side: "Bid", limitPrice: "110", remainingQty: "3" }),
    ];
    const matches = matchOrdersForPair(orders, { base: "BTC", quote: "USDC" });
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
    const matches = matchOrdersForPair(orders, { base: "BTC", quote: "USDC" });
    assert.equal(matches.length, 0);
  });
});

describe("aggregateBook", () => {
  it("groups by price and counts orders", () => {
    const orders = [
      mkOrder({ contractId: "b1", side: "Bid", limitPrice: "100", remainingQty: "1" }),
      mkOrder({ contractId: "b2", side: "Bid", limitPrice: "100", remainingQty: "2" }),
      mkOrder({ contractId: "a1", side: "Ask", limitPrice: "110", remainingQty: "1.5" }),
    ];
    const book = aggregateBook(orders);
    assert.equal(book.bids.length, 1);
    assert.equal(book.bids[0]!.size, "3");
    assert.equal(book.bids[0]!.count, 2);
    assert.equal(book.asks.length, 1);
    assert.equal(book.asks[0]!.price, "110");
  });
});
