// Registry prerequisites bootstrap.
//
// The DEX assumes a set of registry contracts exist on the ledger before any
// trading can happen (see docs/guides/registry-integration.md). This script
// creates, under the asset admin unless noted:
//   - CantonDex.Instrument.InstrumentConfiguration per tradable instrument
//   - the same, under the lpRegistrar, per LP token
//   - CantonDex.Instrument.Credentials:Credential for the holders that need one
//   - CantonDex.Registry.V2:Registry -- the V2 registry, which IS the
//     AllocationFactory / SettlementFactory / TransferFactory (they are
//     interface views of the same contract, so its cid is the value for
//     CANTON_ALLOC_FACTORY_CID and CANTON_SETTLE_FACTORY_CID)
//   - CantonDex.Registry.V2:InstrumentConfig per V2 instrument, via
//     Registry_RegisterInstrument. Nothing else creates these: Registry_Mint
//     needs one and never creates one lazily.
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

interface CredentialRequirement {
  issuer: string;
  property: string;
  value: string;
}

interface RegistryV2Instrument {
  instrumentId: string;
  // Daml Decimal is 10-scale; the registry accepts 0..18.
  decimals?: number;
  // Total issuable supply. Omit (or null) for uncapped.
  supplyCap?: string | null;
  holderRequirements?: CredentialRequirement[];
  issuerRequirements?: CredentialRequirement[];
  isin?: string | null;
  cusip?: string | null;
}

interface BootstrapConfig {
  instruments: Array<{
    instrumentId: string;
    description: string;
    isin?: string;
    cusip?: string;
    holderRequirements?: CredentialRequirement[];
    issuerRequirements?: CredentialRequirement[];
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
  // The V2 registry: the contract every V2 holding is minted through. Distinct
  // from `instruments` above, which creates the legacy reference-registry
  // InstrumentConfiguration.
  registryV2?: {
    // Parties allowed to exercise the factory choices. Defaults to the
    // operator + lpRegistrar.
    users?: string[];
    instruments: RegistryV2Instrument[];
  };
}

const DEFAULT_CONFIG: BootstrapConfig = {
  instruments: [
    { instrumentId: "BTC", description: "Demo Bitcoin" },
    { instrumentId: "USDC", description: "Demo USD Coin" },
    { instrumentId: "ETH", description: "Demo Ether" },
  ],
  lpInstruments: ["BTC-USDC-LP", "ETH-USDC-LP"],
  credentials: [],
  registryV2: {
    // Mirrors `instruments` above: the V1 reference registry and the V2
    // registry are separate contracts, and an instrument tradable on one is
    // not automatically registered on the other.
    instruments: [
      { instrumentId: "BTC", decimals: 8 },
      { instrumentId: "USDC" },
      { instrumentId: "ETH" },
    ],
  },
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
    commandId: "bootstrap-registry-v2",
    command: {
      kind: "create",
      templateId: REGISTRY_TEMPLATE_ID,
      argument: { admin, users },
    },
  });
  // The AllocationFactory / SettlementFactory / TransferFactory are interface
  // views of this same contract, so this one cid is all three.
  log.info(
    "Registry.V2 created -- use this cid for CANTON_ALLOC_FACTORY_CID and CANTON_SETTLE_FACTORY_CID",
    { contractId },
  );
  return contractId;
}

/**
 * Register one instrument on the V2 registry. This is what mints go through:
 * Registry_Mint takes the InstrumentConfig cid and will not register an
 * instrument on demand, so every mintable instrument has to be listed here.
 */
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
        holderRequirements: inst.holderRequirements ?? [],
        issuerRequirements: inst.issuerRequirements ?? [],
        isin: inst.isin ?? null,
        cusip: inst.cusip ?? null,
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
  const operator = required("CANTON_OPERATOR");
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

  const registryV2 = cfg.registryV2 ?? DEFAULT_CONFIG.registryV2!;

  log.info("bootstrap starting", {
    ledger: baseUrl,
    admin,
    lpRegistrar,
    instruments: cfg.instruments.length,
    lpInstruments: cfg.lpInstruments.length,
    credentials: cfg.credentials.length,
    registryV2Instruments: registryV2.instruments.length,
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

  // 4. The V2 registry and its instruments. Every V2 holding is minted
  //    through Registry_Mint, which needs an InstrumentConfig for the
  //    instrument and never creates one lazily, so anything that will be
  //    minted has to be listed in registryV2.instruments.
  const registryCid = await ensureRegistry(
    ledger,
    admin,
    registryV2.users ?? [operator, lpRegistrar],
    dryRun,
  );
  if (registryCid) {
    for (const inst of registryV2.instruments) {
      await ensureV2Instrument(ledger, admin, registryCid, inst, dryRun);
    }
  } else {
    log.info("dry run: skipping V2 instrument registration", {
      instruments: registryV2.instruments.map((i) => i.instrumentId),
    });
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
