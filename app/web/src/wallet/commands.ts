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

export type DamlCommand =
  | { CreateCommand: CreateCommand }
  | { ExerciseCommand: ExerciseCommand }
  | { CreateAndExerciseCommand: CreateAndExerciseCommand };

export interface CreateAndExerciseCommand {
  templateId: string;
  createArguments: Record<string, unknown>;
  choice: string;
  choiceArgument: Record<string, unknown>;
}

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
    case "fund-order":                return composeFundOrder(intent, ctx);
    case "place-order":                return composePlaceOrder(intent, ctx);
    case "request-swap":               return composeRequestSwap(intent, ctx);
    case "split-holding":              return composeSplitHolding(intent, ctx);
    case "merge-holdings":             return composeMergeHoldings(intent, ctx);
    case "add-liquidity":              return composeAddLiquidity(intent, ctx);
    case "remove-liquidity":           return composeRemoveLiquidity(intent, ctx);
    case "fund-matched-trade":         return composeFundMatchedTrade(intent, ctx);
  }
}

// Order funding: author the OrderAllocationRequest's specifications as direct
// AllocationFactory_Allocate exercises — the lock-admin funding spec plus, for a
// cross-admin pair, the counter-admin receipt. The input holdings fund the
// lock spec; the receipt locks nothing. The wallet does not accept the
// request; `Order_Fund` derives the expected specs from the order itself and
// binds the created allocations.
function composeFundOrder(
  intent: Extract<WalletIntent, { kind: "fund-order" }>,
  ctx: ComposeContext,
): ComposedCommands {
  intent.factoryCids.forEach((cid) => assertFactoryReady(cid, "fund-order"));
  return composeAllocationCommands(
    intent,
    ctx,
    intent.allocations.map((spec) =>
      specFundsHoldings(spec) ? intent.inputHoldingCids : [],
    ),
    "order-fund-batch",
  );
}

