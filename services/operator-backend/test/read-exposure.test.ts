// Read routes that name parties are scoped, and book sizes keep ledger scale.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";

import { openDb, type Db } from "../src/indexer/db.js";
import { InMemoryLedger } from "../src/ledger/in-memory.js";
import type { SubscriptionFilter } from "../src/ledger/index.js";
import { OperatorBackend } from "../src/index.js";
import { startHttpServer } from "../src/http/index.js";
import { aggregateBook } from "../src/order/matching.js";
import { StubRegistry } from "./stub-registry.js";
import type { Order } from "../src/types.js";

const ADMIN_TOKEN = "admin-secret";
const CALLER_SECRET = "caller-secret";

function callerToken(sub: string): string {
  const encode = (value: string | Buffer) =>
    Buffer.from(value).toString("base64url");
  const header = encode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = encode(JSON.stringify({
    sub,
    exp: Math.floor(Date.now() / 1000) + 3600,
  }));
  const signature = encode(
    createHmac("sha256", CALLER_SECRET).update(`${header}.${payload}`).digest(),
  );
  return `${header}.${payload}.${signature}`;
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
    callerJwtSecret: CALLER_SECRET,
    context: {
      operator: "op" as never, lpRegistrar: "lp" as never, admin: "ad" as never,
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

const get = async (p: string, token?: string, caller?: string) => {
  const r = await fetch(`${baseUrl}${p}`, {
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(caller ? { "x-caller-token": callerToken(caller) } : {}),
    },
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
    const r = await get("/v1/trades?trader=alice", undefined, "alice");
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 1);
  });

  it("rejects a missing or mismatched caller on a scoped read", async () => {
    assert.equal((await get("/v1/trades?trader=alice")).status, 401);
    assert.equal(
      (await get("/v1/trades?trader=alice", undefined, "mallory")).status,
      403,
    );
  });

  it("the admin token still gets the unfiltered view", async () => {
    const r = await get("/v1/trades", ADMIN_TOKEN);
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 1);
  });
});

describe("party-scoped ACS reads", () => {
  for (const path of [
    "/v1/orders?trader=alice",
    "/v1/holdings?owner=alice",
    "/v1/balances?owner=alice",
  ]) {
    it(`${path} binds the query party to the caller`, async () => {
      assert.equal((await get(path)).status, 401);
      assert.equal((await get(path, undefined, "mallory")).status, 403);
      assert.equal((await get(path, undefined, "alice")).status, 200);
      assert.equal((await get(path, ADMIN_TOKEN)).status, 200);
    });
  }
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

describe("bounded history queries", () => {
  it("rejects malformed or non-positive limits", async () => {
    assert.equal(
      (await get("/v1/trades?trader=alice&limit=-1", undefined, "alice")).status,
      400,
    );
    assert.equal((await get("/v1/swaps?limit=not-a-number")).status, 400);
  });

  it("clamps oversized limits instead of emitting an unbounded query", async () => {
    assert.equal(
      (await get("/v1/trades?trader=alice&limit=999999", undefined, "alice")).status,
      200,
    );
  });
});

describe("holding query failures", () => {
  it("returns an error instead of presenting a ledger failure as a zero balance", async () => {
    class FailingHoldingLedger extends InMemoryLedger {
      override async query<T>(filter: SubscriptionFilter): Promise<T[]> {
        if (filter.templateId?.endsWith("Registry.V2:Holding")) {
          throw new Error("participant unavailable");
        }
        return [];
      }
    }

    const handle = await startHttpServer({
      backend: new OperatorBackend({
        ledger: new FailingHoldingLedger(),
        registry: new StubRegistry(),
        operatorParty: "op" as never,
      }),
      port: 0,
      host: "127.0.0.1",
      callerJwtSecret: CALLER_SECRET,
      context: {
        operator: "op" as never,
        lpRegistrar: "lp" as never,
        admin: "ad" as never,
        network: "canton:test",
      },
      devOpen: true,
    });
    try {
      const response = await fetch(`${handle.url}/v1/balances?owner=alice`, {
        headers: { "x-caller-token": callerToken("alice") },
      });
      assert.equal(response.status, 503);
      const body = await response.json() as { error?: string };
      assert.equal(body.error, "unable to load holdings from the ledger");
    } finally {
      await handle.close();
    }
  });
});
