// Pool orchestration and read models.

import { createHash } from "node:crypto";
import { LedgerError } from "../ledger/index.js";

import type { ContractId } from "@canton-dex/registry-client";
import type { RegistryDiscovery } from "@canton-dex/registry-client";

import { asChoiceContext } from "../ledger/choice-context.js";
import { LedgerSubmitter } from "../ledger/index.js";
import { recoverCreatedAllocations } from "../ledger/recover.js";
import { discoverBatchesByAdmin } from "../settlement/index.js";
import { retryOnContention } from "../ledger/submit-with-retry.js";
import * as dec from "./decimal.js";
import type {
  Decimal,
  InstrumentId,
  LiquidityAllocationRequestContract,
  LiquidityAllocationAcceptanceContract,
  PoolLiquidityRulesContract,
  LPTokenPolicy,
  Party,
  Pool,
  PoolConfigContract,
  PoolRulesContract,
  PoolSlice,
  PoolSliceContract,
  PoolStateContract,
  Time,
  V2Account,
  V2AllocationSpecification,
  V2SettlementInfo,
} from "../types.js";

type ChoiceArguments = Record<string, unknown>;

// Full-identity instrument equality. Two instruments can share a text id under
// different admins (USD@A vs USD@B), so the swap side is decided on both admin
// and id, never on the text id alone.
function sameInstrument(a: InstrumentId, b: InstrumentId): boolean {
  return a.admin === b.admin && a.id === b.id;
}

interface AllocationInstructionResult {
  output?: {
    tag?: string;
    value?: { allocationCid?: string };
  };
}

interface AddLiquidityAllocationPlan {
  baseReceiver: ChoiceArguments;
  quoteReceiver: ChoiceArguments;
  lpMintSender: ChoiceArguments;
}

interface RemoveLiquidityAllocationPlan {
  lpBurnReceiver: ChoiceArguments;
}

// A settlement-preview choice returns a Daml `Map Party SettleBatch`, whose
// JSON encoding is an array of [admin, choiceArgs] pairs.
type SettlementPreview = Array<[Party, ChoiceArguments]>;

function completedAllocationCid(
  result: AllocationInstructionResult,
  operation: string,
): ContractId<"Allocation"> {
  const tag = result.output?.tag;
  const allocationCid = result.output?.value?.allocationCid;
  if (
    (tag !== "AllocationInstructionResult_Completed" && tag !== "Completed") ||
    !allocationCid
  ) {
    throw new LedgerError(
      "unsupported",
      `${operation}: registry did not complete allocation creation synchronously`,
      false,
    );
  }
  return allocationCid as ContractId<"Allocation">;
}

export interface PoolSwapInput {
  poolCid: ContractId<"Pool">;
  swapperAccount: V2Account;
  // The input instrument's full identity {admin,id}. The side is decided by
  // full-identity equality against the pool's base/quote so USD@A and USD@B
  // route to the correct reserve.
  inputInstrumentId: InstrumentId;
  inputAmount: Decimal;
  minOutputAmount: Decimal;
  quoteBinding: PoolSwapQuoteBinding;
  // The swapper's authored allocations in canonical order: the input
  // instrument's admin first, then the output instrument's. A single-admin swap
  // supplies one combined allocation. Omitted on the operator-discovery path,
  // where `updateId` is supplied and the operator recovers them.
  swapperAllocationCids?: ContractId<"Allocation">[];
  // Legacy single-admin alias for `swapperAllocationCids`.
  swapperAllocationCid?: ContractId<"Allocation">;
  // Operator-discovery path (updateId-only wallet, e.g. PartyLayer): the
  // swapper's signed allocations are recovered from the tree, one per admin.
  updateId?: string | null;
  // On-ledger SwapAllocationRequest(s) from /request to archive at settle.
  // Normally empty: a wallet accept consumes the request when it authors the
  // allocations. Pass only cids provably still active.
  swapAllocationRequestCids?: ContractId<"SwapAllocationRequest">[];
  // Optional client-supplied idempotency key. When present the swap
  // commandId is derived from it; otherwise the commandId is derived
  // deterministically from the request content.
  idempotencyKey?: string;
}

const BPS_SCALE = dec.parseDecimal("10000");

// `refunded` as a fraction of `supplied`, in basis points.
function bpsOf(refunded: bigint, supplied: bigint): bigint {
  if (supplied === 0n) return 0n;
  return dec.div(dec.mul(refunded, BPS_SCALE), supplied);
}

// The settle refunds the off-ratio remainder, but a caller who meant to add at
// the ratio would rather re-quote than have half its deposit handed back.
function enforceOffRatioTolerance(
  match: LiquidityMatch,
  maxOffRatioBps: number | Decimal | null | undefined,
): void {
  if (maxOffRatioBps === undefined || maxOffRatioBps === null) return;
  const limit = parseBpsLimit(maxOffRatioBps);
  if (dec.parseDecimal(match.offRatioBps) > limit) {
    throw new LedgerError(
      "validation",
      `add-liquidity is ${match.offRatioBps} bps off the pool ratio, over the ` +
        `${dec.formatDecimal(limit)} bps limit: only ${match.matchedBaseAmount} base and ` +
        `${match.matchedQuoteAmount} quote would enter the pool; the remaining ` +
        `${match.refundedBaseAmount} base and ${match.refundedQuoteAmount} quote would be refunded`,
      false,
    );
  }
}

function parseBpsLimit(v: number | Decimal): bigint {
  let scaled: bigint;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) {
      throw new LedgerError("validation", "maxOffRatioBps must be a finite number", false);
    }
    scaled = dec.parseDecimal(v.toFixed(dec.DECIMALS));
  } else if (typeof v === "string" && /^\d+(\.\d{1,10})?$/.test(v.trim())) {
    scaled = dec.parseDecimal(v);
  } else {
    throw new LedgerError(
      "validation",
      "maxOffRatioBps must be a number or a Daml Decimal string",
      false,
    );
  }
  // 10000 bps is a whole leg unmatched, the most of a leg that can come back.
  if (scaled < 0n || scaled > BPS_SCALE) {
    throw new LedgerError("validation", "maxOffRatioBps must be between 0 and 10000", false);
  }
  return scaled;
}

// Short stable hash of request content for deterministic, replay-safe
// commandIds. Same content => same commandId, so a retried
// request collapses onto the cached submission instead of re-firing.
function contentHash(parts: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 16);
}

// The wallet-facing request for a swap: Daml builds one terminal allocation
// containing the exact input and output sides for a specific pool snapshot.
// Creates nothing on-ledger; the wallet authors the returned specification.
export interface PoolRequestSwapInput {
  poolCid: ContractId<"Pool">;
  swapper: Party;
  // The input instrument's full identity {admin,id}; see PoolSwapInput.
  inputInstrumentId: InstrumentId;
  inputAmount: Decimal;
  minOutputAmount: Decimal;
  // Stamped onto the SwapAllocationRequest; defaults to now.
  requestedAt?: Time;
  settleAt?: Time | null;
}

