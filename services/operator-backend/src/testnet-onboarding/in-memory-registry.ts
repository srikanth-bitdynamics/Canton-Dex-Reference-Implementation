// Registry.V2 issuance, simulated on the in-memory ledger.
//
// The dev server and the backend unit tests run against InMemoryLedger, which
// knows nothing about Daml: anything the backend exercises there has to be
// hand-written. This module simulates the two issuance choices the faucet
// depends on, and it is deliberately faithful in the two respects that the
// airdrop's correctness rests on:
//
//   - the minted holding lands under `CantonDex.Registry.V2:Holding` -- the
//     only template carrying the V2 Holding interface instance -- and not
//     under the legacy `CantonDex.Instrument.Holding:Holding`;
//   - Registry_Mint archives the InstrumentConfig it was handed and recreates
//     it with the bumped supply, so the config cid ROTATES exactly as the
//     consuming InstrumentConfig_BumpSupply makes it rotate on a participant.
//
// Without the second property a caller could cache the config cid and every
// local test would still pass while the second airdrop on testnet failed.
//
// It is a mock, not a Daml interpreter: no authorization, no supply cap, no
// credential checks.

import { LedgerError } from "../ledger/index.js";
import type { InMemoryLedger } from "../ledger/in-memory.js";
import type { Party } from "../types.js";
import {
  INSTRUMENT_CONFIG_TEMPLATE_ID,
  REGISTRY_HOLDING_TEMPLATE_ID,
  REGISTRY_TEMPLATE_ID,
} from "./registry-mint.js";

/** Daml's Decimal scale, matching what the rest of the wire code emits. */
const SCALE = 10;

export interface DevRegistryParties {
  /** Asset admin: signatory of the registry, configs and holdings. */
  admin: Party;
  /**
   * Extra parties that must be able to see the registry and the minted
   * holdings. Observers are explicit on the in-memory ledger (signatories are
   * not implied), and the dev server's /v1/holdings route queries as the
   * operator, so the operator belongs here.
   */
  observers?: Party[];
}

/**
 * Register the create + choice handlers that make Registry_RegisterInstrument
 * and Registry_Mint work on an InMemoryLedger.
 */
export function registerRegistryV2Handlers(
  ledger: InMemoryLedger,
  parties: DevRegistryParties,
): void {
  const { admin } = parties;
  const extra = parties.observers ?? [];

  ledger.registerCreateHandler(REGISTRY_TEMPLATE_ID, (payload) => ({
    observers: [
      admin,
      ...extra,
      ...((payload as { users?: Party[] }).users ?? []),
    ],
  }));
  // InstrumentConfig is `signatory admin` with no observers on the ledger.
  ledger.registerCreateHandler(INSTRUMENT_CONFIG_TEMPLATE_ID, () => ({
    observers: [admin],
  }));
  ledger.registerCreateHandler(REGISTRY_HOLDING_TEMPLATE_ID, (payload) => ({
    observers: [admin, ...extra, (payload as { owner: Party }).owner],
  }));

  ledger.registerChoice(
    REGISTRY_TEMPLATE_ID,
    "Registry_RegisterInstrument",
    (ctx) => {
      const registry = ctx.self.payload as { admin: Party };
      const arg = ctx.arg as {
        instrumentId: string;
        decimals?: unknown;
        supplyCap?: unknown;
        holderRequirements?: unknown[];
        issuerRequirements?: unknown[];
        isin?: unknown;
        cusip?: unknown;
      };
      return ctx.create(
        INSTRUMENT_CONFIG_TEMPLATE_ID,
        {
          admin: registry.admin,
          instrumentId: arg.instrumentId,
          decimals: arg.decimals ?? String(SCALE),
          supplyCap: arg.supplyCap ?? null,
          circulatingSupply: (0).toFixed(SCALE),
          holderRequirements: arg.holderRequirements ?? [],
          issuerRequirements: arg.issuerRequirements ?? [],
          isin: arg.isin ?? null,
          cusip: arg.cusip ?? null,
        },
        [registry.admin],
      );
    },
  );

  ledger.registerChoice(REGISTRY_TEMPLATE_ID, "Registry_Mint", (ctx) => {
    const registry = ctx.self.payload as { admin: Party };
    const arg = ctx.arg as { configCid: string; owner: Party; amount: string };
    const entry = ctx.acs.get(arg.configCid);
    // The ledger turns a missing cid into a retryable contention before the
    // handler runs; this covers a cid that is live but not a config.
    if (!entry || entry.templateId !== INSTRUMENT_CONFIG_TEMPLATE_ID) {
      throw new LedgerError(
        "contention",
        `not an active InstrumentConfig: ${arg.configCid}`,
        true,
      );
    }
    const config = entry.payload as {
      instrumentId: string;
      circulatingSupply: string;
    };

    // InstrumentConfig_BumpSupply is consuming: the config cid rotates here,
    // which is what forces the caller to re-resolve it before every mint.
    ctx.archive(arg.configCid);
    ctx.create(
      INSTRUMENT_CONFIG_TEMPLATE_ID,
      {
        ...config,
        circulatingSupply: (
          Number(config.circulatingSupply) + Number(arg.amount)
        ).toFixed(SCALE),
      },
      [registry.admin],
    );

    return ctx.create(
      REGISTRY_HOLDING_TEMPLATE_ID,
      {
        admin: registry.admin,
        owner: arg.owner,
        instrumentId: config.instrumentId,
        amount: arg.amount,
        locked: false,
      },
      [registry.admin, ...extra, arg.owner],
    );
  });
}

export interface SeedRegistryV2Options {
  admin: Party;
  /** Registry observers: the parties that may exercise the factory choices. */
  users: Party[];
  /** Instruments to register, i.e. what the faucet is allowed to mint. */
  instruments: string[];
}

/**
 * Local stand-in for scripts/bootstrap-registry.ts: create the Registry and
 * one InstrumentConfig per instrument. Returns the cids for tests that want
 * to observe the rotation.
 */
export async function seedRegistryV2(
  ledger: InMemoryLedger,
  opts: SeedRegistryV2Options,
): Promise<{ registryCid: string; configCids: Record<string, string> }> {
  const registryCid = await ledger.submit<string>({
    actAs: [opts.admin],
    commandId: "seed-registry-v2",
    command: {
      kind: "create",
      templateId: REGISTRY_TEMPLATE_ID,
      argument: { admin: opts.admin, users: opts.users },
    },
  });

  const configCids: Record<string, string> = {};
  for (const instrumentId of opts.instruments) {
    configCids[instrumentId] = await ledger.submit<string>({
      actAs: [opts.admin],
      commandId: `seed-registry-v2-instrument-${instrumentId}`,
      command: {
        kind: "exercise",
        templateId: REGISTRY_TEMPLATE_ID,
        contractId: registryCid,
        choice: "Registry_RegisterInstrument",
        argument: {
          instrumentId,
          decimals: String(SCALE),
          supplyCap: null,
          holderRequirements: [],
          issuerRequirements: [],
          isin: null,
          cusip: null,
        },
      },
    });
  }
  return { registryCid, configCids };
}
