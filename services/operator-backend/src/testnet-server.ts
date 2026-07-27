// Testnet server. Same HTTP shim as dev-server.ts, but pointed at a
// real Canton participant via JsonApiLedger. Used for the smoke-test
// path against the deployed DEX on a remote testnet.
//
// Required env vars:
//   CANTON_LEDGER_URL    Base URL of the JSON Ledger API.
//   CANTON_LEDGER_TOKEN  Bearer JWT issued by the participant.
//   CANTON_OPERATOR      Operator party (DEX market venue).
//   CANTON_LP_REGISTRAR  LP registrar party.
//   CANTON_ADMIN         Asset admin party.
//   CANTON_USER_ID       JSON Ledger API user id (default: ledger-api-user).
//   CANTON_NETWORK       Display label, e.g. canton:devnet.
//   CANTON_SYNCHRONIZER  Synchronizer id, e.g. global-domain::1220...
//   CANTON_DEX_PACKAGE_ID  Hash (or `#canton-dex-trading`) for template ids.
//
// Optional:
//   CANTON_ALLOC_FACTORY_CID  AllocationFactory contract id.
//   CANTON_SETTLE_FACTORY_CID SettlementFactory contract id.
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
import { testnetOnboardingFromEnv } from "./testnet-onboarding/index.js";
import { RegistryClient } from "@canton-dex/registry-client";
import type { ChoiceContextRef, ContractId, DisclosedContract } from "@canton-dex/registry-client";
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

// Lightweight registry client: resolves each admin's Registry.V2 contract off
// the ledger and serves it as that admin's factory. Production deployments use
// a real registry index.
//
// PER-ADMIN, not fixed. Registry.V2 is its own AllocationFactory and
// SettlementFactory, and `AllocationFactory_Allocate` asserts that the spec's
// instrument admin matches the registry the factory belongs to. This DEX runs
// TWO registries -- `CANTON_ADMIN` issues the deposit instruments (dBTC, dUSD)
// and `CANTON_LP_REGISTRAR` issues the pool's LP token -- and a liquidity DvP
// touches both: two deposit legs on the admin's registry, the LP mint/burn leg
// on the LP registrar's. Returning one cid for every admin therefore authored
// the LP leg against the wrong registry and the ledger rejected the whole
// submission with "AllocationFactory: spec admin must match registry".
//
// It also discloses the registry contract. Registry.V2 is `observer users`
// and that list is fixed at creation, so a party outside it -- every party the
// testnet faucet hands out -- cannot see the factory it has to exercise, and
// its allocation fails with CONTRACT_NOT_FOUND. Explicit contract disclosure
// is the supported way through: attach the contract's createdEventBlob to the
// submission. A real registry serves this from its off-ledger API alongside
// factoryId and choiceContextData; here it is read straight off the ledger,
// which is the same data by a shorter path.
interface ResolvedRegistry {
  cid: string;
  disclosure: DisclosedContract[];
}

class FixedRegistry extends RegistryClient {
  private readonly cache = new Map<string, ResolvedRegistry>();

  constructor(
    private readonly allocCid: ContractId<"AllocationFactory">,
    private readonly settleCid: ContractId<"SettlementFactory">,
    private readonly ledgerBaseUrl: string,
    private readonly ledgerToken: string,
    private readonly adminParty: string,
  ) {
    super({ baseUrl: "http://fixed-registry" });
  }

  /**
   * This admin's own Registry contract, disclosed so non-observers can exercise
   * its factories. Matched on the contract's `admin` FIELD rather than on the
   * queried party: the LP registrar is an observer on the deposit registry too,
   * so its ACS carries both and picking the first would reintroduce the bug.
   */
  private async resolve(admin: string): Promise<ResolvedRegistry> {
    const hit = this.cache.get(admin);
    if (hit) return hit;
    const hdrs = { Authorization: `Bearer ${this.ledgerToken}`, "Content-Type": "application/json" };
    const endRes = await fetch(`${this.ledgerBaseUrl}/v2/state/ledger-end`, { headers: hdrs });
    const { offset } = (await endRes.json()) as { offset: number };
    const res = await fetch(`${this.ledgerBaseUrl}/v2/state/active-contracts`, {
      method: "POST",
      headers: hdrs,
      body: JSON.stringify({
        verbose: false,
        activeAtOffset: offset,
        filter: { filtersByParty: { [admin]: { cumulative: [
          { identifierFilter: { TemplateFilter: { value: {
            // ACS filters take the package-NAME form.
            templateId: "#canton-dex-trading:CantonDex.Registry.V2:Registry",
            includeCreatedEventBlob: true,
          } } } },
        ] } } },
      }),
    });
    const body = (await res.json()) as Array<{
      contractEntry?: { JsActiveContract?: { createdEvent?: {
        contractId: string; templateId: string; createdEventBlob?: string;
        createArgument?: { admin?: string };
      } } };
    }>;
    const ev = body
      .map((e) => e.contractEntry?.JsActiveContract?.createdEvent)
      .find((c) => c?.createArgument?.admin === admin && c?.createdEventBlob);
    if (!ev?.createdEventBlob) {
      // Fall back to the configured cids so a deployment that cannot read the
      // blob keeps the behaviour it had before -- degraded (faucet parties will
      // fail with CONTRACT_NOT_FOUND) but not worse.
      const fallback = admin === this.adminParty ? this.allocCid : null;
      log.warn("registry contract unresolved for admin; parties outside its observer " +
        "list will not be able to allocate", { admin, fallbackCid: fallback });
      if (!fallback) {
        throw new Error(`no Registry.V2 contract found for admin ${admin}`);
      }
      const degraded = { cid: fallback, disclosure: [] as DisclosedContract[] };
      this.cache.set(admin, degraded);
      return degraded;
    }
    // The disclosed templateId must carry the resolved package id -- the
    // `#package-name` form used in the filter above is rejected here.
    const resolved: ResolvedRegistry = {
      cid: ev.contractId,
      disclosure: [{
        templateId: ev.templateId, contractId: ev.contractId, createdEventBlob: ev.createdEventBlob,
      }],
    };
    this.cache.set(admin, resolved);
    return resolved;
  }

