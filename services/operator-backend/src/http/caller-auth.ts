// Per-caller party binding for operator-authority write routes.
//
// The operator bearer token (checkOperatorAuth) authenticates the *backend
// client* — but on its own it lets any holder name an arbitrary party as the
// subject of a write the operator then performs on that party's behalf
// (finding B-2: "shared operator token can still name any well-formed party").
//
// This module adds the missing binding: a per-caller JWT, carried in a
// dedicated header (X-Caller-Token), whose `sub` claim is the caller's Canton
// party id. Write routes that act on behalf of a trader require this token and
// reject the request unless the route's subject-party field equals the caller's
// own party. So a caller can only ever drive a swap / liquidity / order / rfq
// for themselves, never for a party they do not control.
//
// The token is HS256-signed with a shared secret (DEX_CALLER_JWT_SECRET),
// matching the Splice / LocalNet unsafe-JWT convention (sub = party id). HS256
// is verified here with node's built-in crypto — no new dependency.
//
// Binding is OFF unless DEX_CALLER_JWT_SECRET is configured, so existing
// trusted single-backend deployments are unchanged; multi-tenant deployments
// turn it on to get per-trader authorization. When ON it is fail-closed: a
// trader-subject route with no/!invalid caller token is rejected.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

import type { AuthCheck } from "./auth.js";

export interface CallerAuthConfig {
  /** HS256 secret for the per-caller party JWT. Binding is off when unset. */
  callerJwtSecret: string | undefined;
  /**
   * Required `aud` claim. When set, a caller token whose audience does not
   * include this value is rejected — stops a token minted for another service
   * (e.g. the ledger API) from being replayed against this operator backend.
   */
  callerJwtAudience?: string | undefined;
}

// Map each operator-write route to the request-body field naming the party the
// operator acts on behalf of (the "subject"). Only routes that act for a trader
// are listed; operator/admin-authority routes (matched-trades/*, orders/match,
// rfq/accept's asset admin) are intentionally absent — they are gated by the
// operator/admin token, not bound to a trader caller.
//
// `swapperAccountOwner` marks the swap route whose subject is the nested
// swapperAccount.owner rather than a flat field.
type SubjectField = { kind: "field"; field: string } | { kind: "swapperAccountOwner" };

const SUBJECT_PARTY_BY_ROUTE: Record<string, SubjectField> = {
  "POST /v1/pools/swap": { kind: "swapperAccountOwner" },
  "POST /v1/pools/swap/request": { kind: "field", field: "swapper" },
  "POST /v1/pools/add-liquidity/request": { kind: "field", field: "recipient" },
  "POST /v1/pools/add-liquidity/settle": { kind: "field", field: "recipient" },
  "POST /v1/pools/remove-liquidity/request": { kind: "field", field: "holder" },
  "POST /v1/pools/remove-liquidity/settle": { kind: "field", field: "holder" },
  "POST /v1/rfq": { kind: "field", field: "trader" },
};

/** Does this route act on behalf of a trader subject (and thus need binding)? */
export function routeBindsCaller(routeKey: string): boolean {
  return routeKey in SUBJECT_PARTY_BY_ROUTE;
}

function base64UrlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export interface VerifyOptions {
  /** Required audience. When set, the token's `aud` must include it. */
  audience?: string | undefined;
  /**
   * Require an `exp` claim. Defaults to true: a caller token with no expiry is
   * rejected, so a leaked token cannot be replayed forever.
   */
  requireExp?: boolean;
}

/**
 * Verify an HS256 JWT against the shared secret and return its claims. Returns
 * null on any structural / signature / parse / expiry / audience failure
 * (never throws). By default an `exp` claim is REQUIRED.
 */
export function verifyHs256(
  token: string,
  secret: string,
  opts: VerifyOptions = {},
): Record<string, unknown> | null {
  const requireExp = opts.requireExp ?? true;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  // Header must declare HS256 (reject "none" and asymmetric algs).
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(base64UrlDecode(headerB64).toString("utf8"));
  } catch {
    return null;
  }
  if (header.alg !== "HS256") return null;

  const expectedSig = createHmac("sha256", secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest();
  const givenSig = base64UrlDecode(sigB64);
  if (expectedSig.length !== givenSig.length) return null;
  if (!timingSafeEqual(expectedSig, givenSig)) return null;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64).toString("utf8"));
  } catch {
    return null;
  }

  // Expiry: required by default, and honoured when present.
  if (typeof payload.exp === "number") {
    if (Date.now() / 1000 > payload.exp) return null;
  } else if (requireExp) {
    return null;
  }

  // Audience: when an expected aud is configured, the token's `aud` (string or
  // string[]) must include it.
  if (opts.audience !== undefined) {
    const aud = payload.aud;
    const ok =
      aud === opts.audience ||
      (Array.isArray(aud) && aud.includes(opts.audience));
    if (!ok) return null;
  }

  return payload;
}

/**
 * Extract + verify the caller's party from the X-Caller-Token header. Returns
 * null when the header is absent or the token fails verification (signature,
 * expiry, audience, or no `sub`). Exported so service routes whose subject
 * party is on-ledger (RFQ accept/cancel) can do a fetch-based binding the
 * body-map cannot express.
 */
export function callerPartyFromRequest(
  req: IncomingMessage,
  cfg: CallerAuthConfig,
): string | null {
  if (!cfg.callerJwtSecret) return null;
  const raw = req.headers["x-caller-token"];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (typeof header !== "string" || header.length === 0) return null;
  // Accept "Bearer <jwt>" or a bare token.
  const token = header.startsWith("Bearer ") ? header.slice(7) : header;
  const claims = verifyHs256(token, cfg.callerJwtSecret, {
    audience: cfg.callerJwtAudience,
  });
  if (!claims) return null;
  const sub = claims.sub;
  return typeof sub === "string" && sub.length > 0 ? sub : null;
}

function subjectParty(spec: SubjectField, body: unknown): unknown {
  if (typeof body !== "object" || body === null) return undefined;
  const o = body as Record<string, unknown>;
  if (spec.kind === "field") return o[spec.field];
  // swapperAccountOwner
  const acct = o.swapperAccount;
  if (typeof acct !== "object" || acct === null) return undefined;
  return (acct as Record<string, unknown>).owner;
}

/**
 * Enforce that the caller (per-caller JWT `sub`) is the subject party of a
 * trader-on-behalf-of write. No-op for non-binding routes or when the binding
 * secret is unset. Fail-closed when ON: missing/invalid caller token, or a
 * subject party that is not the caller's, is rejected.
 */
export function checkCallerBinding(
  req: IncomingMessage,
  cfg: CallerAuthConfig,
  routeKey: string,
  body: unknown,
): AuthCheck {
  const spec = SUBJECT_PARTY_BY_ROUTE[routeKey];
  if (!spec) return { ok: true };
  if (!cfg.callerJwtSecret) return { ok: true }; // binding disabled

  const caller = callerPartyFromRequest(req, cfg);
  if (!caller) {
    return {
      ok: false,
      status: 401,
      code: "unauthorized",
      message:
        "this route acts on behalf of a party and requires a valid X-Caller-Token (per-caller party JWT)",
    };
  }

  const subject = subjectParty(spec, body);
  if (typeof subject !== "string" || subject !== caller) {
    return {
      ok: false,
      status: 403,
      code: "forbidden",
      message: "caller may only act for its own party",
    };
  }
  return { ok: true };
}