export interface PoolSwapQuoteBinding {
  expectedPoolId: string;
  poolStateCid: ContractId<"PoolState">;
  inputSliceCid: ContractId<"PoolSlice">;
  outputSliceCids: ContractId<"PoolSlice">[];
  minOutputAmount: Decimal;
}

export interface PoolRequestSwapResult {
  // The on-ledger specs the wallet authors via AllocationFactory_Allocate: one
  // per (swapper, admin). A single-admin swap has one; a cross-admin swap has
  // the swap-in spec under the input admin and the swap-out spec under the
  // output admin.
  allocationSpecs: V2AllocationSpecification[];
  // The on-ledger request carrying those specs; passed back to /swap so the
  // settle can archive it when the wallet did not consume it via accept.
  swapRequestCid: ContractId<"SwapAllocationRequest">;
  settlement: V2SettlementInfo;
  quoteBinding: PoolSwapQuoteBinding;
}

// === DvP liquidity ==========================================

export interface PoolRequestAddLiquidityInput {
  poolCid: ContractId<"Pool">;
  recipient: Party;
  baseAmount: Decimal;
  quoteAmount: Decimal;
  requestedAt: Time;
  settleAt?: Time | null;
  /**
   * Ceiling on `offRatioBps`, 0..10000. Omitted means no ceiling, which is
   * what every existing caller relies on.
   */
  maxOffRatioBps?: number | Decimal | null;
}

/**
 * What a deposit buys. LP is minted against the leg that is short relative to
 * the reserve ratio; only that matched share enters the reserves, and the
 * settle refunds the rest of the other leg to the depositor.
 */
export interface LiquidityMatch {
  lpAmount: Decimal;
  matchedBaseAmount: Decimal;
  matchedQuoteAmount: Decimal;
  /** The unmatched remainder of each leg, which comes back on settle. */
  refundedBaseAmount: Decimal;
  refundedQuoteAmount: Decimal;
  /** The unmatched leg as a fraction of what that leg supplied, in bps. */
  offRatioBps: Decimal;
}

export interface PoolRequestAddLiquidityResult extends LiquidityMatch {
  requestCid: ContractId<"LiquidityAllocationRequest">;
  // Echoed so the later settle uses the same supply snapshot.
  knownTotalLpSupply: Decimal;
  baseAmount: Decimal;
  quoteAmount: Decimal;
  // The on-ledger specs the wallet authors, in canonical order.
  allocations: V2AllocationSpecification[];
  settlement: V2SettlementInfo;
}

export interface PoolSettleAddLiquidityInput {
  poolCid: ContractId<"Pool">;
  // Bind settlement to either a live request (direct-allocation integration)
  // or the receipt left when a wallet accepts and consumes that request.
  requestCid?: ContractId<"LiquidityAllocationRequest"> | null;
  acceptanceCid?: ContractId<"LiquidityAllocationAcceptance"> | null;
  recipient: Party;
  // Explicit created cids (dApp-return path). Omitted on the operator-discovery
  // path, where `updateId` is supplied instead and the operator recovers them.
  lpBaseDepositCid?: ContractId<"Allocation">;
  lpQuoteDepositCid?: ContractId<"Allocation">;
  lpReceiptCid?: ContractId<"Allocation">;
  // Operator-discovery path: the wallet returned only an updateId. The operator
  // recovers the 3 Allocation cids + the acceptance evidence from the transaction
  // tree. Mutually exclusive with the explicit cids.
  updateId?: string | null;
  baseAmount: Decimal;
  quoteAmount: Decimal;
  minLpTokens: Decimal;
  knownTotalLpSupply: Decimal;
  requestedAt: Time;
}

export interface PoolRequestRemoveLiquidityInput {
  poolCid: ContractId<"Pool">;
  holder: Party;
  // The caller passes only intent; the backend derives the slice plan.
  lpTokensToRedeem: Decimal;
  requestedAt: Time;
  settleAt?: Time | null;
}

export interface PoolRequestRemoveLiquidityResult {
  requestCid: ContractId<"LiquidityAllocationRequest">;
  /** Echoed for the later settle. */
  knownTotalLpSupply: Decimal;
  // The plan the wallet authors receipt legs against.
  baseSliceCids: ContractId<"PoolSlice">[];
  quoteSliceCids: ContractId<"PoolSlice">[];
  baseOuts: Decimal[];
  quoteOuts: Decimal[];
  // The on-ledger specs the holder authors.
  allocations: V2AllocationSpecification[];
  settlement: V2SettlementInfo;
}

export interface PoolSettleRemoveLiquidityInput {
  poolCid: ContractId<"Pool">;
  // Bind to the live request OR the acceptance evidence (see settle-add).
  requestCid?: ContractId<"LiquidityAllocationRequest"> | null;
  acceptanceCid?: ContractId<"LiquidityAllocationAcceptance"> | null;
  holder: Party;
  lpTokensToRedeem: Decimal;
  knownTotalLpSupply: Decimal;
  minBaseOut: Decimal;
  minQuoteOut: Decimal;
  // The backend re-derives the slice prefix from current state.
  // Explicit created cids (dApp-return path); omitted when `updateId` is given.
  holderBaseReceiptCid?: ContractId<"Allocation">;
  holderQuoteReceiptCid?: ContractId<"Allocation">;
  holderBurnSenderCid?: ContractId<"Allocation">;
  // Operator-discovery path (updateId-only wallet); see settle-add.
  updateId?: string | null;
  requestedAt: Time;
}

// One side of an operator-derived redemption plan.
export interface RemoveSidePlan {
  sliceCids: ContractId<"PoolSlice">[];
  outs: Decimal[];
}

export interface RemovePlan {
  base: RemoveSidePlan;
  quote: RemoveSidePlan;
}

// Select the head-first slice prefix that covers `target` (a scaled-BigInt
// decimal). Uses exact decimal arithmetic so the prefix matches the
// on-ledger reserve accounting.
function selectCoveringPrefix(slices: PoolSlice[], target: bigint): ContractId<"PoolSlice">[] {
  const out: ContractId<"PoolSlice">[] = [];
  let acc = 0n;
  for (const s of slices) {
    out.push(s.contractId);
    acc += dec.parseDecimal(s.amount);
    if (acc >= target) break;
  }
  return out;
}

/** Raw Daml `PS_*` constructor -> the spelling types.ts declares. Idempotent. */
function normalizePoolStatus(raw: unknown): Pool["status"] {
  const s = String(raw);
  return (s.startsWith("PS_") ? s.slice(3) : s) as Pool["status"];
}

