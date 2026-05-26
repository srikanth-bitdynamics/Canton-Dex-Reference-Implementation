// WalletIntent → Daml command tree. Single place where trader-authority
// writes get composed; pages emit intents, providers submit the result.

import type { ContractId, Party, WalletIntent } from "./types";

export type DamlCommand =
  | { CreateCommand: CreateCommand }
  | { ExerciseCommand: ExerciseCommand };

export interface CreateCommand {
  templateId: string;
  createArguments: Record<string, unknown>;
}

export interface ExerciseCommand {
  templateId: string;
  contractId: string;
  choice: string;
  choiceArgument: Record<string, unknown>;
}

export interface ComposedCommands {
  commandId: string;
  commands: DamlCommand[];
  actAs: Party[];
}

export interface ComposeContext {
  party: Party;
  /** Package hash or `#package-name` reference. */
  packagePrefix: string;
  now: () => Date;
}

const tid = (pkg: string, name: string) => `${pkg}:${name}`;

export function composeCommands(
  intent: WalletIntent,
  ctx: ComposeContext,
): ComposedCommands {
  switch (intent.kind) {
    case "accept-allocation-request": return composeAcceptAllocationRequest(intent, ctx);
    case "place-order":                return composePlaceOrder(intent, ctx);
    case "request-swap":               return composeRequestSwap(intent, ctx);
    case "add-liquidity":              return composeAddLiquidity(intent, ctx);
    case "accept-lp-burn":             return composeAcceptLpBurn(intent, ctx);
    case "post-rfq-quote":             return composePostRfqQuote(intent, ctx);
    case "accept-rfq":                 return composeAcceptRfq(intent, ctx);
  }
}

function composeAcceptAllocationRequest(
  intent: Extract<WalletIntent, { kind: "accept-allocation-request" }>,
  ctx: ComposeContext,
): ComposedCommands {
  return {
    commandId: `alloc-accept-${shortCid(intent.requestCid)}-${ctx.now().getTime()}`,
    actAs: [ctx.party],
    commands: [{
      ExerciseCommand: {
        templateId: tid(ctx.packagePrefix, "CantonDex.Dex.OrderAllocationRequest:OrderAllocationRequest"),
        contractId: intent.requestCid,
        choice: "OrderAllocationRequest_Accept",
        choiceArgument: {
          factoryCid: intent.factoryCid,
          inputHoldingCids: intent.inputHoldingCids,
        },
      },
    }],
  };
}

function composePlaceOrder(
  intent: Extract<WalletIntent, { kind: "place-order" }>,
  ctx: ComposeContext,
): ComposedCommands {
  return {
    commandId: `order-${intent.pair.base}-${intent.pair.quote}-${ctx.now().getTime()}`,
    actAs: [ctx.party],
    commands: [{
      CreateCommand: {
        templateId: tid(ctx.packagePrefix, "CantonDex.Dex.OrderFundingRequest:OrderFundingRequest"),
        createArguments: {
          trader: ctx.party,
          operator: intent.operator,
          admin: intent.admin,
          baseInstrumentId: intent.pair.base,
          quoteInstrumentId: intent.pair.quote,
          side: intent.side,
          limitPrice: intent.limitPrice,
          quantity: intent.quantity,
          expiry: intent.expiry,
        },
      },
    }],
  };
}

function composeRequestSwap(
  intent: Extract<WalletIntent, { kind: "request-swap" }>,
  ctx: ComposeContext,
): ComposedCommands {
  assertFactoryReady(intent.factoryCid, "request-swap");
  return {
    commandId: `swap-${shortCid(intent.poolId)}-${ctx.now().getTime()}`,
    actAs: [ctx.party],
    commands: [{
      CreateCommand: {
        templateId: tid(ctx.packagePrefix, "CantonDex.Dex.SwapRequest:SwapRequest"),
        createArguments: {
          trader: ctx.party,
          operator: intent.operator,
          admin: intent.admin,
          poolCid: intent.poolId,
          inputInstrumentId: intent.inputInstrumentId,
          inputAmount: intent.inputAmount,
          minOutputAmount: intent.minOutputAmount,
          inputHoldingCids: intent.inputHoldingCids,
          factoryCid: intent.factoryCid,
          requestedAt: ctx.now().toISOString(),
        },
      },
    }],
  };
}

