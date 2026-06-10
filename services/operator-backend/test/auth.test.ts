// Auth gate on state-changing routes, the wallet-relay
// flag, and CORS default-deny. Starts the HTTP shim against an InMemoryLedger
// with various auth configs and asserts the gate behaviour.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { InMemoryLedger } from "../src/ledger/in-memory.js";
import { OperatorBackend } from "../src/index.js";
import { startHttpServer, type HttpServerConfig } from "../src/http/index.js";
import {
  bearerMatches,
  isOperatorWrite,
  checkOperatorAuth,
} from "../src/http/auth.js";
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

function startServer(extra: Partial<HttpServerConfig>): {
  url: string;
  close: () => Promise<void>;
} {
  const ledger = new InMemoryLedger();
  const backend = new OperatorBackend({
    ledger,
    registry: new StubRegistry(),
    operatorParty: "op" as never,
  });
  const port = 19180 + Math.floor(Math.random() * 1000);
  return startHttpServer({
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
    ...extra,
  });
}

async function post(
  url: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<number> {
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  await res.text();
  return res.status;
}

describe("auth unit helpers", () => {
  it("bearerMatches is exact and length-guarded", () => {
    assert.equal(bearerMatches("Bearer secret", "secret"), true);
    assert.equal(bearerMatches("Bearer secret", "secre"), false);
    assert.equal(bearerMatches("Bearer wrong", "secret"), false);
    assert.equal(bearerMatches(undefined, "secret"), false);
    assert.equal(bearerMatches("secret", "secret"), false); // missing prefix
  });

  it("classifies state-changing operator routes", () => {
    assert.equal(isOperatorWrite("POST", "/v1/pools/swap"), true);
    assert.equal(isOperatorWrite("POST", "/v1/orders/fund"), true);
    assert.equal(isOperatorWrite("POST", "/v1/orders/abc123/cancel"), true);
    assert.equal(isOperatorWrite("POST", "/v1/rfq/xyz/cancel"), true);
    assert.equal(isOperatorWrite("POST", "/v1/matched-trades/settle"), true);
    // The wallet relay forwards commands under the operator JWT and must be
    // operator-gated (finding B-1).
    assert.equal(isOperatorWrite("POST", "/v1/wallet/submit"), true);
    // Reads and admin routes are not operator-write gated.
    assert.equal(isOperatorWrite("GET", "/v1/pools"), false);
    assert.equal(isOperatorWrite("POST", "/v1/admin/pools"), false);
  });

  it("fails closed when no token and no devOpen", () => {
    const r = checkOperatorAuth(
      { method: "POST", headers: {} } as never,
      { operatorToken: undefined, devOpen: false },
      "/v1/pools/swap",
    );
    assert.equal(r.ok, false);
  });

  it("dev bypass allows writes with no token", () => {
    const r = checkOperatorAuth(
      { method: "POST", headers: {} } as never,
      { operatorToken: undefined, devOpen: true },
      "/v1/pools/swap",
    );
    assert.equal(r.ok, true);
  });
});

describe("fail-closed (no token, no devOpen)", () => {
  let url: string;
  let close: () => Promise<void>;
  before(() => {
    ({ url, close } = startServer({}));
  });
  after(async () => {
    await close();
  });

  it("rejects a swap write with 401", async () => {
    const status = await post(url, "/v1/pools/swap", {
      poolCid: "#p:0",
      inputInstrumentId: "BTC",
      inputAmount: "1.0",
      minOutputAmount: "0.0",
    });
    assert.equal(status, 401);
  });

  it("rejects order cancel (cid route) with 401", async () => {
    const status = await post(url, "/v1/orders/abc/cancel", {});
    assert.equal(status, 401);
  });

  it("does NOT gate reads", async () => {
    const res = await fetch(`${url}/v1/pools`);
    await res.text();
    assert.equal(res.status, 200);
  });
});

describe("with operator token", () => {
  let url: string;
  let close: () => Promise<void>;
  before(() => {
    ({ url, close } = startServer({ operatorToken: "op-secret" }));
  });
  after(async () => {
    await close();
  });

  it("rejects a write with a missing token (401)", async () => {
    const status = await post(url, "/v1/pools/swap", {
      poolCid: "#p:0",
      inputInstrumentId: "BTC",
      inputAmount: "1.0",
      minOutputAmount: "0.0",
    });
    assert.equal(status, 401);
  });

  it("rejects a write with the wrong token (401)", async () => {
    const status = await post(
      url,
      "/v1/pools/swap",
      { poolCid: "#p:0", inputInstrumentId: "BTC", inputAmount: "1.0", minOutputAmount: "0.0" },
      { Authorization: "Bearer nope" },
    );
    assert.equal(status, 401);
  });

  it("passes the gate with the valid token (not 401)", async () => {
    // The stub ledger has no pool so the handler errors downstream, but the
    // point is the request got past the auth gate — it must not be a 401.
    const status = await post(
      url,
      "/v1/pools/swap",
      { poolCid: "#p:0", inputInstrumentId: "BTC", inputAmount: "1.0", minOutputAmount: "0.0" },
      { Authorization: "Bearer op-secret" },
    );
    assert.notEqual(status, 401);
  });
});

describe("wallet relay + CORS", () => {
  it("wallet relay is 404 when the flag is OFF", async () => {
    const { url, close } = startServer({
      devOpen: true,
      ledgerUrl: "http://ledger.invalid",
      ledgerToken: "t",
    });
    try {
      const status = await post(url, "/v1/wallet/submit", { actAs: ["op"] });
      assert.equal(status, 404);
    } finally {
      await close();
    }
  });

  it("wallet relay is operator-gated: 401 with a token set and no auth header (B-1)", async () => {
    // Token configured, no dev bypass: the relay must require the operator
    // token like every other write, even before its own relay flag is checked.
    const { url, close } = startServer({
      operatorToken: "op-secret",
      walletRelayEnabled: true,
      walletRelayParties: ["allowed-party"],
      ledgerUrl: "http://ledger.invalid",
      ledgerToken: "t",
    });
    try {
      const status = await post(url, "/v1/wallet/submit", { actAs: ["allowed-party"] });
      assert.equal(status, 401);
    } finally {
      await close();
    }
  });

  it("wallet relay rejects non-allowlisted actAs with 403 when ON", async () => {
    const { url, close } = startServer({
      devOpen: true,
      walletRelayEnabled: true,
      walletRelayParties: ["allowed-party"],
      ledgerUrl: "http://ledger.invalid",
      ledgerToken: "t",
    });
    try {
      const status = await post(url, "/v1/wallet/submit", { actAs: ["evil-party"] });
      assert.equal(status, 403);
    } finally {
      await close();
    }
  });

  it("CORS default-denies (no Allow-Origin header) when ALLOWED_ORIGINS unset", async () => {
    const { url, close } = startServer({ devOpen: true });
    try {
      const res = await fetch(`${url}/v1/pools`, {
        headers: { Origin: "http://evil.example" },
      });
      await res.text();
      assert.equal(res.headers.get("access-control-allow-origin"), null);
    } finally {
      await close();
    }
  });
});
