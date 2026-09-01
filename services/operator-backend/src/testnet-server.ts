// Remote-participant runtime entrypoint. It uses the same HTTP API surface as
// dev-server.ts, but JsonApiLedger submits to a real Canton participant and a
// DEX package that the operator has deployed to a controlled testnet.
//
// Required env vars:
//   CANTON_LEDGER_URL    Base URL of the JSON Ledger API.
//   CANTON_LEDGER_TOKEN  Bearer JWT issued by the participant.
//   CANTON_OPERATOR      Operator party (DEX market venue).
//   CANTON_LP_REGISTRAR  LP registrar party.
//   CANTON_ADMIN         Asset admin party.
//   CANTON_DEX_PACKAGE_ID  Hash (or `#canton-dex-trading-v2`) for template ids.
//
// Defaulted / optional:
//   CANTON_USER_ID       JSON Ledger API user id (default: ledger-api-user).
//   CANTON_NETWORK       Display label, e.g. canton:devnet.
//   CANTON_SYNCHRONIZER  Synchronizer id, e.g. global-domain::1220...
//
// Required in full/write mode (optional only with DEX_READ_ONLY=1):
//   DEX_OPERATOR_API_TOKEN  Bearer token for non-admin state-changing routes.
//   OPERATOR_ADMIN_TOKEN    Bearer token for /v1/admin/* writes.
//   CANTON_ALLOC_FACTORY_CID  Asset-admin AllocationFactory contract id.
//   CANTON_SETTLE_FACTORY_CID Asset-admin SettlementFactory contract id.
//   CANTON_LP_ALLOC_FACTORY_CID  LP-registry AllocationFactory contract id
//                                when lpRegistrar != admin.
//   CANTON_LP_SETTLE_FACTORY_CID LP-registry SettlementFactory contract id
//                                when lpRegistrar != admin.
//   DEX_READ_ONLY=1          Start without API write tokens; state-changing
//                            routes fail closed, while reads/read-only quotes
//                            remain usable.
//
// Optional trusted relay (disabled by default):
//   DEX_HOSTED_RFQ_RELAY=1   Allow the HTTP RFQ create/cancel/accept routes to
//                            submit with trader authority. Requires
//                            DEX_CALLER_JWT_SECRET and participant rights for
//                            every hosted trader. This is not self-custody.
//
// Why this lives next to dev-server.ts and not in place of it: the
// in-memory dev server is the fast local path for UI development. The
// testnet server is the real path. Both share the same HTTP routes via
// startHttpServer() so the dApp doesn't change.

import { JsonApiLedger } from "./ledger/json-api.js";
import { OperatorBackend } from "./index.js";
import { startHttpServer } from "./http/index.js";
import { openDb } from "./indexer/db.js";
import { Indexer } from "./indexer/index.js";
import { IdempotentLedger } from "./indexer/idempotency.js";
import { DealersService } from "./dealers/index.js";
import {
  FixedRegistryClient,
  RegistryClient,
  RegistryError,
} from "@canton-dex/registry-client";
import type {
  ChoiceArguments,
  ChoiceContextRef,
  ContractId,
  FactoryChoiceContextRef,
  FactoryRefs,
  Party,
  RegistryDiscovery,
} from "@canton-dex/registry-client";
import { rootLogger } from "./lib/logger.js";

const log = rootLogger.child({ component: "testnet-server" });

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    log.error("missing required env var", { var: name });
    process.exit(1);
  }
  return v;
}

// Lightweight registry client for the two reference registrars. It is
// intentionally explicit per admin: returning one registry CID for every
// party breaks LP issuance as soon as asset governance and LP custody are
// separated. Deployments that list arbitrary third-party assets should replace
// this map with the registry HTTP discovery client.
class ConfiguredRegistry extends FixedRegistryClient {
  constructor(factoriesByAdmin: ReadonlyMap<Party, FactoryRefs>) {
    super((admin) => {
      const factories = factoriesByAdmin.get(admin);
      if (!factories) {
        throw new RegistryError(
          "factory-stale",
          `no configured factory mapping for admin=${admin}`,
          false,
        );
      }
      return factories;
    });
  }
}

