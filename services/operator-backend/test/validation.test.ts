// HTTP input validation tests — start the dev HTTP shim against an
// InMemoryLedger and exercise each POST endpoint's failure modes.
// Each failure case verifies a specific 4xx response shape.

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
  const ledger = new InMemoryLedger();
  const backend = new OperatorBackend({
    ledger,
    registry: new StubRegistry(),
    operatorParty: "op" as never,
  });
  const port = 18180 + Math.floor(Math.random() * 1000);
  const handle = startHttpServer({
    backend,
    port,
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
    // Dev-open so the operator-auth gate does not 401 the write
    // routes this suite exercises; auth itself is covered in auth.test.ts.
    devOpen: true,
  });
  baseUrl = handle.url;
  close = handle.close;
});

after(async () => {
  await close();
});

async function getJson(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function postJson(
  path: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe("HTTP input validation", () => {
  it("GET /v1/orders without ?trader= → 400", async () => {
    const r = await getJson("/v1/orders");
    assert.equal(r.status, 400);
  });

  it("GET /v1/holdings without ?owner= → 400", async () => {
    const r = await getJson("/v1/holdings");
    assert.equal(r.status, 400);
  });

  it("GET /v1/orders/book without ?base= → 400", async () => {
    const r = await getJson("/v1/orders/book?quote=USDC");
    assert.equal(r.status, 400);
  });

  it("GET /v1/prices without ?pairs= → 400", async () => {
    const r = await getJson("/v1/prices");
    assert.equal(r.status, 400);
  });

  it("POST /v1/orders/match without base/quote → 400", async () => {
    const r = await postJson("/v1/orders/match", {});
    assert.equal(r.status, 400);
  });

  it("GET /v1/status returns shaped status", async () => {
    const r = await getJson("/v1/status");
    assert.equal(r.status, 200);
    const body = r.body as { network: string; slot: number; synced: boolean };
    assert.equal(typeof body.network, "string");
    assert.equal(typeof body.slot, "number");
    assert.equal(typeof body.synced, "boolean");
  });

  it("GET /v1/context returns shaped context", async () => {
    const r = await getJson("/v1/context");
    assert.equal(r.status, 200);
    const body = r.body as {
      operator: string;
      admin: string;
      lpRegistrar: string;
    };
    assert.equal(body.operator, "op");
    assert.equal(body.admin, "ad");
    assert.equal(body.lpRegistrar, "lp");
  });

  it("unknown route → 404", async () => {
    const r = await getJson("/v1/does-not-exist");
    assert.equal(r.status, 404);
  });
});

// Runtime validation of write bodies (decimal/party/cid/presence).
describe("write-body validation", () => {
  it("POST /v1/pools/swap rejects a non-decimal inputAmount → 400", async () => {
    const r = await postJson("/v1/pools/swap", {
      poolCid: "#p:0",
      inputInstrumentId: "BTC",
      inputAmount: "not-a-number",
      minOutputAmount: "0.0",
    });
    assert.equal(r.status, 400);
    assert.equal((r.body as { code?: string }).code, "bad_request");
  });

  it("POST /v1/pools/swap rejects a missing required field → 400", async () => {
    const r = await postJson("/v1/pools/swap", {
      poolCid: "#p:0",
      inputInstrumentId: "BTC",
      // inputAmount missing
      minOutputAmount: "0.0",
    });
    assert.equal(r.status, 400);
  });

  it("POST /v1/pools/swap/request rejects a whitespace party → 400", async () => {
    const r = await postJson("/v1/pools/swap/request", {
      poolCid: "#p:0",
      swapper: "bad party",
      inputInstrumentId: "BTC",
      inputAmount: "1.0",
    });
    assert.equal(r.status, 400);
  });

  it("POST /v1/rfq rejects a non-decimal size → 400", async () => {
    const r = await postJson("/v1/rfq", {
      trader: "alice",
      rfqId: "r1",
      pair: "BTC/USDC",
      side: "RFQ_Buy",
      size: "lots",
      expiresAt: "2099-01-01T00:00:00Z",
      whitelist: [],
      createdAt: "2026-01-01T00:00:00Z",
    });
    assert.equal(r.status, 400);
  });

  it("POST /v1/orders/fund rejects an empty cid → 400", async () => {
    const r = await postJson("/v1/orders/fund", { orderCid: "" });
    assert.equal(r.status, 400);
  });
});

// Integrator feedback: quote accepts poolCid OR poolId (finding #5). The
// fixture seeds no pool, so a valid reference passes validation and 404s at
// lookup — proving the anyOf rule accepted it (a validation failure is 400).
describe("quote pool reference (poolCid or poolId)", () => {
  it("rejects a body with neither poolCid nor poolId → 400", async () => {
    const r = await postJson("/v1/swaps/quote", {
      inputInstrumentId: "BTC",
      inputAmount: "0.5",
    });
    assert.equal(r.status, 400);
    assert.equal((r.body as { code?: string }).code, "bad_request");
    assert.match(String((r.body as { error?: string }).error), /at least one/);
  });

  it("accepts poolCid (validation passes; 404 as no pool is seeded)", async () => {
    const r = await postJson("/v1/swaps/quote", {
      poolCid: "#p:0",
      inputInstrumentId: "BTC",
      inputAmount: "0.5",
    });
    assert.equal(r.status, 404);
  });

  it("still accepts legacy poolId (validation passes; 404)", async () => {
    const r = await postJson("/v1/swaps/quote", {
      poolId: "BTC-USDC",
      inputInstrumentId: "BTC",
      inputAmount: "0.5",
    });
    assert.equal(r.status, 404);
  });
});

// Integrator feedback: aggregated balances endpoint (finding #7).
describe("GET /v1/balances", () => {
  it("requires ?owner= → 400", async () => {
    const r = await getJson("/v1/balances");
    assert.equal(r.status, 400);
    assert.equal((r.body as { code?: string }).code, "bad_request");
  });

  it("returns an array (empty when the owner holds nothing here)", async () => {
    const r = await getJson("/v1/balances?owner=nobody::1220ab");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body));
  });
});
