// Registry prerequisites bootstrap.
//
// The DEX assumes a set of registry contracts exist on the ledger before any
// trading can happen (see docs/guides/registry-integration.md). This script
// creates one CantonDex.Registry.V2:Registry per admin, registers the configured
// instruments, and exposes the V2 holding, allocation, settlement, and
// transfer interfaces.
//
// This script is idempotent: it checks whether each contract already
// exists (by template + payload key) and only creates the missing ones.
//
// Usage:
//   node --import tsx scripts/bootstrap-registry.ts
//
// Required env vars (see services/operator-backend/.env.example):
//   CANTON_LEDGER_URL, CANTON_LEDGER_TOKEN, CANTON_USER_ID,
//   CANTON_ADMIN, CANTON_LP_REGISTRAR, CANTON_OPERATOR.
//
// Optional:
//   BOOTSTRAP_CONFIG       path to a JSON config (default: scripts/bootstrap-registry.json)
//   BOOTSTRAP_DRY_RUN      "1" to print the plan without submitting
//   CANTON_DEX_PACKAGE_ID  package hash prefix for template ids

import { readFileSync, existsSync } from "node:fs";
import { JsonApiLedger } from "../services/operator-backend/src/ledger/json-api.js";
import { rootLogger } from "../services/operator-backend/src/lib/logger.js";

const log = rootLogger.child({ component: "bootstrap-registry" });

interface RegistryV2Instrument {
  instrumentId: string;
  // Daml Decimal is 10-scale; the registry accepts 0..18.
  decimals?: number;
  // Total issuable supply. Omit (or null) for uncapped.
  supplyCap?: string | null;
  isin?: string | null;
  cusip?: string | null;
}

interface BootstrapConfig {
  instruments: RegistryV2Instrument[];
  // LP instrument ids — one per pool that the operator plans to seed.
  lpInstruments: string[];
  // Optional registry overrides. The top-level instruments remain the default.
  registryV2?: {
    // Parties allowed to exercise the factory choices. Defaults to the
    // operator + lpRegistrar.
    users?: string[];
    instruments: RegistryV2Instrument[];
  };
}

const DEFAULT_CONFIG: BootstrapConfig = {
  instruments: [
    { instrumentId: "BTC" },
    { instrumentId: "USDC" },
    { instrumentId: "ETH" },
  ],
  lpInstruments: ["BTC-USDC-LP", "ETH-USDC-LP"],
};

const REGISTRY_TEMPLATE_ID = "CantonDex.Registry.V2:Registry";
const INSTRUMENT_CONFIG_TEMPLATE_ID = "CantonDex.Registry.V2:InstrumentConfig";

/** Daml Decimal scale, used when an instrument does not pick its own. */
const DEFAULT_DECIMALS = 10;

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    log.error("missing required env var", { var: name });
    process.exit(1);
  }
  return v;
}

function loadConfig(): BootstrapConfig {
  const path = process.env.BOOTSTRAP_CONFIG ?? "scripts/bootstrap-registry.json";
  if (!existsSync(path)) {
    log.info("config file not found, using defaults", { path });
    return DEFAULT_CONFIG;
  }
  return JSON.parse(readFileSync(path, "utf8")) as BootstrapConfig;
}

/**
 * Create the V2 Registry if the admin does not have one. Returns its cid, or
 * undefined on a dry run where nothing was created.
 */
async function ensureRegistry(
  ledger: JsonApiLedger,
  admin: string,
  users: string[],
  dryRun: boolean,
): Promise<string | undefined> {
  const existing = await ledger.query<{ admin: string; contractId: string }>({
    templateId: REGISTRY_TEMPLATE_ID,
    observingParty: admin,
  });
  const found = existing.find((r) => r.admin === admin);
  if (found) {
    log.info("Registry.V2 already present", { contractId: found.contractId });
    return found.contractId;
  }
  log.info("creating Registry.V2", { users, dryRun });
  if (dryRun) return undefined;
  const contractId = await ledger.submit<string>({
    actAs: [admin],
    commandId: `bootstrap-registry-v2:${admin}`,
    command: {
      kind: "create",
      templateId: REGISTRY_TEMPLATE_ID,
      argument: { admin, users },
    },
  });
  // One cid answers for all three factory interfaces, per admin.
  log.info("Registry.V2 created", { admin, contractId });
  return contractId;
}

