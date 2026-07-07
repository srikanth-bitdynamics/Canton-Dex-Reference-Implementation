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
  // Single command: author the funding allocation only. We deliberately do NOT
  // also exercise AllocationRequest_Accept on the request, because Canton's
  // interactive-submission path (CIP-0103 wallets) rejects a prepared
  // transaction carrying more than one command ("FAILED_TO_PREPARE_TRANSACTION:
  // Preparing multiple commands is currently not supported"), so a 2-command
  // submit fails outright. The operator's Order_Fund then consumes the
  // OrderAllocationRequest (it takes the request cid + archives it), so the
  // request does not linger after the order is funded.
  return {
    commandId: `alloc-accept-${shortCid(intent.requestCid)}-${ctx.now().getTime()}`,
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

// Holding_Split / Holding_Merge are `controller admin, owner` in the registry
// (trading/CantonDex/Registry/V2.daml), so the submission genuinely needs admin
// authority in `actAs`. Only providers that route an admin co-sign (the
// operator relay / dev) ever reach these intents: `normalizeSwapFunding` in
// services/ledger.ts gates split/merge behind `activeWalletCoSignsAdmin()` and
// falls back to exact-subset selection for real external wallets. So
// `actAs: [party, admin]` here is correct for the only callers that hit it.
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
  // Single top-level command (CIP-0103 prepareExecute allows only one): the
  // holder exercises LiquidityAllocationRequest_AcceptAndAllocate, which authors
  // all three allocations (base deposit, quote deposit, LP receipt) + the
  // acceptance receipt inside one Daml transaction. The choice reads the specs
  // from the request itself; we pass only the per-allocation factory, input
  // holdings, and context, PARALLEL to the request's `allocations`
  // [base, quote, LP].
  return acceptAndAllocateCommand(intent, ctx, [
    intent.baseHoldingCids,
    intent.quoteHoldingCids,
    [],
  ]);
}

// Build the single LiquidityAllocationRequest_AcceptAndAllocate command shared
// by add (deposits) and remove (receipts + burn). `inputHoldingCids` is the
// per-allocation funding list, PARALLEL to the request's [base, quote, LP]
// allocations; the factory + context layout is the same for both directions
// (base/quote under the deposit factory, LP under the lpRegistrar factory).
function acceptAndAllocateCommand(
  intent: {
    requestCid: ContractId<"LiquidityAllocationRequest">;
    depositFactoryCid: ContractId<"AllocationFactory">;
    lpFactoryCid: ContractId<"AllocationFactory">;
    depositFactoryExtraArgs: V2ExtraArgs;
    lpFactoryExtraArgs: V2ExtraArgs;
    disclosure: DisclosedContract[];
  },
  ctx: ComposeContext,
  inputHoldingCids: string[][],
): ComposedCommands {
  return {
    commandId: `lp-accept-allocate-${shortCid(intent.requestCid)}-${ctx.now().getTime()}`,
    actAs: [ctx.party],
    commands: [
      {
        ExerciseCommand: {
          templateId: tid(
            ctx.packagePrefix,
            "CantonDex.Dex.LiquidityAllocationRequest:LiquidityAllocationRequest",
          ),
          contractId: intent.requestCid,
          choice: "LiquidityAllocationRequest_AcceptAndAllocate",
          choiceArgument: {
            factoryCids: [
              intent.depositFactoryCid,
              intent.depositFactoryCid,
              intent.lpFactoryCid,
            ],
            inputHoldingCids,
            allocExtraArgs: [
              intent.depositFactoryExtraArgs,
              intent.depositFactoryExtraArgs,
              intent.lpFactoryExtraArgs,
            ],
          },
        },
      },
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
  // Single top-level command, mirroring add: the holder exercises
  // LiquidityAllocationRequest_AcceptAndAllocate to author the base receipt,
  // quote receipt, and LP burn-sender in one Daml transaction. Only the
  // burn-sender funds from holdings (the LP holding); the two receipts are
  // receiver-side and lock nothing. Parallel to the request's [base, quote, LP].
  return acceptAndAllocateCommand(intent, ctx, [
    [],
    [],
    intent.lpHoldingCids,
  ]);
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

/** Intents whose follow-up step needs the wallet-authored allocation cid. */
export function isAllocationAuthoringIntent(intent: WalletIntent): boolean {
  return (
    intent.kind === "accept-allocation-request" ||
    intent.kind === "add-liquidity" ||
    intent.kind === "remove-liquidity" ||
    intent.kind === "request-swap"
  );
}

// Template suffixes used to classify created events in a submit result.
const ALLOCATION_TEMPLATE_SUFFIX = "CantonDex.Registry.V2:Allocation";
const LIQUIDITY_ACCEPTANCE_SUFFIX =
  "CantonDex.Dex.LiquidityAllocationRequest:LiquidityAllocationAcceptance";

// How many V2.Allocation contracts each intent authors. Drives the extraction
// count check independently of how many total commands the submission carries
// (the accept pairing adds a command but no extra Allocation).
function expectedAllocationCount(intent: WalletIntent): number {
  switch (intent.kind) {
    case "add-liquidity":
    case "remove-liquidity":
      return 3;
    case "request-swap":
    case "accept-allocation-request":
      return 1;
    default:
      return 0;
  }
}

type CreatedEvent = { contractId: string; templateId?: string };

function createdEventsOf(tx: {
  createdEvents?: CreatedEvent[];
  events?: Array<{ created?: CreatedEvent }>;
}): CreatedEvent[] {
  return tx.createdEvents ?? tx.events?.flatMap((e) => (e.created ? [e.created] : [])) ?? [];
}

/**
 * Pull the created V2.Allocation cids (in command order) out of a provider's
 * submit-transaction shape for intents whose next step needs the authored
 * allocation cid. When template ids are present, keeps only the V2.Allocation
 * creates — so the canonical accept pairing's `LiquidityAllocationAcceptance`
 * receipt (and any locked-holding creates) are ignored. Fails loudly if the
 * remaining count doesn't match the intent's authored-allocation count.
 */
export function extractCreatedAllocationCids(
  intent: WalletIntent,
  tx: {
    createdEvents?: CreatedEvent[];
    events?: Array<{ created?: CreatedEvent }>;
  },
): string[] | undefined {
  if (!isAllocationAuthoringIntent(intent)) return undefined;
  const created = createdEventsOf(tx);
  const templated = created.some((e) => e.templateId !== undefined);
  const allocations = templated
    ? created.filter((e) => e.templateId?.endsWith(ALLOCATION_TEMPLATE_SUFFIX))
    : created;
  const cids = allocations.map((e) => e.contractId);
  const expected = expectedAllocationCount(intent);
  if (cids.length !== expected) {
    throw new Error(
      `wallet did not return ${expected} created allocation cids for ${intent.kind} ` +
        `(got ${cids.length})`,
    );
  }
  return cids;
}

/**
 * Pull the `LiquidityAllocationAcceptance` evidence cid out of a submit result
 * (created by AllocationRequest_Accept in the canonical LP flow). The operator
 * settle binds to this when the live request has been consumed. Undefined if
 * the submission did not produce one (e.g. legacy direct-allocation flow).
 */
export function extractLiquidityAcceptanceCid(tx: {
  createdEvents?: CreatedEvent[];
  events?: Array<{ created?: CreatedEvent }>;
}): string | undefined {
  return createdEventsOf(tx).find((e) =>
    e.templateId?.endsWith(LIQUIDITY_ACCEPTANCE_SUFFIX),
  )?.contractId;
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
