// Pool flow (DEX-40/41).
//
// The on-chain pool is split into Pool (immutable config), PoolState
// (reserves/status/supply), PoolSlice (one committed allocation each) and
// PoolRules (one per venue, holding the operational choices). This service
// assembles those into the combined `Pool` view the HTTP/dApp layer
// consumes, and drives the PoolRules choices with the cids they need.

import type { ContractId, DisclosedContract } from "@canton-dex/registry-client";
import { RegistryClient } from "@canton-dex/registry-client";

import { LedgerSubmitter } from "../ledger/index.js";
import { retryOnContention } from "../ledger/submit-with-retry.js";
import { toFloat } from "../policy/index.js";
import type {
  Decimal,
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
} from "../types.js";

export interface PoolInitializeInput {
  poolCid: ContractId<"Pool">;
  recipient: Party;
  baseAmount: Decimal;
  quoteAmount: Decimal;
  baseHoldingCids: ContractId<"Holding">[];
  quoteHoldingCids: ContractId<"Holding">[];
  requestedAt: Time;
}

export interface PoolAddLiquidityInput extends PoolInitializeInput {
  knownTotalLpSupply: Decimal;
  minLpTokens: Decimal;
}

export interface PoolSwapInput {
  poolCid: ContractId<"Pool">;
  swapperAccount: V2Account;
  inputInstrumentId: string;
  inputAmount: Decimal;
  minOutputAmount: Decimal;
  swapperAllocationCid: ContractId<"Allocation">;
}

export interface PoolRemoveLiquidityInput {
  poolCid: ContractId<"Pool">;
  holder: Party;
  lpTokensToRedeem: Decimal;
  knownTotalLpSupply: Decimal;
  minBaseOut: Decimal;
  minQuoteOut: Decimal;
  boundaryBaseHoldingCids: ContractId<"Holding">[];
  boundaryQuoteHoldingCids: ContractId<"Holding">[];
  requestedAt: Time;
}