function composeAddLiquidity(
  intent: Extract<WalletIntent, { kind: "add-liquidity" }>,
  ctx: ComposeContext,
): ComposedCommands {
  assertFactoryReady(intent.factoryCid, "add-liquidity");
  return {
    commandId: `add-lp-${shortCid(intent.poolId)}-${ctx.now().getTime()}`,
    actAs: [ctx.party],
    commands: [{
      CreateCommand: {
        templateId: tid(ctx.packagePrefix, "CantonDex.Dex.LiquidityRequest:AddLiquidityRequest"),
        createArguments: {
          trader: ctx.party,
          operator: intent.operator,
          admin: intent.admin,
          poolCid: intent.poolId,
          baseAmount: intent.baseAmount,
          quoteAmount: intent.quoteAmount,
          minLpTokens: intent.minLpTokens,
          baseHoldingCids: intent.baseHoldingCids,
          quoteHoldingCids: intent.quoteHoldingCids,
          factoryCid: intent.factoryCid,
          requestedAt: ctx.now().toISOString(),
        },
      },
    }],
  };
}

function composeAcceptLpBurn(
  intent: Extract<WalletIntent, { kind: "accept-lp-burn" }>,
  ctx: ComposeContext,
): ComposedCommands {
  return {
    commandId: `lp-burn-${shortCid(intent.burnRequestCid)}-${ctx.now().getTime()}`,
    actAs: [ctx.party],
    commands: [{
      ExerciseCommand: {
        templateId: tid(ctx.packagePrefix, "CantonDex.Dex.LPToken:LPTokenPolicy"),
        contractId: intent.burnRequestCid,
        choice: "LPTokenPolicy_AcceptBurn",
        choiceArgument: { holderHoldingCid: intent.holderHoldingCid },
      },
    }],
  };
}

function composePostRfqQuote(
  intent: Extract<WalletIntent, { kind: "post-rfq-quote" }>,
  ctx: ComposeContext,
): ComposedCommands {
  return {
    commandId: `rfq-quote-${intent.rfqId}-${ctx.now().getTime()}`,
    actAs: [ctx.party],
    commands: [{
      CreateCommand: {
        templateId: tid(ctx.packagePrefix, "CantonDex.Dex.Rfq:RfqQuote"),
        createArguments: {
          dealer: ctx.party,
          trader: intent.trader,
          operator: intent.operator,
          rfqId: intent.rfqId,
          price: intent.price,
          expiresAt: intent.expiresAt,
          postedAt: intent.postedAt,
          tier: intent.tier,
        },
      },
    }],
  };
}

// Rfq_Accept is controller trader+operator. Joint authority means the
// trader's wallet alone can't authorize this; the operator co-sign has
// to come from elsewhere. Fail at compose time if operator is missing.
function composeAcceptRfq(
  intent: Extract<WalletIntent, { kind: "accept-rfq" }>,
  ctx: ComposeContext,
): ComposedCommands {
  if (!intent.operator) {
    throw new Error("accept-rfq: operator party is required (joint trader+operator authority).");
  }
  return {
    commandId: `rfq-accept-${shortCid(intent.rfqCid)}-${ctx.now().getTime()}`,
    actAs: [ctx.party, intent.operator],
    commands: [{
      ExerciseCommand: {
        templateId: tid(ctx.packagePrefix, "CantonDex.Dex.Rfq:Rfq"),
        contractId: intent.rfqCid,
        choice: "Rfq_Accept",
        choiceArgument: {
          acceptedQuoteCid: intent.acceptedQuoteCid,
          consideredQuoteCids: intent.consideredQuoteCids,
          admin: intent.admin,
          currentTime: ctx.now().toISOString(),
          signature: null,
        },
      },
    }],
  };
}

function shortCid(cid: ContractId<unknown> | string): string {
  return String(cid).slice(0, 12);
}

function assertFactoryReady(factoryCid: string | undefined, kind: string): void {
  if (!factoryCid || factoryCid.startsWith("PENDING_")) {
    throw new Error(
      `${kind}: AllocationFactory CID not configured (got ${factoryCid ?? "undefined"}).`,
    );
  }
}
