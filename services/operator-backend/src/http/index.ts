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
//     GET  /v1/instruments              -> Instrument[] (id, symbol, decimals)
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
//   Testnet-only party faucet (registered only under DEX_TESTNET_ONBOARDING=1):
//     POST /v1/testnet/party            -> { partyId, airdrops }
//     GET  /v1/testnet/hosting?party=:p -> { hostedHere }
//     POST /v1/testnet/submit           -> { updateId, createdEvents }
//     POST /v1/testnet/swap             -> { updateId, inputAmount, outputAmount, allocationCid }
//     POST /v1/testnet/liquidity        -> { updateId, lpAmount, baseAmount, quoteAmount }
//     POST /v1/testnet/order            -> { updateId, orderCid, status }
//     POST /v1/testnet/order/cancel     -> { updateId }
//     POST /v1/testnet/rfq              -> { rfqId, rfqCid, pair, expiresAt, quotes }
//     POST /v1/testnet/rfq/accept       -> { tradeCid, acceptedDealer, ... }
//     POST /v1/testnet/rfq/cancel       -> { rfqId }
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
import {
  OnboardingThrottleError,
  type TestnetOnboardingService,
} from "../testnet-onboarding/index.js";
import { RegistryBootstrapError } from "../testnet-onboarding/registry-mint.js";
import {
  TestnetCommandRejectedError,
  TestnetLedgerError,
  TestnetPartyIneligibleError,
  TestnetSubmitUnavailableError,
} from "../testnet-onboarding/submit.js";
import { TestnetSwapRejectedError } from "../testnet-onboarding/swap.js";
import { TestnetLiquidityRejectedError } from "../testnet-onboarding/liquidity.js";
import { TestnetOrderRejectedError } from "../testnet-onboarding/order.js";
import { TestnetRfqRejectedError } from "../testnet-onboarding/rfq.js";
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

export interface HttpServerHandle {
  close: () => Promise<void>;
  /**
   * Base URL of the listening server, carrying the port actually bound — so a
   * caller that asked for port 0 reads the OS-assigned one back from here.
   */
  url: string;
  /** The port actually bound. Equals `cfg.port` unless that was 0. */
  port: number;
}

export interface HttpServerConfig {
  backend: OperatorBackend;
  /**
   * TCP port to bind. 0 asks the OS for a free one; read the assigned port
   * back from the resolved handle's `url` / `port`. Tests use 0 so that
   * concurrently-running test files cannot collide on a port.
   */
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
  /**
   * Testnet-only party faucet. Supplied only when DEX_TESTNET_ONBOARDING=1
   * (see testnetOnboardingFromEnv); when absent the /v1/testnet/* routes are
   * not registered at all.
   */
  testnetOnboarding?: TestnetOnboardingService;
  /**
   * Read the client address for the faucet throttle from X-Forwarded-For.
   * OFF by default: the header is caller-controlled, so honouring it on a
   * directly-exposed server would let one client rotate it and defeat the
   * per-IP cap. Set only when a trusted reverse proxy sets the header.
   */
  testnetTrustProxy?: boolean;
}

/** True for "0", "0.0000000000", "-0.0" etc, without parsing. */
function isZero(d: string): boolean {
  return /^-?0*\.?0*$/.test(d);
}

/**
 * Bind the HTTP surface and resolve once the socket is actually listening.
 *
 * Resolving on `listening` rather than returning synchronously is what makes
 * `port: 0` usable: the OS-assigned port is not readable from
 * `server.address()` until then, so a synchronous return could only ever echo
 * back the requested port. It also means a caller that awaits this can issue a
 * request immediately without racing the bind.
 */
/**
 * The pair-scoped reads accept `?pair=BASE/QUOTE`. `?base=&quote=` is kept for
 * callers that already use it, so this is additive.
 *
 * Every other pair-scoped read on this API takes `?pair=` -- /v1/trades,
 * /v1/swaps, /v1/price-history, /v1/stats/24h -- and the two order routes were
 * the only ones that did not, which is a trap an integrator hits once per
 * route rather than once.
 */
function pairParams(url: URL): { base: string; quote: string } | undefined {
  const pair = url.searchParams.get("pair");
  if (pair) {
    const parts = pair.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
    return { base: parts[0], quote: parts[1] };
  }
  const base = url.searchParams.get("base");
  const quote = url.searchParams.get("quote");
  return base && quote ? { base, quote } : undefined;
}

