// Settlement orchestrator helpers shared between MatchedTrade and Pool flows.

import type {
  ContractId,
  DisclosedContract,
  RegistryDiscovery,
} from "@canton-dex/registry-client";
import { asChoiceContext } from "../ledger/choice-context.js";
import { mergeDisclosures } from "../ledger/disclosure.js";
import type { Party, V2TransferLeg } from "../types.js";

/** Group transfer legs by admin (caller supplies the per-leg admin). */
export function groupLegsByAdmin(
  legs: V2TransferLeg[],
  adminOfLeg: (leg: V2TransferLeg) => Party,
): Map<Party, V2TransferLeg[]> {
  const out = new Map<Party, V2TransferLeg[]>();
  for (const leg of legs) {
    const admin = adminOfLeg(leg);
    const existing = out.get(admin);
    if (existing) {
      existing.push(leg);
    } else {
      out.set(admin, [leg]);
    }
  }
  return out;
}

/** Daml `AdminBatch.RegistryBatchInput`: the factory + context for one admin. */
export interface RegistryBatchInput {
  factoryCid: ContractId<"SettlementFactory">;
  extraArgs: {
    context: { values: Record<string, unknown> };
    meta: { values: Record<string, unknown> };
  };
}

/**
 * Discover one settlement factory per admin from an on-ledger settlement
 * preview. The preview is a Daml `Map Party SettlementFactory_SettleBatch`,
 * whose JSON encoding is an ARRAY of `[admin, choiceArgs]` pairs; each admin's
 * exact args are sent to that registry's settlement endpoint. Returns the
 * admin-keyed `RegistryBatchInput` GenMap (again an array of pairs) and the
 * merged transaction disclosures.
 *
 * Discovery runs on the registry-returned context alone; the operator holds no
 * `readAs` on any admin. A single-admin settlement yields one entry.
 */
export async function discoverBatchesByAdmin(
  registry: RegistryDiscovery,
  preview: ReadonlyArray<[Party, Record<string, unknown>]>,
): Promise<{
  batchesByAdmin: Array<[Party, RegistryBatchInput]>;
  disclosure: DisclosedContract[];
}> {
  const perAdmin: Array<{
    admin: Party;
    input: RegistryBatchInput;
    disclosure: DisclosedContract[];
  }> = [];
  for (const [admin, choiceArgs] of preview) {
    const factory = await registry.getSettlementFactory(admin, choiceArgs);
    const ctx = asChoiceContext(factory);
    perAdmin.push({
      admin,
      input: {
        factoryCid: factory.factoryCid as ContractId<"SettlementFactory">,
        extraArgs: ctx.extraArgs,
      },
      disclosure: ctx.disclosure,
    });
  }
  return {
    batchesByAdmin: perAdmin.map((e) => [e.admin, e.input]),
    disclosure: mergeDisclosures(...perAdmin.map((e) => e.disclosure)),
  };
}