export class PoolService {
  constructor(
    private readonly ledger: LedgerSubmitter,
    private readonly registry: RegistryDiscovery,
    private readonly operatorParty: Party,
  ) {}

  private async rulesCid(): Promise<ContractId<"PoolRules">> {
    const rules = await this.ledger.query<PoolRulesContract>({
      templateId: "CantonDex.Dex.PoolRules:PoolRules",
      observingParty: this.operatorParty,
    });
    const found = rules.find((r) => r.operator === this.operatorParty);
    if (!found) throw new Error("no PoolRules contract for operator");
    return found.contractId;
  }

  private async poolLiquidityRules(): Promise<PoolLiquidityRulesContract[]> {
    return this.ledger.query<PoolLiquidityRulesContract>({
      templateId: "CantonDex.Dex.PoolLiquidityRules:PoolLiquidityRules",
      observingParty: this.operatorParty,
    });
  }

  async poolLiquidityRulesCid(lpRegistrar: Party): Promise<ContractId<"PoolLiquidityRules">> {
    const all = await this.poolLiquidityRules();
    const found = all.find(
      (r) => r.operator === this.operatorParty && r.lpRegistrar === lpRegistrar,
    );
    if (!found) {
      throw new Error(`no PoolLiquidityRules contract for operator + lpRegistrar=${lpRegistrar}`);
    }
    return found.contractId;
  }

  /** Assemble the combined `Pool` view from config, state, and slices. */
  async listActive(): Promise<Pool[]> {
    const [configs, states, slices] = await Promise.all([
      this.ledger.query<PoolConfigContract>({
        templateId: "CantonDex.Dex.Pool:Pool",
        observingParty: this.operatorParty,
      }),
      this.ledger.query<PoolStateContract>({
        templateId: "CantonDex.Dex.PoolState:PoolState",
        observingParty: this.operatorParty,
      }),
      this.ledger.query<PoolSliceContract>({
        templateId: "CantonDex.Dex.PoolSlice:PoolSlice",
        observingParty: this.operatorParty,
      }),
    ]);
    let rulesCid: ContractId<"PoolRules"> | undefined;
    try {
      rulesCid = await this.rulesCid();
    } catch {
      rulesCid = undefined;
    }
    const liquidityRules = await this.poolLiquidityRules();
    const liquidityRulesCidFor = (lpRegistrar: Party): ContractId<"PoolLiquidityRules"> | null =>
      liquidityRules.find(
        (r) => r.operator === this.operatorParty && r.lpRegistrar === lpRegistrar,
      )?.contractId ?? null;

    const stateByPool = new Map(states.map((s) => [s.poolId, s]));
    const combined: Pool[] = [];
    for (const cfg of configs) {
      const state = stateByPool.get(cfg.poolId);
      if (!state) continue;
      const poolSlices = slices.filter((s) => s.poolId === cfg.poolId);
      const toSlice = (s: PoolSliceContract): PoolSlice => ({
        contractId: s.contractId,
        allocationCid: s.allocationCid,
        amount: s.amount,
        side: s.side,
      });
      // A participant returns "PS_Active" where types.ts declares "Active",
      // so a client written against the published type saw no tradable pools.
      // Read path only: create arguments stay prefixed.
      const status = normalizePoolStatus(state.status);
      if (status === "Paused") continue;
      combined.push({
        contractId: cfg.contractId,
        poolId: cfg.poolId,
        poolStateCid: state.contractId,
        rulesCid: rulesCid ?? ("" as ContractId<"PoolRules">),
        poolLiquidityRulesCid: liquidityRulesCidFor(cfg.lpRegistrar),
        operator: cfg.operator,
        lpRegistrar: cfg.lpRegistrar,
        baseInstrumentId: cfg.baseInstrumentId,
        quoteInstrumentId: cfg.quoteInstrumentId,
        lpInstrumentId: cfg.lpInstrumentId,
        feeBps: cfg.feeBps,
        status,
        reserves: state.reserves,
        totalLpSupply: state.totalLpSupply,
        baseSlices: poolSlices.filter((s) => s.side === "BaseSide").map(toSlice),
        quoteSlices: poolSlices.filter((s) => s.side === "QuoteSide").map(toSlice),
        publicReaders: state.publicReaders,
      });
    }
    return combined;
  }

  /**
   * Off-chain quote computation for the constant-product pool, in exact
   * fixed-point decimal (10dp, floored at each step) so it agrees with the
   * on-ledger PoolRules_Swap computation to the last digit. This
   * is advisory; the on-chain choice re-validates.
   */
  computeQuote(
    pool: Pool,
    inputInstrumentId: InstrumentId,
    inputAmount: Decimal,
  ): Decimal {
    const [reserveIn, reserveOut] =
      sameInstrument(inputInstrumentId, pool.baseInstrumentId)
        ? [pool.reserves.baseAmount, pool.reserves.quoteAmount]
        : [pool.reserves.quoteAmount, pool.reserves.baseAmount];
    const rIn = dec.parseDecimal(reserveIn);
    const rOut = dec.parseDecimal(reserveOut);
    // feeMul = (10000 - feeBps) / 10000, as a scaled decimal.
    const feeNum = dec.parseDecimal(String(10000 - pool.feeBps));
    const feeDen = dec.parseDecimal("10000");
    const dx = dec.divFloor(
      dec.mulFloor(dec.parseDecimal(inputAmount), feeNum),
      feeDen,
    );
    const out = dec.divFloor(dec.mulFloor(rOut, dx), rIn + dx);
    return dec.formatDecimal(out);
  }

