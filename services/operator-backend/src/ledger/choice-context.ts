// Convert one operation-specific registry response into the ExtraArgs shape
// expected by Token Standard choices. Discovery itself stays at the call site
// so a context cannot be fetched without the exact operation arguments.

import type { ChoiceContextRef, DisclosedContract } from "@canton-dex/registry-client";

export interface ChoiceContext {
  extraArgs: {
    context: { values: Record<string, unknown> };
    meta: { values: Record<string, unknown> };
  };
  disclosure: DisclosedContract[];
}

export function asChoiceContext(ctx: ChoiceContextRef): ChoiceContext {
  return {
    extraArgs: { context: ctx.context, meta: { values: {} } },
    disclosure: ctx.disclosure,
  };
}

export const emptyExtraArgs = {
  context: { values: {} },
  meta: { values: {} },
};