  override async getFactories(admin: string) {
    const { cid, disclosure } = await this.resolve(admin);
    // Registry.V2 implements both factory interfaces, so one contract answers
    // for both; `settleCid` stays configurable only for the degraded path.
    return {
      allocationFactoryCid: cid as ContractId<"AllocationFactory">,
      settlementFactoryCid: (cid === this.allocCid
        ? this.settleCid
        : (cid as unknown as ContractId<"SettlementFactory">)),
      disclosure,
    };
  }
  override async getChoiceContext(admin: string): Promise<ChoiceContextRef> {
    const { disclosure } = await this.resolve(admin);
    return { context: { values: {} }, disclosure };
  }
}

async function main(): Promise<void> {
  const baseUrl = required("CANTON_LEDGER_URL");
  const token = required("CANTON_LEDGER_TOKEN");
  const operator = required("CANTON_OPERATOR");
  const lpRegistrar = required("CANTON_LP_REGISTRAR");
  const admin = required("CANTON_ADMIN");
  const userId = process.env.CANTON_USER_ID ?? "ledger-api-user";
  const network = process.env.CANTON_NETWORK ?? "canton:devnet";
  const allocCid = (process.env.CANTON_ALLOC_FACTORY_CID ??
    "PENDING_ALLOC_FACTORY") as ContractId<"AllocationFactory">;
  const settleCid = (process.env.CANTON_SETTLE_FACTORY_CID ??
    "PENDING_SETTLE_FACTORY") as ContractId<"SettlementFactory">;

  const rawLedger = new JsonApiLedger({
    baseUrl,
    token,
    applicationId: userId,
    templateIdPrefix: process.env.CANTON_DEX_PACKAGE_ID,
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

  const backend = new OperatorBackend({
    ledger,
    registry: new FixedRegistry(allocCid, settleCid, baseUrl, token, admin),
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

  // Testnet party faucet. Off unless DEX_TESTNET_ONBOARDING=1; the returned
  // service is what registers the /v1/testnet/* routes. Party and user
  // management sit outside the LedgerSubmitter abstraction, so it is handed
  // the participant's URL + token directly. `userId` is this backend's own
  // ledger user: the airdrop mint acts as the tester's party, so that user
  // needs CanActAs on each party the faucet allocates.
  const testnetOnboarding = testnetOnboardingFromEnv({
    ledger,
    admin,
    ledgerUrl: baseUrl,
    ledgerToken: token,
    userId,
    // Relayed submissions go to submit-and-wait directly (they carry several
    // commands and need the transaction tree back), so they need the same
    // synchronizer id the JsonApiLedger envelope carries.
    synchronizerId: process.env.CANTON_SYNCHRONIZER,
    // The two operator-authority halves of a hosted-party swap
    // (PoolRules_RequestSwap / PoolRules_Swap) run through the same pool
    // service the token-gated routes use.
    pool: backend.pool,
    // The two operator-authority halves of a hosted-party order
    // (OrderFundingRequest_Bind / Order_Fund) and its cancel run through the
    // same order service the token-gated routes use. The registry resolves the
    // allocation factory the collateral step exercises, and the operator party
    // is named on the trader's funding request.
    order: { service: backend.order, registry: backend.registry, operator },
  });

  const indexer = new Indexer(db, ledger, {
    intervalMs: Number(process.env.INDEXER_INTERVAL_MS ?? 5000),
    observingParty: operator,
  });
  indexer.start();

  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? "127.0.0.1";
  const { url, close } = startHttpServer({
    backend,
    port,
    host,
    context: {
      operator,
      lpRegistrar,
      admin,
      allocationFactoryCid: allocCid,
      settlementFactoryCid: settleCid,
      allocationFactoryExtraArgs: { context: { values: {} }, meta: { values: {} } },
      allocationFactoryDisclosure: [],
      network,
    },
    db,
    adminToken: process.env.OPERATOR_ADMIN_TOKEN,
    // Operator token gates all non-admin writes; fail-closed on testnet
    // (no DEX_DEV_OPEN bypass here).
    operatorToken: process.env.DEX_OPERATOR_API_TOKEN,
    devOpen: process.env.DEX_DEV_OPEN === "1",
    // Wallet relay OFF unless explicitly enabled, with a party allowlist.
    walletRelayEnabled: process.env.DEX_DEV_WALLET_RELAY === "1",
    walletRelayParties: (process.env.DEX_DEV_RELAY_PARTIES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    // Per-caller party binding (B-2): when set, trader-subject write routes
    // require an X-Caller-Token JWT whose `sub` is the caller's party.
    callerJwtSecret: process.env.DEX_CALLER_JWT_SECRET || undefined,
    // Optional `aud` claim the caller JWT must carry (defence against a token
    // minted for another service being replayed here).
    callerJwtAudience: process.env.DEX_CALLER_JWT_AUDIENCE || undefined,
    ledgerUrl: baseUrl,
    ledgerToken: token,
    testnetOnboarding,
    // Only honour X-Forwarded-For for the faucet throttle when a trusted
    // reverse proxy is in front of this process.
    testnetTrustProxy: process.env.DEX_TESTNET_TRUST_PROXY === "1",
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
