// End-to-end wiring of the bootstrap-bound mint over the HTTP surface: a settle
// returns a caller token ONLY when a bootstrap token accompanies the request
// and its nonceHash matches the settle's Daml-proven authBinding. The subject is
// always the ledger-proven party, never any HTTP body field.
//
// The swap settle is stubbed to return a canned { authenticatedParty, authBinding }
// so the test exercises the handler's merge logic without a live pool.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { InMemoryLedger } from "../src/ledger/in-memory.js";
import { OperatorBackend } from "../src/index.js";
import {
  startHttpServer,
  type HttpServerHandle,
} from "../src/http/index.js";
import { StubRegistry } from "./stub-registry.js";

const SECRET = "test-caller-secret";
const AUDIENCE = "canton-dex";
// The party the (stubbed) ledger proves. Absent from every request body below,
// so a minted token whose sub equals it can only have come from the ledger.
const PROVEN_PARTY = "prover::1220abcdef";

function decodeJwt(token: string): Record<string, unknown> {
  const payload = token.split(".")[1] ?? "";
  return JSON.parse(
    Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
  );
}

// The canned settle result the patched pool.swap returns; each test sets it.
let stubSwapResult: Record<string, unknown> = {};

function startServer(): Promise<HttpServerHandle> {
  const ledger = new InMemoryLedger();
  const backend = new OperatorBackend({
    ledger,
    registry: new StubRegistry(),
    operatorParty: "op" as never,
  });
  // Stub the settle so it surfaces a fixed on-ledger proof.
  (backend.pool as unknown as { swap: (i: unknown) => Promise<unknown> }).swap =
    async () => stubSwapResult;
  return startHttpServer({
    backend,
    port: 0,
    host: "127.0.0.1",
    callerJwtSecret: SECRET,
    callerJwtAudience: AUDIENCE,
    context: {
      operator: "op" as never,
      lpRegistrar: "lp" as never,
      admin: "ad" as never,
      network: "canton:test",
    },
  });
}

async function postJson(
  url: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

async function newBootstrap(url: string): Promise<{ token: string; nonceHash: string }> {
  const { status, body } = await postJson(url, "/v1/session/bootstrap", {});
  assert.equal(status, 200);
  const token = body.bootstrapToken as string;
  return { token, nonceHash: decodeJwt(token).nonceHash as string };
}

const swapBody = (bootstrapToken?: string): Record<string, unknown> => ({
  poolCid: "#p:0",
  inputInstrumentId: "BTC",
  inputAmount: "1.0",
  minOutputAmount: "0.0",
  quoteBinding: {},
  ...(bootstrapToken ? { bootstrapToken } : {}),
});

describe("bootstrap-bound settle mint over HTTP", () => {
  let url: string;
  let close: () => Promise<void>;
  before(async () => {
    ({ url, close } = await startServer());
  });
  after(async () => {
    await close();
  });

  it("issues a public bootstrap token", async () => {
    const { status, body } = await postJson(url, "/v1/session/bootstrap", {});
    assert.equal(status, 200);
    assert.ok(typeof body.bootstrapToken === "string");
    assert.ok((body.expiresAt as number) > Date.now());
  });

  it("mints a caller token when the bootstrap nonceHash matches the settle authBinding", async () => {
    const { token, nonceHash } = await newBootstrap(url);
    stubSwapResult = { amountOut: "0.9", authenticatedParty: PROVEN_PARTY, authBinding: nonceHash };
    const { status, body } = await postJson(url, "/v1/pools/swap", swapBody(token));
    assert.equal(status, 200);
    assert.ok(typeof body.callerToken === "string", "callerToken present");
    assert.ok((body.callerTokenExpiresAt as number) > Date.now());
    // The token's subject is the ledger-proven party, never a body field.
    const claims = decodeJwt(body.callerToken as string);
    assert.equal(claims.sub, PROVEN_PARTY);
    assert.equal(claims.auth_method, "ledger-allocation");
  });

  it("mints NOTHING when the settle authBinding does not match the bootstrap", async () => {
    const { token } = await newBootstrap(url);
    // The settle observed a different binding than this bootstrap carries.
    stubSwapResult = {
      amountOut: "0.9",
      authenticatedParty: PROVEN_PARTY,
      authBinding: "00".repeat(32),
    };
    const { status, body } = await postJson(url, "/v1/pools/swap", swapBody(token));
    assert.equal(status, 200);
    assert.equal(body.callerToken, undefined);
    assert.equal(body.callerTokenExpiresAt, undefined);
    // The settle result itself still comes back.
    assert.equal(body.amountOut, "0.9");
  });

  it("mints NOTHING when the settle proved no party (authenticatedParty None)", async () => {
    const { token, nonceHash } = await newBootstrap(url);
    stubSwapResult = { amountOut: "0.9", authenticatedParty: null, authBinding: nonceHash };
    const { body } = await postJson(url, "/v1/pools/swap", swapBody(token));
    assert.equal(body.callerToken, undefined);
  });

  it("settles fine with no bootstrap token, minting nothing (no upgrade)", async () => {
    stubSwapResult = { amountOut: "0.9", authenticatedParty: PROVEN_PARTY, authBinding: null };
    const { status, body } = await postJson(url, "/v1/pools/swap", swapBody());
    assert.equal(status, 200);
    assert.equal(body.callerToken, undefined);
    assert.equal(body.amountOut, "0.9");
  });
});
