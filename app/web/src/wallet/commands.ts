// WalletIntent → Daml command tree. Single place where trader-authority
// writes get composed; pages emit intents, providers submit the result.

import type {
  ContractId,
  DisclosedContract,
  Party,
  V2AllocationSpecification,
  V2ExtraArgs,
  V2SettlementInfo,
  WalletIntent,
} from "./types";

// AllocationFactory is a Token-Standard interface in the splice
// allocation-instruction-v2 package (NOT our app package), so the
// AllocationFactory_Allocate exercise targets the interface id directly.
const ALLOCATION_FACTORY_IID =
  "#splice-api-token-allocation-instruction-v2:Splice.Api.Token.AllocationInstructionV2:AllocationFactory";
const ALLOCATION_REQUEST_IID =
  "#splice-api-token-allocation-request-v2:Splice.Api.Token.AllocationRequestV2:AllocationRequest";

// One AllocationFactory_Allocate exercise: the wallet authors the given
// spec under `factoryCid`, locking `inputHoldingCids`. Created Allocation
// cids are read back from the submit result in command order.
function allocateCmd(
  factoryCid: ContractId<"AllocationFactory">,
  settlement: V2SettlementInfo,
  spec: V2AllocationSpecification,
  inputHoldingCids: ContractId<"Holding">[],
  party: Party,
  requestedAt: string,
  extraArgs: V2ExtraArgs,
): DamlCommand {
  return {
    ExerciseCommand: {
      templateId: ALLOCATION_FACTORY_IID,
      contractId: factoryCid,
      choice: "AllocationFactory_Allocate",
      choiceArgument: {
        settlement,
        allocation: spec,
        requestedAt,
        inputHoldingCids,
        actors: [party],
        extraArgs,
      },
    },
  };
}

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
  disclosedContracts?: DisclosedContract[];
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
    case "split-holding":              return composeSplitHolding(intent, ctx);
    case "merge-holdings":             return composeMergeHoldings(intent, ctx);
    case "add-liquidity":              return composeAddLiquidity(intent, ctx);
    case "remove-liquidity":           return composeRemoveLiquidity(intent, ctx);
    case "post-rfq-quote":             return composePostRfqQuote(intent, ctx);
    case "accept-rfq":                 return composeAcceptRfq(intent, ctx);
  }
}

