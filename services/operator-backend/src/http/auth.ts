// Admin auth middleware. Bearer token required for /v1/admin/* writes.
//
// Token is configured via OPERATOR_ADMIN_TOKEN env var (read by the
// caller and passed into HttpServerConfig.adminToken). If the token is
// unset, ALL admin writes are rejected — production should fail closed.
//
// The middleware does not gate reads (GET) on admin routes since the
// config dump is not sensitive (dealer whitelist, policy params). To
// require auth on reads as well, add the path here.

import type { IncomingMessage } from "node:http";

export type AuthCheck =
  | { ok: true }
  | { ok: false; status: number; code: string; message: string };

const WRITE_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

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
  const auth = req.headers["authorization"];
  if (typeof auth !== "string" || auth !== `Bearer ${adminToken}`) {
    return {
      ok: false,
      status: 401,
      code: "unauthorized",
      message: "missing or invalid admin token",
    };
  }
  return { ok: true };
}