// Routes registry discovery by instrument admin. The DEX's own registrars use
// their bootstrap-configured factory cids (ConfiguredRegistry); any admin listed
// in DEX_EXTERNAL_REGISTRIES is discovered live over the CIP-112 registry HTTP
// API (e.g. USDCx via the DA Utilities registry). External registries return
// their own choice context and disclosures, which the settlement path threads
// per admin already.
class RoutingRegistry implements RegistryDiscovery {
  constructor(
    private readonly self: RegistryDiscovery,
    private readonly external: RegistryDiscovery,
    private readonly isExternal: (admin: Party) => boolean,
  ) {}

  private pick(admin: Party): RegistryDiscovery {
    return this.isExternal(admin) ? this.external : this.self;
  }

  getAllocationFactory(
    admin: Party,
    args: ChoiceArguments,
  ): Promise<FactoryChoiceContextRef> {
    return this.pick(admin).getAllocationFactory(admin, args);
  }

  getSettlementFactory(
    admin: Party,
    args: ChoiceArguments,
  ): Promise<FactoryChoiceContextRef> {
    return this.pick(admin).getSettlementFactory(admin, args);
  }

  getAllocationCancelContext(
    admin: Party,
    allocationId: string,
    meta?: Record<string, string>,
  ): Promise<ChoiceContextRef> {
    return this.pick(admin).getAllocationCancelContext(admin, allocationId, meta);
  }

  getAllocationWithdrawContext(
    admin: Party,
    allocationId: string,
    meta?: Record<string, string>,
  ): Promise<ChoiceContextRef> {
    return this.pick(admin).getAllocationWithdrawContext(admin, allocationId, meta);
  }
}

// DEX_EXTERNAL_REGISTRIES = {"<instrument-admin-party>":"<registry-base-url>"}.
// Maps a third-party instrument admin to the CIP-112 registry HTTP API that
// serves its factories and choice contexts. Empty/unset keeps every instrument
// on the bootstrap-configured registrars. Example (USDCx on TestNet): the
// decentralized-usdc-interchain-rep admin -> the DA Utilities registry URL.
function externalRegistries(): Map<Party, string> {
  const raw = process.env.DEX_EXTERNAL_REGISTRIES;
  if (!raw) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.error("DEX_EXTERNAL_REGISTRIES is not valid JSON");
    process.exit(1);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    log.error("DEX_EXTERNAL_REGISTRIES must be a JSON object of admin -> url");
    process.exit(1);
  }
  const map = new Map<Party, string>();
  for (const [admin, url] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) {
      log.error("DEX_EXTERNAL_REGISTRIES url must be http(s)", { admin });
      process.exit(1);
    }
    map.set(admin, url);
  }
  return map;
}

// Optional Canton Coin / Amulet leg. Amulet's instrument admin is the DSO
// party, which is not a fixed constant: it is fetched live from the trusted
// Scan node's /v0/dso-party-id. When DEX_AMULET_SCAN_URL is set, that DSO party
// is registered as an external registry served under the Scan token-standard
// mount (default <scan>/api/scan, overridable via DEX_AMULET_REGISTRY_BASE).
// Fails closed if the lookup does not return a party.
async function resolveAmuletRegistry(): Promise<
  { admin: Party; url: string } | null
> {
  const scan = process.env.DEX_AMULET_SCAN_URL;
  if (!scan) return null;
  const base = scan.replace(/\/+$/, "");
  const registryBase =
    process.env.DEX_AMULET_REGISTRY_BASE?.replace(/\/+$/, "") ??
    `${base}/api/scan`;
  let dso: string;
  try {
    const res = await fetch(`${base}/v0/dso-party-id`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      log.error("dso-party-id lookup failed", { status: res.status });
      process.exit(1);
    }
    const body = (await res.json()) as { dso_party_id?: unknown };
    if (typeof body.dso_party_id !== "string" || body.dso_party_id.length === 0) {
      log.error("dso-party-id response missing dso_party_id");
      process.exit(1);
    }
    dso = body.dso_party_id;
  } catch (e) {
    log.error("dso-party-id lookup error", {
      error: e instanceof Error ? e.message : String(e),
    });
    process.exit(1);
  }
  log.info("amulet registry resolved", { dso, registryBase });
  return { admin: dso, url: registryBase };
}

