// HTTP shim around the operator backend services. The dApp calls
// these endpoints; the operator backend translates them into ledger
// submissions.
//
// Runs on Node's built-in http server (no framework dependency). Not
// production-grade auth; production should put this behind an auth
// proxy that validates the trader's session.
//
// Endpoints (single-source list; matches `app/web/src/services/ledger.ts`):
//
//   Read:
//     GET  /v1/context                  -> DexContext (parties + factory cids)
//     GET  /v1/status                   -> { network, slot, synced }
//     GET  /v1/pools                    -> Pool[]
//     GET  /v1/pairs                    -> DexPair[]
//     GET  /v1/orders?trader=:p         -> Order[]
//     GET  /v1/holdings?owner=:p        -> Holding[]
//
//   Quote (off-chain; advisory, on-chain Pool_Swap re-validates):
//     POST /v1/swaps/quote              -> { outputAmount }
//
//   Operator-driven write:
//     POST /v1/pools/swap               -> Pool_Swap result
//     POST /v1/pools/remove-liquidity   -> Pool_RemoveLiquidity result
//     POST /v1/orders/bind              -> { orderCid, allocationRequestCid }
//     POST /v1/orders/fund              -> { orderCid }
//     POST /v1/orders/:cid/cancel       -> {}
//     POST /v1/rfq/accept               -> { tradeCid, receipt }
//
// The dApp polls the ledger event stream directly for live state; the
// HTTP API is for one-shot orchestration calls only. Trader-authority
// writes (place order, add liquidity, swap-side allocation creation)
// do NOT have HTTP endpoints -- they go through the trader's wallet
// per docs/wallet-vs-dapp-boundary.md.

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { OperatorBackend } from "../index.js";
import type { Party, Pool } from "../types.js";
import type { Db } from "../indexer/db.js";
import { OperatorConfig } from "../indexer/config.js";
import { checkAdminAuth } from "./auth.js";
import { rootLogger } from "../lib/logger.js";

const httpLog = rootLogger.child({ component: "http" });

// Allowed origins for CORS, derived from ALLOWED_ORIGINS env var (csv).
// Empty list means allow-all (legacy behaviour).
function parseAllowedOrigins(): string[] {
  const raw = process.env.ALLOWED_ORIGINS;
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function originAllowed(origin: string | undefined, allowed: string[]): string {
  if (allowed.length === 0) return "*";
  if (!origin) return allowed[0]!;
  return allowed.includes(origin) ? origin : allowed[0]!;
}

class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

function badRequest(message: string, details?: unknown): never {
  throw new HttpError(400, "bad_request", message, details);
}

function expectString(o: unknown, field: string): string {
  if (typeof o !== "object" || o === null) badRequest("expected JSON object");
  const v = (o as Record<string, unknown>)[field];
  if (typeof v !== "string" || v.length === 0) {
    badRequest(`missing or invalid field: ${field}`, { field, expected: "non-empty string" });
  }
  return v as string;
}

function expectField<T = unknown>(o: unknown, field: string): T {
  if (typeof o !== "object" || o === null) badRequest("expected JSON object");
  const v = (o as Record<string, unknown>)[field];
  if (v === undefined) badRequest(`missing field: ${field}`, { field });
  return v as T;
}

/**
 * Static context the dApp needs to build trader-authority intents. The
 * dApp does not derive these from queries — it would have to guess
 * which admin governs which instrument, which factory CID to use, etc.
 * Surfacing them here keeps that knowledge on the operator's side.
 */
export interface DexContext {
  operator: Party;
  lpRegistrar: Party;
  admin: Party;
  allocationFactoryCid: string;
  settlementFactoryCid: string;
  network: string;
}

export interface DexStatus {
  network: string;
  /** Monotonic counter while this process runs. Stand-in for a real participant offset. */
  slot: number;
  synced: boolean;
  /** ISO timestamp the server cut this snapshot. */
  serverTime: string;
}

export interface HttpServerConfig {
  backend: OperatorBackend;
  port: number;
  host?: string;
  /** Static context payload returned at GET /v1/context. */
  context: DexContext;
  /** Optional persistence handle for indexer-driven endpoints. */
  db?: Db;
  /** Shared bearer token required for /v1/admin/* writes. */
  adminToken?: string;
}

export function startHttpServer(cfg: HttpServerConfig): {
  close: () => Promise<void>;
  url: string;
} {
  // Slot starts at the seeded baseline and increments by 1 each second so
  // the UI's pill moves visibly. Real deployments swap this for the
  // participant's actual ledger offset.
  let slot = 4128442;
  const slotTimer = setInterval(() => {
    slot += 1;
  }, 1000);
  // Allow the tick timer to be GC'd if the server is closed.
  if (typeof slotTimer.unref === "function") slotTimer.unref();

  const allowedOrigins = parseAllowedOrigins();
  const server = createServer(async (req, res) => {
    const requestId = (req.headers["x-request-id"] as string | undefined) ?? randomUUID();
    res.setHeader("X-Request-Id", requestId);
    const reqLog = httpLog.child({ requestId, method: req.method, path: req.url });
    const started = Date.now();
    try {
      await routeRequest(
        cfg.backend,
        cfg.context,
        () => slot,
        cfg.db,
        cfg.adminToken,
        allowedOrigins,
        req,
        res,
      );
      reqLog.info("request completed", { status: res.statusCode, durationMs: Date.now() - started });
    } catch (e) {
      if (e instanceof HttpError) {
        reqLog.warn("request rejected", { status: e.status, code: e.code, error: e.message });
        respondJson(res, e.status, { error: e.message, code: e.code, details: e.details, requestId });
        return;
      }
      reqLog.error("request failed", { error: e instanceof Error ? e.message : String(e) });
      respondJson(res, 500, {
        error: e instanceof Error ? e.message : String(e),
        code: "internal_error",
        requestId,
      });
    }
  });
  server.listen(cfg.port, cfg.host ?? "127.0.0.1");
  return {
    url: `http://${cfg.host ?? "127.0.0.1"}:${cfg.port}`,
    close: () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      ),
  };
}