// Select the ordered prefix of slices whose cumulative amount covers
// `target` (the slice-local contention optimization: pass the rules
// choice only the slices it actually needs, head-first).
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

  /** The per-venue PoolRules cid for this operator. */
  private async rulesCid(): Promise<ContractId<"PoolRules">> {
    const rules = await this.ledger.query<PoolRulesContract>({
      templateId: "CantonDex.Dex.PoolRules:PoolRules",
      observingParty: this.operatorParty,
    });
    const found = rules.find((r) => r.operator === this.operatorParty);
    if (!found) throw new Error("no PoolRules contract for operator");
    return found.contractId;
  }

  /**
   * Assemble the combined `Pool` view by joining the split contracts by
   * poolId: config + state + its slices. Pools without an active state
   * (none seeded yet) are skipped.
   */
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
        // No operator-fee accrual on-chain (see PoolRules_Swap); the API
        // field is retained as null for wire-shape stability.
        accumulatedOperatorFees: null,
        publicReaders: state.publicReaders,
      });
    }
    return combined;
  }

  async initialize(input: PoolInitializeInput): Promise<{
    poolCid: ContractId<"Pool">;
    lpTokensMinted: Decimal;
  }> {
    const pool = await this.fetchPool(input.poolCid);
    const factories = await this.registry.getFactories(pool.admin);
    const ctx = await this.choiceContext(pool.admin);
    const lpPolicyCid = await this.fetchLpPolicy(pool);
    await retryOnContention(() =>
      this.ledger.submit({
        actAs: [this.operatorParty],
        commandId: `pool-init:${input.poolCid}`,
        disclosure: [...factories.disclosure, ...ctx.disclosure],
        command: {
          kind: "exercise",
          templateId: "CantonDex.Dex.PoolRules:PoolRules",
          contractId: pool.rulesCid,
          choice: "PoolRules_Initialize",
          argument: {
            expectedPoolId: pool.poolId,
            poolCid: input.poolCid,
            poolStateCid: pool.poolStateCid,
            recipient: input.recipient,
            baseFactoryCid: factories.allocationFactoryCid,
            quoteFactoryCid: factories.allocationFactoryCid,
            baseHoldingCids: input.baseHoldingCids,
            quoteHoldingCids: input.quoteHoldingCids,
            baseAmount: input.baseAmount,
            quoteAmount: input.quoteAmount,
            requestedAt: input.requestedAt,
            lpPolicyCid,
            extraArgs: ctx.extraArgs,
          },
        },
      }),
    );
    return { poolCid: input.poolCid, lpTokensMinted: "0.0" };
  }

  async addLiquidity(input: PoolAddLiquidityInput): Promise<unknown> {
    const pool = await this.fetchPool(input.poolCid);
    const factories = await this.registry.getFactories(pool.admin);
    const ctx = await this.choiceContext(pool.admin);
    const lpPolicyCid = await this.fetchLpPolicy(pool);
    return retryOnContention(() =>
      this.ledger.submit({
        actAs: [this.operatorParty],
        commandId: `pool-add:${input.poolCid}:${input.requestedAt}`,
        disclosure: [...factories.disclosure, ...ctx.disclosure],
        command: {
          kind: "exercise",
          templateId: "CantonDex.Dex.PoolRules:PoolRules",
          contractId: pool.rulesCid,
          choice: "PoolRules_AddLiquidity",
          argument: {
            expectedPoolId: pool.poolId,
            poolCid: input.poolCid,
            poolStateCid: pool.poolStateCid,
            recipient: input.recipient,
            baseFactoryCid: factories.allocationFactoryCid,
            quoteFactoryCid: factories.allocationFactoryCid,
            baseHoldingCids: input.baseHoldingCids,
            quoteHoldingCids: input.quoteHoldingCids,
            baseAmount: input.baseAmount,
            quoteAmount: input.quoteAmount,
            minLpTokens: input.minLpTokens,
            knownTotalLpSupply: input.knownTotalLpSupply,
            requestedAt: input.requestedAt,
            lpPolicyCid,
            extraArgs: ctx.extraArgs,
          },
        },
      }),
    );
  }

  /**
   * Off-chain quote computation. Mirrors the on-chain constant-product
   * formula. The on-chain PoolRules_Swap re-validates against
   * `minOutputAmount`, so the operator's quote is advisory not authoritative.
   */
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
    // Pool grows its head input slice; source output across the prefix
    // that covers the quoted amountOut.
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

  /**
   * PoolRules_RemoveLiquidity. Slice-local: the operator passes only the
   * head-first prefix of slices per side that covers the redemption; the
   * choice cancels the fully-consumed ones and re-allocates the boundary.
   */
  async removeLiquidity(input: PoolRemoveLiquidityInput): Promise<unknown> {
    const pool = await this.fetchPool(input.poolCid);
    const factories = await this.registry.getFactories(pool.admin);
    const ctx = await this.choiceContext(pool.admin);
    const lpPolicyCid = await this.fetchLpPolicy(pool);
    const share = toFloat(input.lpTokensToRedeem) / toFloat(input.knownTotalLpSupply);
    const baseOut = toFloat(pool.reserves.baseAmount) * share;
    const quoteOut = toFloat(pool.reserves.quoteAmount) * share;
    const baseSliceCids = selectCoveringPrefix(pool.baseSlices, baseOut);
    const quoteSliceCids = selectCoveringPrefix(pool.quoteSlices, quoteOut);
    return retryOnContention(() =>
      this.ledger.submit({
        actAs: [this.operatorParty],
        commandId: `pool-remove:${input.poolCid}:${input.requestedAt}`,
        disclosure: [...factories.disclosure, ...ctx.disclosure],
        command: {
          kind: "exercise",
          templateId: "CantonDex.Dex.PoolRules:PoolRules",
          contractId: pool.rulesCid,
          choice: "PoolRules_RemoveLiquidity",
          argument: {
            expectedPoolId: pool.poolId,
            poolCid: input.poolCid,
            poolStateCid: pool.poolStateCid,
            holder: input.holder,
            lpTokensToRedeem: input.lpTokensToRedeem,
            knownTotalLpSupply: input.knownTotalLpSupply,
            minBaseOut: input.minBaseOut,
            minQuoteOut: input.minQuoteOut,
            baseSliceCids,
            quoteSliceCids,
            baseFactoryCid: factories.allocationFactoryCid,
            quoteFactoryCid: factories.allocationFactoryCid,
            boundaryBaseHoldingCids: input.boundaryBaseHoldingCids,
            boundaryQuoteHoldingCids: input.boundaryQuoteHoldingCids,
            requestedAt: input.requestedAt,
            lpPolicyCid,
            extraArgs: ctx.extraArgs,
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

  private async fetchLpPolicy(pool: Pool): Promise<ContractId<"LPTokenPolicy">> {
    const policies = await this.ledger.query<LPTokenPolicy>({
      templateId: "CantonDex.Dex.LPToken:LPTokenPolicy",
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