async function main(): Promise<void> {
  const baseUrl = required("CANTON_LEDGER_URL");
  const token = required("CANTON_LEDGER_TOKEN");
  const operator = required("CANTON_OPERATOR");
  const lpRegistrar = required("CANTON_LP_REGISTRAR");
  const admin = required("CANTON_ADMIN");
  const dexPackageId = required("CANTON_DEX_PACKAGE_ID");
  const userId = process.env.CANTON_USER_ID ?? "ledger-api-user";
  const network = process.env.CANTON_NETWORK ?? "canton:devnet";
  const readOnly = process.env.DEX_READ_ONLY === "1";
  const hostedRfqEnabled = process.env.DEX_HOSTED_RFQ_RELAY === "1";
  const callerJwtSecret = process.env.DEX_CALLER_JWT_SECRET || undefined;
  if (readOnly && hostedRfqEnabled) {
    log.error("invalid mode: DEX_HOSTED_RFQ_RELAY cannot be enabled with DEX_READ_ONLY");
    process.exit(1);
  }
  if (hostedRfqEnabled && !callerJwtSecret) {
    required("DEX_CALLER_JWT_SECRET");
  }
  // Fail at startup instead of presenting a deceptively healthy but unusable
  // full-mode server. Read-only operation must be chosen explicitly.
  const operatorToken = readOnly
    ? undefined
    : required("DEX_OPERATOR_API_TOKEN");
  const adminToken = readOnly
    ? undefined
    : required("OPERATOR_ADMIN_TOKEN");
  const allocCid = (readOnly
    ? process.env.CANTON_ALLOC_FACTORY_CID || "PENDING_ALLOC_FACTORY"
    : required("CANTON_ALLOC_FACTORY_CID")) as ContractId<"AllocationFactory">;
  const settleCid = (readOnly
    ? process.env.CANTON_SETTLE_FACTORY_CID || "PENDING_SETTLE_FACTORY"
    : required("CANTON_SETTLE_FACTORY_CID")) as ContractId<"SettlementFactory">;
  const lpAllocCid = (lpRegistrar === admin
    ? allocCid
    : readOnly
      ? process.env.CANTON_LP_ALLOC_FACTORY_CID || "PENDING_LP_ALLOC_FACTORY"
      : required("CANTON_LP_ALLOC_FACTORY_CID")) as ContractId<"AllocationFactory">;
  const lpSettleCid = (lpRegistrar === admin
    ? settleCid
    : readOnly
      ? process.env.CANTON_LP_SETTLE_FACTORY_CID || "PENDING_LP_SETTLE_FACTORY"
      : required("CANTON_LP_SETTLE_FACTORY_CID")) as ContractId<"SettlementFactory">;

  const factoriesByAdmin = new Map<Party, FactoryRefs>([
    [
      admin,
      {
        allocationFactoryCid: allocCid,
        settlementFactoryCid: settleCid,
        disclosure: [],
      },
    ],
    [
      lpRegistrar,
      {
        allocationFactoryCid: lpAllocCid,
        settlementFactoryCid: lpSettleCid,
        disclosure: [],
      },
    ],
  ]);

  const rawLedger = new JsonApiLedger({
    baseUrl,
    token,
    applicationId: userId,
    templateIdPrefix: dexPackageId,
    synchronizerId: process.env.CANTON_SYNCHRONIZER,
  });

  // Indexer + persistence.
  const dbPath = process.env.DB_PATH ?? "./data/operator.db";
  const db = openDb(dbPath);

  // Wrap the ledger so every submit() goes through idempotency.
  const ledger = new IdempotentLedger(rawLedger, db);
  // Sweep stale rows every hour.
  const sweepTimer = setInterval(() => ledger.sweep(), 60 * 60 * 1000);
  if (typeof sweepTimer.unref === "function") sweepTimer.unref();

  const configuredRegistry = new ConfiguredRegistry(factoriesByAdmin);
  const externalRegistryMap = externalRegistries();
  const amulet = await resolveAmuletRegistry();
  if (amulet) externalRegistryMap.set(amulet.admin, amulet.url);
  const registry: RegistryDiscovery =
    externalRegistryMap.size === 0
      ? configuredRegistry
      : new RoutingRegistry(
          configuredRegistry,
          new RegistryClient({
            baseUrl: (a: Party) => {
              const url = externalRegistryMap.get(a);
              if (!url) {
                throw new RegistryError(
                  "factory-stale",
                  `no external registry url for admin=${a}`,
                  false,
                );
              }
              return url;
            },
            authToken: process.env.DEX_EXTERNAL_REGISTRY_TOKEN || undefined,
          }),
          (a) => externalRegistryMap.has(a),
        );
  if (externalRegistryMap.size > 0) {
    log.info("external registries enabled", {
      admins: [...externalRegistryMap.keys()],
    });
  }

  const backend = new OperatorBackend({
    ledger,
    registry,
    operatorParty: operator,
  });

  // Seed dealer registry from DEX_INITIAL_DEALERS env if the table is empty.
  // Format: JSON array of { party, name, trusted?, whitelisted?, latencyMs?, fillRate? }
  const initialDealersRaw = process.env.DEX_INITIAL_DEALERS;
  if (initialDealersRaw) {
    try {
      const initial = JSON.parse(initialDealersRaw) as Array<{
        party: string;
        name?: string;
        trusted?: boolean;
        whitelisted?: boolean;
        latencyMs?: number | null;
        fillRate?: number | null;
      }>;
      new DealersService(db).seedIfEmpty(initial);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        "[testnet-server] failed to parse DEX_INITIAL_DEALERS:",
        e instanceof Error ? e.message : e,
      );
    }
  }

  const indexer = new Indexer(db, ledger, {
    intervalMs: Number(process.env.INDEXER_INTERVAL_MS ?? 5000),
    observingParty: operator,
  });
  indexer.start();

  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? "127.0.0.1";
  const { url, close } = await startHttpServer({
    backend,
    port,
    host,
    context: {
      operator,
      lpRegistrar,
      admin,
      network,
    },
    db,
    adminToken,
    // Operator token gates all non-admin writes; fail-closed on testnet
    // (no DEX_DEV_OPEN bypass here).
    operatorToken,
    // The in-memory dev server is the only entrypoint allowed to honor
    // DEX_DEV_OPEN. A stray deployment environment variable must never bypass
    // the testnet/production write gate (including explicit read-only mode).
    devOpen: false,
    // The arbitrary-command wallet relay is confined to dev-server.ts. A
    // deployment must use a real wallet/BFF boundary; testnet-server never
    // honors DEX_DEV_WALLET_RELAY even if it leaks into the environment.
    walletRelayEnabled: false,
    walletRelayParties: [],
    hostedRfqEnabled,
    // Per-caller party binding: when set, party-scoped reads and trader-subject
    // writes require an X-Caller-Token JWT whose `sub` is the caller's party.
    callerJwtSecret,
    // Optional `aud` claim the caller JWT must carry (defence against a token
    // minted for another service being replayed here).
    callerJwtAudience: process.env.DEX_CALLER_JWT_AUDIENCE || undefined,
    ledgerUrl: baseUrl,
    ledgerToken: token,
  });
  log.info("server started", {
    url,
    ledger: baseUrl,
    operator,
    lpRegistrar,
    admin,
    network,
    db: dbPath,
    indexerIntervalMs: Number(process.env.INDEXER_INTERVAL_MS ?? 5000),
    mode: readOnly ? "read-only" : "full",
    registryAdmins: Array.from(factoriesByAdmin.keys()),
    hostedRfqEnabled,
  });

  // Graceful shutdown: drain HTTP requests, stop indexer, flush DB.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutdown signal received", { signal });
    clearInterval(sweepTimer);
    try {
      indexer.stop();
    } catch (e) {
      log.warn("indexer stop failed", { error: String(e) });
    }
    try {
      await close();
    } catch (e) {
      log.warn("http close failed", { error: String(e) });
    }
    try {
      db.close();
    } catch (e) {
      log.warn("db close failed", { error: String(e) });
    }
    log.info("shutdown complete");
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((e) => {
  log.error("fatal", { error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined });
  process.exit(1);
});