async function routeRequest(
  backend: OperatorBackend,
  context: DexContext,
  getSlot: () => number,
  db: Db | undefined,
  adminToken: string | undefined,
  allowedOrigins: string[],
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://x");
  const path = url.pathname;
  const method = req.method ?? "GET";

  // CORS: narrow to ALLOWED_ORIGINS if set, else allow-all (dev).
  const origin = req.headers["origin"] as string | undefined;
  res.setHeader("Access-Control-Allow-Origin", originAllowed(origin, allowedOrigins));
  if (allowedOrigins.length > 0) res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Request-Id");
  res.setHeader("Access-Control-Expose-Headers", "X-Request-Id");
  if (method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  // Admin auth gate: writes to /v1/admin/* require the bearer token.
  const auth = checkAdminAuth(req, adminToken, path);
  if (!auth.ok) {
    respondJson(res, auth.status, { error: auth.message, code: auth.code });
    return;
  }

  // === read endpoints ====================================================

  if (method === "GET" && path === "/v1/context") {
    respondJson(res, 200, context);
    return;
  }

  if (method === "GET" && path === "/v1/status") {
    const body: DexStatus = {
      network: context.network,
      slot: getSlot(),
      synced: true,
      serverTime: new Date().toISOString(),
    };
    respondJson(res, 200, body);
    return;
  }

  if (method === "GET" && path === "/v1/pools") {
    const pools = await backend.pool.listActive();
    respondJson(res, 200, pools);
    return;
  }

  if (method === "GET" && path === "/v1/pairs") {
    // The DexPair contract template lives in pr5333/CantonDex/Dex/DexPair.daml.
    // The operator queries the ACS via the ledger driver.
    const pairs = await backend.ledger.query<unknown>({
      templateId: "CantonDex.Dex.DexPair:DexPair",
      observingParty: backend.operatorParty,
    });
    respondJson(res, 200, pairs);
    return;
  }

  if (method === "GET" && path === "/v1/orders") {
    const trader = url.searchParams.get("trader");
    if (!trader) {
      throw new HttpError(400, "bad_request", "missing ?trader= query parameter");
    }
    const all = await backend.order.listOpen();
    respondJson(
      res,
      200,
      all.filter((o) => o.trader === trader),
    );
    return;
  }

  if (method === "GET" && path === "/v1/credentials") {
    const holder = url.searchParams.get("holder");
    if (!holder) {
      respondJson(res, 400, { error: "missing ?holder=" });
      return;
    }
    const creds = await backend.ledger.query<{ holder: string }>({
      templateId: "CantonDex.Instrument.Credentials:Credential",
      observingParty: backend.operatorParty,
    });
    respondJson(res, 200, creds.filter((c) => c.holder === holder));
    return;
  }

  if (method === "GET" && path === "/v1/instruments") {
    const idsParam = url.searchParams.get("ids");
    const ids = idsParam ? idsParam.split(",").map((s) => s.trim()).filter(Boolean) : null;
    const all = await backend.ledger.query<{ instrumentId: string }>({
      templateId: "CantonDex.Instrument.InstrumentConfiguration:InstrumentConfiguration",
      observingParty: backend.operatorParty,
    });
    respondJson(res, 200, ids ? all.filter((c) => ids.includes(c.instrumentId)) : all);
    return;
  }

  if (method === "GET" && path === "/v1/orders/book") {
    const base = url.searchParams.get("base");
    const quote = url.searchParams.get("quote");
    if (!base || !quote) {
      respondJson(res, 400, { error: "missing ?base= or ?quote=" });
      return;
    }
    const book = await backend.order.book({
      baseInstrumentId: base,
      quoteInstrumentId: quote,
    });
    respondJson(res, 200, book);
    return;
  }

  if (method === "POST" && path === "/v1/orders/match") {
    const body = await readJson<{ base: string; quote: string }>(req);
    if (!body.base || !body.quote) {
      respondJson(res, 400, { error: "expected { base, quote }" });
      return;
    }
    const matches = await backend.order.findMatches({
      baseInstrumentId: body.base,
      quoteInstrumentId: body.quote,
    });
    respondJson(res, 200, { matches });
    return;
  }

  if (method === "GET" && path === "/v1/prices") {
    const pairsParam = url.searchParams.get("pairs");
    if (!pairsParam) {
      respondJson(res, 400, { error: "missing ?pairs=BASE/QUOTE,BASE/QUOTE" });
      return;
    }
    const pairs = pairsParam.split(",").map((s) => s.trim()).filter(Boolean);
    const prices = await backend.pricing.quoteMany(pairs);
    respondJson(res, 200, { prices });
    return;
  }

  if (method === "GET" && path === "/v1/holdings") {
    const owner = url.searchParams.get("owner");
    if (!owner) {
      throw new HttpError(400, "bad_request", "missing ?owner= query parameter");
    }
    // Holdings are read off the registry-side template; the operator
    // reads via the ledger driver as observer-of-registrar.
    const holdings = await backend.ledger.query<{ owner: string }>({
      templateId: "CantonDex.Instrument.Holding:Holding",
      observingParty: backend.operatorParty,
    });
    respondJson(
      res,
      200,
      holdings.filter((h) => h.owner === owner),
    );
    return;
  }

  // === indexer-backed history ==========================================
  // Available only when the server was started with a `db` handle.

  if (method === "GET" && path === "/v1/trades") {
    if (!db) {
      respondJson(res, 503, { error: "indexer disabled" });
      return;
    }
    const trader = url.searchParams.get("trader");
    const pair = url.searchParams.get("pair");
    const limit = Math.min(
      parseInt(url.searchParams.get("limit") ?? "50", 10),
      500,
    );
    const where: string[] = [];
    const args: unknown[] = [];
    if (trader) {
      where.push("trader = ?");
      args.push(trader);
    }
    if (pair) {
      where.push("pair = ?");
      args.push(pair);
    }
    const sql =
      "SELECT tradeCid, ts, pair, trader, dealer, policyVersion, " +
      "acceptedRank, consideredCount FROM trades " +
      (where.length ? `WHERE ${where.join(" AND ")} ` : "") +
      `ORDER BY ts DESC LIMIT ${limit}`;
    respondJson(res, 200, db.prepare(sql).all(...args));
    return;
  }

  if (method === "GET" && path === "/v1/swaps") {
    if (!db) {
      respondJson(res, 503, { error: "indexer disabled" });
      return;
    }
    const pair = url.searchParams.get("pair");
    const limit = Math.min(
      parseInt(url.searchParams.get("limit") ?? "50", 10),
      500,
    );
    const sql = pair
      ? `SELECT * FROM swaps WHERE pair = ? ORDER BY ts DESC LIMIT ${limit}`
      : `SELECT * FROM swaps ORDER BY ts DESC LIMIT ${limit}`;
    respondJson(res, 200, pair ? db.prepare(sql).all(pair) : db.prepare(sql).all());
    return;
  }

  // === operator config (admin-auth) ====================================

  if (path.startsWith("/v1/admin/config")) {
    if (!db) {
      respondJson(res, 503, { error: "config disabled" });
      return;
    }
    const auth = req.headers["authorization"];
    const okWrite =
      adminToken &&
      typeof auth === "string" &&
      auth === `Bearer ${adminToken}`;
    const cfg = new OperatorConfig(db);

    if (method === "GET" && path === "/v1/admin/config") {
      // Read is open by default — config is not sensitive (dealer
      // whitelist, policy params); production may want to gate this.
      respondJson(res, 200, cfg.list());
      return;
    }
    if (method === "PUT" && path === "/v1/admin/config") {
      if (!okWrite) {
        throw new HttpError(401, "unauthorized", "missing or invalid admin token");
      }
      const body = await readJson<{ key: string; value: string }>(req);
      if (!body.key || typeof body.value !== "string") {
        respondJson(res, 400, { error: "expected { key, value: string }" });
        return;
      }
      cfg.set(body.key, body.value);
      respondJson(res, 200, { ok: true });
      return;
    }
    if (method === "DELETE" && path.startsWith("/v1/admin/config/")) {
      if (!okWrite) {
        throw new HttpError(401, "unauthorized", "missing or invalid admin token");
      }
      const key = decodeURIComponent(path.slice("/v1/admin/config/".length));
      cfg.delete(key);
      respondJson(res, 200, { ok: true });
      return;
    }
  }

  if (method === "GET" && path === "/v1/rfq/history") {
    if (!db) {
      respondJson(res, 503, { error: "indexer disabled" });
      return;
    }
    const trader = url.searchParams.get("trader");
    const limit = Math.min(
      parseInt(url.searchParams.get("limit") ?? "100", 10),
      500,
    );
    const sql = trader
      ? `SELECT * FROM rfq_history WHERE trader = ? ORDER BY ts DESC LIMIT ${limit}`
      : `SELECT * FROM rfq_history ORDER BY ts DESC LIMIT ${limit}`;
    respondJson(
      res,
      200,
      trader ? db.prepare(sql).all(trader) : db.prepare(sql).all(),
    );
    return;
  }

  // === quote ============================================================

  if (method === "POST" && path === "/v1/swaps/quote") {
    const raw = await readJson<unknown>(req);
    const poolId = expectString(raw, "poolId");
    const inputInstrumentId = expectString(raw, "inputInstrumentId");
    const inputAmount = expectString(raw, "inputAmount");
    if (Number.isNaN(parseFloat(inputAmount)) || parseFloat(inputAmount) <= 0) {
      badRequest("inputAmount must be a positive decimal string", { field: "inputAmount" });
    }
    const pools = await backend.pool.listActive();
    const pool = pools.find((p) => p.contractId === (poolId as never));
    if (!pool) {
      throw new HttpError(404, "not_found", "pool not found", { poolId });
    }
    const out = backend.pool.computeQuote(
      pool,
      inputInstrumentId,
      inputAmount,
    );
    respondJson(res, 200, { outputAmount: out });
    return;
  }

  // === operator-driven writes ===========================================

  if (method === "GET" && path === "/v1/rfq") {
    const result = await backend.rfq.list();
    respondJson(res, 200, result);
    return;
  }

  if (method === "POST" && path === "/v1/rfq") {
    const body = await readJson<Parameters<typeof backend.rfq.create>[0]>(req);
    const result = await backend.rfq.create(body);
    respondJson(res, 200, result);
    return;
  }

  // /v1/rfq/:cid/cancel
  const rfqCancelMatch = path.match(/^\/v1\/rfq\/([^/]+)\/cancel$/);
  if (method === "POST" && rfqCancelMatch) {
    const rfqCid = decodeURIComponent(rfqCancelMatch[1]!);
    await backend.rfq.cancel({ rfqCid: rfqCid as never });
    respondJson(res, 204, {});
    return;
  }

  if (method === "POST" && path === "/v1/rfq/accept") {
    const body = await readJson<Parameters<typeof backend.rfq.accept>[0]>(req);
    const result = await backend.rfq.accept(body);
    respondJson(res, 200, result);
    return;
  }

  if (method === "POST" && path === "/v1/orders/bind") {
    const body = await readJson<Parameters<typeof backend.order.bind>[0]>(req);
    const result = await backend.order.bind(body);
    respondJson(res, 200, result);
    return;
  }

  if (method === "POST" && path === "/v1/orders/fund") {
    const body = await readJson<Parameters<typeof backend.order.fund>[0]>(req);
    const result = await backend.order.fund(body);
    respondJson(res, 200, result);
    return;
  }

  // /v1/orders/:cid/cancel
  const cancelMatch = path.match(/^\/v1\/orders\/([^/]+)\/cancel$/);
  if (method === "POST" && cancelMatch) {
    const orderCid = decodeURIComponent(cancelMatch[1]!);
    await backend.order.cancel(orderCid as never);
    respondJson(res, 204, {});
    return;
  }

  if (method === "POST" && path === "/v1/pools/swap") {
    const body = await readJson<Parameters<typeof backend.pool.swap>[0]>(req);
    const result = await backend.pool.swap(body);
    respondJson(res, 200, result);
    return;
  }

  // === admin =============================================================

  if (method === "POST" && path === "/v1/admin/pairs") {
    const body = await readJson<
      Parameters<typeof backend.admin.createPair>[0]
    >(req);
    const result = await backend.admin.createPair(body);
    respondJson(res, 200, { pairCid: result });
    return;
  }

  const adminPairFee = path.match(/^\/v1\/admin\/pairs\/([^/]+)\/fee-model$/);
  if (method === "POST" && adminPairFee) {
    const pairCid = decodeURIComponent(adminPairFee[1]!);
    const body = await readJson<{ newFeeModel: Parameters<
      typeof backend.admin.updatePairFeeModel
    >[0]["newFeeModel"] }>(req);
    const result = await backend.admin.updatePairFeeModel({
      pairCid: pairCid as never,
      newFeeModel: body.newFeeModel,
    });
    respondJson(res, 200, { pairCid: result });
    return;
  }

  const adminPairActive = path.match(/^\/v1\/admin\/pairs\/([^/]+)\/active$/);
  if (method === "POST" && adminPairActive) {
    const pairCid = decodeURIComponent(adminPairActive[1]!);
    const body = await readJson<{ active: boolean }>(req);
    const result = await backend.admin.setPairActive({
      pairCid: pairCid as never,
      active: body.active,
    });
    respondJson(res, 200, { pairCid: result });
    return;
  }

  const adminPairMode = path.match(
    /^\/v1\/admin\/pairs\/([^/]+)\/trading-mode$/,
  );
  if (method === "POST" && adminPairMode) {
    const pairCid = decodeURIComponent(adminPairMode[1]!);
    const body = await readJson<{ newTradingMode: Parameters<
      typeof backend.admin.updateTradingMode
    >[0]["newTradingMode"] }>(req);
    const result = await backend.admin.updateTradingMode({
      pairCid: pairCid as never,
      newTradingMode: body.newTradingMode,
    });
    respondJson(res, 200, { pairCid: result });
    return;
  }

  if (method === "POST" && path === "/v1/admin/pools") {
    const body = await readJson<
      Parameters<typeof backend.admin.createPool>[0]
    >(req);
    const result = await backend.admin.createPool(body);
    respondJson(res, 200, { poolCid: result });
    return;
  }

  if (method === "POST" && path === "/v1/pools/remove-liquidity") {
    // Operator-driven half of the remove-liquidity flow: cancels the
    // pool's existing allocations, consolidates the remainder, and
    // creates the LPBurnRequest. The trader's LP-holding burn happens
    // separately via the wallet against the lpRegistrar's
    // LPTokenPolicy_AcceptBurn choice.
    const body = await readJson<
      Parameters<typeof backend.pool.removeLiquidity>[0]
    >(req);
    const result = await backend.pool.removeLiquidity(body);
    respondJson(res, 200, result);
    return;
  }

  throw new HttpError(404, "not_found", `no route: ${method} ${path}`);
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;
  const MAX_BODY = 1024 * 1024; // 1 MiB — generous for our shaped commands
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY) {
      throw new HttpError(413, "payload_too_large", "request body exceeds 1MiB");
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return {} as T;
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new HttpError(400, "bad_request", "malformed JSON body", {
      parseError: e instanceof Error ? e.message : String(e),
    });
  }
}

function respondJson(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

export type { Pool };
