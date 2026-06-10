// Per-caller party binding (finding B-2): a trader-subject write route, when a
// caller-JWT secret is configured, must require an X-Caller-Token whose `sub`
// equals the route's subject party, and reject anything else.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { IncomingMessage } from "node:http";

import {
  checkCallerBinding,
  routeBindsCaller,
  verifyHs256,
} from "../src/http/caller-auth.js";

const SECRET = "test-caller-secret";
const ALICE = "alice::1220abcdef";
const BOB = "bob::1220beefcafe";

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function signHs256(payload: Record<string, unknown>, secret = SECRET): string {
  // verifyHs256 requires an `exp` by default; default to a far-future expiry so
  // callers that don't care about expiry get a valid token. Explicit `exp` in
  // `payload` overrides this.
  const withExp = { exp: Math.floor(Date.now() / 1000) + 3600, ...payload };
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(withExp));
  const sig = b64url(createHmac("sha256", secret).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
}

function reqWith(token?: string): IncomingMessage {
  return { headers: token ? { "x-caller-token": token } : {} } as IncomingMessage;
}

describe("verifyHs256", () => {
  it("accepts a correctly signed token and returns its claims", () => {
    const claims = verifyHs256(signHs256({ sub: ALICE }), SECRET);
    assert.equal(claims?.sub, ALICE);
  });
  it("rejects a wrong-secret signature", () => {
    assert.equal(verifyHs256(signHs256({ sub: ALICE }, "other"), SECRET), null);
  });
  it("rejects a tampered payload", () => {
    const t = signHs256({ sub: ALICE });
    const [h, , s] = t.split(".");
    const forged = `${h}.${b64url(JSON.stringify({ sub: BOB }))}.${s}`;
    assert.equal(verifyHs256(forged, SECRET), null);
  });
  it("rejects alg=none", () => {
    const header = b64url(JSON.stringify({ alg: "none", typ: "JWT" }));
    const body = b64url(JSON.stringify({ sub: ALICE }));
    assert.equal(verifyHs256(`${header}.${body}.`, SECRET), null);
  });
  it("rejects an expired token", () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    assert.equal(verifyHs256(signHs256({ sub: ALICE, exp: past }), SECRET), null);
  });
  it("rejects a token with no exp by default (Low residual #2)", () => {
    // Build a token whose payload deliberately has no exp claim.
    const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const body = b64url(JSON.stringify({ sub: ALICE }));
    const sig = b64url(createHmac("sha256", SECRET).update(`${header}.${body}`).digest());
    const noExp = `${header}.${body}.${sig}`;
    assert.equal(verifyHs256(noExp, SECRET), null);
    // ...but accepted when exp is explicitly not required.
    assert.equal(verifyHs256(noExp, SECRET, { requireExp: false })?.sub, ALICE);
  });
  it("enforces the audience claim when configured (Low residual #2)", () => {
    const aud = "canton-dex-operator";
    // No aud in token → rejected when an audience is required.
    assert.equal(verifyHs256(signHs256({ sub: ALICE }), SECRET, { audience: aud }), null);
    // Matching aud (string) → accepted.
    assert.equal(
      verifyHs256(signHs256({ sub: ALICE, aud }), SECRET, { audience: aud })?.sub,
      ALICE,
    );
    // Matching aud (array) → accepted.
    assert.equal(
      verifyHs256(signHs256({ sub: ALICE, aud: ["other", aud] }), SECRET, { audience: aud })?.sub,
      ALICE,
    );
    // Wrong aud → rejected.
    assert.equal(
      verifyHs256(signHs256({ sub: ALICE, aud: "someone-else" }), SECRET, { audience: aud }),
      null,
    );
  });
});

describe("checkCallerBinding", () => {
  const cfg = { callerJwtSecret: SECRET };

  it("classifies which routes bind a caller", () => {
    assert.equal(routeBindsCaller("POST /v1/pools/swap"), true);
    assert.equal(routeBindsCaller("POST /v1/pools/swap/request"), true);
    assert.equal(routeBindsCaller("POST /v1/pools/add-liquidity/request"), true);
    assert.equal(routeBindsCaller("POST /v1/pools/remove-liquidity/settle"), true);
    assert.equal(routeBindsCaller("POST /v1/rfq"), true);
    // operator/admin-authority routes are NOT caller-bound
    assert.equal(routeBindsCaller("POST /v1/matched-trades/settle"), false);
    assert.equal(routeBindsCaller("POST /v1/orders/match"), false);
    assert.equal(routeBindsCaller("POST /v1/rfq/accept"), false);
  });

  it("no-op when the secret is unset (binding disabled)", () => {
    const r = checkCallerBinding(
      reqWith(),
      { callerJwtSecret: undefined },
      "POST /v1/pools/swap/request",
      { swapper: BOB },
    );
    assert.equal(r.ok, true);
  });

  it("no-op for a non-binding route", () => {
    const r = checkCallerBinding(reqWith(), cfg, "POST /v1/matched-trades/settle", {});
    assert.equal(r.ok, true);
  });

  it("rejects a binding route with no caller token (401)", () => {
    const r = checkCallerBinding(reqWith(), cfg, "POST /v1/pools/swap/request", {
      swapper: ALICE,
    });
    assert.equal(r.ok, false);
    assert.equal((r as { status: number }).status, 401);
  });

  it("rejects acting for another party (403)", () => {
    const r = checkCallerBinding(
      reqWith(signHs256({ sub: ALICE })),
      cfg,
      "POST /v1/pools/swap/request",
      { swapper: BOB }, // caller is alice, names bob
    );
    assert.equal(r.ok, false);
    assert.equal((r as { status: number }).status, 403);
  });

  it("allows acting for one's own party (flat field)", () => {
    const r = checkCallerBinding(
      reqWith(signHs256({ sub: ALICE })),
      cfg,
      "POST /v1/pools/add-liquidity/request",
      { recipient: ALICE },
    );
    assert.equal(r.ok, true);
  });

  it("binds the swap route via swapperAccount.owner", () => {
    const ok = checkCallerBinding(
      reqWith(signHs256({ sub: ALICE })),
      cfg,
      "POST /v1/pools/swap",
      { swapperAccount: { owner: ALICE, provider: null, id: "" } },
    );
    assert.equal(ok.ok, true);
    const bad = checkCallerBinding(
      reqWith(signHs256({ sub: ALICE })),
      cfg,
      "POST /v1/pools/swap",
      { swapperAccount: { owner: BOB, provider: null, id: "" } },
    );
    assert.equal(bad.ok, false);
    assert.equal((bad as { status: number }).status, 403);
  });

  it("accepts a Bearer-prefixed caller token", () => {
    const r = checkCallerBinding(
      reqWith(`Bearer ${signHs256({ sub: ALICE })}`),
      cfg,
      "POST /v1/rfq",
      { trader: ALICE },
    );
    assert.equal(r.ok, true);
  });
});
