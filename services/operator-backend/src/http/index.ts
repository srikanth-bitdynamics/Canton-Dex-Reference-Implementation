// HTTP surface over the operator backend services.
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
//     GET  /v1/holdings?owner=:p        -> Holding[] (per-contract, UTXO-style)
//     GET  /v1/balances?owner=:p        -> Balance[] (aggregated by instrument)
//
//   Quote (off-chain; advisory, on-chain PoolRules_Swap re-validates):
//     POST /v1/swaps/quote              -> { outputAmount }
//
//   Operator-driven write:
//     POST /v1/pools/swap               -> PoolRules_Swap result
//     POST /v1/pools/add-liquidity/request  -> LiquidityAllocationRequest payload
//     POST /v1/pools/add-liquidity/settle   -> PoolLiquidityRules_SettleAddLiquidity result
//     POST /v1/pools/remove-liquidity/request -> LiquidityAllocationRequest payload
//     POST /v1/pools/remove-liquidity/settle  -> PoolLiquidityRules_SettleRemoveLiquidity result
//     POST /v1/orders/bind              -> { orderCid, allocationRequestCid }
//     POST /v1/orders/fund              -> { orderCid }
//     POST /v1/orders/:cid/cancel       -> {}
//     POST /v1/rfq/accept               -> { tradeCid, receipt }
//
// The dApp polls the ledger event stream directly for live state; the
// HTTP API is for one-shot orchestration calls only. Trader-authority
// writes (place order, add liquidity, swap-side allocation creation)
// do NOT have HTTP endpoints -- they go through the trader's wallet.

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { OperatorBackend } from "../index.js";
import type { Party, Pool } from "../types.js";
import type { DisclosedContract } from "@canton-dex/registry-client";
import type { Db } from "../indexer/db.js";
import { OperatorConfig } from "../indexer/config.js";
import { LedgerError } from "../ledger/index.js";
import * as dec from "../pool/decimal.js";
import { DealersService } from "../dealers/index.js";
import { checkAdminAuth, checkOperatorAuth, bearerMatches } from "./auth.js";
import { checkCallerBinding, callerPartyFromRequest, type CallerAuthConfig } from "./caller-auth.js";
import { validateWriteBody, ValidationError } from "./validate.js";
import { RfqAuthError } from "../rfq/index.js";
import { rootLogger } from "../lib/logger.js";

const httpLog = rootLogger.child({ component: "http" });

