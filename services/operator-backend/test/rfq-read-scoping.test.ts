// GET /v1/rfq is scoped to one party.
//
// The operator observes every Rfq and RfqQuote, so an unscoped read exposes
// who is asking for a quote, on what, in what size, and every dealer's price.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { InMemoryLedger } from "../src/ledger/in-memory.js";
import type { SubscriptionFilter } from "../src/ledger/index.js";
import { OperatorBackend } from "../src/index.js";
import { startHttpServer } from "../src/http/index.js";
import { StubRegistry } from "./stub-registry.js";

const ALICE = "alice";
const BOB = "bob";
const DEALER = "northwind";
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

class RfqLedger extends InMemoryLedger {
  override async query<T>(filter: SubscriptionFilter): Promise<T[]> {
    if (filter.templateId?.endsWith("Rfq:Rfq")) {
      return [
        { contractId: "#r:1", trader: ALICE, operator: "op", rfqId: "a1", pair: "dBTC/dUSD", side: "RFQ_Buy", size: "1.0", expiresAt: "2030-01-01T00:00:00Z", whitelist: [DEALER], createdAt: "2026-01-01T00:00:00Z" },
        { contractId: "#r:2", trader: BOB, operator: "op", rfqId: "b1", pair: "dBTC/dUSD", side: "RFQ_Sell", size: "50.0", expiresAt: "2030-01-01T00:00:00Z", whitelist: [], createdAt: "2026-01-01T00:00:00Z" },
      ] as T[];
    }
    if (filter.templateId?.endsWith("Rfq:RfqQuote")) {
      return [
        { contractId: "#q:1", dealer: DEALER, trader: ALICE, operator: "op", rfqId: "a1", price: "90000.0", expiresAt: "2030-01-01T00:00:00Z", postedAt: "2026-01-01T00:00:00Z" },
        { contractId: "#q:2", dealer: DEALER, trader: BOB, operator: "op", rfqId: "b1", price: "88000.0", expiresAt: "2030-01-01T00:00:00Z", postedAt: "2026-01-01T00:00:00Z" },
      ] as T[];
    }
    return [];
  }
}

let baseUrl: string;
let close: () => Promise<void>;

before(async () => {
  const backend = new OperatorBackend({
    ledger: new RfqLedger(),
    registry: new StubRegistry(),
    operatorParty: "op" as never,
  });
  const handle = await startHttpServer({
    backend,
    port: 0,
    host: "127.0.0.1",
    adminToken: ADMIN_TOKEN,
    callerJwtSecret: CALLER_SECRET,
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
});

const get = async (path: string, token?: string, caller?: string) => {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(caller ? { "x-caller-token": callerToken(caller) } : {}),
    },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) as any };
};

describe("GET /v1/rfq scoping", () => {
  it("refuses an unscoped read without the admin token", async () => {
    const r = await get("/v1/rfq");
    assert.equal(r.status, 400, "an anonymous caller must not receive the whole book");
    assert.equal(r.body.code, "bad_request");
  });

  it("a trader sees only their own RFQs and quotes", async () => {
    const r = await get(`/v1/rfq?owner=${ALICE}`, undefined, ALICE);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.rfqs.map((x: any) => x.rfqId), ["a1"]);
    assert.deepEqual(r.body.quotes.map((x: any) => x.rfqId), ["a1"]);
  });

  it("one trader cannot see another's size or the prices quoted to them", async () => {
    const r = await get(`/v1/rfq?owner=${ALICE}`, undefined, ALICE);
    const leaked = JSON.stringify(r.body);
    assert.ok(!leaked.includes("b1"), "bob's RFQ id leaked");
    assert.ok(!leaked.includes("50.0"), "bob's size leaked");
    assert.ok(!leaked.includes("88000.0"), "the price quoted to bob leaked");
  });

  it("a whitelisted dealer sees the RFQ and its own quotes", async () => {
    const r = await get(`/v1/rfq?owner=${DEALER}`, undefined, DEALER);
    assert.deepEqual(r.body.rfqs.map((x: any) => x.rfqId), ["a1"], "whitelisted on a1 only");
    assert.equal(r.body.quotes.length, 2, "its own quotes on both");
  });

  it("rejects a missing or mismatched caller on a scoped RFQ read", async () => {
    assert.equal((await get(`/v1/rfq?owner=${ALICE}`)).status, 401);
    assert.equal(
      (await get(`/v1/rfq?owner=${ALICE}`, undefined, BOB)).status,
      403,
    );
  });

  it("refuses an unscoped /v1/rfq/history without the admin token", async () => {
    // Same exposure as /v1/rfq: each settled row names the trader, the pair,
    // the winning dealer and its rank.
    const r = await get("/v1/rfq/history");
    assert.notEqual(r.status, 200, "the settled negotiation history must not be open");
  });

  it("the admin token still gets the unfiltered view", async () => {
    const r = await get("/v1/rfq", ADMIN_TOKEN);
    assert.equal(r.status, 200);
    assert.equal(r.body.rfqs.length, 2);
    assert.equal(r.body.quotes.length, 2);
  });
});
