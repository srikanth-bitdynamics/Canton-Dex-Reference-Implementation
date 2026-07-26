// Registry-backed issuance for the testnet faucet.
//
// A tester's balance is only useful if it can be traded, and every downstream
// flow (swap, add/remove liquidity, transfer) resolves its inputs through the
// V2 Holding interface. The only template that carries
// `interface instance V2.Holding` is `CantonDex.Registry.V2:Holding`, and the
// only way to create one is Registry_Mint on the admin's Registry contract --
// there is no plain-create shortcut. (Registry.V2's own
// allocationFactory_allocateImpl coerces the interface cid back to its module
// -local Holding and fetches it, so a holding of any other template fails at
// allocation time even though it shows up in GET /v1/holdings.)
//
// Two facts about that choice shape this module:
//
//   - `controller admin, owner`: the mint is submitted as both parties, which
//     is also why the provisioner grants the operator's ledger user CanActAs
//     on the party it just allocated.
//   - Registry_Mint exercises the CONSUMING InstrumentConfig_BumpSupply, so
//     the instrument's config cid rotates on every mint. It is re-resolved
//     from the ACS before each attempt and never cached; losing the race
//     surfaces as a stale-contract failure and is retried a bounded number of
//     times.
//
// The Registry and its InstrumentConfigs are operator bootstrap state. This
// module never creates either: a public endpoint that can register instruments
// is not acceptable, so a missing one is a loud failure naming the bootstrap
// step.

import { createHash } from "node:crypto";

import { LedgerError, type LedgerSubmitter } from "../ledger/index.js";
import type { Party } from "../types.js";
import { rootLogger } from "../lib/logger.js";

const log = rootLogger.child({ component: "testnet-onboarding" });

export const REGISTRY_TEMPLATE_ID = "CantonDex.Registry.V2:Registry";
export const INSTRUMENT_CONFIG_TEMPLATE_ID =
  "CantonDex.Registry.V2:InstrumentConfig";
export const REGISTRY_HOLDING_TEMPLATE_ID = "CantonDex.Registry.V2:Holding";

/** How the operator is told to fix a missing registry / instrument. */
const BOOTSTRAP_HINT = "node --import tsx scripts/bootstrap-registry.ts";

const DEFAULT_MAX_ATTEMPTS = 5;
const INITIAL_RETRY_DELAY_MS = 50;
const MAX_RETRY_DELAY_MS = 1000;

/**
 * The faucet is enabled but the ledger it points at was never bootstrapped.
 * An operator misconfiguration, not a caller error -- the HTTP layer maps it
 * to 503 rather than a 500.
 */
export class RegistryBootstrapError extends Error {
  constructor(
    message: string,
    public readonly details: { instrumentId?: string },
  ) {
    super(message);
    this.name = "RegistryBootstrapError";
  }
}

/** No `CantonDex.Registry.V2:Registry` exists for the asset admin. */
export class RegistryNotBootstrappedError extends RegistryBootstrapError {
  constructor(admin: Party) {
    super(
      `no Registry.V2 contract for admin ${admin}. Run the registry bootstrap ` +
        `(${BOOTSTRAP_HINT}) before enabling the testnet faucet.`,
      {},
    );
    this.name = "RegistryNotBootstrappedError";
  }
}

/** A configured airdrop instrument was never registered on the registry. */
export class AirdropInstrumentNotRegisteredError extends RegistryBootstrapError {
  constructor(instrumentId: string, admin: Party) {
    super(
      `airdrop instrument "${instrumentId}" has no Registry.V2 InstrumentConfig ` +
        `for admin ${admin}. Run the registry bootstrap (${BOOTSTRAP_HINT}) to ` +
        `register it, or remove it from DEX_TESTNET_AIRDROP.`,
      { instrumentId },
    );
    this.name = "AirdropInstrumentNotRegisteredError";
  }
}

interface RegistryContract {
  contractId: string;
  admin: string;
}

interface InstrumentConfigContract {
  contractId: string;
  admin: string;
  instrumentId: string;
  circulatingSupply?: string;
}

