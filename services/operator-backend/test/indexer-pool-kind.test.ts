// What the indexer calls a PoolState rotation. Five Daml choices rotate one
// and the indexer sees no choice name, so `totalLpSupply` is the
// discriminator. Also pins the two shapes that break naive implementations:
// a pause, and a dust swap that rounds to zero on one side.

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

  // Drive the private reconcile directly: one rotation per step.
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
    // Supply untouched: fees accrue to the reserves, minting no shares.
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
    // Both reserves increase, so this rotation is an add rather than a swap.
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

  it("calls a removal a remove even when supply is unreadable", async () => {
    // Fallback path: both reserve deltas are negative, so this is a removal.
    await step(1);
    ledger.state = {
      contractId: "#state:1",
      base: "9.99",
      quote: "199800.0",
      lpSupply: "not-a-number",
    };
    await step(2);

    const rows = kinds();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, "remove_liquidity");
  });

  it("calls an add an add when supply is unreadable", async () => {
    await step(1);
    ledger.state = {
      contractId: "#state:1",
      base: "10.01",
      quote: "200200.0",
      lpSupply: "not-a-number",
    };
    await step(2);
    assert.equal(kinds()[0]!.kind, "add_liquidity");
  });

  it("calls a rotation that moved nothing a state change, not a swap", async () => {
    await step(1);
    // Pause: reserves and supply unchanged. Not a trade.
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

  it("computes deltas exactly, not in floating point", async () => {
    // IEEE-754 lands this subtraction on ...4461; exact gives ...4462.
    ledger.state = {
      contractId: "#state:0",
      base: "16.6788007560",
      quote: "499074.5945995643",
      lpSupply: "1000.0",
    };
    await step(1);
    ledger.state = {
      contractId: "#state:1",
      base: "16.6788007560",
      quote: "504686.1354490105",
      lpSupply: "1000.0",
    };
    await step(2);

    const rows = kinds();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.quoteDelta, "5611.5408494462");
    assert.notEqual(
      rows[0]!.quoteDelta,
      (504686.1354490105 - 499074.5945995643).toFixed(10),
      "must not agree with the float computation",
    );
  });

  it("sees an LP mint that float subtraction would lose entirely", async () => {
    // At ~2e6 supply, `2000000.0000000001 - 2000000.0 === 0` in IEEE-754, so a
    // one-ulp mint was classified as a swap -- the exact misclassification the
    // `kind` column exists to prevent.
    ledger.state = {
      contractId: "#state:0",
      base: "10.0",
      quote: "200000.0",
      lpSupply: "2000000.0000000000",
    };
    await step(1);
    ledger.state = {
      contractId: "#state:1",
      base: "10.0000000001",
      quote: "200000.0000000001",
      lpSupply: "2000000.0000000001",
    };
    await step(2);

    const rows = kinds();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, "add_liquidity");
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
