// Testnet server. Same HTTP shim as dev-server.ts, but pointed at a
// real Canton participant via JsonApiLedger. Used for the smoke-test
// path against the deployed DEX on a remote testnet.
//
// Required env vars:
//   CANTON_LEDGER_URL    Base URL of the JSON Ledger API, e.g.
//                        http://5.75.216.246:7575
//   CANTON_LEDGER_TOKEN  Bearer JWT issued by the participant.
//   CANTON_OPERATOR      Operator party (DEX market venue).
//   CANTON_LP_REGISTRAR  LP registrar party.
//   CANTON_ADMIN         Asset admin party.
//   CANTON_USER_ID       JSON Ledger API user id (default: ledger-api-user).
//   CANTON_NETWORK       Display label, e.g. canton:devnet.
//   CANTON_SYNCHRONIZER  Synchronizer id, e.g. global-domain::1220...
//   CANTON_DEX_PACKAGE_ID  Hash (or `#canton-dex-pr5333`) for template ids.
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
import { RegistryClient } from "@canton-dex/registry-client";
import type { ContractId } from "@canton-dex/registry-client";

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    // eslint-disable-next-line no-console
    console.error(`[testnet-server] missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

// Lightweight registry client: returns the configured factory CIDs for
// every admin. Production deployments use a real registry index.
class FixedRegistry extends RegistryClient {
  constructor(
    private readonly allocCid: ContractId<"AllocationFactory">,
    private readonly settleCid: ContractId<"SettlementFactory">,
  ) {
    super({ baseUrl: "http://fixed-registry" });
  }
  override async getFactories() {
    return {
      allocationFactoryCid: this.allocCid,
      settlementFactoryCid: this.settleCid,
      disclosure: [] as never[],
    };
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
    registry: new FixedRegistry(allocCid, settleCid),
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
  const { url } = startHttpServer({
    backend,
    port,
    host: "127.0.0.1",
    context: {
      operator,
      lpRegistrar,
      admin,
      allocationFactoryCid: allocCid,
      settlementFactoryCid: settleCid,
      network,
    },
    db,
    adminToken: process.env.OPERATOR_ADMIN_TOKEN,
    ledgerUrl: baseUrl,
    ledgerToken: token,
  });
  // eslint-disable-next-line no-console
  console.log(`[testnet-server] listening at ${url}`);
  console.log(`[testnet-server] ledger: ${baseUrl}`);
  console.log(`[testnet-server] operator: ${operator}`);
  console.log(`[testnet-server] lpRegistrar: ${lpRegistrar}`);
  console.log(`[testnet-server] admin: ${admin}`);
  console.log(`[testnet-server] network: ${network}`);
  console.log(`[testnet-server] indexer: db=${dbPath}, interval=${process.env.INDEXER_INTERVAL_MS ?? 5000}ms`);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("[testnet-server] fatal:", e);
  process.exit(1);
});
