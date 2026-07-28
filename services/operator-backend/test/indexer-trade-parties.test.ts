// Which side of a matched trade is the trader.
//
// Both fields used to be read off legs[0], but legs[0] is the base leg and its
// sender flips with the side: on a sell the trader sends base, on a buy the
// dealer does. Every buy was therefore labelled backwards — silently, so a
// client reconciling on `trader == me` simply missed all of its buys.
//
// The policy receipt names the accepted dealer outright and is signed by the
// venue, so it is the authority here, not leg direction.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb, type Db } from "../src/indexer/db.js";
import { Indexer } from "../src/indexer/index.js";
import type {
  LedgerEvent,
  LedgerSubmitter,
  SubmitRequest,
  SubscriptionFilter,
} from "../src/ledger/index.js";

const TRADER = "alice::1220ab";
const DEALER = "northwind::1220ab";
const VENUE = "operator::1220ab";

/** One MatchedTrade whose base leg runs in whichever direction the test sets. */
function ledgerWith(baseSender: string, baseReceiver: string, withReceipt = true) {
  const trade = {
    contractId: "#trade:0",
    venue: VENUE,
    admin: "admin::1220ab",
    transferLegs: [
      { transferLegId: "base", sender: { owner: baseSender },
        receiver: { owner: baseReceiver }, amount: "0.001", instrumentId: "dBTC" },
      { transferLegId: "quote", sender: { owner: baseReceiver },
        receiver: { owner: baseSender }, amount: "89.17", instrumentId: "dUSD" },
    ],
    settlementDeadline: null,
    policyReceipt: withReceipt
      ? {
          policyVersion: "v2.0", rfqId: "rfq-1", rankedDealers: [],
          acceptedDealer: DEALER, acceptedRank: 1, consideredCount: 2,
          signedBy: VENUE, signedAt: "2026-07-27T12:00:00Z",
        }
      : null,
  };
  return {
    async query<T>(f: SubscriptionFilter): Promise<T[]> {
      return (f.templateId === "CantonDex.Dex.MatchedTrade:MatchedTrade"
        ? [trade]
        : []) as unknown as T[];
    },
    async submit<R>(_r: SubmitRequest): Promise<R> {
      throw new Error("the indexer must not submit");
    },
    async *subscribe<T>(_f: SubscriptionFilter): AsyncIterable<LedgerEvent<T>> {},
  } as unknown as LedgerSubmitter;
}

describe("indexer: labelling the sides of a matched trade", () => {
  let dir: string;
  let db: Db;

  const run = async (ledger: LedgerSubmitter) => {
    const ix = new Indexer(db, ledger, { intervalMs: 60_000, observingParty: VENUE });
    await (ix as unknown as { reconcileTrades(ts: number): Promise<void> })
      .reconcileTrades(1);
    return db.prepare("SELECT trader, dealer, counterparty FROM trades").get() as
      { trader: string | null; dealer: string | null; counterparty: string | null };
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cdx-trades-"));
    db = openDb(join(dir, "t.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("labels a SELL correctly (trader sends the base leg)", async () => {
    const row = await run(ledgerWith(TRADER, DEALER));
    assert.equal(row.trader, TRADER);
    assert.equal(row.dealer, DEALER);
  });

  it("labels a BUY correctly — the case that used to invert", async () => {
    // Base leg runs dealer -> trader. Reading legs[0].sender as the trader
    // would name the DEALER as the trader here.
    const row = await run(ledgerWith(DEALER, TRADER));
    assert.equal(row.trader, TRADER, "the trader must not flip with the side");
    assert.equal(row.dealer, DEALER);
  });

  it("leaves the dealer unset when there is no receipt to name one", async () => {
    // A non-RFQ matched trade has no dealer role; asserting one from leg
    // direction is what produced the inversion in the first place.
    const row = await run(ledgerWith(TRADER, DEALER, false));
    assert.equal(row.dealer, null);
  });

  it("still records the counterparty when there is no receipt", async () => {
    // `dealer` is a role and a null is correct here -- but the other side of
    // the trade must not vanish with it. /v1/trades does not serve the raw
    // payload, so without this column an order-book fill's counterparty is
    // unrecoverable from the API.
    const row = await run(ledgerWith(TRADER, DEALER, false));
    assert.equal(row.trader, TRADER);
    assert.equal(row.counterparty, DEALER);
  });

  it("records the counterparty on a receipt-bearing trade too", async () => {
    const row = await run(ledgerWith(TRADER, DEALER, true));
    assert.equal(row.dealer, DEALER);
    assert.equal(row.counterparty, DEALER);
  });
});
