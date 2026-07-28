// The order book/matches routes accept `?pair=BASE/QUOTE`, matching every
// other pair-scoped read on this API, and keep `?base=&quote=`.
//
// Driven over real HTTP rather than by inspecting the router source: the last
// attempt at this change added the helper without rewiring the handlers, and a
// source-text guard would have passed on it.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { InMemoryLedger } from "../src/ledger/in-memory.js";
import { OperatorBackend } from "../src/index.js";
import { startHttpServer } from "../src/http/index.js";
import { RegistryClient } from "@canton-dex/registry-client";
import type { ChoiceContextRef, ContractId } from "@canton-dex/registry-client";

class StubRegistry extends RegistryClient {
  constructor() {
    super({ baseUrl: "http://stub" });
  }
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

before(async () => {
  const backend = new OperatorBackend({
    ledger: new InMemoryLedger(),
    registry: new StubRegistry(),
    operatorParty: "op" as never,
  });
  // A fixed port, not 0: startHttpServer is synchronous and builds its url
  // from cfg.port, so it cannot report an OS-assigned one. A different base
  // from auth.test.ts's 19180 -- the files run concurrently and `listen` has
  // no 'error' handler, so a collision takes down the whole run.
  const handle = startHttpServer({
    backend,
    port: 20180 + Math.floor(Math.random() * 1000),
    host: "127.0.0.1",
    context: {
      operator: "op" as never,
      lpRegistrar: "lp" as never,
      admin: "ad" as never,
      allocationFactoryCid: "#alloc:0",
      settlementFactoryCid: "#settle:0",
      allocationFactoryExtraArgs: { context: { values: {} }, meta: { values: {} } },
      allocationFactoryDisclosure: [],
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

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

for (const [route, key] of [
  ["/v1/orders/book", "bids"],
  ["/v1/orders/matches", "matches"],
] as const) {
  describe(`GET ${route}`, () => {
    it("accepts ?pair=BASE/QUOTE", async () => {
      const r = await get(`${route}?pair=BTC/USDC`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.ok(key in r.body, `expected a ${key} field`);
    });

    it("still accepts ?base=&quote=", async () => {
      const r = await get(`${route}?base=BTC&quote=USDC`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.ok(key in r.body, `expected a ${key} field`);
    });

    it("400s with the standard error envelope when neither is given", async () => {
      const r = await get(route);
      assert.equal(r.status, 400);
      // Previously a bare `{ error }`, which the API reference does not
      // document and which carries no requestId to correlate against.
      assert.equal(r.body.code, "bad_request");
      assert.ok(r.body.requestId, "error carries a requestId");
      assert.match(r.body.error, /pair=BASE\/QUOTE/);
    });

    it("400s on a malformed pair rather than reading it as a base", async () => {
      for (const bad of ["BTC", "BTC/", "/USDC", "BTC/USDC/EUR"]) {
        const r = await get(`${route}?pair=${encodeURIComponent(bad)}`);
        assert.equal(r.status, 400, `expected 400 for ?pair=${bad}`);
        assert.equal(r.body.code, "bad_request");
      }
    });
  });
}
