// GET /v1/swaps can serve the non-swap rows the indexer records -- LP adds and
// removes, and pause/resume state changes -- via ?kind=, while the default
// stays swaps only so existing callers see no change.

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

let baseUrl: string;
let close: () => Promise<void>;
let dir: string;
let db: Db;

const seed = (
  kind: string,
  pair: string,
  baseDelta: string,
  quoteDelta: string,
  ts: number,
) =>
  db
    .prepare(
      `INSERT INTO swaps
         (ts, oldPoolCid, newPoolCid, pair, baseDelta, quoteDelta, priceAfter, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ts, "#p:a", "#p:b", pair, baseDelta, quoteDelta, "1.0000000000", kind);

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "cdx-kind-"));
  db = openDb(join(dir, "test.db"));
  const t = Date.now();
  seed("swap", "dBTC/dUSD", "0.0100000000", "-100.0000000000", t);
  seed("swap", "dBTC/dUSD", "0.0200000000", "-200.0000000000", t + 1);
  seed("add_liquidity", "dBTC/dUSD", "1.0000000000", "1000.0000000000", t + 2);
  seed("remove_liquidity", "dBTC/dUSD", "-0.5000000000", "-500.0000000000", t + 3);
  seed("state_change", "dBTC/dUSD", "0.0000000000", "0.0000000000", t + 4);
  seed("add_liquidity", "dETH/dUSD", "2.0000000000", "2000.0000000000", t + 5);

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

const get = async (path: string): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

describe("GET /v1/swaps ?kind= filter", () => {
  it("defaults to swaps only when no ?kind= is given", async () => {
    const r = await get("/v1/swaps");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.length, 2);
    assert.ok(r.body.every((row: any) => row.kind === "swap"));
  });

  it("returns only add_liquidity rows for ?kind=add_liquidity", async () => {
    const r = await get("/v1/swaps?kind=add_liquidity");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.length, 2);
    assert.ok(r.body.every((row: any) => row.kind === "add_liquidity"));
  });

  it("returns only remove_liquidity rows for ?kind=remove_liquidity", async () => {
    const r = await get("/v1/swaps?kind=remove_liquidity");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.length, 1);
    assert.equal(r.body[0].kind, "remove_liquidity");
  });

  it("composes ?kind= with ?pair=", async () => {
    const r = await get("/v1/swaps?kind=add_liquidity&pair=dETH/dUSD");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.length, 1);
    assert.equal(r.body[0].pair, "dETH/dUSD");
    assert.equal(r.body[0].kind, "add_liquidity");
  });

  it("rejects an unknown ?kind= with 400 naming the allowed values", async () => {
    const r = await get("/v1/swaps?kind=bogus");
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /add_liquidity/);
    assert.match(r.body.error, /remove_liquidity/);
    assert.match(r.body.error, /state_change/);
  });
});