export function startHttpServer(cfg: HttpServerConfig): Promise<HttpServerHandle> {
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
      if (e instanceof LedgerError && e.kind === "validation") {
        // A precondition/input failure surfaced by a service or the ledger —
        // a client error, not a server fault.
        reqLog.warn("request rejected", { status: 400, code: "bad_request", error: e.detail });
        respondJson(res, 400, { error: e.detail, code: "bad_request", requestId });
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
  const host = cfg.host ?? "127.0.0.1";
  const close = (): Promise<void> =>
    new Promise<void>((resolve) => {
      clearInterval(slotTimer);
      server.close(() => {
        resolve();
      });
    });

  return new Promise<HttpServerHandle>((resolve, reject) => {
    // A failed bind (EADDRINUSE) is an 'error' event, which would otherwise be
    // unhandled and take the process down; surface it as a rejection instead.
    const onError = (e: Error): void => {
      clearInterval(slotTimer);
      reject(e);
    };
    server.once("error", onError);
    server.listen(cfg.port, host, () => {
      server.removeListener("error", onError);
      const addr = server.address();
      const boundPort = typeof addr === "object" && addr !== null ? addr.port : cfg.port;
      resolve({ url: `http://${host}:${boundPort}`, port: boundPort, close });
    });
  });
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
  // Present only on a testnet deployment that opted into the party faucet.
  const onboarding = cfg.testnetOnboarding;
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
      allocationFactoryDisclosure: dedupeDisclosure([
        ...factories.disclosure,
        ...choiceContext.disclosure,
      ]),
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
    // Instrument metadata. The reference registry carries decimals on
    // Registry.V2 `InstrumentConfig` and isin/cusip/description on
    // `InstrumentConfiguration`; query both and merge by instrumentId, then
    // fall back to the instruments referenced by active pools so the endpoint
    // is populated even before any config is registered (e.g. the demo).
    // `symbol` is the instrument id. Optional `?ids=BTC,USDC` filters.
    const idsParam = url.searchParams.get("ids");
    const ids = idsParam
      ? idsParam.split(",").map((s) => s.trim()).filter(Boolean)
      : null;
    // Both config templates are `signatory admin` with no observers, so the
    // operator cannot see either. Querying as the operator returned nothing
    // and every field fell back to null. Read as the parties that sign them,
    // and merge -- the lpRegistrar signs the LP-token configs.
    //
    // This only reaches instruments issued by a registry this deployment
    // hosts. Metadata for a foreign registry's instrument comes from that
    // registry's off-ledger metadata-v1 API, which registry-client does not
    // implement yet; those instruments still report null here.
    const q = async <T>(templateId: string): Promise<T[]> => {
      const parties = [
        cfg.context.admin,
        cfg.context.lpRegistrar,
        backend.operatorParty,
      ].filter((p, i, a) => p && a.indexOf(p) === i);
      const out: T[] = [];
      for (const observingParty of parties) {
        try {
          out.push(
            ...(await backend.ledger.query<T>({ templateId, observingParty })),
          );
        } catch {
          // A party this token cannot read is not an error here; try the next.
        }
      }
      return out;
    };
    const cfgs = await q<{ instrumentId: string; decimals?: number | string }>(
      "CantonDex.Registry.V2:InstrumentConfig",
    );
    const confs = await q<{
      instrumentId: string;
      isin?: string | null;
      cusip?: string | null;
      description?: string;
    }>("CantonDex.Instrument.InstrumentConfiguration:InstrumentConfiguration");
    type Instrument = {
      instrumentId: string;
      symbol: string;
      decimals: number | null;
      isin: string | null;
      cusip: string | null;
      description: string | null;
    };
    const byId = new Map<string, Instrument>();
    const put = (id: string): Instrument => {
      let e = byId.get(id);
      if (!e) {
        e = { instrumentId: id, symbol: id, decimals: null, isin: null, cusip: null, description: null };
        byId.set(id, e);
      }
      return e;
    };
    for (const c of cfgs) {
      const e = put(c.instrumentId);
      // Daml Int64 is JSON-encoded as a string, so a `typeof === "number"`
      // guard drops it silently.
      const d = typeof c.decimals === "string" ? Number(c.decimals) : c.decimals;
      if (typeof d === "number" && Number.isInteger(d)) e.decimals = d;
    }
    for (const c of confs) {
      const e = put(c.instrumentId);
      e.isin = c.isin ?? e.isin;
      e.cusip = c.cusip ?? e.cusip;
      e.description = c.description ?? e.description;
    }
    for (const p of await backend.pool.listActive()) {
      put(p.baseInstrumentId);
      put(p.quoteInstrumentId);
    }
    let out = [...byId.values()].sort((a, b) =>
      a.instrumentId.localeCompare(b.instrumentId),
    );
    if (ids) out = out.filter((c) => ids.includes(c.instrumentId));
    respondJson(res, 200, out);
    return;
  }

  if (method === "GET" && path === "/v1/orders/book") {
    const p = pairParams(url);
    if (!p) {
      throw new HttpError(
        400,
        "bad_request",
        "expected ?pair=BASE/QUOTE (or ?base=&quote=)",
      );
    }
    const book = await backend.order.book({
      baseInstrumentId: p.base,
      quoteInstrumentId: p.quote,
    });
    respondJson(res, 200, book);
    return;
  }

  // Read-only match preview: discover crossing orders without settling.
  // The execute path is POST /v1/orders/match (runMatching), below.
  if (method === "GET" && path === "/v1/orders/matches") {
    const p = pairParams(url);
    if (!p) {
      throw new HttpError(
        400,
        "bad_request",
        "expected ?pair=BASE/QUOTE (or ?base=&quote=)",
      );
    }
    const matches = await backend.order.findMatches({
      baseInstrumentId: p.base,
      quoteInstrumentId: p.quote,
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

  // Instrument metadata: the registry's InstrumentConfig (authoritative
  // decimals / isin / cusip) unioned with the instruments referenced by active
  // pools. `symbol` is the instrument id (the canonical symbol in this system);
  // `decimals` is null for instruments with no on-ledger config row.

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
    // `ts` is in milliseconds, so the bound must be too.
    const since = Date.now() - hours * 3600 * 1000;
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
      // priceAfter is stored exactly; serve the string rather than a float,
      // consistent with every other amount on this API.
      points: rows.map((r) => ({ ts: r.ts, price: r.priceAfter })),
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
    // Milliseconds, matching the indexer's stamp.
    const since = Date.now() - 24 * 3600 * 1000;
    const rows = db
      .prepare(
        `SELECT ts, priceAfter, baseDelta, kind FROM swaps
         WHERE pair = ? AND ts >= ?
         ORDER BY ts ASC`,
      )
      .all(pair, since) as Array<{
        ts: number;
        priceAfter: string;
        baseDelta: string;
        kind: string;
      }>;
    // Price comes from every rotation; volume from swaps alone.
    const traded = rows.filter((r) => r.kind === "swap");
    const first = rows[0];
    const last = rows[rows.length - 1];
    const priceChange =
      rows.length >= 2 && first && last
        // A derived ratio, not an amount: a float is the honest type here.
        ? (parseFloat(last.priceAfter) - parseFloat(first.priceAfter)) /
          parseFloat(first.priceAfter)
        : null;
    const volume = traded.reduce(
      (s, r) => s + Math.abs(parseFloat(r.baseDelta)),
      0,
    );
    respondJson(res, 200, {
      pair,
      priceChange24h: priceChange,
      volume24h: traded.length > 0 ? volume : null,
      swapCount24h: traded.length,
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
      // Either side: a party is `trader` on trades it initiated and
      // `counterparty` on those it was matched into.
      where.push("(trader = ? OR counterparty = ?)");
      args.push(trader, trader);
    }
    if (pair) {
      where.push("pair = ?");
      args.push(pair);
    }
    const sql =
      "SELECT tradeCid, ts, pair, trader, dealer, counterparty, policyVersion, " +
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
    // Swaps only: LP moves and pause/resume rotate the state too.
    const sql = pair
      ? `SELECT * FROM swaps WHERE kind = 'swap' AND pair = ? ORDER BY ts DESC LIMIT ${limit}`
      : `SELECT * FROM swaps WHERE kind = 'swap' ORDER BY ts DESC LIMIT ${limit}`;
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
    // The deltas are stored exactly, as scaled decimal strings. Deriving the
    // direction and magnitude textually keeps them that way: parseFloat +
    // Math.abs round-tripped them through IEEE-754 and emitted JSON numbers,
    // losing the trailing scale on a feed where every other amount is a
    // string.
    const magnitude = (d: string) => (d.startsWith("-") ? d.slice(1) : d);
    const mapped = rows.map((r) => {
      const [base, quote] = r.pair.split("/");
      const sentBase = !r.baseDelta.startsWith("-") && !isZero(r.baseDelta);
      return {
        ...r,
        inputInstrumentId: sentBase ? base : quote,
        outputInstrumentId: sentBase ? quote : base,
        inputAmount: magnitude(sentBase ? r.baseDelta : r.quoteDelta),
        outputAmount: magnitude(sentBase ? r.quoteDelta : r.baseDelta),
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
    // Same reasoning as GET /v1/rfq above: the indexed history is the settled
    // record of the same private negotiations, so the unfiltered sweep is
    // gated on the admin token and everyone else names the trader they are
    // asking about.
    const trader = url.searchParams.get("trader");
    if (
      !trader &&
      (!adminToken || !bearerMatches(req.headers["authorization"], adminToken))
    ) {
      throw new HttpError(
        400,
        "bad_request",
        "missing ?trader= query parameter; the unfiltered history requires the admin token",
      );
    }
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

  // Per-party by default. This route reads the operator's ACS view, and the
  // operator is an observer on every Rfq and every RfqQuote on this deployment
  // -- so an unfiltered response hands any anonymous visitor the whole book:
  // who is asking for a quote, on what, in what size, and at what price every
  // dealer answered. The page's own copy promises the opposite ("no other party
  // sees it"), and on-ledger that promise is real; it was only this endpoint
  // that broke it.
  //
  // The filter reproduces the Daml stakeholder sets exactly, minus the
  // operator: an Rfq is `signatory trader, observer operator :: whitelist`, so
  // its trader and its whitelisted dealers may see it; an RfqQuote is
  // `signatory dealer, observer trader, operator`, so its dealer and the RFQ's
  // trader may see it -- and one dealer still cannot see another's price, which
  // is the property that makes a competitive RFQ worth running.
  //
  // The operator's own global view is not removed, only gated: it is what an
  // operator console needs, and the admin token is what it already carries. No
  // party binding is invented here -- naming a party is a claim, not a proof --
  // because everything this returns is already visible to that party on-ledger;
  // the leak was serving it to callers who name someone ELSE.
  if (method === "GET" && path === "/v1/rfq") {
    const owner = url.searchParams.get("owner");
    if (!owner) {
      if (!adminToken || !bearerMatches(req.headers["authorization"], adminToken)) {
        throw new HttpError(
          400,
          "bad_request",
          "missing ?owner= query parameter; the unfiltered view requires the admin token",
        );
      }
      respondJson(res, 200, await backend.rfq.list());
      return;
    }
    const { rfqs, quotes } = await backend.rfq.list();
    respondJson(res, 200, {
      rfqs: rfqs.filter(
        (r) => r.trader === owner || r.whitelist.includes(owner),
      ),
      quotes: quotes.filter((q) => q.trader === owner || q.dealer === owner),
    });
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
    const dexPairCid = (body as Record<string, unknown>).dexPairCid;
    const result = await backend.matchedTrade.settle({
      tradeCid: tradeCid as never,
      batchesByAdmin,
      allocationRequestCids: allocationRequestCids as never[],
      dexPairCid: (typeof dexPairCid === "string" ? dexPairCid : null) as never,
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

  // === testnet-only hosted-party onboarding ==============================
  // Registered only when the server was handed an onboarding service, which
  // `testnetOnboardingFromEnv` builds only under DEX_TESTNET_ONBOARDING=1.
  // With the flag off these two guards are false and the request falls
  // through to the 404 below -- the paths genuinely do not exist.

  if (onboarding && method === "POST" && path === "/v1/testnet/party") {
    // The body is display-only. A caller cannot name the party it gets: the
    // id is generated server-side, because granting CanActAs on a
    // caller-chosen party would hand out authority over an existing one.
    const body = await readValidatedJson<{ label?: unknown }>(
      req,
      "POST /v1/testnet/party",
      callerAuth,
    );
    const label =
      typeof body.label === "string" ? body.label.slice(0, 64) : undefined;
    try {
      const result = await onboarding.createParty({
        clientIp: clientAddress(req, cfg.testnetTrustProxy ?? false),
        label,
      });
      respondJson(res, 201, result);
    } catch (e) {
      if (e instanceof OnboardingThrottleError) {
        throw new HttpError(429, "too_many_requests", e.message, e.details);
      }
      if (e instanceof RegistryBootstrapError) {
        // The faucet is switched on but the ledger it points at was never
        // bootstrapped, so it can mint nothing. That is an operator
        // misconfiguration the caller can only wait out -- 503, and the
        // message names the bootstrap step.
        throw new HttpError(503, "service_unavailable", e.message, e.details);
      }
      throw e;
    }
    return;
  }

  // Public, unauthenticated ledger write. It is safe only because every degree
  // of freedom a caller would need to abuse it has been taken away here rather
  // than in the caller: the authority is fixed to the one party the faucet
  // minted for them, the commands are allowlisted, and the disclosure is the
  // operator's own. See ../testnet-onboarding/submit.ts for the reasoning; the
  // deliberate absence of the operator token is noted in ./auth.ts.
  if (onboarding && method === "POST" && path === "/v1/testnet/submit") {
    const body = await readValidatedJson<{ party: string; commands: unknown }>(
      req,
      "POST /v1/testnet/submit",
      callerAuth,
    );
    const party = expectString(body, "party");
    try {
      const receipt = await onboarding.submitForParty({
        party,
        commands: body.commands,
        clientIp: clientAddress(req, cfg.testnetTrustProxy ?? false),
        // Registry.V2 fixes its observer list at creation, so a faucet party
        // cannot see the factory it has to exercise. The operator discloses it
        // from its own registry client -- the same source GET /v1/context
        // serves -- so that a caller has no blob of their own to inject.
        resolveDisclosure: () => registryDisclosure(backend, context.admin),
      });
      respondJson(res, 200, receipt);
    } catch (e) {
      if (e instanceof TestnetCommandRejectedError) {
        throw new HttpError(400, "bad_request", e.message, e.details);
      }
      if (e instanceof TestnetPartyIneligibleError) {
        throw new HttpError(403, "forbidden", e.message, e.details);
      }
      if (e instanceof OnboardingThrottleError) {
        throw new HttpError(429, "too_many_requests", e.message, e.details);
      }
      if (e instanceof TestnetSubmitUnavailableError) {
        throw new HttpError(501, "not_implemented", e.message);
      }
      if (e instanceof TestnetLedgerError) {
        // Summarized on purpose: the participant's own error text can quote the
        // submitted payload back, and this response is public.
        throw new HttpError(502, e.code, e.message, e.details);
      }
      throw e;
    }
    return;
  }

  // Public, unauthenticated, and the only route on this server that drives an
  // operator-authority write for an anonymous caller. It exists because a swap
  // is three transactions and two of them are the operator's: without it a
  // faucet party can author its allocation (above) and then has nowhere to go.
  // Exempting POST /v1/pools/swap/request + POST /v1/pools/swap from the
  // operator token instead would open those for ANY party; this route takes the
  // party, pool and amounts from a validated body, selects the party's own
  // holdings server-side, and can do nothing else. See
  // ../testnet-onboarding/swap.ts; the deliberate absence of the operator token
  // is noted in ./auth.ts.
  if (onboarding && method === "POST" && path === "/v1/testnet/swap") {
    const body = await readValidatedJson<{
      party: string;
      poolCid: string;
      inputInstrumentId: string;
      inputAmount: string;
      minOutputAmount?: unknown;
    }>(req, "POST /v1/testnet/swap", callerAuth);
    // Optional, so the route spec cannot declare it; held to the same
    // string-typed Decimal rule the spec applies to the required amounts.
    const minOutputAmount = body.minOutputAmount;
    if (
      minOutputAmount !== undefined &&
      minOutputAmount !== null &&
      typeof minOutputAmount !== "string"
    ) {
      badRequest("minOutputAmount must be a Daml Decimal string when present", {
        field: "minOutputAmount",
      });
    }
    try {
      // Rebuilt field by field: `inputHoldingCids`, `actAs`, `swapperAccount`
      // and anything else a caller attached are not read, here or below.
      const receipt = await onboarding.swapForParty({
        party: expectString(body, "party"),
        poolCid: expectString(body, "poolCid"),
        inputInstrumentId: expectString(body, "inputInstrumentId"),
        inputAmount: expectString(body, "inputAmount"),
        ...(typeof minOutputAmount === "string" ? { minOutputAmount } : {}),
        clientIp: clientAddress(req, cfg.testnetTrustProxy ?? false),
      });
      respondJson(res, 200, receipt);
    } catch (e) {
      if (e instanceof TestnetSwapRejectedError) {
        throw new HttpError(400, "bad_request", e.message, e.details);
      }
      if (e instanceof TestnetCommandRejectedError) {
        throw new HttpError(400, "bad_request", e.message, e.details);
      }
      if (e instanceof TestnetPartyIneligibleError) {
        throw new HttpError(403, "forbidden", e.message, e.details);
      }
      if (e instanceof OnboardingThrottleError) {
        throw new HttpError(429, "too_many_requests", e.message, e.details);
      }
      if (e instanceof TestnetSubmitUnavailableError) {
        throw new HttpError(501, "not_implemented", e.message);
      }
      if (e instanceof TestnetLedgerError) {
        // Summarized on purpose, on both the relayed and the operator steps:
        // the participant's error text can quote the payload back.
        throw new HttpError(502, e.code, e.message, e.details);
      }
      throw e;
    }
    return;
  }

  // Public, unauthenticated, and the second route that drives operator-authority
  // writes for an anonymous caller. It exists for the same reason the swap above
  // does: a liquidity change is three transactions and two of them are the
  // operator's, so a faucet party authors its allocations via /v1/testnet/submit
  // and then stops -- today the add simply fails with 401. Exempting the four
  // /v1/pools/{add,remove}-liquidity/* routes from the operator token instead
  // would open that whole surface for ANY party; this route takes the party,
  // pool and amounts from a validated body, selects the party's own deposits or
  // LP position server-side, and can do nothing else. See
  // ../testnet-onboarding/liquidity.ts -- including why the three allocations go
  // through the relay as three commands rather than the dApp's batched one --
  // and ./auth.ts for the deliberate absence of the operator token.
  if (onboarding && method === "POST" && path === "/v1/testnet/liquidity") {
    const body = await readValidatedJson<{
      party: string;
      poolCid: string;
      action: string;
      baseAmount?: unknown;
      quoteAmount?: unknown;
      lpAmount?: unknown;
    }>(req, "POST /v1/testnet/liquidity", callerAuth);

    const action = expectString(body, "action");
    if (action !== "add" && action !== "remove") {
      badRequest('action must be "add" or "remove"', { field: "action" });
    }
    // Conditional on the action, so the route spec cannot declare any of them;
    // held to the same string-typed Decimal rule the spec applies elsewhere,
    // with the service deciding which pair this action requires.
    const amounts: Record<string, string> = {};
    for (const field of ["baseAmount", "quoteAmount", "lpAmount"] as const) {
      const value = body[field];
      if (value === undefined || value === null) continue;
      if (typeof value !== "string") {
        badRequest(`${field} must be a Daml Decimal string when present`, {
          field,
        });
      }
      amounts[field] = value;
    }

    try {
      // Rebuilt field by field: holding cids, allocation cids, `requestCid`,
      // `actAs` and anything else a caller attached are not read, here or below.
      const receipt = await onboarding.liquidityForParty({
        party: expectString(body, "party"),
        poolCid: expectString(body, "poolCid"),
        action,
        ...amounts,
        clientIp: clientAddress(req, cfg.testnetTrustProxy ?? false),
      });
      respondJson(res, 200, receipt);
    } catch (e) {
      if (e instanceof TestnetLiquidityRejectedError) {
        throw new HttpError(400, "bad_request", e.message, e.details);
      }
      if (e instanceof TestnetCommandRejectedError) {
        throw new HttpError(400, "bad_request", e.message, e.details);
      }
      if (e instanceof TestnetPartyIneligibleError) {
        throw new HttpError(403, "forbidden", e.message, e.details);
      }
      if (e instanceof OnboardingThrottleError) {
        throw new HttpError(429, "too_many_requests", e.message, e.details);
      }
      if (e instanceof TestnetSubmitUnavailableError) {
        throw new HttpError(501, "not_implemented", e.message);
      }
      if (e instanceof TestnetLedgerError) {
        // Summarized on purpose, on both the relayed and the operator steps:
        // the participant's error text can quote the payload back.
        throw new HttpError(502, e.code, e.message, e.details);
      }
      throw e;
    }
    return;
  }

  // Public, unauthenticated, and the one route here whose first step is a
  // trader-authority CREATE. Placing an order is four transactions: the
  // trader's OrderFundingRequest, the operator's bind, the trader's collateral
  // allocation, the operator's fund. The two operator halves are
  // /v1/orders/bind + /v1/orders/fund, both token-gated, and the create is not
  // on the relay's allowlist -- a faucet party cannot take a single step of it
  // from a browser. Widening the relay to accept creates would let any caller
  // author any template in the package, so this route drives all four steps for
  // one faucet party instead: the pair must be one this deployment lists, the
  // collateral holdings are SELECTED server-side from holdings that party owns,
  // and the settlement reference is server-generated. See
  // ../testnet-onboarding/order.ts; the deliberate absence of the operator
  // token is noted in ./auth.ts.
  if (onboarding && method === "POST" && path === "/v1/testnet/order") {
    const body = await readValidatedJson<{
      party: string;
      baseInstrumentId: string;
      quoteInstrumentId: string;
      side: string;
      limitPrice: string;
      quantity: string;
      expiry?: unknown;
    }>(req, "POST /v1/testnet/order", callerAuth);
    // Optional, so the route spec cannot declare it; the service holds it to
    // the ISO-8601 form OrderFundingRequest's `Optional Time` expects.
    const expiry = body.expiry;
    if (expiry !== undefined && expiry !== null && typeof expiry !== "string") {
      badRequest("expiry must be an ISO-8601 timestamp when present", {
        field: "expiry",
      });
    }
    try {
      // Rebuilt field by field: `trader`, `operator`, `admin`, holding cids,
      // `settlementRef` and anything else a caller attached are not read, here
      // or below.
      const receipt = await onboarding.orderForParty({
        party: expectString(body, "party"),
        baseInstrumentId: expectString(body, "baseInstrumentId"),
        quoteInstrumentId: expectString(body, "quoteInstrumentId"),
        side: expectString(body, "side"),
        limitPrice: expectString(body, "limitPrice"),
        quantity: expectString(body, "quantity"),
        ...(typeof expiry === "string" ? { expiry } : {}),
        clientIp: clientAddress(req, cfg.testnetTrustProxy ?? false),
      });
      respondJson(res, 200, receipt);
    } catch (e) {
      throw testnetOrderHttpError(e);
    }
    return;
  }

  // The other half of the order route. Order_Cancel is `controller operator`,
  // so the operator can cancel any order on the book -- which is why the
  // service resolves the order and compares its trader to the calling party
  // before submitting anything, rather than trusting the cid in the body.
  if (onboarding && method === "POST" && path === "/v1/testnet/order/cancel") {
    const body = await readValidatedJson<{ party: string; orderCid: string }>(
      req,
      "POST /v1/testnet/order/cancel",
      callerAuth,
    );
    try {
      const receipt = await onboarding.cancelOrderForParty({
        party: expectString(body, "party"),
        orderCid: expectString(body, "orderCid"),
        clientIp: clientAddress(req, cfg.testnetTrustProxy ?? false),
      });
      respondJson(res, 200, receipt);
    } catch (e) {
      throw testnetOrderHttpError(e);
    }
    return;
  }

  // Public, unauthenticated, and the route that drives the most authorities of
  // any of them. An RFQ round trip is the trader's Rfq (a CREATE), one
  // dealer-signed RfqQuote per dealer (also CREATEs), the joint trader+operator
  // Rfq_Accept, the operator's MatchedTrade_RequestAllocations, each
  // counterparty's own AllocationFactory_Allocate, and the operator's
  // MatchedTrade_Settle. Three of those are creates, which the relay's
  // exercise-only allowlist refuses by design, and three are operator-authority
  // writes behind POST /v1/rfq, /v1/rfq/accept and /v1/matched-trades/*, all
  // token-gated. A faucet party can take no step of it from a browser.
  //
  // Widening the relay to admit creates would let any caller author any
  // template the package defines; dropping the token from the operator routes
  // would open the RFQ and matched-trade surface for any party. So this route
  // drives every step for ONE faucet party instead, with each degree of freedom
  // removed here rather than in the caller: the pair must be one this
  // deployment lists, the on-ledger `pair` text is REBUILT from that listing
  // (Rfq_Accept splits it literally into leg instrument ids), the dealers and
  // their tiers come from the operator's own table, the prices are derived from
  // the operator's own pool mid, and the rfqId is server-generated. See
  // ../testnet-onboarding/rfq.ts; the deliberate absence of the operator token
  // is noted in ./auth.ts.
  if (onboarding && method === "POST" && path === "/v1/testnet/rfq") {
    const body = await readValidatedJson<{
      party: string;
      pair?: unknown;
      poolCid?: unknown;
      side: string;
      size: string;
      expiryMinutes?: unknown;
    }>(req, "POST /v1/testnet/rfq", callerAuth);
    // The pair may be named either way round, so neither can be a required
    // field of the route spec; the service refuses a request that names
    // neither, and resolves both against its own listings.
    for (const field of ["pair", "poolCid"] as const) {
      const value = body[field];
      if (value !== undefined && value !== null && typeof value !== "string") {
        badRequest(`${field} must be a string when present`, { field });
      }
    }
    const expiryMinutes = body.expiryMinutes;
    if (
      expiryMinutes !== undefined &&
      expiryMinutes !== null &&
      typeof expiryMinutes !== "number"
    ) {
      badRequest("expiryMinutes must be a number when present", {
        field: "expiryMinutes",
      });
    }
    try {
      // Rebuilt field by field: `whitelist`, `rfqId`, quote prices, tiers,
      // holding cids, `actAs` and anything else a caller attached are not read,
      // here or below.
      const receipt = await onboarding.rfqForParty({
        party: expectString(body, "party"),
        ...(typeof body.pair === "string" ? { pair: body.pair } : {}),
        ...(typeof body.poolCid === "string" ? { poolCid: body.poolCid } : {}),
        side: expectString(body, "side"),
        size: expectString(body, "size"),
        ...(typeof expiryMinutes === "number" ? { expiryMinutes } : {}),
        clientIp: clientAddress(req, cfg.testnetTrustProxy ?? false),
      });
      respondJson(res, 200, receipt);
    } catch (e) {
      throw testnetRfqHttpError(e);
    }
    return;
  }

  // The other half. Rfq_Accept is submitted as [trader, operator] under the
  // operator's own ledger user, which holds CanActAs on every party this faucet
  // allocated — so the service resolves the RFQ on-ledger and refuses it unless
  // the RFQ's own trader is the calling party, rather than trusting the cid in
  // the body. Everything downstream of the accept (the allocations and the
  // settle) is bound to what the ledger returned, never to a caller's cid.
  if (onboarding && method === "POST" && path === "/v1/testnet/rfq/accept") {
    const body = await readValidatedJson<{
      party: string;
      rfqCid: string;
      acceptedQuoteCid: string;
    }>(req, "POST /v1/testnet/rfq/accept", callerAuth);
    try {
      const receipt = await onboarding.rfqAcceptForParty({
        party: expectString(body, "party"),
        rfqCid: expectString(body, "rfqCid"),
        acceptedQuoteCid: expectString(body, "acceptedQuoteCid"),
        clientIp: clientAddress(req, cfg.testnetTrustProxy ?? false),
      });
      respondJson(res, 200, receipt);
    } catch (e) {
      throw testnetRfqHttpError(e);
    }
    return;
  }

  if (onboarding && method === "POST" && path === "/v1/testnet/rfq/cancel") {
    const body = await readValidatedJson<{ party: string; rfqCid: string }>(
      req,
      "POST /v1/testnet/rfq/cancel",
      callerAuth,
    );
    try {
      const result = await onboarding.rfqCancelForParty({
        party: expectString(body, "party"),
        rfqCid: expectString(body, "rfqCid"),
        clientIp: clientAddress(req, cfg.testnetTrustProxy ?? false),
      });
      respondJson(res, 200, result);
    } catch (e) {
      throw testnetRfqHttpError(e);
    }
    return;
  }

  if (onboarding && method === "GET" && path === "/v1/testnet/hosting") {
    const party = url.searchParams.get("party");
    if (!party) {
      throw new HttpError(400, "bad_request", "missing ?party= query parameter");
    }
    respondJson(res, 200, { hostedHere: await onboarding.isHostedHere(party) });
    return;
  }

  throw new HttpError(404, "not_found", `no route: ${method} ${path}`);
}

/**
 * Map an order-flow failure onto its HTTP shape. Shared by the two testnet
 * order routes because they refuse for the same reasons; the mapping is the
 * swap route's, plus the order service's own 400. Anything unrecognized is
 * handed back untouched for the generic 500 path.
 */
/**
 * Map an RFQ-flow failure onto its HTTP shape. Shared by the two testnet RFQ
 * routes because they refuse for the same reasons; the mapping is the swap
 * route's, plus the RFQ service's own 400. Anything unrecognized is handed back
 * untouched for the generic 500 path.
 */
function testnetRfqHttpError(e: unknown): unknown {
  if (e instanceof TestnetRfqRejectedError) {
    return new HttpError(400, "bad_request", e.message, e.details);
  }
  if (e instanceof RfqAuthError) {
    // The service checks ownership before submitting anything; this is the
    // second, ledger-read check inside RfqService.accept firing.
    return new HttpError(403, "forbidden", e.message);
  }
  if (e instanceof TestnetCommandRejectedError) {
    return new HttpError(400, "bad_request", e.message, e.details);
  }
  if (e instanceof TestnetPartyIneligibleError) {
    return new HttpError(403, "forbidden", e.message, e.details);
  }
  if (e instanceof OnboardingThrottleError) {
    return new HttpError(429, "too_many_requests", e.message, e.details);
  }
  if (e instanceof TestnetSubmitUnavailableError) {
    return new HttpError(501, "not_implemented", e.message);
  }
  if (e instanceof TestnetLedgerError) {
    // Summarized on purpose, on both the relayed and the operator steps: the
    // participant's error text can quote the payload back.
    return new HttpError(502, e.code, e.message, e.details);
  }
  return e;
}

function testnetOrderHttpError(e: unknown): unknown {
  if (e instanceof TestnetOrderRejectedError) {
    return new HttpError(400, "bad_request", e.message, e.details);
  }
  if (e instanceof TestnetCommandRejectedError) {
    return new HttpError(400, "bad_request", e.message, e.details);
  }
  if (e instanceof TestnetPartyIneligibleError) {
    return new HttpError(403, "forbidden", e.message, e.details);
  }
  if (e instanceof OnboardingThrottleError) {
    return new HttpError(429, "too_many_requests", e.message, e.details);
  }
  if (e instanceof TestnetSubmitUnavailableError) {
    return new HttpError(501, "not_implemented", e.message);
  }
  if (e instanceof TestnetLedgerError) {
    // Summarized on purpose, on both the relayed and the operator steps: the
    // participant's error text can quote the payload back.
    return new HttpError(502, e.code, e.message, e.details);
  }
  return e;
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

/**
 * The registry's disclosed contracts, from the operator's own registry client.
 * Both the factory refs and the choice context carry disclosure, and a registry
 * may legitimately return the same contract from both (the factory contract is
 * often also what the choice context needs) — the participant rejects a
 * submission that discloses the same contract twice, hence the dedupe.
 */
async function registryDisclosure(
  backend: OperatorBackend,
  admin: Party,
): Promise<DisclosedContract[]> {
  const [factories, choiceContext] = await Promise.all([
    backend.registry.getFactories(admin),
    backend.registry.getChoiceContext(admin),
  ]);
  return dedupeDisclosure([
    ...factories.disclosure,
    ...choiceContext.disclosure,
  ]);
}

/** Disclosed contracts, unique by contract id, first occurrence wins. */
function dedupeDisclosure(all: DisclosedContract[]): DisclosedContract[] {
  return all.filter(
    (d, i) => all.findIndex((o) => o.contractId === d.contractId) === i,
  );
}

/**
 * Client address the testnet faucet throttle is charged to. X-Forwarded-For is
 * set by the caller unless a reverse proxy overwrites it, so it is only read
 * when the deployment declares it sits behind one (testnetTrustProxy);
 * otherwise one client could rotate the header and mint parties without limit.
 */
function clientAddress(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = req.headers["x-forwarded-for"];
    const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "unknown";
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
