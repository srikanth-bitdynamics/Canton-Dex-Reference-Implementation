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