// Allowed origins for CORS, derived from ALLOWED_ORIGINS env var (csv).
// Empty list means deny: no Access-Control-Allow-Origin header is
// emitted, so browsers reject cross-origin reads. Only echo back origins on
// the allowlist.
function parseAllowedOrigins(): string[] {
  const raw = process.env.ALLOWED_ORIGINS;
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

// Returns the origin to echo in Access-Control-Allow-Origin, or null to emit
// no CORS header at all (default-deny when the allowlist is empty or the
// request origin is not on it).
function originAllowed(origin: string | undefined, allowed: string[]): string | null {
  if (allowed.length === 0) return null;
  if (origin && allowed.includes(origin)) return origin;
  return null;
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
  allocationFactoryExtraArgs: {
    context: { values: Record<string, unknown> };
    meta: { values: Record<string, unknown> };
  };
  allocationFactoryDisclosure: DisclosedContract[];
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
  /** Bearer token required for all non-admin state-changing routes. */
  operatorToken?: string;
  /** Dev bypass: allow operator writes without a token (in-memory dev only). */
  devOpen?: boolean;
  /** Gate /v1/wallet/submit behind this flag; default OFF. */
  walletRelayEnabled?: boolean;
  /** Allowlist of actAs parties the wallet relay may forward for. */
  walletRelayParties?: string[];
  /**
   * HS256 secret for per-caller party binding (finding B-2). When set, write
   * routes that act on behalf of a trader require an X-Caller-Token JWT whose
   * `sub` is the caller's party, and reject any request whose subject party is
   * not the caller's own. Unset = binding disabled (single trusted backend).
   */
  callerJwtSecret?: string;
  /**
   * Required `aud` claim for the per-caller party JWT. When set, a caller token
   * whose audience does not include this value is rejected — stops a token
   * minted for another service from being replayed against this backend.
   */
  callerJwtAudience?: string;
  /** JSON LAPI base URL — used to poll the real ledger offset for /v1/status. */
  ledgerUrl?: string;
  /** JWT used to read the ledger offset. */
  ledgerToken?: string;
}

export function startHttpServer(cfg: HttpServerConfig): {
  close: () => Promise<void>;
  url: string;
} {
  // Slot is the ledger's latest offset (ACS pruning watermark). We poll
  // the participant every 2s and cache the result. Falls back to a local
  // counter if the participant query fails so the UI's pill still moves.
  let slot = 0;
  let lastPolledOk = false;
  const slotUrl = (cfg.ledgerUrl ?? "").replace(/\/$/, "");
  const slotToken = cfg.ledgerToken;
  async function pollSlot(): Promise<void> {
    if (!slotUrl || !slotToken) {
      slot += 1;
      return;
    }
    try {
      const res = await fetch(
        `${slotUrl}/v2/state/latest-pruned-offsets`,
        { headers: { Authorization: `Bearer ${slotToken}` } },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as {
        participantPrunedUpToInclusive?: number;
      };
      const offset = body.participantPrunedUpToInclusive;
      if (typeof offset === "number" && offset > 0) {
        slot = offset;
        lastPolledOk = true;
      } else {
        // Pruned offset is 0 (nothing pruned yet) — fall back to ACS end.
        const ledgerEndRes = await fetch(
          `${slotUrl}/v2/state/ledger-end`,
          { headers: { Authorization: `Bearer ${slotToken}` } },
        );
        if (ledgerEndRes.ok) {
          const end = (await ledgerEndRes.json()) as { offset?: number };
          if (typeof end.offset === "number") {
            slot = end.offset;
            lastPolledOk = true;
          }
        }
      }
    } catch {
      // Quiet on transient errors; keep the last good value or tick.
      if (!lastPolledOk) slot += 1;
    }
  }
  void pollSlot();
  const slotTimer = setInterval(() => {
    void pollSlot();
  }, 2000);
  if (typeof slotTimer.unref === "function") slotTimer.unref();

  const allowedOrigins = parseAllowedOrigins();
  const server = createServer(async (req, res) => {
    const requestId = (req.headers["x-request-id"] as string | undefined) ?? randomUUID();
    res.setHeader("X-Request-Id", requestId);
    const reqLog = httpLog.child({ requestId, method: req.method, path: req.url });
    const started = Date.now();
    try {
      await routeRequest(
        cfg,
        cfg.context,
        () => slot,
        cfg.db,
        allowedOrigins,
        req,
        res,
      );
      reqLog.info("request completed", { status: res.statusCode, durationMs: Date.now() - started });
    } catch (e) {
      if (e instanceof ValidationError) {
        reqLog.warn("request rejected", { status: 400, code: "bad_request", error: e.message });
        respondJson(res, 400, { error: e.message, code: "bad_request", details: e.details, requestId });
        return;
      }
      if (e instanceof HttpError) {
        reqLog.warn("request rejected", { status: e.status, code: e.code, error: e.message });
        respondJson(res, e.status, { error: e.message, code: e.code, details: e.details, requestId });
        return;
      }
      if (e instanceof RfqAuthError) {
        // Per-caller binding mismatch on a fetch-bound RFQ route (B-2).
        reqLog.warn("request rejected", { status: 403, code: "forbidden", error: e.message });
        respondJson(res, 403, { error: e.message, code: "forbidden", requestId });
        return;
      }
      if (e instanceof LedgerError && e.kind === "unsupported") {
        // A demo-mode limitation, not a server fault: surface it as a clean
        // 501 with an actionable message rather than a 500 internal_error.
        reqLog.warn("request unsupported", { status: 501, code: "not_supported", error: e.detail });
        respondJson(res, 501, { error: e.detail, code: "not_supported", requestId });
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
  cfg: HttpServerConfig,
  context: DexContext,
  getSlot: () => number,
  db: Db | undefined,
  allowedOrigins: string[],
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const backend = cfg.backend;
  const adminToken = cfg.adminToken;
  const ledgerUrl = cfg.ledgerUrl;
  const ledgerToken = cfg.ledgerToken;
  // Per-caller party binding config (finding B-2): secret + optional audience.
  const callerAuth: CallerAuthConfig = {
    callerJwtSecret: cfg.callerJwtSecret,
    callerJwtAudience: cfg.callerJwtAudience,
  };
  const url = new URL(req.url ?? "/", "http://x");
  const path = url.pathname;
  const method = req.method ?? "GET";

  // CORS: echo only allowlisted origins; default-deny (no header)
  // when ALLOWED_ORIGINS is unset or the origin is not on the list.
  const origin = req.headers["origin"] as string | undefined;
  const corsOrigin = originAllowed(origin, allowedOrigins);
  if (corsOrigin) res.setHeader("Access-Control-Allow-Origin", corsOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Request-Id");
  res.setHeader("Access-Control-Expose-Headers", "X-Request-Id");
  if (method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  // Admin auth gate: writes to /v1/admin/* require the admin bearer token.
  const auth = checkAdminAuth(req, adminToken, path);
  if (!auth.ok) {
    respondJson(res, auth.status, { error: auth.message, code: auth.code });
    return;
  }

  // Operator auth gate: all other state-changing routes require
  // the operator bearer token (fail-closed unless DEX_DEV_OPEN).
  const opAuth = checkOperatorAuth(
    req,
    { operatorToken: cfg.operatorToken, devOpen: cfg.devOpen ?? false },
    path,
  );
  if (!opAuth.ok) {
    respondJson(res, opAuth.status, { error: opAuth.message, code: opAuth.code });
    return;
  }

  // === read endpoints ====================================================

  if (method === "GET" && path === "/v1/context") {
    const [factories, choiceContext] = await Promise.all([
      backend.registry.getFactories(context.admin),
      backend.registry.getChoiceContext(context.admin),
    ]);
    respondJson(res, 200, {
      ...context,
      allocationFactoryCid: factories.allocationFactoryCid,
      settlementFactoryCid: factories.settlementFactoryCid,
      allocationFactoryExtraArgs: {
        context: choiceContext.context,
        meta: { values: {} },
      },
      allocationFactoryDisclosure: [
        ...factories.disclosure,
        ...choiceContext.disclosure,
      ],
    });
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
    // The DexPair contract template lives in trading/CantonDex/Dex/DexPair.daml.
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

  // Read-only match preview: discover crossing orders without settling.
  // The execute path is POST /v1/orders/match (runMatching), below.
  if (method === "GET" && path === "/v1/orders/matches") {
    const base = url.searchParams.get("base");
    const quote = url.searchParams.get("quote");
    if (!base || !quote) {
      respondJson(res, 400, { error: "missing ?base= or ?quote=" });
      return;
    }
    const matches = await backend.order.findMatches({
      baseInstrumentId: base,
      quoteInstrumentId: quote,
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
    // Per-contract (UTXO-style) rows. For a summed balance, use /v1/balances.
    respondJson(res, 200, await loadHoldings(backend, owner));
    return;
  }

  // Aggregated balances: per-instrument total / available / locked, summed
  // across the owner's holding contracts. Saves every client re-deriving a
  // balance from the UTXO-style /v1/holdings rows. Exact decimal math.
  if (method === "GET" && path === "/v1/balances") {
    const owner = url.searchParams.get("owner");
    if (!owner) {
      throw new HttpError(400, "bad_request", "missing ?owner= query parameter");
    }
    const holdings = await loadHoldings(backend, owner);
    const byInstrument = new Map<string, { total: bigint; locked: bigint }>();
    for (const h of holdings) {
      const amt = dec.parseDecimal(String(h.amount));
      const cur = byInstrument.get(h.instrumentId) ?? { total: 0n, locked: 0n };
      cur.total += amt;
      if (h.locked) cur.locked += amt;
      byInstrument.set(h.instrumentId, cur);
    }
    const balances = [...byInstrument.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([instrumentId, { total, locked }]) => ({
        instrumentId,
        total: dec.formatDecimal(total),
        available: dec.formatDecimal(total - locked),
        locked: dec.formatDecimal(locked),
      }));
    respondJson(res, 200, balances);
    return;
  }

  // Execute path: discover crossing orders and create MatchedTrade
  // contracts. Operator-auth gated (state-changing). The read-only preview
  // is GET /v1/orders/matches, above.
  if (method === "POST" && path === "/v1/orders/match") {
    const body = await readJson<{ base: string; quote: string }>(req);
    if (!body.base || !body.quote) {
      respondJson(res, 400, { error: "expected { base, quote }" });
      return;
    }
    const results = await backend.order.runMatching({
      baseInstrumentId: body.base,
      quoteInstrumentId: body.quote,
      venue: context.operator as Party,
      admin: context.admin as Party,
    });
    respondJson(res, 200, { matches: results });
    return;
  }

  // GET /v1/price-history?pair=BTC/USDC&hours=24 — price points from
  // the swaps indexer. Empty array if no swaps yet for the pair.
  if (method === "GET" && path === "/v1/price-history") {
    if (!db) {
      respondJson(res, 503, { error: "indexer disabled" });
      return;
    }
    const pair = url.searchParams.get("pair");
    if (!pair) {
      respondJson(res, 400, { error: "missing ?pair=BASE/QUOTE" });
      return;
    }
    const hours = Math.max(
      1,
      Math.min(24 * 30, parseInt(url.searchParams.get("hours") ?? "24", 10)),
    );
    const since = Math.floor(Date.now() / 1000) - hours * 3600;
    const rows = db
      .prepare(
        `SELECT ts, priceAfter FROM swaps
         WHERE pair = ? AND ts >= ?
         ORDER BY ts ASC LIMIT 500`,
      )
      .all(pair, since) as Array<{ ts: number; priceAfter: string }>;
    respondJson(res, 200, {
      pair,
      hours,
      points: rows.map((r) => ({ ts: r.ts, price: parseFloat(r.priceAfter) })),
    });
    return;
  }

  // GET /v1/stats/24h?pair=BTC/USDC — derived stats over the last 24h
  // window from the indexer:
  //   - priceChange24h: (latest - earliest) / earliest (null if <2 points)
  //   - volume24h: sum of |baseDelta| across swaps in the window
  //   - swapCount24h
  // Empty / null when the indexer has no data yet for the pair.
  if (method === "GET" && path === "/v1/stats/24h") {
    if (!db) {
      respondJson(res, 503, { error: "indexer disabled" });
      return;
    }
    const pair = url.searchParams.get("pair");
    if (!pair) {
      respondJson(res, 400, { error: "missing ?pair=BASE/QUOTE" });
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    const since = now - 24 * 3600;
    const rows = db
      .prepare(
        `SELECT ts, priceAfter, baseDelta FROM swaps
         WHERE pair = ? AND ts >= ?
         ORDER BY ts ASC`,
      )
      .all(pair, since) as Array<{
        ts: number;
        priceAfter: string;
        baseDelta: string;
      }>;
    const first = rows[0];
    const last = rows[rows.length - 1];
    const priceChange =
      rows.length >= 2 && first && last
        ? (parseFloat(last.priceAfter) - parseFloat(first.priceAfter)) /
          parseFloat(first.priceAfter)
        : null;
    const volume = rows.reduce(
      (s, r) => s + Math.abs(parseFloat(r.baseDelta)),
      0,
    );
    respondJson(res, 200, {
      pair,
      priceChange24h: priceChange,
      volume24h: rows.length > 0 ? volume : null,
      swapCount24h: rows.length,
    });
    return;
  }

  // === dealer registry =================================================
  // GET /v1/dealers     — public list (no auth)
  // PUT /v1/admin/dealers  — admin upsert
  // DELETE /v1/admin/dealers/:party — admin remove

  if (method === "GET" && path === "/v1/dealers") {
    if (!db) {
      respondJson(res, 503, { error: "dealer registry requires the SQLite indexer" });
      return;
    }
    const dealers = new DealersService(db).list();
    respondJson(res, 200, dealers);
    return;
  }

  if (method === "PUT" && path === "/v1/admin/dealers") {
    if (!db) {
      respondJson(res, 503, { error: "dealer registry requires the SQLite indexer" });
      return;
    }
    if (!adminToken || !bearerMatches(req.headers["authorization"], adminToken)) {
      respondJson(res, 401, { error: "missing or invalid admin token" });
      return;
    }
    const body = await readJson<{
      party?: string;
      name?: string;
      trusted?: boolean;
      whitelisted?: boolean;
      latencyMs?: number | null;
      fillRate?: number | null;
    }>(req);
    if (!body.party || typeof body.party !== "string") {
      respondJson(res, 400, { error: "expected { party: string, ... }" });
      return;
    }
    const dealers = new DealersService(db);
    const dealer = dealers.upsert(body as { party: string });
    respondJson(res, 200, dealer);
    return;
  }

  const dealerMatch = path.match(/^\/v1\/admin\/dealers\/(.+)$/);
  if (method === "DELETE" && dealerMatch) {
    if (!db) {
      respondJson(res, 503, { error: "dealer registry requires the SQLite indexer" });
      return;
    }
    if (!adminToken || !bearerMatches(req.headers["authorization"], adminToken)) {
      respondJson(res, 401, { error: "missing or invalid admin token" });
      return;
    }
    const party = decodeURIComponent(dealerMatch[1]!);
    const removed = new DealersService(db).remove(party);
    respondJson(res, removed ? 200 : 404, { removed, party });
    return;
  }

  if (method === "POST" && path === "/v1/wallet/submit") {
    // The wallet relay forwards client bodies under the operator JWT.
    // It is OFF by default; enable with DEX_DEV_WALLET_RELAY=1. When ON the
    // forwarded actAs parties are restricted to DEX_DEV_RELAY_PARTIES.
    if (!cfg.walletRelayEnabled) {
      respondJson(res, 404, {
        error: "wallet relay disabled; set DEX_DEV_WALLET_RELAY=1 to enable",
        code: "not_found",
      });
      return;
    }
    if (!ledgerUrl || !ledgerToken) {
      respondJson(res, 503, { error: "ledger not configured" });
      return;
    }
    const body = await readJson<Record<string, unknown>>(req);
    // Authorization first: restrict the relayed authority to the allowlisted
    // parties before validating the rest of the payload.
    const allowParties = cfg.walletRelayParties ?? [];
    const requestedActAs = ((body.actAs as string[] | undefined) ?? []).filter(Boolean);
    const disallowed = requestedActAs.filter((p) => !allowParties.includes(p));
    if (allowParties.length === 0 || requestedActAs.length === 0 || disallowed.length > 0) {
      respondJson(res, 403, {
        error: "wallet relay actAs party not allowlisted",
        code: "forbidden",
        details: { requestedActAs, disallowed, allowParties },
      });
      return;
    }
    // Then validate the forwarded shape rather than passing the raw body to
    // Canton (which would echo a bare 400). commands must be a non-empty array
    // and commandId a non-empty string; userId, if present, must be a string.
    if (!Array.isArray(body.commands) || body.commands.length === 0) {
      respondJson(res, 400, {
        error: "commands must be a non-empty array",
        code: "bad_request",
      });
      return;
    }
    if (typeof body.commandId !== "string" || body.commandId.length === 0) {
      respondJson(res, 400, {
        error: "commandId must be a non-empty string",
        code: "bad_request",
      });
      return;
    }
    if (body.userId !== undefined && typeof body.userId !== "string") {
      respondJson(res, 400, {
        error: "userId must be a string when present",
        code: "bad_request",
      });
      return;
    }
    const base = ledgerUrl.replace(/\/$/, "");
    try {
      const r = await fetch(`${base}/v2/commands/submit-and-wait`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ledgerToken}`,
        },
        body: JSON.stringify(body),
      });
      const text = await r.text();
      if (!r.ok) {
        res.statusCode = r.status;
        res.setHeader("Content-Type", "application/json");
        res.end(text);
        return;
      }
      // submit-and-wait returns only { updateId, completionOffset } — no
      // created events. The DvP settle path (swap + LP add/remove) needs the
      // created Allocation cids, so follow the transaction tree by-id and
      // surface its CreatedTreeEvents. Additive: existing callers keep
      // reading `updateId`; new callers read `createdEvents`.
      const submitBody = JSON.parse(text) as {
        updateId?: string;
        completionOffset?: number;
      };
      const actAs = ((body.actAs as string[] | undefined) ?? []).filter(Boolean);
      let createdEvents: Array<{ contractId: string; templateId: string }> = [];
      if (submitBody.updateId && actAs.length > 0) {
        const treeUrl = new URL(
          `${base}/v2/updates/transaction-tree-by-id/${encodeURIComponent(submitBody.updateId)}`,
        );
        for (const p of new Set(actAs)) treeUrl.searchParams.append("parties", p);
        // The transaction tree can lag the submit-and-wait completion
        // (read-after-write visibility), so retry briefly before giving up.
        let treeRes: Response | undefined;
        for (let attempt = 0; attempt < 4; attempt++) {
          treeRes = await fetch(treeUrl.toString(), {
            headers: { Authorization: `Bearer ${ledgerToken}` },
          });
          if (treeRes.ok) break;
          await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
        }
        if (!treeRes || !treeRes.ok) {
          // The transaction committed (submit-and-wait returned ok) but its tree
          // could not be fetched. Do NOT fall through to a 200 with empty
          // createdEvents — to the caller that reads as "0 created allocations"
          // on a settled tx and throws a misleading count error. Surface the
          // updateId distinctly so the caller can recover via operator-discovery.
          const treeStatus = treeRes?.status ?? null;
          httpLog.warn(
            "wallet relay: transaction committed but its created-event tree could not be fetched",
            { updateId: submitBody.updateId, treeStatus },
          );
          respondJson(res, 502, {
            error:
              "transaction committed but its created events could not be fetched; " +
              "recover via operator-discovery using updateId",
            code: "tree_fetch_failed",
            updateId: submitBody.updateId,
            treeStatus,
          });
          return;
        }
        const tree = (await treeRes.json()) as {
          transaction?: {
            eventsById?: Record<
              string,
              {
                CreatedTreeEvent?: {
                  value?: { contractId?: string; templateId?: string };
                };
              }
            >;
          };
        };
        createdEvents = Object.values(
          tree.transaction?.eventsById ?? {},
        )
          .map((e) => e.CreatedTreeEvent?.value)
          .filter(
            (v): v is { contractId: string; templateId: string } =>
              !!v?.contractId,
          )
          .map((v) => ({ contractId: v.contractId, templateId: v.templateId ?? "" }));
      }
      respondJson(res, 200, { ...submitBody, createdEvents });
    } catch (e) {
      respondJson(res, 502, { error: `submit proxy failed: ${e instanceof Error ? e.message : String(e)}` });
    }
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
    const rows = (pair ? db.prepare(sql).all(pair) : db.prepare(sql).all()) as Array<{
      ts: number;
      pair: string;
      baseDelta: string;
      quoteDelta: string;
      priceAfter: string;
    }>;
    // The indexer stores signed pool-reserve deltas (baseDelta/quoteDelta).
    // Project them into the swapper-oriented shape the dApp renders: a positive
    // baseDelta means the pool GAINED base, i.e. the swapper SENT base and
    // received quote (and vice-versa).
    const mapped = rows.map((r) => {
      const [base, quote] = r.pair.split("/");
      const bd = parseFloat(r.baseDelta);
      const qd = parseFloat(r.quoteDelta);
      const sentBase = bd > 0;
      return {
        ...r,
        inputInstrumentId: sentBase ? base : quote,
        outputInstrumentId: sentBase ? quote : base,
        inputAmount: Math.abs(sentBase ? bd : qd),
        outputAmount: Math.abs(sentBase ? qd : bd),
        // The indexer does not currently capture the swapper party.
        trader: null,
      };
    });
    respondJson(res, 200, mapped);
    return;
  }

  // === operator config (admin-auth) ====================================

  if (path.startsWith("/v1/admin/config")) {
    if (!db) {
      respondJson(res, 503, { error: "config disabled" });
      return;
    }
    const okWrite =
      !!adminToken && bearerMatches(req.headers["authorization"], adminToken);
    const opCfg = new OperatorConfig(db);

    if (method === "GET" && path === "/v1/admin/config") {
      // Read is open by default — config is not sensitive (dealer
      // whitelist, policy params); production may want to gate this.
      respondJson(res, 200, opCfg.list());
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
      opCfg.set(body.key, body.value);
      respondJson(res, 200, { ok: true });
      return;
    }
    if (method === "DELETE" && path.startsWith("/v1/admin/config/")) {
      if (!okWrite) {
        throw new HttpError(401, "unauthorized", "missing or invalid admin token");
      }
      const key = decodeURIComponent(path.slice("/v1/admin/config/".length));
      opCfg.delete(key);
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
    const raw = await readValidatedJson<unknown>(req, "POST /v1/swaps/quote", callerAuth);
    // Pool reference: `poolCid` is canonical (the pool ContractId). `poolId` is
    // accepted for compatibility and resolves EITHER the ContractId OR the
    // logical pool id (e.g. "BTC-USDC"), removing the old field-name trap.
    const body = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const poolRef =
      typeof body.poolCid === "string" && body.poolCid
        ? body.poolCid
        : expectString(raw, "poolId");
    const inputInstrumentId = expectString(raw, "inputInstrumentId");
    const inputAmount = expectString(raw, "inputAmount");
    if (Number.isNaN(parseFloat(inputAmount)) || parseFloat(inputAmount) <= 0) {
      badRequest("inputAmount must be a positive decimal string", { field: "inputAmount" });
    }
    const pools = await backend.pool.listActive();
    const pool = pools.find(
      (p) => p.contractId === poolRef || p.poolId === poolRef,
    );
    if (!pool) {
      throw new HttpError(404, "not_found", "pool not found", { pool: poolRef });
    }
    respondJson(
      res,
      200,
      backend.pool.computeQuoteDetailed(pool, inputInstrumentId, inputAmount),
    );
    return;
  }

  // === operator-driven writes ===========================================

  if (method === "GET" && path === "/v1/rfq") {
    const result = await backend.rfq.list();
    respondJson(res, 200, result);
    return;
  }

  if (method === "POST" && path === "/v1/rfq") {
    const body = await readValidatedJson<Parameters<typeof backend.rfq.create>[0]>(req, "POST /v1/rfq", callerAuth);
    const result = await backend.rfq.create(body);
    respondJson(res, 200, result);
    return;
  }

  // /v1/rfq/:cid/cancel
  const rfqCancelMatch = path.match(/^\/v1\/rfq\/([^/]+)\/cancel$/);
  if (method === "POST" && rfqCancelMatch) {
    const rfqCid = decodeURIComponent(rfqCancelMatch[1]!);
    // Per-caller binding (B-2, Low residual #1): cancel acts as the fetched
    // RFQ's trader, so the body-map binding can't cover it. Resolve the caller
    // (fail-closed when the secret is set) and let the service compare it to
    // the RFQ's trader — stops an operator-token holder griefing any RFQ.
    const requireTrader = requireCallerForFetchBoundRoute(req, callerAuth, "cancelling an RFQ");
    await backend.rfq.cancel({ rfqCid: rfqCid as never, requireTrader });
    respondJson(res, 204, {});
    return;
  }

  if (method === "POST" && path === "/v1/rfq/accept") {
    const body = await readValidatedJson<Parameters<typeof backend.rfq.accept>[0]>(req, "POST /v1/rfq/accept", callerAuth);
    // Same fetch-based binding as cancel: accept acts as the RFQ's trader, so
    // an operator-token holder must not accept a quote on a trader's behalf.
    const requireTrader = requireCallerForFetchBoundRoute(req, callerAuth, "accepting an RFQ");
    const result = await backend.rfq.accept({ ...body, requireTrader });
    respondJson(res, 200, result);
    return;
  }

  if (method === "POST" && path === "/v1/orders/bind") {
    const body = await readValidatedJson<Parameters<typeof backend.order.bind>[0]>(req, "POST /v1/orders/bind", callerAuth);
    const result = await backend.order.bind(body);
    respondJson(res, 200, result);
    return;
  }

  if (method === "POST" && path === "/v1/orders/fund") {
    const body = await readValidatedJson<Parameters<typeof backend.order.fund>[0]>(req, "POST /v1/orders/fund", callerAuth);
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

  // === matched-trade settlement (TradingAppV2) =========================
  // The on-chain choices are MatchedTrade_RequestAllocations →
  // MatchedTrade_Settle → (or MatchedTrade_Cancel). Operator-auth gated.
  // The settle/cancel bodies carry a `batchesByAdmin` / `allocationsByAdmin`
  // JSON object keyed by admin party; we convert to the Map the service wants.

  if (method === "POST" && path === "/v1/matched-trades/request-allocations") {
    const body = await readValidatedJson<unknown>(req, "POST /v1/matched-trades/request-allocations", callerAuth);
    const tradeCid = expectString(body, "tradeCid");
    const result = await backend.matchedTrade.requestAllocations({
      tradeCid: tradeCid as never,
    });
    respondJson(res, 200, { allocationRequestCids: result });
    return;
  }

  if (method === "POST" && path === "/v1/matched-trades/settle") {
    const body = await readValidatedJson<unknown>(req, "POST /v1/matched-trades/settle", callerAuth);
    const tradeCid = expectString(body, "tradeCid");
    const batchesByAdminRaw = expectField<Record<string, { allocationCids: string[] }>>(
      body,
      "batchesByAdmin",
    );
    const allocationRequestCids = expectField<string[]>(body, "allocationRequestCids");
    const batchesByAdmin = new Map(
      Object.entries(batchesByAdminRaw).map(([admin, batch]) => [
        admin as Party,
        { allocationCids: (batch.allocationCids ?? []) as never[] },
      ]),
    );
    const result = await backend.matchedTrade.settle({
      tradeCid: tradeCid as never,
      batchesByAdmin,
      allocationRequestCids: allocationRequestCids as never[],
    });
    respondJson(res, 200, { result });
    return;
  }

  if (method === "POST" && path === "/v1/matched-trades/cancel") {
    const body = await readValidatedJson<unknown>(req, "POST /v1/matched-trades/cancel", callerAuth);
    const tradeCid = expectString(body, "tradeCid");
    const allocationsByAdminRaw = expectField<Record<string, string[]>>(
      body,
      "allocationsByAdmin",
    );
    const allocationRequestCids = expectField<string[]>(body, "allocationRequestCids");
    const allocationsByAdmin = new Map(
      Object.entries(allocationsByAdminRaw).map(([admin, cids]) => [
        admin as Party,
        (cids ?? []) as never[],
      ]),
    );
    const result = await backend.matchedTrade.cancel({
      tradeCid: tradeCid as never,
      allocationsByAdmin,
      allocationRequestCids: allocationRequestCids as never[],
    });
    respondJson(res, 200, { result });
    return;
  }

  if (method === "POST" && path === "/v1/pools/swap/request") {
    const body =
      await readValidatedJson<Parameters<typeof backend.pool.requestSwap>[0]>(req, "POST /v1/pools/swap/request", callerAuth);
    const result = await backend.pool.requestSwap(body);
    respondJson(res, 200, result);
    return;
  }

  if (method === "POST" && path === "/v1/pools/swap") {
    const body = await readValidatedJson<Parameters<typeof backend.pool.swap>[0]>(req, "POST /v1/pools/swap", callerAuth);
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

  // === DvP liquidity ==========================================

  if (method === "POST" && path === "/v1/pools/add-liquidity/request") {
    const body = await readValidatedJson<
      Parameters<typeof backend.pool.requestAddLiquidity>[0]
    >(req, "POST /v1/pools/add-liquidity/request", callerAuth);
    const result = await backend.pool.requestAddLiquidity(body);
    respondJson(res, 200, result);
    return;
  }

  if (method === "POST" && path === "/v1/pools/add-liquidity/settle") {
    const body = await readValidatedJson<
      Parameters<typeof backend.pool.settleAddLiquidity>[0]
    >(req, "POST /v1/pools/add-liquidity/settle", callerAuth);
    const result = await backend.pool.settleAddLiquidity(body);
    respondJson(res, 200, { result });
    return;
  }

  // Operator-discovery recovery: given an updateId-only wallet receipt, recover
  // the created Allocation cids + the acceptance evidence from the transaction
  // tree. Exposed for clients that prefer to settle in two steps.
  if (method === "POST" && path === "/v1/pools/recover-dvp-allocations") {
    const body = await readJson<{ updateId: string; party: string; expected?: number }>(req);
    const result = await backend.pool.recoverDvpAllocations(
      body.updateId,
      body.party as never,
      body.expected ?? 3,
    );
    respondJson(res, 200, result);
    return;
  }

  if (method === "POST" && path === "/v1/pools/remove-liquidity/request") {
    const body = await readValidatedJson<
      Parameters<typeof backend.pool.requestRemoveLiquidity>[0]
    >(req, "POST /v1/pools/remove-liquidity/request", callerAuth);
    const result = await backend.pool.requestRemoveLiquidity(body);
    respondJson(res, 200, result);
    return;
  }

  if (method === "POST" && path === "/v1/pools/remove-liquidity/settle") {
    const body = await readValidatedJson<
      Parameters<typeof backend.pool.settleRemoveLiquidity>[0]
    >(req, "POST /v1/pools/remove-liquidity/settle", callerAuth);
    const result = await backend.pool.settleRemoveLiquidity(body);
    respondJson(res, 200, { result });
    return;
  }

  throw new HttpError(404, "not_found", `no route: ${method} ${path}`);
}

// Read the JSON body and validate it against the write spec for this route.
// `routeKey` is "${method} ${path}". Throws ValidationError (→ 400) on a
// malformed amount / party / cid / missing required field, and an HttpError
// (401/403) when per-caller party binding is enabled and the caller is not the
// route's subject party (finding B-2).
// Load an owner's holdings across the V2 registry Holding and the legacy
// instrument Holding templates, merged and filtered to that owner. Shared by
// GET /v1/holdings and GET /v1/balances.
async function loadHoldings(
  backend: OperatorBackend,
  owner: string,
): Promise<
  Array<{ owner: string; instrumentId: string; amount: string; locked: boolean }>
> {
  type H = { owner: string; instrumentId: string; amount: string; locked: boolean };
  const load = async (templateId: string): Promise<H[]> => {
    try {
      return await backend.ledger.query<H>({
        templateId,
        observingParty: owner as never,
      });
    } catch {
      return [];
    }
  };
  const holdings = [
    ...(await load("CantonDex.Registry.V2:Holding")),
    ...(await load("CantonDex.Instrument.Holding:Holding")),
  ];
  return holdings.filter((h) => h.owner === owner);
}

async function readValidatedJson<T>(
  req: IncomingMessage,
  routeKey: string,
  callerAuth?: CallerAuthConfig,
): Promise<T> {
  const body = await readJson<T>(req);
  validateWriteBody(routeKey, body);
  const binding = checkCallerBinding(
    req,
    callerAuth ?? { callerJwtSecret: undefined },
    routeKey,
    body,
  );
  if (!binding.ok) {
    throw new HttpError(binding.status, binding.code, binding.message);
  }
  return body;
}

/**
 * Resolve the verified caller party for a route whose subject lives on-ledger
 * (RFQ accept/cancel act as the fetched RFQ's `trader`, which the body-map
 * binding cannot reach — finding B-2, Low residual #1). Returns undefined when
 * binding is disabled (no secret), so the service skips the check. When binding
 * is ON it is fail-closed: a missing/invalid caller token throws 401, and the
 * returned party is handed to the service, which compares it to the fetched
 * RFQ's trader and rejects a mismatch (403).
 */
function requireCallerForFetchBoundRoute(
  req: IncomingMessage,
  callerAuth: CallerAuthConfig,
  action: string,
): Party | undefined {
  if (!callerAuth.callerJwtSecret) return undefined; // binding disabled
  const caller = callerPartyFromRequest(req, callerAuth);
  if (!caller) {
    throw new HttpError(
      401,
      "unauthorized",
      `${action} requires a valid X-Caller-Token (per-caller party JWT)`,
    );
  }
  return caller as Party;
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
