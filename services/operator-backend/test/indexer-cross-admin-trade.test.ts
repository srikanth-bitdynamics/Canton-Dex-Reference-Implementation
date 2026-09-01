// A cross-admin MatchedTrade must be indexed from its `tradeLegs`.
//
// The trade templates carry admin-tagged legs (`tradeLegs : [{ admin, leg }]`),
// not a flat `transferLegs` list with a single top-level admin. The indexer must
// read the pair label off each leg's instrument id and the parties off each
// leg's sender/receiver accounts — including when the two legs are administered
// by different registries.

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
const BTC_ADMIN = "btc-registry::1220ab";
const USD_ADMIN = "usd-registry::1220ab";

// One MatchedTrade whose base and quote legs are administered by two different
// registries. The base leg runs trader -> dealer, the quote leg dealer -> trader.
function crossAdminLedger(): LedgerSubmitter {
  const trade = {
    contractId: "#trade:x",
    venue: VENUE,
    tradeLegs: [
      {
        admin: BTC_ADMIN,
        leg: {
          transferLegId: "base",
          sender: { owner: TRADER },
          receiver: { owner: DEALER },
          amount: "0.001",
          instrumentId: "dBTC",
        },
      },
      {
        admin: USD_ADMIN,
        leg: {
          transferLegId: "quote",
          sender: { owner: DEALER },
          receiver: { owner: TRADER },
          amount: "89.17",
          instrumentId: "dUSD",
        },
      },
    ],
    settlementDeadline: null,
    policyReceipt: {
      policyVersion: "v2.0",
      rfqId: "rfq-x",
      rankedDealers: [],
      acceptedDealer: DEALER,
      acceptedRank: 1,
      consideredCount: 2,
      signedBy: VENUE,
      signedAt: "2026-07-27T12:00:00Z",
    },
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

describe("indexer: a cross-admin matched trade", () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cdx-xadmin-"));
    db = openDb(join(dir, "t.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the pair and parties from tradeLegs, not a flat transferLegs", async () => {
    const ix = new Indexer(db, crossAdminLedger(), {
      intervalMs: 60_000,
      observingParty: VENUE,
    });
    await (ix as unknown as { reconcileTrades(ts: number): Promise<void> })
      .reconcileTrades(1);

    const row = db
      .prepare("SELECT pair, baseAdmin, quoteAdmin, trader, dealer, counterparty FROM trades")
      .get() as {
        pair: string;
        baseAdmin: string | null;
        quoteAdmin: string | null;
        trader: string | null;
        dealer: string | null;
        counterparty: string | null;
      };
    // Pair label is the two legs' instrument ids, base leg first.
    assert.equal(row.pair, "dBTC/dUSD");
    // The per-side admin carries the full instrument identity, so the same pair
    // label on another registry does not collide with this trade.
    assert.equal(row.baseAdmin, BTC_ADMIN);
    assert.equal(row.quoteAdmin, USD_ADMIN);
    // Parties come off the legs' sender/receiver accounts; the venue-signed
    // receipt names the dealer, and the trader is the other party.
    assert.equal(row.dealer, DEALER);
    assert.equal(row.trader, TRADER);
    assert.equal(row.counterparty, DEALER);
  });
});