  /**
   * Enriched quote for trading clients: the output amount plus the fields a
   * client would otherwise recompute from `reserves` + `feeBps` — the fee
   * actually applied, the execution price, the pre-trade spot (mid) price, and
   * the resulting price impact. All exact (BigInt decimal math, no floats).
   */
  computeQuoteDetailed(
    pool: Pool,
    inputInstrumentId: InstrumentId,
    inputAmount: Decimal,
  ): {
    outputAmount: Decimal;
    inputAmount: Decimal;
    inputInstrumentId: string;
    outputInstrumentId: string;
    feeBps: number;
    feeAmount: Decimal;
    executionPrice: Decimal;
    spotPrice: Decimal;
    priceImpact: Decimal;
    poolCid: string;
    poolId: string;
  } {
    const isBaseIn = sameInstrument(inputInstrumentId, pool.baseInstrumentId);
    const outputInstrumentId = isBaseIn
      ? pool.quoteInstrumentId.id
      : pool.baseInstrumentId.id;
    const [reserveIn, reserveOut] = isBaseIn
      ? [pool.reserves.baseAmount, pool.reserves.quoteAmount]
      : [pool.reserves.quoteAmount, pool.reserves.baseAmount];

    const outputAmount = this.computeQuote(pool, inputInstrumentId, inputAmount);
    const inDec = dec.parseDecimal(inputAmount);
    const outDec = dec.parseDecimal(outputAmount);
    const rIn = dec.parseDecimal(reserveIn);
    const rOut = dec.parseDecimal(reserveOut);

    // fee actually applied = inputAmount * feeBps / 10000
    const feeAmount = dec.div(
      dec.mul(inDec, dec.parseDecimal(String(pool.feeBps))),
      dec.parseDecimal("10000"),
    );
    // execution price = output per unit input; spot = reserve mid (pre-trade).
    const executionPrice = inDec > 0n ? dec.div(outDec, inDec) : 0n;
    const spotPrice = rIn > 0n ? dec.div(rOut, rIn) : 0n;
    // price impact = (spot - execution) / spot, as a fraction (>=0 worse).
    const priceImpact =
      spotPrice > 0n ? dec.div(spotPrice - executionPrice, spotPrice) : 0n;

    return {
      outputAmount,
      inputAmount,
      // Echoed as the display text ids the client sent/expects.
      inputInstrumentId: inputInstrumentId.id,
      outputInstrumentId,
      feeBps: pool.feeBps,
      feeAmount: dec.formatDecimal(feeAmount),
      executionPrice: dec.formatDecimal(executionPrice),
      spotPrice: dec.formatDecimal(spotPrice),
      priceImpact: dec.formatDecimal(priceImpact),
      poolCid: pool.contractId,
      poolId: pool.poolId,
    };
  }

  async swap(input: PoolSwapInput): Promise<unknown> {
    const pool = await this.fetchPool(input.poolCid);
    const binding = input.quoteBinding;
    if (!binding || !Array.isArray(binding.outputSliceCids)) {
      throw new LedgerError("validation", "swap: quoteBinding is required", false);
    }
    if (binding.expectedPoolId !== pool.poolId) {
      throw new LedgerError("validation", "swap: quote belongs to a different pool", false);
    }
    if (binding.poolStateCid !== pool.poolStateCid) {
      throw new LedgerError(
        "contention",
        "swap: pool changed after the quote; request a fresh quote and allocation",
        true,
      );
    }
    if (dec.parseDecimal(binding.minOutputAmount) !== dec.parseDecimal(input.minOutputAmount)) {
      throw new LedgerError("validation", "swap: slippage minimum differs from quote", false);
    }
    const inputIsBase = sameInstrument(input.inputInstrumentId, pool.baseInstrumentId);
    const inputAdmin = inputIsBase
      ? pool.baseInstrumentId.admin
      : pool.quoteInstrumentId.admin;
    const outputAdmin = inputIsBase
      ? pool.quoteInstrumentId.admin
      : pool.baseInstrumentId.admin;
    // Canonical admin order the swapper authored specs in (see
    // PoolRules.swapperAllocationSpecs); a single-admin swap collapses to one.
    const swapAdmins = inputAdmin === outputAdmin ? [inputAdmin] : [inputAdmin, outputAdmin];

    // Resolve the swapper's per-admin allocations: an explicit list, the legacy
    // single cid, or recovered from the tree (one per admin) on the
    // operator-discovery path.
    let swapperAllocationCids =
      input.swapperAllocationCids ??
      (input.swapperAllocationCid ? [input.swapperAllocationCid] : undefined);
    if (input.updateId) {
      const { allocationCids } = await recoverCreatedAllocations(
        this.ledger, this.operatorParty, input.updateId, swapAdmins.length,
      );
      swapperAllocationCids = allocationCids as ContractId<"Allocation">[];
    }
    if (!swapperAllocationCids || swapperAllocationCids.length !== swapAdmins.length) {
      throw new LedgerError(
        "validation",
        `swap: supply ${swapAdmins.length} swapper allocation cid(s) (one per admin) ` +
          "or an updateId to recover them",
        false,
      );
    }
    const swapperCids = swapperAllocationCids;
    const swapperAllocationCidsByAdmin = swapAdmins.map(
      (admin, i) => [admin, swapperCids[i]!] as [Party, ContractId<"Allocation">],
    );
    const inputSlices = inputIsBase ? pool.baseSlices : pool.quoteSlices;
    const outputSlices = inputIsBase ? pool.quoteSlices : pool.baseSlices;
    if (!inputSlices.some((slice) => slice.contractId === binding.inputSliceCid)) {
      throw new LedgerError("contention", "swap: quoted input slice is no longer active", true);
    }
    const activeOutputCids = new Set(outputSlices.map((slice) => slice.contractId));
    if (
      binding.outputSliceCids.length === 0 ||
      binding.outputSliceCids.some((cid) => !activeOutputCids.has(cid))
    ) {
      throw new LedgerError("contention", "swap: quoted output slices are no longer active", true);
    }
    // Deterministic, replay-safe commandId: computed ONCE here,
    // outside the retry closure, from a client key or the request content.
    const swapKey =
      input.idempotencyKey ??
      contentHash({
        poolCid: input.poolCid,
        swapper: input.swapperAccount.owner,
        inputInstrumentId: input.inputInstrumentId,
        inputAmount: input.inputAmount,
        minOutputAmount: input.minOutputAmount,
        quoteBinding: binding,
        swapperAllocationCidsByAdmin,
        updateId: input.updateId ?? null,
      });
    const commandId = `pool-swap:${input.poolCid}:${swapKey}`;
    const swapArgument = {
      expectedPoolId: pool.poolId,
      poolCid: input.poolCid,
      poolStateCid: binding.poolStateCid,
      swapperAccount: input.swapperAccount,
      inputInstrumentId: input.inputInstrumentId,
      inputAmount: input.inputAmount,
      minOutputAmount: input.minOutputAmount,
      // GenMap: array of [admin, cid] pairs.
      swapperAllocationCidsByAdmin,
      inputSliceCid: binding.inputSliceCid,
      outputSliceCids: binding.outputSliceCids,
      quoteBinding: binding,
    };
    // No readAs on the swapper (a self-custody trader will not grant the
    // operator that right) nor on any instrument admin: the operator is the
    // settlement executor named on the swapper's allocations, so it already
    // sees them, and the registry-returned settlement-factory disclosures cover
    // each admin.
    const preview = await retryOnContention(() =>
      this.ledger.submit<SettlementPreview>({
        actAs: [this.operatorParty],
        commandId: `${commandId}:preview`,
        command: {
          kind: "exercise",
          templateId: "CantonDex.Dex.PoolRules:PoolRules",
          contractId: pool.rulesCid,
          choice: "PoolRules_PreviewSwapSettlement",
          argument: swapArgument,
        },
      }),
    );
    // One settlement factory per admin: swap-in under the input admin, swap-out
    // under the output admin (both under one for a single-admin swap).
    const { batchesByAdmin, disclosure } = await discoverBatchesByAdmin(
      this.registry,
      preview,
    );
    return retryOnContention(() =>
      this.ledger.submit({
        actAs: [this.operatorParty],
        commandId,
        disclosure,
        command: {
          kind: "exercise",
          templateId: "CantonDex.Dex.PoolRules:PoolRules",
          contractId: pool.rulesCid,
          choice: "PoolRules_Swap",
          argument: {
            ...swapArgument,
            batchesByAdmin,
            swapAllocationRequestCids: input.swapAllocationRequestCids ?? [],
          },
        },
      }),
    );
  }

