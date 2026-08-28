// Amounts leave the API exactly as they were stored.
//
// The deltas are stored as scaled decimal strings. Running parseFloat over
// them on the way out kept the value -- JS prints the shortest round-tripping
// form -- but dropped the trailing scale, and emitted a number on a feed where
// every other amount is a string.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb, type Db } from "../src/indexer/db.js";
import { InMemoryLedger } from "../src/ledger/in-memory.js";
import { OperatorBackend } from "../src/index.js";
import { startHttpServer } from "../src/http/index.js";
import { StubRegistry } from "./stub-registry.js";

// Ten-decimal values whose trailing zeros a float would drop, and one whose
// last digit float subtraction would move.
const BASE_DELTA = "0.0100000000";
const QUOTE_DELTA = "-1207.2003884290";
const PRICE = "120720.0388429000";

let baseUrl: string;
let close: () => Promise<void>;
let dir: string;
let db: Db;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "cdx-proj-"));
  db = openDb(join(dir, "test.db"));
  db.prepare(
    `INSERT INTO swaps
       (ts, oldPoolCid, newPoolCid, pair, baseDelta, quoteDelta, priceAfter, kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'swap')`,
  ).run(Date.now(), "#p:0", "#p:1", "dBTC/dUSD", BASE_DELTA, QUOTE_DELTA, PRICE);

  const backend = new OperatorBackend({
    ledger: new InMemoryLedger(),
    registry: new StubRegistry(),
    operatorParty: "op" as never,
  });
  const handle = await startHttpServer({
    backend,
    db,
    port: 0,
    host: "127.0.0.1",
    context: {
      operator: "op" as never,
      lpRegistrar: "lp" as never,
      admin: "ad" as never,
      network: "canton:test",
    },
    devOpen: true,
  });
  baseUrl = handle.url;
  close = handle.close;
});

after(async () => {
  await close();
  rmSync(dir, { recursive: true, force: true });
});

const get = async (path: string) =>
  (await fetch(`${baseUrl}${path}`)).json() as Promise<any>;

describe("indexer projections keep amounts exact", () => {
  it("GET /v1/swaps serves amounts as strings, not JSON numbers", async () => {
    const rows = await get("/v1/swaps?limit=1");
    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.equal(
      typeof r.inputAmount,
      "string",
      "inputAmount came back as a JSON number; every other amount on this API " +
        "is a string, and a number cannot carry the 10-decimal scale",
    );
    assert.equal(typeof r.outputAmount, "string");
  });

  it("the served magnitudes are the stored strings, digit for digit", async () => {
    const r = (await get("/v1/swaps?limit=1"))[0];
    // Base delta positive => base was sent in, quote came out.
    assert.equal(r.inputAmount, "0.0100000000");
    assert.equal(r.outputAmount, "1207.2003884290");
    assert.equal(r.inputInstrumentId, "dBTC");
    assert.equal(r.outputInstrumentId, "dUSD");
  });

  it("the raw deltas still round-trip untouched", async () => {
    const r = (await get("/v1/swaps?limit=1"))[0];
    assert.equal(r.baseDelta, BASE_DELTA);
    assert.equal(r.quoteDelta, QUOTE_DELTA);
  });

  it("GET /v1/price-history serves the price exactly", async () => {
    const body = await get("/v1/price-history?pair=dBTC/dUSD&hours=24");
    assert.equal(body.points.length, 1);
    assert.equal(
      typeof body.points[0].price,
      "string",
      "price came back as a JSON number, dropping the stored scale",
    );
    assert.equal(body.points[0].price, PRICE);
  });

  it("a zero base delta does not read as a positive one", async () => {
    // Guards the textual direction test: "0.0000000000" must not be treated
    // as base-sent just because it lacks a minus sign.
    db.prepare(
      `INSERT INTO swaps
         (ts, oldPoolCid, newPoolCid, pair, baseDelta, quoteDelta, priceAfter, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'swap')`,
    ).run(
      Date.now() + 1,
      "#p:1",
      "#p:2",
      "dBTC/dUSD",
      "0.0000000000",
      "-5.0000000000",
      PRICE,
    );
    const r = (await get("/v1/swaps?limit=1"))[0];
    assert.equal(r.inputInstrumentId, "dUSD", "zero base delta means quote was sent");
    assert.equal(r.inputAmount, "5.0000000000");
  });
});
