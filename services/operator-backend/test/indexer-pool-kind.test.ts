// What the indexer calls a PoolState rotation.
//
// Five Daml choices rotate a PoolState — Swap, Pause, Resume,
// SettleAddLiquidity and SettleRemoveLiquidity — and the indexer only polls
// the ACS, so it never sees which one ran. It used to record every rotation
// as a swap, which put LP deposits and withdrawals in the trade feed with a
// direction and a price that no trade ever had.
//
// `totalLpSupply` is the discriminator: an add mints shares, a remove burns
// them, and nothing else moves supply — swap fees accrue to LPs through the
// reserves without minting. These tests pin that, plus the two shapes that
// broke the obvious implementations: a pause (reserves and supply both
// unchanged, which must not read as a swap) and a dust swap whose output
// rounds to zero on one side (which must still read as a swap).

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

const OBSERVER = "operator::1220ab";
const POOL_ID = "dBTC-dUSD";

interface StateSpec {
  contractId: string;
  base: string;
  quote: string;
  lpSupply: string;
  status?: string;
}

/** Serves one Pool config and whichever single PoolState the test is on. */
class StubLedger implements LedgerSubmitter {
  state: StateSpec = {
    contractId: "#state:0",
    base: "10.0",
    quote: "200000.0",
    lpSupply: "1000.0",
  };

  async query<T>(filter: SubscriptionFilter): Promise<T[]> {
    if (filter.templateId === "CantonDex.Dex.Pool:Pool") {
      return [
        {
          contractId: "#pool:0",
          poolId: POOL_ID,
          baseInstrumentId: "dBTC",
          quoteInstrumentId: "dUSD",
        },
      ] as unknown as T[];
    }
    if (filter.templateId === "CantonDex.Dex.PoolState:PoolState") {
      return [
        {
          contractId: this.state.contractId,
          poolId: POOL_ID,
          status: this.state.status ?? "Active",
          reserves: {
            baseAmount: this.state.base,
            quoteAmount: this.state.quote,
          },
          totalLpSupply: this.state.lpSupply,
        },
      ] as unknown as T[];
    }
    return [];
  }

  async submit<R>(_req: SubmitRequest): Promise<R> {
    throw new Error("the indexer must not submit");
  }
  async *subscribe<T>(_f: SubscriptionFilter): AsyncIterable<LedgerEvent<T>> {}
}

describe("indexer: classifying a PoolState rotation", () => {
  let dir: string;
  let db: Db;
  let ledger: StubLedger;
  let indexer: Indexer;

  // reconcilePools is private; `start()` fires it on a timer we do not want in
  // a test. Drive it directly so each rotation is one deterministic step.
  const step = (ts: number) =>
    (indexer as unknown as {
      reconcilePools(ts: number): Promise<void>;
    }).reconcilePools(ts);

  const kinds = () =>
    (db
      .prepare("SELECT kind, baseDelta, quoteDelta FROM swaps ORDER BY id")
      .all() as Array<{ kind: string; baseDelta: string; quoteDelta: string }>);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cdx-indexer-"));
    db = openDb(join(dir, "test.db"));
    ledger = new StubLedger();
    indexer = new Indexer(db, ledger, {
      intervalMs: 60_000,
      observingParty: OBSERVER,
    });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("calls a reserve-crossing rotation at flat supply a swap", async () => {
    await step(1);
    // 0.1 dBTC in, ~1974 dUSD out. Supply untouched: fees accrue to the
    // reserves, no LP shares are minted.
    ledger.state = {
      contractId: "#state:1",
      base: "10.1",
      quote: "198025.6839",
      lpSupply: "1000.0",
    };
    await step(2);

    const rows = kinds();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, "swap");
  });

  it("calls a supply-increasing rotation an add", async () => {
    await step(1);
    ledger.state = {
      contractId: "#state:1",
      base: "10.01",
      quote: "200200.0",
      lpSupply: "1001.0",
    };
    await step(2);

    const rows = kinds();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, "add_liquidity");
    // Both reserves moved the SAME way — the shape that used to be served as
    // a swap with a fabricated direction.
    assert.ok(parseFloat(rows[0]!.baseDelta) > 0);
    assert.ok(parseFloat(rows[0]!.quoteDelta) > 0);
  });

  it("calls a supply-decreasing rotation a remove", async () => {
    await step(1);
    ledger.state = {
      contractId: "#state:1",
      base: "9.99",
      quote: "199800.0",
      lpSupply: "999.0",
    };
    await step(2);

    const rows = kinds();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, "remove_liquidity");
  });

  it("calls a rotation that moved nothing a state change, not a swap", async () => {
    await step(1);
    // Pause rotates the PoolState with identical reserves and supply. Recorded
    // for the audit trail, but it is not a trade and must never reach a feed.
    ledger.state = {
      contractId: "#state:1",
      base: "10.0",
      quote: "200000.0",
      lpSupply: "1000.0",
      status: "Paused",
    };
    await step(2);

    const rows = kinds();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, "state_change");
  });

  it("still calls a dust swap a swap when one side rounds to zero", async () => {
    await step(1);
    // constantProductOut floors to 10dp, so a small enough input can leave one
    // reserve unchanged at that precision. A sign-based classifier would see
    // baseDelta * quoteDelta === 0 and could drop the row.
    ledger.state = {
      contractId: "#state:1",
      base: "10.0000000001",
      quote: "200000.0",
      lpSupply: "1000.0",
    };
    await step(2);

    const rows = kinds();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, "swap");
  });
});