  // Build the exact two-sided allocation and snapshot binding in Daml so the
  // wallet authorizes precisely what PoolRules_Swap later settles.
  async requestSwap(input: PoolRequestSwapInput): Promise<PoolRequestSwapResult> {
    const pool = await this.fetchPool(input.poolCid);
    if (
      !sameInstrument(input.inputInstrumentId, pool.baseInstrumentId) &&
      !sameInstrument(input.inputInstrumentId, pool.quoteInstrumentId)
    ) {
      throw new LedgerError("validation", "swap: input instrument is not in the pool", false);
    }
    const inputIsBase = sameInstrument(input.inputInstrumentId, pool.baseInstrumentId);
    const inputSlices = inputIsBase ? pool.baseSlices : pool.quoteSlices;
    const outputSlices = inputIsBase ? pool.quoteSlices : pool.baseSlices;
    const inputSlice = inputSlices[0];
    if (!inputSlice) throw new LedgerError("validation", "swap: pool has no input liquidity", false);
    const amountOut = dec.parseDecimal(
      this.computeQuote(pool, input.inputInstrumentId, input.inputAmount),
    );
    if (amountOut <= 0n) {
      throw new LedgerError("validation", "swap: output rounds to zero", false);
    }
    if (amountOut < dec.parseDecimal(input.minOutputAmount)) {
      throw new LedgerError("validation", "swap: quoted output is below the slippage minimum", false);
    }
    const quoteBinding: PoolSwapQuoteBinding = {
      expectedPoolId: pool.poolId,
      poolStateCid: pool.poolStateCid,
      inputSliceCid: inputSlice.contractId,
      outputSliceCids: selectCoveringPrefix(outputSlices, amountOut),
      minOutputAmount: input.minOutputAmount,
    };
    const result = await this.ledger.submit<{
      settlement: V2SettlementInfo;
      allocationSpecs: V2AllocationSpecification[];
      swapRequestCid: ContractId<"SwapAllocationRequest">;
      quoteBinding: PoolSwapQuoteBinding | null;
    }>({
      actAs: [this.operatorParty],
      commandId: `pool-swap-req:${input.poolCid}:${contentHash({
        swapper: input.swapper,
        inputInstrumentId: input.inputInstrumentId,
        inputAmount: input.inputAmount,
        minOutputAmount: input.minOutputAmount,
        quoteBinding,
      })}`,
      command: {
        kind: "exercise",
        templateId: "CantonDex.Dex.PoolRules:PoolRules",
        contractId: pool.rulesCid,
        choice: "PoolRules_RequestSwap",
        argument: {
          poolCid: input.poolCid,
          swapper: input.swapper,
          inputInstrumentId: input.inputInstrumentId,
          inputAmount: input.inputAmount,
          requestedAt: input.requestedAt ?? new Date().toISOString(),
          settleAt: input.settleAt ?? null,
          quoteBinding,
        },
      },
    });
    if (!result.quoteBinding) {
      throw new LedgerError("validation", "swap: on-ledger request omitted quote binding", false);
    }
    return {
      allocationSpecs: result.allocationSpecs,
      swapRequestCid: result.swapRequestCid,
      settlement: result.settlement,
      quoteBinding: result.quoteBinding,
    };
  }

  // === DvP liquidity ==========================================

  private requirePoolLiquidityRules(pool: Pool): ContractId<"PoolLiquidityRules"> {
    if (!pool.poolLiquidityRulesCid) {
      throw new Error(`pool ${pool.poolId} has no PoolLiquidityRules; run admin bootstrap`);
    }
    return pool.poolLiquidityRulesCid;
  }

  private async fetchLiquidityPool(
    cid: ContractId<"Pool">,
  ): Promise<{ pool: Pool; liquidityRulesCid: ContractId<"PoolLiquidityRules"> }> {
    const pool = await this.fetchPool(cid);
    return { pool, liquidityRulesCid: this.requirePoolLiquidityRules(pool) };
  }

  private async createRegistryAllocation(
    admin: Party,
    choiceArguments: ChoiceArguments,
    commandId: string,
    actAs: Party[],
  ): Promise<{
    allocationCid: ContractId<"Allocation">;
    factoryCid: ContractId<"AllocationFactory">;
  }> {
    const discovered = await this.registry.getAllocationFactory(
      admin,
      choiceArguments,
    );
    const context = asChoiceContext(discovered);
    const result = await retryOnContention(() =>
      this.ledger.submit<AllocationInstructionResult>({
        actAs,
        commandId,
        disclosure: context.disclosure,
        command: {
          kind: "exerciseInterface",
          interfaceId:
            "Splice.Api.Token.AllocationInstructionV2:AllocationFactory",
          contractId: discovered.factoryCid,
          choice: "AllocationFactory_Allocate",
          argument: {
            ...choiceArguments,
            extraArgs: context.extraArgs,
          },
        },
      }),
    );
    return {
      allocationCid: completedAllocationCid(result, commandId),
      factoryCid: discovered.factoryCid,
    };
  }

  /** Read back a newly-created liquidity request. */
  private async fetchRequest(
    cid: ContractId<"LiquidityAllocationRequest">,
  ): Promise<LiquidityAllocationRequestContract> {
    const reqs = await this.ledger.query<LiquidityAllocationRequestContract>({
      templateId: "CantonDex.Dex.LiquidityAllocationRequest:LiquidityAllocationRequest",
      observingParty: this.operatorParty,
    });
    const found = reqs.find((r) => r.contractId === cid);
    if (!found) throw new Error(`LiquidityAllocationRequest ${cid} not found after create`);
    return found;
  }

