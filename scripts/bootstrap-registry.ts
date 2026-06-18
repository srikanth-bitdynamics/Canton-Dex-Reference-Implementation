// Registry prerequisites bootstrap.
//
// The DEX assumes a set of reference-registry contracts exist on the ledger
// before any trading can happen (see docs/registry-prerequisites.md):
//   - InstrumentConfiguration per tradable instrument in the reference registry
//   - TransferRule per registrar
//   - Holder/issuer Credentials for the parties that need them
//   - AllocationFactory and SettlementFactory
//   - LP InstrumentConfiguration for each pool in the reference registry
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

interface BootstrapConfig {
  instruments: Array<{
    instrumentId: string;
    description: string;
    isin?: string;
    cusip?: string;
    holderRequirements?: Array<{ issuer: string; property: string; value: string }>;
    issuerRequirements?: Array<{ issuer: string; property: string; value: string }>;
  }>;
  // LP instrument ids — one per pool that the operator plans to seed.
  lpInstruments: string[];
  // Holder credentials to seed (per holder, per requirement).
  credentials: Array<{
    issuer: string;
    holder: string;
    property: string;
    value: string;
  }>;
}

const DEFAULT_CONFIG: BootstrapConfig = {
  instruments: [
    { instrumentId: "BTC", description: "Demo Bitcoin" },
    { instrumentId: "USDC", description: "Demo USD Coin" },
    { instrumentId: "ETH", description: "Demo Ether" },
  ],
  lpInstruments: ["BTC-USDC-LP", "ETH-USDC-LP"],
  credentials: [],
};

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

async function ensureInstrument(
  ledger: JsonApiLedger,
  admin: string,
  inst: BootstrapConfig["instruments"][number],
  dryRun: boolean,
): Promise<void> {
  const existing = await ledger.query<{ admin: string; instrumentId: string }>({
    templateId: "CantonDex.Instrument.InstrumentConfiguration:InstrumentConfiguration",
    observingParty: admin,
  });
  if (existing.some((e) => e.admin === admin && e.instrumentId === inst.instrumentId)) {
    log.info("instrument already configured", { instrumentId: inst.instrumentId });
    return;
  }
  log.info("creating InstrumentConfiguration", { instrumentId: inst.instrumentId, dryRun });
  if (dryRun) return;
  await ledger.submit({
    actAs: [admin],
    commandId: `bootstrap-instrument-${inst.instrumentId}`,
    command: {
      kind: "create",
      templateId: "CantonDex.Instrument.InstrumentConfiguration:InstrumentConfiguration",
      argument: {
        admin,
        instrumentId: inst.instrumentId,
        holderRequirements: inst.holderRequirements ?? [],
        issuerRequirements: inst.issuerRequirements ?? [],
        isin: inst.isin ?? null,
        cusip: inst.cusip ?? null,
        description: inst.description,
      },
    },
  });
}

async function ensureCredential(
  ledger: JsonApiLedger,
  cred: BootstrapConfig["credentials"][number],
  dryRun: boolean,
): Promise<void> {
  const existing = await ledger.query<{
    issuer: string;
    holder: string;
    property: string;
    value: string;
  }>({
    templateId: "CantonDex.Instrument.Credentials:Credential",
    observingParty: cred.issuer,
  });
  if (
    existing.some(
      (c) =>
        c.issuer === cred.issuer &&
        c.holder === cred.holder &&
        c.property === cred.property &&
        c.value === cred.value,
    )
  ) {
    log.info("credential already exists", cred);
    return;
  }
  log.info("creating Credential", { ...cred, dryRun });
  if (dryRun) return;
  await ledger.submit({
    actAs: [cred.issuer],
    commandId: `bootstrap-cred-${cred.issuer}-${cred.holder}-${cred.property}`,
    command: {
      kind: "create",
      templateId: "CantonDex.Instrument.Credentials:Credential",
      argument: cred,
    },
  });
}

async function main(): Promise<void> {
  const baseUrl = required("CANTON_LEDGER_URL");
  const token = required("CANTON_LEDGER_TOKEN");
  const admin = required("CANTON_ADMIN");
  const lpRegistrar = required("CANTON_LP_REGISTRAR");
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
    credentials: cfg.credentials.length,
    dryRun,
  });

  // 1. Admin's instruments (BTC, USDC, ...).
  for (const inst of cfg.instruments) {
    await ensureInstrument(ledger, admin, inst, dryRun);
  }

  // 2. LP token configurations under the lpRegistrar.
  for (const lpId of cfg.lpInstruments) {
    await ensureInstrument(
      ledger,
      lpRegistrar,
      { instrumentId: lpId, description: `LP token for ${lpId}` },
      dryRun,
    );
  }

  // 3. Seed holder credentials.
  for (const cred of cfg.credentials) {
    await ensureCredential(ledger, cred, dryRun);
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