export interface RegistryMinterConfig {
  ledger: LedgerSubmitter;
  /** Asset admin: signatory of the registry, the configs and the holdings. */
  admin: Party;
  /** Attempts per grant when the config cid rotates under us. */
  maxAttempts?: number;
  /** Injectable backoff (tests). */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Mints V2 holdings through the admin's Registry contract. One instance per
 * onboarding service; it caches nothing that can rotate.
 */
export class RegistryMinter {
  private cachedRegistryCid?: string;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly cfg: RegistryMinterConfig) {
    this.maxAttempts = cfg.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.sleep = cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * Mint `amount` of `instrumentId` to `owner`, returning the holding cid.
   * Throws a RegistryBootstrapError (never retried) when the registry or the
   * instrument's config is missing.
   */
  async mint(owner: Party, instrumentId: string, amount: string): Promise<string> {
    let delay = INITIAL_RETRY_DELAY_MS;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const registryCid = await this.registryCid();
      // Re-resolved on every attempt, never cached: Registry_Mint exercises
      // the consuming InstrumentConfig_BumpSupply, so this cid is dead the
      // moment any other mint of the same instrument commits.
      const configCid = await this.instrumentConfigCid(instrumentId);
      try {
        return await this.cfg.ledger.submit<string>({
          // Registry_Mint is `controller admin, owner` and the holding it
          // creates is `signatory admin, owner`: both authorities are needed.
          actAs: [this.cfg.admin, owner],
          // The config cid is part of the command id because a retry
          // re-resolves it, and the testnet IdempotentLedger rejects a
          // commandId replayed with different args. Double-minting is not a
          // risk: `owner` is a party this request allocated seconds ago, so
          // every command id here is already unique to one grant.
          //
          // Digested rather than concatenated: a party id (~113 chars) plus a
          // contract id (~138) overruns the ledger's 255-char command id limit,
          // which the participant rejects with INVALID_FIELD. The hash keeps the
          // one property that matters -- a different config cid yields a
          // different command id -- at a fixed length.
          commandId: `testnet-airdrop:${instrumentId}:${createHash("sha256")
            .update(`${owner}:${instrumentId}:${configCid}`)
            .digest("hex")
            .slice(0, 32)}`,
          command: {
            kind: "exercise",
            templateId: REGISTRY_TEMPLATE_ID,
            contractId: registryCid,
            choice: "Registry_Mint",
            argument: {
              configCid,
              owner,
              amount,
              // Credential records, not contract ids. Empty is what an
              // instrument with no issuerRequirements expects.
              issuerClaims: [],
            },
          },
        });
      } catch (e) {
        lastErr = e;
        // The Registry template has no consuming choice, so its cid does not
        // rotate -- but drop the cache anyway so a redeployed registry
        // recovers without a restart of the backend.
        this.cachedRegistryCid = undefined;
        if (!isStaleContract(e)) throw e;
        log.warn("airdrop mint raced a config rotation, retrying", {
          instrumentId,
          owner,
          attempt,
          error: e instanceof Error ? e.message : String(e),
        });
        await this.sleep(delay);
        delay = Math.min(MAX_RETRY_DELAY_MS, delay * 2);
      }
    }
    throw lastErr;
  }

  /**
   * The admin's Registry cid. Safe to cache: every choice on the template
   * (both named ones and all four interface instances) is nonconsuming, so
   * the contract lives for the deployment.
   */
  private async registryCid(): Promise<string> {
    if (this.cachedRegistryCid) return this.cachedRegistryCid;
    const registries = await this.cfg.ledger.query<RegistryContract>({
      templateId: REGISTRY_TEMPLATE_ID,
      observingParty: this.cfg.admin,
    });
    const found = registries
      .filter((r) => r.admin === this.cfg.admin)
      .sort((a, b) => a.contractId.localeCompare(b.contractId))[0];
    if (!found) throw new RegistryNotBootstrappedError(this.cfg.admin);
    this.cachedRegistryCid = found.contractId;
    return found.contractId;
  }

  /** Current config cid for `instrumentId`. Deliberately never cached. */
  private async instrumentConfigCid(instrumentId: string): Promise<string> {
    // InstrumentConfig is `signatory admin` with no observers, so the admin is
    // the only party that can see it.
    const all = await this.cfg.ledger.query<InstrumentConfigContract>({
      templateId: INSTRUMENT_CONFIG_TEMPLATE_ID,
      observingParty: this.cfg.admin,
    });
    const configs = all.filter(
      (c) => c.admin === this.cfg.admin && c.instrumentId === instrumentId,
    );
    if (configs.length === 0) {
      throw new AirdropInstrumentNotRegisteredError(instrumentId, this.cfg.admin);
    }
    if (configs.length > 1) {
      // A duplicate registration splits the supply accounting over two
      // configs -- an operator error worth surfacing, but not worth wedging
      // the faucet for. Pick the one furthest along, deterministically.
      log.warn("duplicate Registry.V2 InstrumentConfig for one instrument", {
        instrumentId,
        count: configs.length,
      });
      configs.sort(
        (a, b) =>
          Number(b.circulatingSupply ?? 0) - Number(a.circulatingSupply ?? 0) ||
          a.contractId.localeCompare(b.contractId),
      );
    }
    return configs[0]!.contractId;
  }
}

/**
 * Did this failure come from submitting against a contract that is no longer
 * active? The in-memory ledger reports a consumed cid as `kind: "contention"`;
 * Canton reports CONTRACT_NOT_FOUND / CONTRACT_NOT_ACTIVE /
 * LOCAL_VERDICT_LOCKED_CONTRACTS, none of which the JSON API driver's
 * `errorFor` classifies as contention -- hence the detail-string arm.
 */
export function isStaleContract(e: unknown): boolean {
  if (!(e instanceof LedgerError)) return false;
  if (e.kind === "contention") return true;
  return /contract_not_found|contract_not_active|locked_contracts|inconsistent|archived/i.test(
    e.detail,
  );
}