  /**
   * Discover the acceptance evidence by its stable, globally-unique correlation
   * key: the consumed request's cid (`originalRequestCid`). The
   * operator created the request and knows its cid, so it recovers the matching
   * evidence even though the request itself is archived. (Keying on
   * `(lp, settlement.id)` is NOT unique — `poolSettlement` uses a constant
   * settlement id per pool, so an LP with two pending requests would be
   * ambiguous.) Used when the wallet result did not surface the acceptance cid.
   */
  async discoverAcceptance(
    requestCid: ContractId<"LiquidityAllocationRequest">,
  ): Promise<ContractId<"LiquidityAllocationAcceptance">> {
    const accs = await this.ledger.query<LiquidityAllocationAcceptanceContract>({
      templateId:
        "CantonDex.Dex.LiquidityAllocationRequest:LiquidityAllocationAcceptance",
      observingParty: this.operatorParty,
    });
    const [match, ...rest] = accs.filter((a) => a.originalRequestCid === requestCid);
    if (!match) {
      throw new Error(`no LiquidityAllocationAcceptance for requestCid=${requestCid}`);
    }
    if (rest.length > 0) {
      // requestCid is unique, so this should be unreachable; guard anyway.
      throw new Error(
        `ambiguous LiquidityAllocationAcceptance for requestCid=${requestCid} (${rest.length + 1} matches)`,
      );
    }
    return match.contractId;
  }

  /**
   * Operator-discovery: recover the created `Allocation` cids (in canonical
   * command order) and the `LiquidityAllocationAcceptance` cid from a
   * committed transaction by `updateId`. Used when the wallet (e.g. PartyLayer)
   * returns only an `updateId` and not the created events, so `/settle` can be
   * driven without the dApp surfacing cids. Throws if the ledger can't serve
   * trees, or if the expected number of allocations isn't present.
   */
  async recoverDvpAllocations(
    updateId: string,
    party: Party,
    expectedAllocations: number,
  ): Promise<{
    allocationCids: ContractId<"Allocation">[];
    acceptanceCid?: ContractId<"LiquidityAllocationAcceptance">;
  }> {
    const { allocationCids, acceptanceCid } = await recoverCreatedAllocations(
      this.ledger,
      party,
      updateId,
      expectedAllocations,
    );
    return {
      allocationCids: allocationCids as ContractId<"Allocation">[],
      acceptanceCid: acceptanceCid as
        | ContractId<"LiquidityAllocationAcceptance">
        | undefined,
    };
  }

  /** LP quote in fixed-point decimal, with the deposit share it is minted against. */
  private matchLiquidity(pool: Pool, baseAmount: Decimal, quoteAmount: Decimal): LiquidityMatch {
    const b = dec.parseDecimal(baseAmount);
    const q = dec.parseDecimal(quoteAmount);
    const supply = dec.parseDecimal(pool.totalLpSupply);
    if (supply === 0n) {
      // First funding sets the ratio, so no leg can be off it.
      return {
        lpAmount: dec.formatDecimal(dec.sqrt(dec.mul(b, q))),
        matchedBaseAmount: dec.formatDecimal(b),
        matchedQuoteAmount: dec.formatDecimal(q),
        refundedBaseAmount: dec.formatDecimal(0n),
        refundedQuoteAmount: dec.formatDecimal(0n),
        offRatioBps: dec.formatDecimal(0n),
      };
    }
    const rb = dec.parseDecimal(pool.reserves.baseAmount);
    const rq = dec.parseDecimal(pool.reserves.quoteAmount);
    const lp = dec.min(dec.div(dec.mul(b, supply), rb), dec.div(dec.mul(q, supply), rq));
    // Mirrors PM.ratioMatchedDeposit, which is what the settle draws on: the
    // side short of the reserve ratio goes in whole, the other only as far as
    // it pairs. Deriving these from `lp` instead rounds twice and disagrees
    // with the ledger, so the quoted refund would not be the settled one.
    const [matchedBase, matchedQuote] =
      b * rq > q * rb
        ? [dec.min(b, dec.ceilMulDiv(q, rb, rq)), q]
        : [b, dec.min(q, dec.ceilMulDiv(b, rq, rb))];
    return {
      lpAmount: dec.formatDecimal(lp),
      matchedBaseAmount: dec.formatDecimal(matchedBase),
      matchedQuoteAmount: dec.formatDecimal(matchedQuote),
      refundedBaseAmount: dec.formatDecimal(b - matchedBase),
      refundedQuoteAmount: dec.formatDecimal(q - matchedQuote),
      offRatioBps: dec.formatDecimal(
        dec.max(bpsOf(b - matchedBase, b), bpsOf(q - matchedQuote, q)),
      ),
    };
  }

  /** Create the wallet-facing request for a DvP add. */
  async requestAddLiquidity(
    input: PoolRequestAddLiquidityInput,
  ): Promise<PoolRequestAddLiquidityResult> {
    const { pool, liquidityRulesCid } = await this.fetchLiquidityPool(input.poolCid);
    const match = this.matchLiquidity(pool, input.baseAmount, input.quoteAmount);
    enforceOffRatioTolerance(match, input.maxOffRatioBps);
    const requestCid = await retryOnContention(() =>
      this.ledger.submit<ContractId<"LiquidityAllocationRequest">>({
        actAs: [this.operatorParty],
        commandId: `lp-add-req:${input.poolCid}:${input.requestedAt}`,
        command: {
          kind: "exercise",
          templateId: "CantonDex.Dex.PoolLiquidityRules:PoolLiquidityRules",
          contractId: liquidityRulesCid,
          choice: "PoolLiquidityRules_RequestAddLiquidity",
          argument: {
            poolCid: input.poolCid,
            recipient: input.recipient,
            baseAmount: input.baseAmount,
            quoteAmount: input.quoteAmount,
            lpAmount: match.lpAmount,
            requestedAt: input.requestedAt,
            settleAt: input.settleAt ?? null,
          },
        },
      }),
    );
    const req = await this.fetchRequest(requestCid);
    return {
      ...match,
      requestCid,
      knownTotalLpSupply: pool.totalLpSupply,
      baseAmount: input.baseAmount,
      quoteAmount: input.quoteAmount,
      allocations: req.allocations,
      settlement: req.settlement,
    };
  }