function composeAcceptAllocationRequest(
  intent: Extract<WalletIntent, { kind: "accept-allocation-request" }>,
  ctx: ComposeContext,
): ComposedCommands {
  assertFactoryReady(intent.factoryCid, "accept-allocation-request");
  return {
    commandId: `alloc-accept-${shortCid(intent.requestCid)}-${ctx.now().getTime()}`,
    actAs: [ctx.party],
    commands: [
      {
        ExerciseCommand: {
          templateId: ALLOCATION_REQUEST_IID,
          contractId: intent.requestCid,
          choice: "AllocationRequest_Accept",
          choiceArgument: {
            actors: [ctx.party],
            extraArgs: intent.allocationRequestExtraArgs,
          },
        },
      },
      allocateCmd(
        intent.factoryCid,
        intent.settlement,
        intent.allocationSpec,
        intent.inputHoldingCids,
        ctx.party,
        ctx.now().toISOString(),
        intent.allocationFactoryExtraArgs,
      ),
    ],
    disclosedContracts: dedupeDisclosure(intent.disclosure),
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

// Swap (DvP): author the single prefunded/iterated input allocation the
// operator's PoolRules_RequestSwap named, locking the trader's input holdings.
// The created Allocation cid is read back from the submit result (like LP DvP)
// and fed to the operator settle (PoolRules_Swap). No intermediate request contract.
function composeRequestSwap(
  intent: Extract<WalletIntent, { kind: "request-swap" }>,
  ctx: ComposeContext,
): ComposedCommands {
  assertFactoryReady(intent.factoryCid, "request-swap");
  return {
    commandId: `swap-${shortCid(intent.poolId)}-${ctx.now().getTime()}`,
    actAs: [ctx.party],
    commands: [
      allocateCmd(
        intent.factoryCid,
        intent.settlement,
        intent.allocationSpec,
        intent.inputHoldingCids,
        ctx.party,
        ctx.now().toISOString(),
        intent.allocationFactoryExtraArgs,
      ),
    ],
    disclosedContracts: dedupeDisclosure(intent.disclosure),
  };
}

function composeSplitHolding(
  intent: Extract<WalletIntent, { kind: "split-holding" }>,
  ctx: ComposeContext,
): ComposedCommands {
  return {
    commandId: `split-holding-${shortCid(intent.holdingCid)}-${ctx.now().getTime()}`,
    actAs: [ctx.party, intent.admin],
    commands: [{
      ExerciseCommand: {
        templateId: tid(ctx.packagePrefix, "CantonDex.Registry.V2:Holding"),
        contractId: intent.holdingCid,
        choice: "Holding_Split",
        choiceArgument: {
          splitAmount: intent.splitAmount,
        },
      },
    }],
  };
}

function composeMergeHoldings(
  intent: Extract<WalletIntent, { kind: "merge-holdings" }>,
  ctx: ComposeContext,
): ComposedCommands {
  return {
    commandId: `merge-holding-${shortCid(intent.holdingCid)}-${ctx.now().getTime()}`,
    actAs: [ctx.party, intent.admin],
    commands: [{
      ExerciseCommand: {
        templateId: tid(ctx.packagePrefix, "CantonDex.Registry.V2:Holding"),
        contractId: intent.holdingCid,
        choice: "Holding_Merge",
        choiceArgument: {
          otherCid: intent.otherCid,
        },
      },
    }],
  };
}

// DvP add: author the three allocations the request named, in one
// submission. Canonical order [base deposit, quote deposit, LP receipt]:
// the two deposits are committed sender-side under the deposit (pool.admin)
// factory and lock the trader's base/quote holdings; the LP receipt is the
// receiver side under the lpRegistrar factory (no input holdings — it
// receives the minted tokens).
function composeAddLiquidity(
  intent: Extract<WalletIntent, { kind: "add-liquidity" }>,
  ctx: ComposeContext,
): ComposedCommands {
  assertFactoryReady(intent.depositFactoryCid, "add-liquidity");
  assertFactoryReady(intent.lpFactoryCid, "add-liquidity");
  if (intent.allocations.length !== 3) {
    throw new Error(`add-liquidity: expected 3 allocation specs, got ${intent.allocations.length}`);
  }
  const requestedAt = ctx.now().toISOString();
  const [baseSpec, quoteSpec, receiptSpec] = intent.allocations;
  return {
    commandId: `add-lp-${shortCid(intent.requestCid)}-${ctx.now().getTime()}`,
    actAs: [ctx.party],
    commands: [
      allocateCmd(
        intent.depositFactoryCid,
        intent.settlement,
        baseSpec,
        intent.baseHoldingCids,
        ctx.party,
        requestedAt,
        intent.depositFactoryExtraArgs,
      ),
      allocateCmd(
        intent.depositFactoryCid,
        intent.settlement,
        quoteSpec,
        intent.quoteHoldingCids,
        ctx.party,
        requestedAt,
        intent.depositFactoryExtraArgs,
      ),
      allocateCmd(
        intent.lpFactoryCid,
        intent.settlement,
        receiptSpec,
        [],
        ctx.party,
        requestedAt,
        intent.lpFactoryExtraArgs,
      ),
    ],
    disclosedContracts: dedupeDisclosure(intent.disclosure),
  };
}

// DvP remove: author [base receipt, quote receipt, LP burn-sender].
// The two receipts are receiver-side under the deposit (pool.admin) factory
// (no input holdings — they receive the returned base/quote); the burn-
// sender is the committed sender side under the lpRegistrar factory and
// locks the trader's LP holding.
function composeRemoveLiquidity(
  intent: Extract<WalletIntent, { kind: "remove-liquidity" }>,
  ctx: ComposeContext,
): ComposedCommands {
  assertFactoryReady(intent.depositFactoryCid, "remove-liquidity");
  assertFactoryReady(intent.lpFactoryCid, "remove-liquidity");
  if (intent.allocations.length !== 3) {
    throw new Error(`remove-liquidity: expected 3 allocation specs, got ${intent.allocations.length}`);
  }
  const requestedAt = ctx.now().toISOString();
  const [baseReceiptSpec, quoteReceiptSpec, burnSenderSpec] = intent.allocations;
  return {
    commandId: `remove-lp-${shortCid(intent.requestCid)}-${ctx.now().getTime()}`,
    actAs: [ctx.party],
    commands: [
      allocateCmd(
        intent.depositFactoryCid,
        intent.settlement,
        baseReceiptSpec,
        [],
        ctx.party,
        requestedAt,
        intent.depositFactoryExtraArgs,
      ),
      allocateCmd(
        intent.depositFactoryCid,
        intent.settlement,
        quoteReceiptSpec,
        [],
        ctx.party,
        requestedAt,
        intent.depositFactoryExtraArgs,
      ),
      allocateCmd(
        intent.lpFactoryCid,
        intent.settlement,
        burnSenderSpec,
        intent.lpHoldingCids,
        ctx.party,
        requestedAt,
        intent.lpFactoryExtraArgs,
      ),
    ],
    disclosedContracts: dedupeDisclosure(intent.disclosure),
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

/** The two intents whose settle needs the wallet's created allocation cids. */
export function isLpDvpIntent(intent: WalletIntent): boolean {
  return (
    intent.kind === "accept-allocation-request" ||
    intent.kind === "add-liquidity" ||
    intent.kind === "remove-liquidity" ||
    intent.kind === "request-swap"
  );
}

/**
 * Pull the created V2.Allocation cids (in command order) out of a provider's
 * submit-transaction shape for intents whose next step needs the authored
 * allocation cid. Fails loudly if the count doesn't match the number of
 * authored allocations.
 */
export function extractCreatedAllocationCids(
  intent: WalletIntent,
  expectedCount: number,
  tx: {
    createdEvents?: Array<{ contractId: string }>;
    events?: Array<{ created?: { contractId: string } }>;
  },
): string[] | undefined {
  if (!isLpDvpIntent(intent)) return undefined;
  const fromCreated = tx.createdEvents?.map((e) => e.contractId);
  const fromEvents = tx.events?.flatMap((e) => (e.created ? [e.created.contractId] : []));
  const cids = fromCreated ?? fromEvents;
  if (!cids || cids.length !== expectedCount) {
    throw new Error(
      `wallet did not return ${expectedCount} created allocation cids for ${intent.kind} ` +
        `(got ${cids?.length ?? 0})`,
    );
  }
  return cids;
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

function dedupeDisclosure(disclosure: DisclosedContract[]): DisclosedContract[] {
  const seen = new Set<string>();
  const out: DisclosedContract[] = [];
  for (const contract of disclosure) {
    if (seen.has(contract.contractId)) continue;
    seen.add(contract.contractId);
    out.push(contract);
  }
  return out;
}
