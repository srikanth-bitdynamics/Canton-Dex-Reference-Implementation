// Read routes that name parties are scoped, and book sizes keep ledger scale.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb, type Db } from "../src/indexer/db.js";
import { InMemoryLedger } from "../src/ledger/in-memory.js";
import { OperatorBackend } from "../src/index.js";
import { startHttpServer } from "../src/http/index.js";
import { aggregateBook } from "../src/order/matching.js";
import { RegistryClient } from "@canton-dex/registry-client";
import type { ChoiceContextRef, ContractId } from "@canton-dex/registry-client";
import type { Order } from "../src/types.js";

const ADMIN_TOKEN = "admin-secret";

class StubRegistry extends RegistryClient {
  constructor() { super({ baseUrl: "http://stub" }); }
  override async getFactories() {
    return {
      allocationFactoryCid: "#alloc:0" as ContractId<"AllocationFactory">,
      settlementFactoryCid: "#settle:0" as ContractId<"SettlementFactory">,
      disclosure: [] as never[],
    };
  }
  override async getChoiceContext(): Promise<ChoiceContextRef> {
    return { context: { values: {} }, disclosure: [] };
  }
}

let baseUrl: string;
let close: () => Promise<void>;
let dir: string;
let db: Db;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "cdx-expo-"));
  db = openDb(join(dir, "t.db"));
  db.prepare(
    `INSERT INTO trades (tradeCid, ts, pair, trader, dealer, counterparty, payload)
     VALUES (?, ?, ?, ?, ?, ?, '{}')`,
  ).run("#t:1", Date.now(), "dBTC/dUSD", "alice", null, "bob");

  const handle = await startHttpServer({
    backend: new OperatorBackend({
      ledger: new InMemoryLedger(),
      registry: new StubRegistry(),
      operatorParty: "op" as never,
    }),
    db,
    port: 0,
    host: "127.0.0.1",
    adminToken: ADMIN_TOKEN,
    context: {
      operator: "op" as never, lpRegistrar: "lp" as never, admin: "ad" as never,
      allocationFactoryCid: "#alloc:0", settlementFactoryCid: "#settle:0",
      allocationFactoryExtraArgs: { context: { values: {} }, meta: { values: {} } },
      allocationFactoryDisclosure: [], network: "canton:test",
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

const get = async (p: string, token?: string) => {
  const r = await fetch(`${baseUrl}${p}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};

describe("GET /v1/trades scoping", () => {
  it("refuses an unscoped read without the admin token", async () => {
    const r = await get("/v1/trades");
    assert.equal(r.status, 400, "the settled trade record names both parties");
    assert.equal(r.body.code, "bad_request");
  });

  it("serves a scoped read", async () => {
    const r = await get("/v1/trades?trader=alice");
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 1);
  });

  it("the admin token still gets the unfiltered view", async () => {
    const r = await get("/v1/trades", ADMIN_TOKEN);
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 1);
  });
});

describe("GET /v1/orders/matches", () => {
  it("serves only the terms, not the whole orders", async () => {
    const r = await get("/v1/orders/matches?pair=dBTC/dUSD");
    assert.equal(r.status, 200);
    for (const m of r.body.matches ?? []) {
      assert.deepEqual(
        Object.keys(m).sort(),
        ["buyOrderCid", "price", "quantity", "sellOrderCid"],
        "a Match embeds both whole Orders; only the terms may be public",
      );
    }
  });
});

describe("aggregateBook", () => {
  const mk = (qty: string, price: string): Order =>
    ({
      contractId: `#o:${qty}`, status: "Funded", side: "Bid",
      limitPrice: price, remainingQty: qty,
    }) as unknown as Order;

  it("keeps ledger scale and does not drift", () => {
    const { bids } = aggregateBook([mk("0.1000000000", "9.0"), mk("0.2000000000", "9.0")]);
    assert.equal(bids[0]!.size, "0.3000000000", "float accumulation gives 0.30000000000000004");
  });

  it("renders dust without exponent notation", () => {
    const { bids } = aggregateBook([mk("0.0000000001", "9.0")]);
    assert.equal(bids[0]!.size, "0.0000000001", "float renders this as 1e-10");
  });
});
