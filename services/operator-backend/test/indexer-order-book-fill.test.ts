// An order-book fill must reach /v1/trades.
//
// The fill settles inside OrderMatchExecution_Execute, whose own consuming
// choice archives the execution contract in the same transaction, so nothing
// about the match enters the ACS on its own. The indexer only ever reads the
// ACS, and /v1/trades returns 200 either way — so a lost fill is invisible.
// SettledTrade is the durable record the choice leaves behind for it.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb, type Db } from "../src/indexer/db.js";
import { Indexer } from "../src/indexer/index.js";
import { OrderService } from "../src/order/index.js";
import { MatchingLedger } from "./matching-ledger.js";
import type { Order } from "../src/types.js";
import { StubRegistry } from "./stub-registry.js";

const OPERATOR = "operator::1220ab";
const BUYER = "alice::1220ab";
const SELLER = "bob::1220ab";

function mkOrder(
  contractId: string,
  trader: string,
  side: "Bid" | "Ask",
  limitPrice: string,
  allocationCid: string,
  createdAt: string,
): Order {
  return {
    contractId,
    operator: OPERATOR,
    trader,
    baseInstrumentId: { admin: "admin::1220ab", id: "dBTC" },
    quoteInstrumentId: { admin: "admin::1220ab", id: "dUSD" },
    side,
    limitPrice,
    remainingQty: "0.5",
    expiry: null,
    status: "Funded",
    // Single-admin pair: one allocation keyed by the shared admin.
    allocationCidsByAdmin: [["admin::1220ab", allocationCid]],
    settlementRef: { id: "DexOrder", cid: null },
    ledgerCreatedAt: createdAt,
  } as unknown as Order;
}

describe("indexer: a settled order-book fill", () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cdx-obfill-"));
    db = openDb(join(dir, "t.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const settleOneMatch = async (): Promise<MatchingLedger> => {
    const ledger = new MatchingLedger([
      mkOrder("#ask:1", SELLER, "Ask", "40000", "#alloc:ask", "2026-01-01T10:00:00Z"),
      mkOrder("#bid:1", BUYER, "Bid", "40000", "#alloc:bid", "2026-01-01T11:00:00Z"),
    ]);
    const svc = new OrderService(ledger, new StubRegistry(), OPERATOR as never);
    const results = await svc.runMatching({
      baseInstrumentId: { admin: "admin::1220ab" as never, id: "dBTC" },
      quoteInstrumentId: { admin: "admin::1220ab" as never, id: "dUSD" },
      admin: "admin::1220ab" as never,
    });
    assert.equal(results[0]!.error, undefined);
    return ledger;
  };

  const reconcile = async (ledger: MatchingLedger): Promise<void> => {
    const ix = new Indexer(db, ledger, {
      intervalMs: 60_000,
      observingParty: OPERATOR as never,
    });
    await (ix as unknown as { reconcileTrades(ts: number): Promise<void> })
      .reconcileTrades(1);
  };

  it("becomes a trades row the /v1/trades query can serve", async () => {
    await reconcile(await settleOneMatch());

    const rows = db
      .prepare("SELECT tradeCid, pair, trader, dealer, counterparty FROM trades")
      .all() as Array<{
        tradeCid: string;
        pair: string;
        trader: string | null;
        dealer: string | null;
        counterparty: string | null;
      }>;
    assert.equal(rows.length, 1, "the settled fill produced no trade history");
    assert.equal(rows[0]!.pair, "dBTC/dUSD");
    // Both sides are traders here; `dealer` is a role only a signed policy
    // receipt establishes, and an order-book fill carries none. /v1/trades
    // filters on either column, so both parties can find the fill.
    assert.equal(rows[0]!.dealer, null);
    assert.deepEqual(
      [rows[0]!.trader, rows[0]!.counterparty].sort(),
      [BUYER, SELLER].sort(),
    );
  });

  it("carries the settled amounts in the row payload", async () => {
    const ledger = await settleOneMatch();
    await reconcile(ledger);

    const { payload } = db.prepare("SELECT payload FROM trades").get() as {
      payload: string;
    };
    const legs = (JSON.parse(payload) as {
      tradeLegs: Array<{ leg: { instrumentId: string; amount: string } }>;
    }).tradeLegs.map((tl) => tl.leg);
    assert.deepEqual(
      legs.map((l) => [l.instrumentId, l.amount]),
      [
        ["dBTC", "0.5000000000"],
        ["dUSD", "20000.0000000000"],
      ],
    );
  });

  it("records the event against the template the fill actually wrote", async () => {
    await reconcile(await settleOneMatch());

    const row = db
      .prepare("SELECT kind, templateId FROM events WHERE kind = 'matched_trade'")
      .get() as { kind: string; templateId: string };
    assert.equal(row.templateId, "CantonDex.Dex.MatchedTrade:SettledTrade");
  });

  it("does not re-insert the fill on a later tick", async () => {
    const ledger = await settleOneMatch();
    await reconcile(ledger);
    await reconcile(ledger);

    const { n } = db.prepare("SELECT COUNT(*) AS n FROM trades").get() as {
      n: number;
    };
    assert.equal(n, 1);
  });
});