function composePlaceOrder(
  intent: Extract<WalletIntent, { kind: "place-order" }>,
  ctx: ComposeContext,
): ComposedCommands {
  return {
    commandId: `order-${intent.pair.base.id}-${intent.pair.quote.id}-${ctx.now().getTime()}`,
    actAs: [ctx.party],
    commands: [{
      CreateCommand: {
        templateId: tid(ctx.packagePrefix, "CantonDex.Dex.OrderFundingRequest:OrderFundingRequest"),
        createArguments: {
          trader: ctx.party,
          operator: intent.operator,
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

// Matched-trade funding: author the TradeAllocationRequest's per-admin
// specifications as direct AllocationFactory_Allocate exercises — the sender-leg
// spec (funded from input holdings) plus, for a cross-admin trade, the
// counter-admin receiver spec (locks nothing). The wallet does not accept the
// request; the created cids drive the operator MatchedTrade_Settle.
function composeFundMatchedTrade(
  intent: Extract<WalletIntent, { kind: "fund-matched-trade" }>,
  ctx: ComposeContext,
): ComposedCommands {
  intent.factoryCids.forEach((cid) => assertFactoryReady(cid, "fund-matched-trade"));
  return composeAllocationCommands(
    intent,
    ctx,
    intent.allocations.map((spec) =>
      specFundsHoldings(spec) ? intent.inputHoldingCids : [],
    ),
    "trade-fund-batch",
  );
}

// Swap (DvP): author the SwapAllocationRequest's per-admin specifications as
// direct AllocationFactory_Allocate exercises — the swap-in leg under the input
// admin and the swap-out receipt under the output admin (one combined spec for a
// single-admin swap). The input holdings fund the swap-in spec; the output
// receipt locks nothing. The wallet does not accept the request; the created
// cids (input admin first) feed the operator settle (PoolRules_Swap), which
// archives the still-live request.
function composeRequestSwap(
  intent: Extract<WalletIntent, { kind: "request-swap" }>,
  ctx: ComposeContext,
): ComposedCommands {
  intent.factoryCids.forEach((cid) => assertFactoryReady(cid, "request-swap"));
  return composeAllocationCommands(
    intent,
    ctx,
    intent.allocations.map((spec) =>
      specFundsHoldings(spec) ? intent.inputHoldingCids : [],
    ),
    "swap-batch",
  );
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
  intent.factoryCids.forEach((cid) => assertFactoryReady(cid, "add-liquidity"));
  if (intent.allocations.length !== 3) {
    throw new Error(`add-liquidity: expected 3 allocation specs, got ${intent.allocations.length}`);
  }
  // Three direct AllocationFactory_Allocate exercises (base deposit, quote
  // deposit, LP receipt) in one atomic transaction. The wallet does not accept
  // the request; the operator binds the still-live request at settle. Holdings
  // PARALLEL to the request's [base, quote, LP] — only the deposits fund.
  return composeAllocationCommands(intent, ctx, [
    intent.baseHoldingCids,
    intent.quoteHoldingCids,
    [],
  ], "lp-batch");
}

// The Token Standard V2 AllocationFactory interface. Vendored under
// vendor/splice/token-standard/splice-api-token-allocation-instruction-v2. Each
// allocation is authored as its own top-level AllocationFactory_Allocate
// exercise on the asset registry's factory contract — the direct token-standard
// command external wallets (Loop / PartyLayer, dapp-sdk) support.
const ALLOCATION_FACTORY_TID =
  "#splice-api-token-allocation-instruction-v2:Splice.Api.Token.AllocationInstructionV2:AllocationFactory";

// The instrument a spec draws its input holdings from: a sender leg's
// instrument (LP deposits, the swap-in leg) or, for a prefunded lock allocation
// with no sender leg (order funding), its single next-iteration funding key. A
// receiver-only or zero-funding receipt spec draws nothing.
function fundingInstrumentId(spec: V2AllocationSpecification): string | undefined {
  const senderSide = spec.transferLegSides.find((s) => s.side === "SenderSide");
  if (senderSide) return senderSide.instrumentId;
  const funding = spec.nextIterationFunding;
  if (funding) {
    const ids = Object.keys(funding);
    if (ids.length === 1) return ids[0];
  }
  return undefined;
}

/** Whether a spec locks input holdings when authored (vs. a bare receipt). */
export function specFundsHoldings(spec: V2AllocationSpecification): boolean {
  return fundingInstrumentId(spec) !== undefined;
}

// The single external-wallet allocation-authoring mechanism, shared by every
// flow (LP add/remove, swap, order + matched-trade funding): author each
// allocation the request names as its own top-level AllocationFactory_Allocate
// exercise, submitted together as one atomic transaction. Leg i locks
// `holdingsBySpec[i]` — a funded leg carries its input holding cids, a receipt
// leg carries [] and locks nothing — and the registry returns any unused input
// and split change in the result's authorizerChangeCids. The wallet does not
// accept the operator-signatory *AllocationRequest; the operator binds the
// still-live request at settle. `holdingsBySpec`, `factoryCids`, and
// `allocationFactoryExtraArgs` are PARALLEL to the request's allocations.
function composeAllocationCommands(
  intent: {
    requestCid:
      | ContractId<"LiquidityAllocationRequest">
      | ContractId<"SwapAllocationRequest">
      | ContractId<"OrderAllocationRequest">
      | ContractId<"TradeAllocationRequest">;
    settlement: V2SettlementInfo;
    allocations: V2AllocationSpecification[];
    requestedAt: string;
    factoryCids: ContractId<"AllocationFactory">[];
    allocationFactoryExtraArgs: V2ExtraArgs[];
    disclosure: DisclosedContract[];
  },
  ctx: ComposeContext,
  holdingsBySpec: string[][],
  commandLabel: string,
): ComposedCommands {
  const { requestedAt, factoryCids, allocations } = intent;
  const allocExtraArgs = intent.allocationFactoryExtraArgs;
  if (factoryCids.length !== allocations.length || allocExtraArgs.length !== allocations.length) {
    throw new Error("allocation authoring: each allocation requires its own factory and choice context");
  }
  const commands: DamlCommand[] = allocations.map((spec, i) => ({
    ExerciseCommand: {
      templateId: ALLOCATION_FACTORY_TID,
      contractId: factoryCids[i],
      choice: "AllocationFactory_Allocate",
      choiceArgument: {
        settlement: intent.settlement,
        allocation: spec,
        requestedAt,
        // Real per-leg holdings: a funded leg locks its cids; a receipt leg
        // passes [] and locks nothing.
        inputHoldingCids: holdingsBySpec[i] ?? [],
        extraArgs: allocExtraArgs[i],
        actors: [ctx.party],
      },
    },
  }));
  return {
    commandId: `${commandLabel}-${shortCid(intent.requestCid)}-${ctx.now().getTime()}`,
    actAs: [ctx.party],
    commands,
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
  intent.factoryCids.forEach((cid) => assertFactoryReady(cid, "remove-liquidity"));
  if (intent.allocations.length !== 3) {
    throw new Error(`remove-liquidity: expected 3 allocation specs, got ${intent.allocations.length}`);
  }
  // Mirroring add: three direct AllocationFactory_Allocate exercises (base
  // receipt, quote receipt, LP burn-sender) in one atomic transaction. Only the
  // burn-sender funds from holdings (the LP holding); the two receipts are
  // receiver-side and lock nothing. The wallet does not accept the request; the
  // operator binds the still-live request at settle. Parallel to the request's
  // [base, quote, LP].
  return composeAllocationCommands(intent, ctx, [
    [],
    [],
    intent.lpHoldingCids,
  ], "lp-batch");
}

/** Intents whose follow-up step needs the wallet-authored allocation cid. */
export function isAllocationAuthoringIntent(intent: WalletIntent): boolean {
  return (
    intent.kind === "fund-order" ||
    intent.kind === "add-liquidity" ||
    intent.kind === "remove-liquidity" ||
    intent.kind === "request-swap" ||
    intent.kind === "fund-matched-trade"
  );
}

// Template suffixes used to classify created events in a submit result.
const ALLOCATION_TEMPLATE_SUFFIX = "CantonDex.Registry.V2:Allocation";
const LIQUIDITY_ACCEPTANCE_SUFFIX =
  "CantonDex.Dex.LiquidityAllocationRequest:LiquidityAllocationAcceptance";

// How many V2.Allocation contracts each intent authors — one per spec the
// request names (one for a single-admin trade, two for a cross-admin one).
// Drives the extraction count check independently of how many total commands
// the submission carries (the accept pairing adds a command but no Allocation).
function expectedAllocationCount(intent: WalletIntent): number {
  switch (intent.kind) {
    case "add-liquidity":
    case "remove-liquidity":
    case "request-swap":
    case "fund-order":
    case "fund-matched-trade":
      return intent.allocations.length;
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
 * the submission used the direct-allocation mode and produced no receipt.
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
