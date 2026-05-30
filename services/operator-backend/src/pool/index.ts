// Pool orchestration and read models.

import type { ContractId, DisclosedContract } from "@canton-dex/registry-client";
import { RegistryClient } from "@canton-dex/registry-client";

import { LedgerSubmitter } from "../ledger/index.js";
import { retryOnContention } from "../ledger/submit-with-retry.js";
import { toFloat } from "../policy/index.js";
import * as dec from "./decimal.js";
import type {
  Decimal,
  LiquidityAllocationRequestContract,
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

export interface PoolSwapInput {
  poolCid: ContractId<"Pool">;
  swapperAccount: V2Account;
  inputInstrumentId: string;
  inputAmount: Decimal;
  minOutputAmount: Decimal;
  swapperAllocationCid: ContractId<"Allocation">;
}

// === DvP liquidity ==========================================

export interface PoolRequestAddLiquidityInput {
  poolCid: ContractId<"Pool">;
  recipient: Party;
  baseAmount: Decimal;
  quoteAmount: Decimal;
  requestedAt: Time;
  settleAt?: Time | null;
}

export interface PoolRequestAddLiquidityResult {
  requestCid: ContractId<"LiquidityAllocationRequest">;
  /** The LP-token amount quoted off-ledger. */
  lpAmount: Decimal;
  // Echoed so the later settle uses the same supply snapshot.
  knownTotalLpSupply: Decimal;
  baseAmount: Decimal;
  quoteAmount: Decimal;
  // The on-ledger specs the wallet authors, in canonical order.
  allocations: V2AllocationSpecification[];
  settlement: V2SettlementInfo;
  // Distinct factories for pool-admin vs lpRegistrar allocations.
  depositFactoryCid: ContractId<"AllocationFactory">;
  lpFactoryCid: ContractId<"AllocationFactory">;
}

export interface PoolSettleAddLiquidityInput {
  poolCid: ContractId<"Pool">;
  requestCid: ContractId<"LiquidityAllocationRequest">;
  recipient: Party;
  lpBaseDepositCid: ContractId<"Allocation">;
  lpQuoteDepositCid: ContractId<"Allocation">;
  lpReceiptCid: ContractId<"Allocation">;
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
  depositFactoryCid: ContractId<"AllocationFactory">;
  lpFactoryCid: ContractId<"AllocationFactory">;
}

export interface PoolSettleRemoveLiquidityInput {
  poolCid: ContractId<"Pool">;
  requestCid: ContractId<"LiquidityAllocationRequest">;
  holder: Party;
  lpTokensToRedeem: Decimal;
  knownTotalLpSupply: Decimal;
  minBaseOut: Decimal;
  minQuoteOut: Decimal;
  // The backend re-derives the slice prefix from current state.
  holderBaseReceiptCid: ContractId<"Allocation">;
  holderQuoteReceiptCid: ContractId<"Allocation">;
  holderBurnSenderCid: ContractId<"Allocation">;
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

// Select the head-first slice prefix that covers `target`.
function selectCoveringPrefix(slices: PoolSlice[], target: number): ContractId<"PoolSlice">[] {
  const out: ContractId<"PoolSlice">[] = [];
  let acc = 0;
  for (const s of slices) {
    out.push(s.contractId);
    acc += toFloat(s.amount);
    if (acc >= target) break;
  }
  return out;
}

export class PoolService {
  constructor(
    private readonly ledger: LedgerSubmitter,
    private readonly registry: RegistryClient,
    private readonly operatorParty: Party,
  ) {}

  private async choiceContext(admin: Party): Promise<{
    extraArgs: { context: { values: Record<string, unknown> }; meta: { values: Record<string, unknown> } };
    disclosure: DisclosedContract[];
  }> {
    const ctx = await this.registry.getChoiceContext(admin);
    return {
      extraArgs: { context: ctx.context, meta: { values: {} } },
      disclosure: ctx.disclosure,
    };
  }

  private async rulesCid(): Promise<ContractId<"PoolRules">> {
    const rules = await this.ledger.query<PoolRulesContract>({
      templateId: "CantonDex.Dex.PoolRules:PoolRules",
      observingParty: this.operatorParty,
    });
    const found = rules.find((r) => r.operator === this.operatorParty);
    if (!found) throw new Error("no PoolRules contract for operator");
    return found.contractId;
  }

  private async lpDvpRules(): Promise<PoolLiquidityRulesContract[]> {
    return this.ledger.query<PoolLiquidityRulesContract>({
      templateId: "CantonDex.Dex.PoolLiquidityRules:PoolLiquidityRules",
      observingParty: this.operatorParty,
    });
  }

  async dvpRulesCid(lpRegistrar: Party): Promise<ContractId<"PoolLiquidityRules">> {
    const all = await this.lpDvpRules();
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
    const dvpRules = await this.lpDvpRules();
    const dvpCidFor = (lpRegistrar: Party): ContractId<"PoolLiquidityRules"> | null =>
      dvpRules.find(
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
      const status = state.status as string;
      if (status === "PS_Paused" || status === "Paused") continue;
      combined.push({
        contractId: cfg.contractId,
        poolId: cfg.poolId,
        poolStateCid: state.contractId,
        rulesCid: rulesCid ?? ("" as ContractId<"PoolRules">),
        lpDvpRulesCid: dvpCidFor(cfg.lpRegistrar),
        operator: cfg.operator,
        lpRegistrar: cfg.lpRegistrar,
        admin: cfg.admin,
        baseInstrumentId: cfg.baseInstrumentId,
        quoteInstrumentId: cfg.quoteInstrumentId,
        lpInstrumentId: cfg.lpInstrumentId,
        feeBps: cfg.feeBps,
        status: state.status,
        reserves: state.reserves,
        totalLpSupply: state.totalLpSupply,
        baseSlices: poolSlices.filter((s) => s.side === "BaseSide").map(toSlice),
        quoteSlices: poolSlices.filter((s) => s.side === "QuoteSide").map(toSlice),
        operatorFeeBps: cfg.operatorFeeBps,
        // Retained for wire-shape stability.
        accumulatedOperatorFees: null,
        publicReaders: state.publicReaders,
      });
    }
    return combined;
  }

  /** Off-chain quote computation for the constant-product pool. */
  computeQuote(
    pool: Pool,
    inputInstrumentId: string,
    inputAmount: Decimal,
  ): Decimal {
    const [reserveIn, reserveOut] =
      inputInstrumentId === pool.baseInstrumentId
        ? [pool.reserves.baseAmount, pool.reserves.quoteAmount]
        : [pool.reserves.quoteAmount, pool.reserves.baseAmount];
    const feeMul = (10000 - pool.feeBps) / 10000;
    const dx = toFloat(inputAmount) * feeMul;
    const out = (toFloat(reserveOut) * dx) / (toFloat(reserveIn) + dx);
    return out.toFixed(10);
  }

  async swap(input: PoolSwapInput): Promise<unknown> {
    const pool = await this.fetchPool(input.poolCid);
    const factories = await this.registry.getFactories(pool.admin);
    const ctx = await this.choiceContext(pool.admin);
    const inputIsBase = input.inputInstrumentId === pool.baseInstrumentId;
    const inputSlices = inputIsBase ? pool.baseSlices : pool.quoteSlices;
    const outputSlices = inputIsBase ? pool.quoteSlices : pool.baseSlices;
    const headInput = inputSlices[0];
    if (!headInput) throw new Error("pool has no input-side slice");
    const amountOut = toFloat(this.computeQuote(pool, input.inputInstrumentId, input.inputAmount));
    const outputSliceCids = selectCoveringPrefix(outputSlices, amountOut);
    return retryOnContention(() =>
      this.ledger.submit({
        actAs: [this.operatorParty],
        commandId: `pool-swap:${input.poolCid}:${Date.now()}`,
        disclosure: [...factories.disclosure, ...ctx.disclosure],
        command: {
          kind: "exercise",
          templateId: "CantonDex.Dex.PoolRules:PoolRules",
          contractId: pool.rulesCid,
          choice: "PoolRules_Swap",
          argument: {
            expectedPoolId: pool.poolId,
            poolCid: input.poolCid,
            poolStateCid: pool.poolStateCid,
            swapperAccount: input.swapperAccount,
            inputInstrumentId: input.inputInstrumentId,
            inputAmount: input.inputAmount,
            minOutputAmount: input.minOutputAmount,
            swapperAllocationCid: input.swapperAllocationCid,
            inputSliceCid: headInput.contractId,
            outputSliceCids,
            factoryCid: factories.settlementFactoryCid,
            extraArgs: ctx.extraArgs,
          },
        },
      }),
    );
  }

  // === DvP liquidity ==========================================

  private requireDvpRules(pool: Pool): ContractId<"PoolLiquidityRules"> {
    if (!pool.lpDvpRulesCid) {
      throw new Error(`pool ${pool.poolId} has no PoolLiquidityRules; run admin bootstrap`);
    }
    return pool.lpDvpRulesCid;
  }

  private async fetchDvpPool(
    cid: ContractId<"Pool">,
  ): Promise<{ pool: Pool; dvpRulesCid: ContractId<"PoolLiquidityRules"> }> {
    const pool = await this.fetchPool(cid);
    return { pool, dvpRulesCid: this.requireDvpRules(pool) };
  }

  private async loadLiquidityFactories(pool: Pool) {
    const [depositFactories, lpFactories] = await Promise.all([
      this.registry.getFactories(pool.admin),
      this.registry.getFactories(pool.lpRegistrar),
    ]);
    return { depositFactories, lpFactories };
  }

  private async loadDvpSurface(pool: Pool) {
    const [{ depositFactories, lpFactories }, depositContext, lpContext] =
      await Promise.all([
        this.loadLiquidityFactories(pool),
        this.choiceContext(pool.admin),
        this.choiceContext(pool.lpRegistrar),
      ]);
    return { depositFactories, lpFactories, depositContext, lpContext };
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

  /** LP quote in fixed-point decimal. */
  private lpQuote(pool: Pool, baseAmount: Decimal, quoteAmount: Decimal): Decimal {
    const b = dec.parseDecimal(baseAmount);
    const q = dec.parseDecimal(quoteAmount);
    const supply = dec.parseDecimal(pool.totalLpSupply);
    let lp: bigint;
    if (supply === 0n) {
      lp = dec.sqrt(dec.mul(b, q));
    } else {
      const rb = dec.parseDecimal(pool.reserves.baseAmount);
      const rq = dec.parseDecimal(pool.reserves.quoteAmount);
      lp = dec.min(dec.div(dec.mul(b, supply), rb), dec.div(dec.mul(q, supply), rq));
    }
    return dec.formatDecimal(lp);
  }

  /** Create the wallet-facing request for a DvP add. */
  async requestAddLiquidity(
    input: PoolRequestAddLiquidityInput,
  ): Promise<PoolRequestAddLiquidityResult> {
    const { pool, dvpRulesCid } = await this.fetchDvpPool(input.poolCid);
    const lpAmount = this.lpQuote(pool, input.baseAmount, input.quoteAmount);
    const requestCid = await retryOnContention(() =>
      this.ledger.submit<ContractId<"LiquidityAllocationRequest">>({
        actAs: [this.operatorParty],
        commandId: `lp-add-req:${input.poolCid}:${input.requestedAt}`,
        command: {
          kind: "exercise",
          templateId: "CantonDex.Dex.PoolLiquidityRules:PoolLiquidityRules",
          contractId: dvpRulesCid,
          choice: "PoolLiquidityRules_RequestAddLiquidity",
          argument: {
            poolCid: input.poolCid,
            recipient: input.recipient,
            baseAmount: input.baseAmount,
            quoteAmount: input.quoteAmount,
            lpAmount,
            requestedAt: input.requestedAt,
            settleAt: input.settleAt ?? null,
          },
        },
      }),
    );
    const req = await this.fetchRequest(requestCid);
    const { depositFactories, lpFactories } = await this.loadLiquidityFactories(pool);
    return {
      requestCid,
      lpAmount,
      knownTotalLpSupply: pool.totalLpSupply,
      baseAmount: input.baseAmount,
      quoteAmount: input.quoteAmount,
      allocations: req.allocations,
      settlement: req.settlement,
      depositFactoryCid: depositFactories.allocationFactoryCid,
      lpFactoryCid: lpFactories.allocationFactoryCid,
    };
  }

  /** Settle a DvP add. */
  async settleAddLiquidity(input: PoolSettleAddLiquidityInput): Promise<unknown> {
    const { pool, dvpRulesCid } = await this.fetchDvpPool(input.poolCid);
    const lpPolicyCid = await this.fetchLpAssetPolicy(pool);
    const { depositFactories, lpFactories, depositContext, lpContext } =
      await this.loadDvpSurface(pool);
    // Split-admin DvP: the base/quote batch settles under pool.admin and the
    // LP-mint batch under pool.lpRegistrar, so each carries its own registry
    // choice context (DEX-73). For the self-registry both contexts are empty.
    return retryOnContention(() =>
      this.ledger.submit({
        actAs: [this.operatorParty, pool.lpRegistrar],
        commandId: `lp-add-settle:${input.requestCid}`,
        disclosure: [
          ...depositFactories.disclosure,
          ...lpFactories.disclosure,
          ...depositContext.disclosure,
          ...lpContext.disclosure,
        ],
        command: {
          kind: "exercise",
          templateId: "CantonDex.Dex.PoolLiquidityRules:PoolLiquidityRules",
          contractId: dvpRulesCid,
          choice: "PoolLiquidityRules_SettleAddLiquidity",
          argument: {
            expectedPoolId: pool.poolId,
            poolCid: input.poolCid,
            poolStateCid: pool.poolStateCid,
            lpPolicyCid,
            requestCid: input.requestCid,
            recipient: input.recipient,
            lpBaseDepositCid: input.lpBaseDepositCid,
            lpQuoteDepositCid: input.lpQuoteDepositCid,
            lpReceiptCid: input.lpReceiptCid,
            baseFactoryCid: depositFactories.allocationFactoryCid,
            quoteFactoryCid: depositFactories.allocationFactoryCid,
            lpFactoryCid: lpFactories.allocationFactoryCid,
            baseQuoteSettleCid: depositFactories.settlementFactoryCid,
            lpSettleCid: lpFactories.settlementFactoryCid,
            baseAmount: input.baseAmount,
            quoteAmount: input.quoteAmount,
            minLpTokens: input.minLpTokens,
            knownTotalLpSupply: input.knownTotalLpSupply,
            requestedAt: input.requestedAt,
            poolAdminExtraArgs: depositContext.extraArgs,
            lpRegistrarExtraArgs: lpContext.extraArgs,
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
    const share = dec.div(dec.parseDecimal(lpTokensToRedeem), dec.parseDecimal(knownTotalLpSupply));
    const baseOut = dec.mul(dec.parseDecimal(pool.reserves.baseAmount), share);
    const quoteOut = dec.mul(dec.parseDecimal(pool.reserves.quoteAmount), share);
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
    const { pool, dvpRulesCid } = await this.fetchDvpPool(input.poolCid);
    const plan = this.deriveRemovePlan(pool, input.lpTokensToRedeem, pool.totalLpSupply);
    const requestCid = await retryOnContention(() =>
      this.ledger.submit<ContractId<"LiquidityAllocationRequest">>({
        actAs: [this.operatorParty],
        commandId: `lp-remove-req:${input.poolCid}:${input.requestedAt}`,
        command: {
          kind: "exercise",
          templateId: "CantonDex.Dex.PoolLiquidityRules:PoolLiquidityRules",
          contractId: dvpRulesCid,
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
    const { depositFactories, lpFactories } = await this.loadLiquidityFactories(pool);
    return {
      requestCid,
      knownTotalLpSupply: pool.totalLpSupply,
      baseSliceCids: plan.base.sliceCids,
      quoteSliceCids: plan.quote.sliceCids,
      baseOuts: plan.base.outs,
      quoteOuts: plan.quote.outs,
      allocations: req.allocations,
      settlement: req.settlement,
      depositFactoryCid: depositFactories.allocationFactoryCid,
      lpFactoryCid: lpFactories.allocationFactoryCid,
    };
  }

  /** Settle a DvP remove. */
  async settleRemoveLiquidity(input: PoolSettleRemoveLiquidityInput): Promise<unknown> {
    const { pool, dvpRulesCid } = await this.fetchDvpPool(input.poolCid);
    // Re-derive from current state; drift since /request aborts at settle.
    const plan = this.deriveRemovePlan(pool, input.lpTokensToRedeem, input.knownTotalLpSupply);
    const lpPolicyCid = await this.fetchLpAssetPolicy(pool);
    const { depositFactories, lpFactories, depositContext, lpContext } =
      await this.loadDvpSurface(pool);
    // Split-admin DvP: base/quote batch under pool.admin, LP-burn batch under
    // pool.lpRegistrar — each carries its own registry choice context
    // (DEX-73). For the self-registry both contexts are empty.
    return retryOnContention(() =>
      this.ledger.submit({
        actAs: [this.operatorParty, pool.lpRegistrar],
        commandId: `lp-remove-settle:${input.requestCid}`,
        disclosure: [
          ...depositFactories.disclosure,
          ...lpFactories.disclosure,
          ...depositContext.disclosure,
          ...lpContext.disclosure,
        ],
        command: {
          kind: "exercise",
          templateId: "CantonDex.Dex.PoolLiquidityRules:PoolLiquidityRules",
          contractId: dvpRulesCid,
          choice: "PoolLiquidityRules_SettleRemoveLiquidity",
          argument: {
            expectedPoolId: pool.poolId,
            poolCid: input.poolCid,
            poolStateCid: pool.poolStateCid,
            lpPolicyCid,
            requestCid: input.requestCid,
            holder: input.holder,
            lpTokensToRedeem: input.lpTokensToRedeem,
            knownTotalLpSupply: input.knownTotalLpSupply,
            minBaseOut: input.minBaseOut,
            minQuoteOut: input.minQuoteOut,
            baseSliceCids: plan.base.sliceCids,
            quoteSliceCids: plan.quote.sliceCids,
            holderBaseReceiptCid: input.holderBaseReceiptCid,
            holderQuoteReceiptCid: input.holderQuoteReceiptCid,
            holderBurnSenderCid: input.holderBurnSenderCid,
            baseFactoryCid: depositFactories.allocationFactoryCid,
            quoteFactoryCid: depositFactories.allocationFactoryCid,
            lpFactoryCid: lpFactories.allocationFactoryCid,
            baseQuoteSettleCid: depositFactories.settlementFactoryCid,
            lpSettleCid: lpFactories.settlementFactoryCid,
            requestedAt: input.requestedAt,
            poolAdminExtraArgs: depositContext.extraArgs,
            lpRegistrarExtraArgs: lpContext.extraArgs,
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
    const found = policies.find(
      (p) =>
        p.active &&
        p.lpInstrumentId.id === pool.lpInstrumentId.id &&
        p.lpInstrumentId.admin === pool.lpInstrumentId.admin,
    );
    if (!found) {
      throw new Error(
        `no active LPTokenPolicy for ${pool.lpInstrumentId.admin}:${pool.lpInstrumentId.id}`,
      );
    }
    return found.contractId;
  }
}
