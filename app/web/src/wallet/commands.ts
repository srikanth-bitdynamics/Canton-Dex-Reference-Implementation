// Intent -> Daml command tree.
//
// Single audit surface for every trader-authority write the dApp can
// trigger. Pages emit `WalletIntent`s (typed business actions, see
// `./types`); this module is the ONLY place that turns those into the
// Daml command tree shape a wallet submits.
//
// Why this module exists:
//   1. Audit: reviewers find every "user click -> on-ledger commands"
//      mapping in one file. No hunting across pages.
//   2. Reuse: providers (the dapp-sdk-backed one today; mock-provider
//      for tests; future remote/injected adapters) all share the same
//      composer, so their behaviour cannot drift.
//   3. Boundary: the wallet receives `JsCommands` shaped tree only.
//      It never sees `WalletIntent`. That keeps us aligned with the
//      CIP-0103 dApp Standard: the dApp composes commands, the wallet
//      signs them.
//
// The output shape mirrors the Canton JSON Ledger API command payload
// (CreateCommand / ExerciseCommand) and is also what `@canton-network/
// dapp-sdk`'s `PrepareExecuteParams.commands` accepts.
//
// Anti-pattern explicitly rejected: pages building `ExerciseCommand`
// objects directly. The `WalletIntent` layer is the audit boundary; it
// is not optional decoration.

import type {
  ContractId,
  Party,
  WalletIntent,
} from "./types";

/**
 * The shape `composeCommands` produces. Mirrors the dapp-sdk's
 * `PrepareExecuteParams.commands` (which is typed as `JsCommands =
 * {[key: string]: any}`). We keep our types strict here for audit
 * clarity even though the wallet layer is permissive.
 */
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

/**
 * Output of every intent compose: a Daml command tree + the parties
 * the submission must act as + a deterministic commandId for retries.
 * The wallet appends its own metadata (synchronizer, package
 * preferences) before submission via `prepareExecute`.
 */
export interface ComposedCommands {
  commandId: string;
  commands: DamlCommand[];
  actAs: Party[];
}

/**
 * Build the Daml package-qualified template id. Pages should NOT call
 * this directly; only composer code below uses it.
 */
function templateId(packagePrefix: string, name: string): string {
  return `${packagePrefix}:${name}`;
}

/**
 * Context required for composition. `party` is the connected wallet's
 * primary party (`actAs` defaults to `[party]` unless the intent needs
 * joint authority — see `accept-rfq`). `packagePrefix` is either a
 * package hash (e.g. `"a1b2c3..."`) or a `#package-name` reference
 * (CIP-0103 lets wallets resolve the latter at submission time).
 */
export interface ComposeContext {
  party: Party;
  packagePrefix: string;
  /** Wall-clock now in ISO form. Pass in for testability. */
  now: () => Date;
}

/**
 * Entry point. Dispatches on `intent.kind` and returns a ready-to-sign
 * command tree.
 */
export function composeCommands(
  intent: WalletIntent,
  ctx: ComposeContext,
): ComposedCommands {
  switch (intent.kind) {
    case "accept-allocation-request":
      return composeAcceptAllocationRequest(intent, ctx);
    case "place-order":
      return composePlaceOrder(intent, ctx);
    case "request-swap":
      return composeRequestSwap(intent, ctx);
    case "add-liquidity":
      return composeAddLiquidity(intent, ctx);
    case "accept-lp-burn":
      return composeAcceptLpBurn(intent, ctx);
    case "post-rfq-quote":
      return composePostRfqQuote(intent, ctx);
    case "accept-rfq":
      return composeAcceptRfq(intent, ctx);
  }
}

// === per-intent composers ===============================================

function composeAcceptAllocationRequest(
  intent: Extract<WalletIntent, { kind: "accept-allocation-request" }>,
  ctx: ComposeContext,
): ComposedCommands {
  return {
    commandId: `alloc-accept-${shortCid(intent.requestCid)}-${ctx.now().getTime()}`,
    actAs: [ctx.party],
    commands: [
      {
        ExerciseCommand: {
          templateId: templateId(
            ctx.packagePrefix,
            "CantonDex.Dex.OrderAllocationRequest:OrderAllocationRequest",
          ),
          contractId: intent.requestCid,
          choice: "OrderAllocationRequest_Accept",
          choiceArgument: {
            factoryCid: intent.factoryCid,
            inputHoldingCids: intent.inputHoldingCids,
          },
        },
      },
    ],
  };
}