  /** Settle a DvP add. */
  async settleAddLiquidity(input: PoolSettleAddLiquidityInput): Promise<unknown> {
    const { pool, liquidityRulesCid } = await this.fetchLiquidityPool(input.poolCid);
    const lpPolicyCid = await this.fetchLpAssetPolicy(pool);

    // Resolve the three created allocation cids + the binding. On the
    // operator-discovery path (updateId-only wallet, e.g. PartyLayer) the
    // operator recovers them from the transaction tree; otherwise the dApp
    // supplied them explicitly.
    let { lpBaseDepositCid, lpQuoteDepositCid, lpReceiptCid, requestCid, acceptanceCid } = input;
    if (input.updateId) {
      const rec = await this.recoverDvpAllocations(input.updateId, this.operatorParty, 3);
      [lpBaseDepositCid, lpQuoteDepositCid, lpReceiptCid] = rec.allocationCids;
      acceptanceCid = rec.acceptanceCid ?? input.acceptanceCid ?? null;
      requestCid = null; // accept consumed the request on this path
    }
    if (!lpBaseDepositCid || !lpQuoteDepositCid || !lpReceiptCid) {
      throw new Error(
        "settleAddLiquidity: supply the 3 allocation cids or an updateId to recover them",
      );
    }
    const flowKey = requestCid ?? acceptanceCid ?? input.updateId;
    if (!flowKey) {
      throw new Error("settleAddLiquidity: request, acceptance, or update id is required");
    }
    const preparation = {
      expectedPoolId: pool.poolId,
      poolCid: input.poolCid,
      poolStateCid: pool.poolStateCid,
      lpPolicyCid,
      requestCid: requestCid ?? null,
      acceptanceCid: acceptanceCid ?? null,
      recipient: input.recipient,
      lpBaseDepositCid,
      lpQuoteDepositCid,
      lpReceiptCid,
      baseAmount: input.baseAmount,
      quoteAmount: input.quoteAmount,
      minLpTokens: input.minLpTokens,
      knownTotalLpSupply: input.knownTotalLpSupply,
    };
    const allocationPlan = await retryOnContention(() =>
      this.ledger.submit<AddLiquidityAllocationPlan>({
        actAs: [this.operatorParty, pool.lpRegistrar],
        commandId: `lp-add-preview-allocations:${flowKey}`,
        command: {
          kind: "exercise",
          templateId: "CantonDex.Dex.PoolLiquidityRules:PoolLiquidityRules",
          contractId: liquidityRulesCid,
          choice: "PoolLiquidityRules_PreviewAddAllocations",
          argument: { preparation, requestedAt: input.requestedAt },
        },
      }),
    );
    const [operatorBaseReceiver, operatorQuoteReceiver, registrarMint] =
      await Promise.all([
        this.createRegistryAllocation(
          pool.baseInstrumentId.admin,
          allocationPlan.baseReceiver,
          `lp-add-base-receiver:${flowKey}`,
          [this.operatorParty],
        ),
        this.createRegistryAllocation(
          pool.quoteInstrumentId.admin,
          allocationPlan.quoteReceiver,
          `lp-add-quote-receiver:${flowKey}`,
          [this.operatorParty],
        ),
        this.createRegistryAllocation(
          pool.lpRegistrar,
          allocationPlan.lpMintSender,
          `lp-add-mint-sender:${flowKey}`,
          [pool.lpRegistrar],
        ),
      ]);
    const settlementPreview = await retryOnContention(() =>
      this.ledger.submit<SettlementPreview>({
        actAs: [this.operatorParty, pool.lpRegistrar],
        commandId: `lp-add-preview-settlement:${flowKey}`,
        command: {
          kind: "exercise",
          templateId: "CantonDex.Dex.PoolLiquidityRules:PoolLiquidityRules",
          contractId: liquidityRulesCid,
          choice: "PoolLiquidityRules_PreviewAddSettlement",
          argument: {
            preparation,
            operatorBaseReceiverCid: operatorBaseReceiver.allocationCid,
            operatorQuoteReceiverCid: operatorQuoteReceiver.allocationCid,
            registrarMintCid: registrarMint.allocationCid,
          },
        },
      }),
    );
    // One settlement factory per admin: base and quote under their instrument
    // admins (collapsed to one for a single-admin pool), LP under the registrar.
    const { batchesByAdmin, disclosure } = await discoverBatchesByAdmin(
      this.registry,
      settlementPreview,
    );

    return retryOnContention(() =>
      this.ledger.submit({
        actAs: [this.operatorParty, pool.lpRegistrar],
        commandId: `lp-add-settle:${flowKey}`,
        disclosure,
        command: {
          kind: "exercise",
          templateId: "CantonDex.Dex.PoolLiquidityRules:PoolLiquidityRules",
          contractId: liquidityRulesCid,
          choice: "PoolLiquidityRules_SettleAddLiquidity",
          argument: {
            ...preparation,
            // Allocation factories for the pre-created receiver/mint cids;
            // retained shape, unused while the staging cids below are present.
            baseFactoryCid: operatorBaseReceiver.factoryCid,
            quoteFactoryCid: operatorQuoteReceiver.factoryCid,
            lpFactoryCid: registrarMint.factoryCid,
            requestedAt: input.requestedAt,
            batchesByAdmin,
            allocationContextByAdmin: [],
            operatorBaseReceiverCid: operatorBaseReceiver.allocationCid,
            operatorQuoteReceiverCid: operatorQuoteReceiver.allocationCid,
            registrarMintCid: registrarMint.allocationCid,
          },
        },
      }),
    );
  }

  /** Derive the current redemption plan from reserves and slices. */
  private deriveRemovePlan(
    pool: Pool,
    lpTokensToRedeem: Decimal,
    knownTotalLpSupply: Decimal,
  ): RemovePlan {
    const share = dec.divFloor(
      dec.parseDecimal(lpTokensToRedeem),
      dec.parseDecimal(knownTotalLpSupply),
    );
    const baseOut = dec.mulFloor(dec.parseDecimal(pool.reserves.baseAmount), share);
    const quoteOut = dec.mulFloor(dec.parseDecimal(pool.reserves.quoteAmount), share);
    const side = (slices: PoolSlice[], target: bigint): RemoveSidePlan => {
      const sliceCids: ContractId<"PoolSlice">[] = [];
      const outs: Decimal[] = [];
      let remaining = target;
      for (const s of slices) {
        if (remaining <= 0n) break;
        const amt = dec.parseDecimal(s.amount);
        sliceCids.push(s.contractId);
        if (remaining >= amt) {
          outs.push(s.amount);
          remaining -= amt;
        } else {
          outs.push(dec.formatDecimal(remaining));
          remaining = 0n;
        }
      }
      if (remaining > 0n) {
        throw new Error("pool slices cannot cover the redemption");
      }
      return { sliceCids, outs };
    };
    return { base: side(pool.baseSlices, baseOut), quote: side(pool.quoteSlices, quoteOut) };
  }

  /** Create the wallet-facing request for a DvP remove. */
  async requestRemoveLiquidity(
    input: PoolRequestRemoveLiquidityInput,
  ): Promise<PoolRequestRemoveLiquidityResult> {
    const { pool, liquidityRulesCid } = await this.fetchLiquidityPool(input.poolCid);
    const plan = this.deriveRemovePlan(pool, input.lpTokensToRedeem, pool.totalLpSupply);
    const requestCid = await retryOnContention(() =>
      this.ledger.submit<ContractId<"LiquidityAllocationRequest">>({
        actAs: [this.operatorParty],
        commandId: `lp-remove-req:${input.poolCid}:${input.requestedAt}`,
        command: {
          kind: "exercise",
          templateId: "CantonDex.Dex.PoolLiquidityRules:PoolLiquidityRules",
          contractId: liquidityRulesCid,
          choice: "PoolLiquidityRules_RequestRemoveLiquidity",
          argument: {
            poolCid: input.poolCid,
            holder: input.holder,
            baseOuts: plan.base.outs,
            quoteOuts: plan.quote.outs,
            lpBurnAmount: input.lpTokensToRedeem,
            requestedAt: input.requestedAt,
            settleAt: input.settleAt ?? null,
          },
        },
      }),
    );
    const req = await this.fetchRequest(requestCid);
    return {
      requestCid,
      knownTotalLpSupply: pool.totalLpSupply,
      baseSliceCids: plan.base.sliceCids,
      quoteSliceCids: plan.quote.sliceCids,
      baseOuts: plan.base.outs,
      quoteOuts: plan.quote.outs,
      allocations: req.allocations,
      settlement: req.settlement,
    };
  }

