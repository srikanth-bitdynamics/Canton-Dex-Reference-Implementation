// `?pair=BASE/QUOTE` on the order book and matches routes, over real HTTP: an
// earlier attempt added the helper without rewiring the handlers, and a
// source-text guard passed on it.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { InMemoryLedger } from "../src/ledger/in-memory.js";
import { OperatorBackend } from "../src/index.js";
import { startHttpServer } from "../src/http/index.js";
import { StubRegistry } from "./stub-registry.js";

let baseUrl: string;
let close: () => Promise<void>;

before(async () => {
  const backend = new OperatorBackend({
    ledger: new InMemoryLedger(),
    registry: new StubRegistry(),
    operatorParty: "op" as never,
  });
  const handle = await startHttpServer({
    backend,
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
