import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveTradeParties } from "../src/indexer/trade-parties.js";

test("current tradeLegs shape with a receipt names the dealer and the other trader", () => {
  const payload = {
    tradeLegs: [
      { admin: "regA", leg: { sender: { owner: "alice" }, receiver: { owner: "dealer1" } } },
      { admin: "regB", leg: { sender: { owner: "dealer1" }, receiver: { owner: "alice" } } },
    ],
    policyReceipt: { acceptedDealer: "dealer1" },
  };
  assert.deepEqual(deriveTradeParties(payload), {
    trader: "alice",
    dealer: "dealer1",
    counterparty: "dealer1",
  });
});

test("order fill without a receipt reads the trader off the first sender", () => {
  const payload = {
    tradeLegs: [{ admin: "regA", leg: { sender: { owner: "buyer" }, receiver: { owner: "seller" } } }],
  };
  assert.deepEqual(deriveTradeParties(payload), {
    trader: "buyer",
    dealer: null,
    counterparty: "seller",
  });
});

test("legacy flat transferLegs payload derives the same parties", () => {
  const payload = {
    transferLegs: [{ sender: { owner: "buyer" }, receiver: { owner: "seller" } }],
  };
  assert.deepEqual(deriveTradeParties(payload), {
    trader: "buyer",
    dealer: null,
    counterparty: "seller",
  });
});

test("a null / non-object payload yields no parties, never a throw", () => {
  const empty = { trader: null, dealer: null, counterparty: null };
  assert.deepEqual(deriveTradeParties(null), empty);
  assert.deepEqual(deriveTradeParties(undefined), empty);
  assert.deepEqual(deriveTradeParties("not-json"), empty);
  assert.deepEqual(deriveTradeParties(42), empty);
});

test("null and shapeless leg entries yield no parties, never a throw or null overwrite", () => {
  const empty = { trader: null, dealer: null, counterparty: null };
  assert.deepEqual(deriveTradeParties({ tradeLegs: [null] }), empty);
  assert.deepEqual(deriveTradeParties({ tradeLegs: [{}] }), empty);
  assert.deepEqual(deriveTradeParties({ tradeLegs: [] }), empty);
  assert.deepEqual(deriveTradeParties({ transferLegs: [null] }), empty);
});

test("non-string owners and acceptedDealer collapse to null, never an object", () => {
  const empty = { trader: null, dealer: null, counterparty: null };
  // A nested object where a party string is expected must not leak through as an
  // object (it would later fail to bind to SQLite).
  assert.deepEqual(
    deriveTradeParties({
      tradeLegs: [{ admin: "regA", leg: { sender: { owner: { bad: true } }, receiver: { owner: 7 } } }],
    }),
    empty,
  );
  // An object acceptedDealer is dropped; the string leg owners still resolve.
  assert.deepEqual(
    deriveTradeParties({
      tradeLegs: [{ admin: "regA", leg: { sender: { owner: "buyer" }, receiver: { owner: "seller" } } }],
      policyReceipt: { acceptedDealer: { name: "dealer1" } },
    }),
    { trader: "buyer", dealer: null, counterparty: "seller" },
  );
  // An empty-string owner is not a valid party.
  assert.deepEqual(
    deriveTradeParties({ tradeLegs: [{ admin: "regA", leg: { sender: { owner: "" }, receiver: { owner: "" } } }] }),
    empty,
  );
});

test("a non-array leg field yields no parties, never a throw", () => {
  const empty = { trader: null, dealer: null, counterparty: null };
  assert.deepEqual(deriveTradeParties({ tradeLegs: "bad" }), empty);
  assert.deepEqual(deriveTradeParties({ tradeLegs: 42 }), empty);
  assert.deepEqual(deriveTradeParties({ tradeLegs: { bad: true } }), empty);
  assert.deepEqual(deriveTradeParties({ transferLegs: { bad: true } }), empty);
  assert.deepEqual(deriveTradeParties({ transferLegs: "bad" }), empty);
  // A non-array tradeLegs falls through to a valid legacy transferLegs.
  assert.deepEqual(
    deriveTradeParties({
      tradeLegs: "bad",
      transferLegs: [{ sender: { owner: "buyer" }, receiver: { owner: "seller" } }],
    }),
    { trader: "buyer", dealer: null, counterparty: "seller" },
  );
});
