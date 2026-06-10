// Auth middleware for the operator HTTP surface.
//
// Two bearer-token gates, both fail-closed:
//
//   - Admin token (OPERATOR_ADMIN_TOKEN -> HttpServerConfig.adminToken):
//     required for writes to /v1/admin/*. Config dump (GET) stays open
//     since it is not sensitive (dealer whitelist, policy params).
//
//   - Operator token (DEX_OPERATOR_API_TOKEN -> HttpServerConfig.operatorToken):
//     required for ALL other state-changing routes (POST swap, add/remove
//     liquidity settle, orders cancel/fund/bind, rfq create/accept/cancel,
//     matched-trade settle, order match-execute, ...). If the token is unset
//     the gate fails closed unless DEX_DEV_OPEN=1 is set (in-memory dev only),
//     which lets the dev-server run without auth.
//
// Both compares use crypto.timingSafeEqual (length-guarded) to avoid leaking
// the token through response-time differences.

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export type AuthCheck =
  | { ok: true }
  | { ok: false; status: number; code: string; message: string };

const WRITE_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

/**
 * Constant-time bearer-token comparison. Returns false (no exception) on
 * any shape/length mismatch — timingSafeEqual throws if the buffers differ
 * in length, so we guard that first.
 */
export function bearerMatches(
  authHeader: string | string[] | undefined,
  token: string,
): boolean {
  if (typeof authHeader !== "string") return false;
  const expected = `Bearer ${token}`;
  const a = Buffer.from(authHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function checkAdminAuth(
  req: IncomingMessage,
  adminToken: string | undefined,
  path: string,
): AuthCheck {
  if (!path.startsWith("/v1/admin/")) return { ok: true };
  if (!WRITE_METHODS.has(req.method ?? "GET")) return { ok: true };
  if (!adminToken) {
    return {
      ok: false,
      status: 401,
      code: "unauthorized",
      message: "admin writes require OPERATOR_ADMIN_TOKEN to be configured",
    };
  }
  if (!bearerMatches(req.headers["authorization"], adminToken)) {
    return {
      ok: false,
      status: 401,
      code: "unauthorized",
      message: "missing or invalid admin token",
    };
  }
  return { ok: true };
}

// Write routes that move funds / change ledger state and must carry the
// operator token. /v1/admin/* is handled separately by checkAdminAuth.
// Exact paths plus a few cid-suffixed patterns matched via regex.
const OPERATOR_WRITE_EXACT = new Set<string>([
  // The wallet relay forwards arbitrary commands under the operator's JWT;
  // it must carry the operator token like every other state-changing route.
  // (It is additionally gated by walletRelayEnabled + a party allowlist in
  // the handler, but the auth gate is the first line of defence.)
  "/v1/wallet/submit",
  "/v1/pools/swap",
  "/v1/pools/swap/request",
  "/v1/pools/add-liquidity/request",
  "/v1/pools/add-liquidity/settle",
  "/v1/pools/remove-liquidity/request",
  "/v1/pools/remove-liquidity/settle",
  "/v1/pools/recover-dvp-allocations",
  "/v1/orders/bind",
  "/v1/orders/fund",
  "/v1/orders/match",
  "/v1/matched-trades/request-allocations",
  "/v1/matched-trades/settle",
  "/v1/matched-trades/cancel",
  "/v1/rfq",
  "/v1/rfq/accept",
]);

const OPERATOR_WRITE_PATTERNS: RegExp[] = [
  /^\/v1\/orders\/[^/]+\/cancel$/,
  /^\/v1\/rfq\/[^/]+\/cancel$/,
];

export function isOperatorWrite(method: string, path: string): boolean {
  if (!WRITE_METHODS.has(method)) return false;
  if (path.startsWith("/v1/admin/")) return false; // admin gate handles these
  if (OPERATOR_WRITE_EXACT.has(path)) return true;
  return OPERATOR_WRITE_PATTERNS.some((re) => re.test(path));
}

export interface OperatorAuthConfig {
  operatorToken: string | undefined;
  /** Dev bypass: allow operator writes with no token (in-memory dev only). */
  devOpen: boolean;
}

/**
 * Gate state-changing operator routes behind the operator token. Fails
 * closed when the token is unset unless `devOpen` is true.
 */
export function checkOperatorAuth(
  req: IncomingMessage,
  cfg: OperatorAuthConfig,
  path: string,
): AuthCheck {
  const method = req.method ?? "GET";
  if (!isOperatorWrite(method, path)) return { ok: true };
  if (!cfg.operatorToken) {
    if (cfg.devOpen) return { ok: true };
    return {
      ok: false,
      status: 401,
      code: "unauthorized",
      message:
        "state-changing routes require DEX_OPERATOR_API_TOKEN to be configured (or DEX_DEV_OPEN=1 for the dev server)",
    };
  }
  if (!bearerMatches(req.headers["authorization"], cfg.operatorToken)) {
    return {
      ok: false,
      status: 401,
      code: "unauthorized",
      message: "missing or invalid operator token",
    };
  }
  return { ok: true };
}
