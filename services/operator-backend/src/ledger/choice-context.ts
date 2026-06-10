// Shared off-ledger choice-context fetch: wraps the registry's enriched
// context + disclosures into the extraArgs shape the token-standard choices
// take. Used by the pool, order, and matched-trade services.

import type { DisclosedContract } from "@canton-dex/registry-client";
import { RegistryClient } from "@canton-dex/registry-client";

import type { Party } from "../types.js";

export interface ChoiceContext {
  extraArgs: {
    context: { values: Record<string, unknown> };
    meta: { values: Record<string, unknown> };
  };
  disclosure: DisclosedContract[];
}

export async function fetchChoiceContext(
  registry: RegistryClient,
  admin: Party,
): Promise<ChoiceContext> {
  const ctx = await registry.getChoiceContext(admin);
  return {
    extraArgs: { context: ctx.context, meta: { values: {} } },
    disclosure: ctx.disclosure,
  };
}