/** Register one instrument on the V2 registry; required before any mint. */
async function ensureV2Instrument(
  ledger: JsonApiLedger,
  admin: string,
  registryCid: string,
  inst: RegistryV2Instrument,
  dryRun: boolean,
): Promise<void> {
  // InstrumentConfig is `signatory admin` with no observers, so the admin is
  // the only party that can see it.
  const existing = await ledger.query<{ admin: string; instrumentId: string }>({
    templateId: INSTRUMENT_CONFIG_TEMPLATE_ID,
    observingParty: admin,
  });
  if (
    existing.some((c) => c.admin === admin && c.instrumentId === inst.instrumentId)
  ) {
    log.info("V2 instrument already registered", {
      instrumentId: inst.instrumentId,
    });
    return;
  }
  log.info("registering V2 instrument", {
    instrumentId: inst.instrumentId,
    dryRun,
  });
  if (dryRun) return;
  await ledger.submit({
    actAs: [admin],
    commandId: `bootstrap-registry-v2-instrument-${inst.instrumentId}`,
    command: {
      kind: "exercise",
      templateId: REGISTRY_TEMPLATE_ID,
      contractId: registryCid,
      choice: "Registry_RegisterInstrument",
      argument: {
        instrumentId: inst.instrumentId,
        decimals: String(inst.decimals ?? DEFAULT_DECIMALS),
        supplyCap: inst.supplyCap ?? null,
        // The reference verifier does not resolve signed credential evidence.
        // Bootstrap only open instruments; gated assets need another registry.
        holderRequirements: [],
        issuerRequirements: [],
        isin: inst.isin ?? null,
        cusip: inst.cusip ?? null,
      },
    },
  });
}

async function main(): Promise<void> {
  const baseUrl = required("CANTON_LEDGER_URL");
  const token = required("CANTON_LEDGER_TOKEN");
  const admin = required("CANTON_ADMIN");
  const lpRegistrar = required("CANTON_LP_REGISTRAR");
  // Lazy: only needed once there is a registry to create.
  const operator = () => required("CANTON_OPERATOR");
  const userId = process.env.CANTON_USER_ID ?? "ledger-api-user";
  const dryRun = process.env.BOOTSTRAP_DRY_RUN === "1";

  const cfg = loadConfig();
  const ledger = new JsonApiLedger({
    baseUrl,
    token,
    applicationId: userId,
    templateIdPrefix: process.env.CANTON_DEX_PACKAGE_ID,
    synchronizerId: process.env.CANTON_SYNCHRONIZER,
  });


  log.info("bootstrap starting", {
    ledger: baseUrl,
    admin,
    lpRegistrar,
    instruments: cfg.instruments.length,
    lpInstruments: cfg.lpInstruments.length,
    registryV2Instruments: cfg.registryV2?.instruments.length ?? cfg.instruments.length,
    dryRun,
  });

  // 1. Asset registry and its tradable instruments.
  const registryV2 = cfg.registryV2;
  const assetRegistryCid = await ensureRegistry(
    ledger,
    admin,
    registryV2?.users ?? [operator(), lpRegistrar],
    dryRun,
  );
  for (const inst of registryV2?.instruments ?? cfg.instruments) {
    if (assetRegistryCid) {
      await ensureV2Instrument(ledger, admin, assetRegistryCid, inst, dryRun);
    }
  }

  // 2. LP registry and pool-share instruments. When the same party administers
  // both asset classes, reuse the registry created above.
  const lpRegistryCid = admin === lpRegistrar
    ? assetRegistryCid
    : await ensureRegistry(ledger, lpRegistrar, [operator(), admin], dryRun);
  for (const instrumentId of cfg.lpInstruments) {
    if (lpRegistryCid) {
      await ensureV2Instrument(
        ledger,
        lpRegistrar,
        lpRegistryCid,
        { instrumentId },
        dryRun,
      );
    }
  }

  log.info("bootstrap complete", { dryRun });
}

main().catch((e) => {
  log.error("bootstrap failed", {
    error: e instanceof Error ? e.message : String(e),
    stack: e instanceof Error ? e.stack : undefined,
  });
  process.exit(1);
});