function composePlaceOrder(
  intent: Extract<WalletIntent, { kind: "place-order" }>,
  ctx: ComposeContext,
): ComposedCommands {
  return {
    commandId: `order-${intent.pair.base}-${intent.pair.quote}-${ctx.now().getTime()}`,
    actAs: [ctx.party],
    commands: [
      {
        CreateCommand: {
          templateId: templateId(
            ctx.packagePrefix,
            "CantonDex.Dex.OrderFundingRequest:OrderFundingRequest",
          ),
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
      },
    ],
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
    commands: [
      {
        CreateCommand: {
          templateId: templateId(
            ctx.packagePrefix,
            "CantonDex.Dex.SwapRequest:SwapRequest",
          ),
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
      },
    ],
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
    commands: [
      {
        CreateCommand: {
          templateId: templateId(
            ctx.packagePrefix,
            "CantonDex.Dex.LiquidityRequest:AddLiquidityRequest",
          ),
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
      },
    ],
  };
}

function composeAcceptLpBurn(
  intent: Extract<WalletIntent, { kind: "accept-lp-burn" }>,
  ctx: ComposeContext,
): ComposedCommands {
  return {
    commandId: `lp-burn-${shortCid(intent.burnRequestCid)}-${ctx.now().getTime()}`,
    actAs: [ctx.party],
    commands: [
      {
        ExerciseCommand: {
          templateId: templateId(
            ctx.packagePrefix,
            "CantonDex.Dex.LPToken:LPTokenPolicy",
          ),
          contractId: intent.burnRequestCid,
          choice: "LPTokenPolicy_AcceptBurn",
          choiceArgument: {
            holderHoldingCid: intent.holderHoldingCid,
          },
        },
      },
    ],
  };
}

function composePostRfqQuote(
  intent: Extract<WalletIntent, { kind: "post-rfq-quote" }>,
  ctx: ComposeContext,
): ComposedCommands {
  return {
    commandId: `rfq-quote-${intent.rfqId}-${ctx.now().getTime()}`,
    actAs: [ctx.party],
    commands: [
      {
        CreateCommand: {
          templateId: templateId(
            ctx.packagePrefix,
            "CantonDex.Dex.Rfq:RfqQuote",
          ),
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
      },
    ],
  };
}

function composeAcceptRfq(
  intent: Extract<WalletIntent, { kind: "accept-rfq" }>,
  ctx: ComposeContext,
): ComposedCommands {
  // Rfq_Accept is `controller trader, operator`. Joint authority. The
  // dapp-sdk path can only carry the trader's signature; the operator's
  // half has to come from a delegation contract or an operator co-sign
  // service. Surface the requirement at compose time so a misconfigured
  // deployment fails loudly before reaching the wallet.
  if (!intent.operator) {
    throw new Error(
      "accept-rfq: operator party is required (joint trader+operator authority).",
    );
  }
  return {
    commandId: `rfq-accept-${shortCid(intent.rfqCid)}-${ctx.now().getTime()}`,
    actAs: [ctx.party, intent.operator],
    commands: [
      {
        ExerciseCommand: {
          templateId: templateId(
            ctx.packagePrefix,
            "CantonDex.Dex.Rfq:Rfq",
          ),
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
      },
    ],
  };
}

// === helpers ============================================================

function shortCid(cid: ContractId<unknown> | string): string {
  return String(cid).slice(0, 12);
}

function assertFactoryReady(
  factoryCid: string | undefined,
  intentKind: string,
): void {
  if (!factoryCid || factoryCid.startsWith("PENDING_")) {
    throw new Error(
      `${intentKind}: AllocationFactory CID not configured (got ${
        factoryCid ?? "undefined"
      }). The operator must seed the registry's allocation factory before this intent can be composed.`,
    );
  }
}
