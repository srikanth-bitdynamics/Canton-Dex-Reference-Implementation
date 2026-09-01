import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import { reindexTradeParties } from "../src/indexer/reindex-trade-parties.js";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE trades (
    tradeCid TEXT PRIMARY KEY,
    trader TEXT,
    dealer TEXT,
    counterparty TEXT,
    payload TEXT NOT NULL
  );`);
  return db;
}

type Row = { trader: string | null; dealer: string | null; counterparty: string | null };

test("reindexTradeParties updates valid rows and never overwrites malformed ones", () => {
  const db = makeDb();
  const insert = db.prepare(
    "INSERT INTO trades (tradeCid, trader, dealer, counterparty, payload) VALUES (?,?,?,?,?)",
  );
  // Valid RFQ trade, stored parties null → derived and filled.
  insert.run(
    "t-valid",
    null,
    null,
    null,
    JSON.stringify({
      tradeLegs: [
        { admin: "regA", leg: { sender: { owner: "alice" }, receiver: { owner: "dealer1" } } },
      ],
      policyReceipt: { acceptedDealer: "dealer1" },
    }),
  );
  // Legacy flat transferLegs → derived and filled.
  insert.run(
    "t-legacy",
    null,
    null,
    null,
    JSON.stringify({ transferLegs: [{ sender: { owner: "b2" }, receiver: { owner: "s2" } }] }),
  );
  // Already correct → left as-is.
  insert.run(
    "t-ok",
    "buyer",
    null,
    "seller",
    JSON.stringify({
      tradeLegs: [{ admin: "regA", leg: { sender: { owner: "buyer" }, receiver: { owner: "seller" } } }],
    }),
  );
  // Non-array leg field → no parties → existing values preserved (was a crash).
  insert.run("t-bad-field", "keep-trader", "keep-dealer", "keep-cp", JSON.stringify({ tradeLegs: "bad" }));
  // Shapeless legs → no parties → preserved.
  insert.run("t-empty", "keep2", null, "keep3", JSON.stringify({ tradeLegs: [{}] }));
  // Non-JSON payload → skipped, preserved.
  insert.run("t-nonjson", "keepA", null, "keepB", "not-json");

  const res = reindexTradeParties(db, false);
  assert.equal(res.checked, 6);
  assert.equal(res.fixed, 2);

  const get = (cid: string) =>
    db.prepare("SELECT trader, dealer, counterparty FROM trades WHERE tradeCid = ?").get(cid) as Row;
  assert.deepEqual(get("t-valid"), { trader: "alice", dealer: "dealer1", counterparty: "dealer1" });
  assert.deepEqual(get("t-legacy"), { trader: "b2", dealer: null, counterparty: "s2" });
  assert.deepEqual(get("t-ok"), { trader: "buyer", dealer: null, counterparty: "seller" });
  assert.deepEqual(get("t-bad-field"), { trader: "keep-trader", dealer: "keep-dealer", counterparty: "keep-cp" });
  assert.deepEqual(get("t-empty"), { trader: "keep2", dealer: null, counterparty: "keep3" });
  assert.deepEqual(get("t-nonjson"), { trader: "keepA", dealer: null, counterparty: "keepB" });
});

test("nested-object owners never reach the SQLite binding as objects", () => {
  const db = makeDb();
  const insert = db.prepare(
    "INSERT INTO trades (tradeCid, trader, dealer, counterparty, payload) VALUES (?,?,?,?,?)",
  );
  // Object owners: no valid parties → existing values preserved, no bind throw.
  insert.run(
    "t-nested",
    "keepT",
    null,
    "keepC",
    JSON.stringify({ tradeLegs: [{ admin: "regA", leg: { sender: { owner: { p: "alice" } }, receiver: { owner: 9 } } }] }),
  );
  // Object acceptedDealer with valid string legs: dealer drops, legs still fill.
  insert.run(
    "t-obj-dealer",
    null,
    null,
    null,
    JSON.stringify({
      tradeLegs: [{ admin: "regA", leg: { sender: { owner: "alice" }, receiver: { owner: "bob" } } }],
      policyReceipt: { acceptedDealer: { name: "dealer1" } },
    }),
  );
  assert.doesNotThrow(() => reindexTradeParties(db, false));
  const get = (cid: string) =>
    db.prepare("SELECT trader, dealer, counterparty FROM trades WHERE tradeCid = ?").get(cid) as Row;
  assert.deepEqual(get("t-nested"), { trader: "keepT", dealer: null, counterparty: "keepC" });
  assert.deepEqual(get("t-obj-dealer"), { trader: "alice", dealer: null, counterparty: "bob" });
});

test("reindexTradeParties is idempotent — a second run fixes nothing", () => {
  const db = makeDb();
  db.prepare(
    "INSERT INTO trades (tradeCid, trader, dealer, counterparty, payload) VALUES (?,?,?,?,?)",
  ).run(
    "t1",
    null,
    null,
    null,
    JSON.stringify({
      tradeLegs: [{ admin: "regA", leg: { sender: { owner: "alice" }, receiver: { owner: "dealer1" } } }],
      policyReceipt: { acceptedDealer: "dealer1" },
    }),
  );
  const first = reindexTradeParties(db, false);
  assert.equal(first.fixed, 1);
  const second = reindexTradeParties(db, false);
  assert.equal(second.checked, 1);
  assert.equal(second.fixed, 0);
});

test("reindexTradeParties dry-run reports changes without writing", () => {
  const db = makeDb();
  db.prepare(
    "INSERT INTO trades (tradeCid, trader, dealer, counterparty, payload) VALUES (?,?,?,?,?)",
  ).run(
    "t1",
    null,
    null,
    null,
    JSON.stringify({ tradeLegs: [{ leg: { sender: { owner: "x" }, receiver: { owner: "y" } } }] }),
  );
  const res = reindexTradeParties(db, true);
  assert.equal(res.fixed, 1);
  const row = db.prepare("SELECT trader FROM trades WHERE tradeCid = 't1'").get() as { trader: string | null };
  assert.equal(row.trader, null);
});
