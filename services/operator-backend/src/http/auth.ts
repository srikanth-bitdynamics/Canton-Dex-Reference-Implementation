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
  // Deliberately NOT listed: POST /v1/testnet/party. The faucet's whole job is
  // to bootstrap a tester who has no credentials yet, so requiring the
  // operator token would defeat it. It is gated instead by
  // DEX_TESTNET_ONBOARDING (the route does not exist without it), a per-IP
  // throttle and a global daily cap, and it only ever grants rights on the
  // party it just allocated.
  //
  // Deliberately NOT listed for the same reason: POST /v1/testnet/submit. The
  // party the faucet hands out lives on the operator's participant, so the
  // tester's browser has to ask this backend to submit for it — and the
  // operator token cannot be shipped to a browser without handing every visitor
  // the keys to /v1/wallet/submit, which relays arbitrary commands under the
  // operator's JWT. The submit route earns its exemption by removing the
  // freedoms the token would otherwise have to guard: DEX_TESTNET_ONBOARDING
  // gates its existence, actAs is fixed server-side to the one faucet-minted
  // party the caller was verified to own, the commands must match a fixed
  // (template, choice) allowlist, disclosure is attached by the operator, and
  // per-IP + global daily caps bound the whole thing. See
  // ../testnet-onboarding/submit.ts.
  //
  // Deliberately NOT listed, and the one exemption that covers OPERATOR-
  // authority writes: POST /v1/testnet/swap. A swap is three transactions and
  // two of them — /v1/pools/swap/request and /v1/pools/swap, both listed above —
  // are the operator's. So a faucet party gets through the trader step via
  // /v1/testnet/submit and then stops. The alternative is dropping the token
  // from those two operator routes, which would let anyone drive the operator's
  // swap surface for any party; this route instead performs all three steps for
  // one faucet party and hands the caller no degree of freedom to abuse:
  // DEX_TESTNET_ONBOARDING gates its existence, the party must pass the same
  // faucet-provenance + hosting check the relay applies, the input holdings are
  // SELECTED server-side from holdings that party owns (never named in the
  // body), the price floor defaults to the operator's own quote, the trader step
  // goes through the relay above unchanged, and the same daily caps apply. See
  // ../testnet-onboarding/swap.ts.
  //
  // Deliberately NOT listed, on the same terms: POST /v1/testnet/liquidity. Add
  // and remove are three transactions each and two of them are the operator's —
  // /v1/pools/add-liquidity/{request,settle} and their remove twins, all four
  // listed above — so a faucet party authors its allocations and then stops,
  // and the add fails with 401. The alternative is dropping the token from
  // those four, which would let anyone drive the operator's liquidity surface
  // for any party. This route instead performs all three steps for one faucet
  // party under the same bounds as the swap: DEX_TESTNET_ONBOARDING gates its
  // existence, the party must pass the same faucet-provenance + hosting check,
  // the funding is SELECTED server-side from holdings that party owns (its
  // deposits on an add, its LP position on a remove — never named in the body),
  // the settle binds to the request and the allocations the relay produced
  // rather than to any cid the caller supplied, the LP-mint and payout floors
  // default to the operator's own quote, the LP step goes through the relay
  // above unchanged, and the same daily caps apply. See
  // ../testnet-onboarding/liquidity.ts.
  //
  // Deliberately NOT listed, on the same terms: POST /v1/testnet/order and POST
  // /v1/testnet/order/cancel. Placing an order is four transactions and two of
  // them are the operator's — /v1/orders/bind and /v1/orders/fund, both listed
  // above — while the first, the trader's own OrderFundingRequest, is a CREATE
  // and so is refused by the relay's exercise-only allowlist. A faucet party
  // therefore cannot take a single step of it. The alternatives are both worse:
  // dropping the token from bind/fund would let anyone drive the operator's
  // order surface for any party, and admitting creates to the relay's allowlist
  // would let anyone author any template the package defines. This route
  // instead performs all four steps for one faucet party under the same bounds
  // as the swap: DEX_TESTNET_ONBOARDING gates its existence, the party must
  // pass the same faucet-provenance + hosting check, the pair must be one this
  // deployment lists under its own admin, the collateral is SELECTED
  // server-side from holdings that party owns (never named in the body), the
  // settlement reference is server-generated, the collateral step goes through
  // the relay above unchanged, and the same daily caps apply. Cancel is
  // operator-authority throughout — Order_Cancel is `controller operator`, so
  // the operator can cancel any order on the book — and earns its exemption by
  // resolving the order on-ledger and refusing it unless the order's trader is
  // the calling party. See ../testnet-onboarding/order.ts.
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
