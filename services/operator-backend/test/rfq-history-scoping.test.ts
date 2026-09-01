// A terminal rfq_history row must carry the trader it belongs to.
//
// Non-admin callers can only read this table filtered by trader, so a row
// written with a null trader is unreachable and the party's own RFQ shows as
// open for ever.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb, type Db } from "../src/indexer/db.js";

const TRADER = "alice";
const RFQ = "rfq-1";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cdx-rfqh-"));
  db = openDb(join(dir, "t.db"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ins = (
  status: string,
  ts: number,
  trader: string | null,
  pair: string | null,
) =>
  db
    .prepare(
      `INSERT OR IGNORE INTO rfq_history
       (rfqId, ts, status, trader, pair, acceptedDealer, acceptedRank, policyVersion)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(RFQ, ts, status, trader, pair, status === "accepted" ? "dealer" : null,
      status === "accepted" ? 1 : null, status === "accepted" ? "v2.0" : null);

const scoped = () =>
  db
    .prepare("SELECT * FROM rfq_history WHERE trader = ? ORDER BY ts ASC")
    .all(TRADER) as Array<{ status: string }>;

describe("rfq_history under the trader filter", () => {
  it("the SELECT ... GROUP BY picks the open row's trader", () => {
    // The reconcile derives the terminal row's trader from this query; SQLite
    // takes bare columns from the MAX(ts) row, which for a still-open RFQ is
    // the open row.
    ins("open", 1, TRADER, "dBTC/dUSD");
    const seen = db
      .prepare(
        `SELECT rfqId, MAX(ts) as maxTs, status, trader, pair
         FROM rfq_history GROUP BY rfqId`,
      )
      .all() as Array<{ trader: string | null; pair: string | null; status: string }>;
    assert.equal(seen[0]!.trader, TRADER);
    assert.equal(seen[0]!.pair, "dBTC/dUSD");
    assert.equal(seen[0]!.status, "open");
  });

  it("a terminal row carrying the trader is reachable", () => {
    ins("open", 1, TRADER, "dBTC/dUSD");
    ins("accepted", 2, TRADER, "dBTC/dUSD");
    assert.deepEqual(scoped().map((r) => r.status), ["open", "accepted"]);
  });

  it("a terminal row with a null trader is invisible to its own party", () => {
    // The defect, pinned: the row exists but the only query a non-admin may
    // run cannot see it.
    ins("open", 1, TRADER, "dBTC/dUSD");
    ins("accepted", 2, null, null);
    assert.deepEqual(
      scoped().map((r) => r.status),
      ["open"],
      "a null-trader terminal row must not be how this is written",
    );
    const all = db.prepare("SELECT COUNT(*) c FROM rfq_history").get() as { c: number };
    assert.equal(all.c, 2, "the row is there, just unreachable");
  });
});

describe("v8 backfill", () => {
  it("recovers the trader on rows written without one", () => {
    // Seed the schema state the v8 migration accepts: the open row has the
    // trader and the terminal row must inherit it.
    const p = join(dir, "old.db");
    const seed = openDb(p);
    const put = (ts: number, status: string, trader: string | null) =>
      seed
        .prepare(
          `INSERT INTO rfq_history
           (rfqId, ts, status, trader, pair, acceptedDealer, acceptedRank, policyVersion)
           VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)`,
        )
        .run(RFQ, ts, status, trader, trader ? "dBTC/dUSD" : null);
    put(1, "open", TRADER);
    put(2, "accepted", null);
    // Rewind to 0 and let every step replay, rather than to `length - 1`, which
    // silently retargets away from the v8 backfill whenever a later migration
    // is appended.
    seed.exec("PRAGMA user_version = 0");
    seed.close();

    const db2 = openDb(p);
    const rows = db2
      .prepare("SELECT status, trader, pair FROM rfq_history WHERE trader = ? ORDER BY ts")
      .all(TRADER) as Array<{ status: string; pair: string | null }>;
    assert.deepEqual(rows.map((r) => r.status), ["open", "accepted"]);
    assert.equal(rows[1]!.pair, "dBTC/dUSD");
  });
});