  /** Settle a DvP remove. */
  async settleRemoveLiquidity(input: PoolSettleRemoveLiquidityInput): Promise<unknown> {
    const { pool, liquidityRulesCid } = await this.fetchLiquidityPool(input.poolCid);
    // Re-derive from current state; drift since /request aborts at settle.
    const plan = this.deriveRemovePlan(pool, input.lpTokensToRedeem, input.knownTotalLpSupply);
    const lpPolicyCid = await this.fetchLpAssetPolicy(pool);

    // Operator-discovery path (updateId-only wallet): recover the 3 created
    // allocation cids [base receipt, quote receipt, burn-sender] + acceptance.
    let { holderBaseReceiptCid, holderQuoteReceiptCid, holderBurnSenderCid, requestCid, acceptanceCid } = input;
    if (input.updateId) {
      const rec = await this.recoverDvpAllocations(input.updateId, this.operatorParty, 3);
      [holderBaseReceiptCid, holderQuoteReceiptCid, holderBurnSenderCid] = rec.allocationCids;
      acceptanceCid = rec.acceptanceCid ?? input.acceptanceCid ?? null;
      requestCid = null;
    }
    if (!holderBaseReceiptCid || !holderQuoteReceiptCid || !holderBurnSenderCid) {
      throw new Error(
        "settleRemoveLiquidity: supply the 3 allocation cids or an updateId to recover them",
      );
    }
    const flowKey = requestCid ?? acceptanceCid ?? input.updateId;
    if (!flowKey) {
      throw new Error("settleRemoveLiquidity: request, acceptance, or update id is required");
    }
    const preparation = {
      expectedPoolId: pool.poolId,
      poolCid: input.poolCid,
      poolStateCid: pool.poolStateCid,
      lpPolicyCid,
      requestCid: requestCid ?? null,
      acceptanceCid: acceptanceCid ?? null,
      holder: input.holder,
      lpTokensToRedeem: input.lpTokensToRedeem,
      knownTotalLpSupply: input.knownTotalLpSupply,
      minBaseOut: input.minBaseOut,
      minQuoteOut: input.minQuoteOut,
      baseSliceCids: plan.base.sliceCids,
      quoteSliceCids: plan.quote.sliceCids,
      holderBaseReceiptCid,
      holderQuoteReceiptCid,
      holderBurnSenderCid,
    };
    const allocationPlan = await retryOnContention(() =>
      this.ledger.submit<RemoveLiquidityAllocationPlan>({
        actAs: [this.operatorParty, pool.lpRegistrar],
        commandId: `lp-remove-preview-allocations:${flowKey}`,
        command: {
          kind: "exercise",
          templateId: "CantonDex.Dex.PoolLiquidityRules:PoolLiquidityRules",
          contractId: liquidityRulesCid,
          choice: "PoolLiquidityRules_PreviewRemoveAllocations",
          argument: { preparation, requestedAt: input.requestedAt },
        },
      }),
    );
    const registrarBurnReceiver = await this.createRegistryAllocation(
      pool.lpRegistrar,
      allocationPlan.lpBurnReceiver,
      `lp-remove-burn-receiver:${flowKey}`,
      [pool.lpRegistrar],
    );
    const settlementPreview = await retryOnContention(() =>
      this.ledger.submit<SettlementPreview>({
        actAs: [this.operatorParty, pool.lpRegistrar],
        commandId: `lp-remove-preview-settlement:${flowKey}`,
        command: {
          kind: "exercise",
          templateId: "CantonDex.Dex.PoolLiquidityRules:PoolLiquidityRules",
          contractId: liquidityRulesCid,
          choice: "PoolLiquidityRules_PreviewRemoveSettlement",
          argument: {
            preparation,
            registrarBurnReceiverCid: registrarBurnReceiver.allocationCid,
          },
        },
      }),
    );
    // One settlement factory per admin: base and quote deliveries under their
    // instrument admins (collapsed for a single-admin pool), LP burn under the
    // registrar.
    const { batchesByAdmin, disclosure } = await discoverBatchesByAdmin(
      this.registry,
      settlementPreview,
    );

    return retryOnContention(() =>
      this.ledger.submit({
        actAs: [this.operatorParty, pool.lpRegistrar],
        commandId: `lp-remove-settle:${flowKey}`,
        disclosure,
        command: {
          kind: "exercise",
          templateId: "CantonDex.Dex.PoolLiquidityRules:PoolLiquidityRules",
          contractId: liquidityRulesCid,
          choice: "PoolLiquidityRules_SettleRemoveLiquidity",
          argument: {
            ...preparation,
            // Allocation factory for the pre-created burn-receiver; retained
            // shape, unused while `registrarBurnReceiverCid` is present.
            lpFactoryCid: registrarBurnReceiver.factoryCid,
            requestedAt: input.requestedAt,
            batchesByAdmin,
            // Staged allocation cids are supplied, so the fallback authoring
            // context is unused; pass an empty GenMap.
            allocationContextByAdmin: [],
            registrarBurnReceiverCid: registrarBurnReceiver.allocationCid,
          },
        },
      }),
    );
  }

  private async fetchPool(cid: ContractId<"Pool">): Promise<Pool> {
    const pools = await this.listActive();
    const found = pools.find((p) => p.contractId === cid);
    if (!found) throw new Error(`Pool ${cid} not found`);
    return found;
  }

  private async fetchLpAssetPolicy(pool: Pool): Promise<ContractId<"LPTokenPolicy">> {
    const policies = await this.ledger.query<LPTokenPolicy>({
      templateId: "CantonDex.Lp.Policy:LPTokenPolicy",
      observingParty: this.operatorParty,
    });
    const candidates = policies.filter(
      (p) =>
        p.active &&
        p.lpInstrumentId.id === pool.lpInstrumentId.id &&
        p.lpInstrumentId.admin === pool.lpInstrumentId.admin,
    );
    const found =
      candidates.find((p) => p.totalSupply === pool.totalLpSupply) ?? candidates[0];
    if (!found) {
      throw new Error(
        `no active LPTokenPolicy for ${pool.lpInstrumentId.admin}:${pool.lpInstrumentId.id}`,
      );
    }
    return found.contractId;
  }
}
