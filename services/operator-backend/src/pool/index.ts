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
import * as dec from "./decimal.js";
import type {
  Decimal,
  LiquidityAllocationRequestContract,
  LpDvpRulesContract,
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

export interface PoolInitializeInput {
  poolCid: ContractId<"Pool">;
  recipient: Party;
  baseAmount: Decimal;
  quoteAmount: Decimal;
  baseHoldingCids: ContractId<"Holding">[];
  quoteHoldingCids: ContractId<"Holding">[];
  requestedAt: Time;
}

export interface PoolSwapInput {
  poolCid: ContractId<"Pool">;
  swapperAccount: V2Account;
  inputInstrumentId: string;
  inputAmount: Decimal;
  minOutputAmount: Decimal;
  swapperAllocationCid: ContractId<"Allocation">;
}

// === DvP liquidity (DEX-53) — two-call: request then settle ===========

export interface PoolRequestAddLiquidityInput {
  poolCid: ContractId<"Pool">;
  recipient: Party;
  baseAmount: Decimal;
  quoteAmount: Decimal;
  requestedAt: Time;
  /** Optional quote deadline carried on the request (the authoritative deadline). */
  settleAt?: Time | null;
}

export interface PoolRequestAddLiquidityResult {
  requestCid: ContractId<"LiquidityAllocationRequest">;
  /** The LP-token amount the operator quoted (floored; the settle bounds it). */
  lpAmount: Decimal;
  // Echoed so the dApp's settle call is self-consistent: the settle
  // validates `knownTotalLpSupply == state.totalLpSupply`, so it must use
  // the supply the quote was computed against.
  knownTotalLpSupply: Decimal;
  baseAmount: Decimal;
  quoteAmount: Decimal;
  // The on-ledger specs (built by the choice) the wallet must author, in
  // canonical order [base deposit, quote deposit, LP receipt], plus the
  // settlement they settle under. The dApp wallet authors AllocationFactory
  // _Allocate from these and posts the resulting cids back to /settle.
  allocations: V2AllocationSpecification[];
  settlement: V2SettlementInfo;
  // Distinct factories the wallet must use: deposits + receipts under
  // pool.admin, the LP mint/burn under pool.lpRegistrar. Equal only in the
  // self-registry case; split-admin venues need both (3c review P2).
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
  // The caller passes only intent (how much LP to redeem). The backend
  // derives the slice prefix + per-slice out amounts from CURRENT reserves
  // and slices — slice selection is operator-internal, not the caller's job.
  lpTokensToRedeem: Decimal;
  requestedAt: Time;
  settleAt?: Time | null;
}

export interface PoolRequestRemoveLiquidityResult {
  requestCid: ContractId<"LiquidityAllocationRequest">;
  /** Echoed for a self-consistent settle. */
  knownTotalLpSupply: Decimal;
  // The derived plan the request was built against; the dApp wallet authors
  // its receipt legs against these per-slice amounts and the settle re-derives
  // (and aborts if reserves drifted, a documented fail-safe).
  baseSliceCids: ContractId<"PoolSlice">[];
  quoteSliceCids: ContractId<"PoolSlice">[];
  baseOuts: Decimal[];
  quoteOuts: Decimal[];
  // The on-ledger specs the holder authors [base receipt, quote receipt,
  // LP burn-sender] + the settlement, for the wallet (see add result).
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
  // No caller-supplied slice arrays: the backend re-derives the prefix from
  // current state (so a drift since /request aborts at SettleBatch).
  holderBaseReceiptCid: ContractId<"Allocation">;
  holderQuoteReceiptCid: ContractId<"Allocation">;
  holderBurnSenderCid: ContractId<"Allocation">;
  requestedAt: Time;
}

// The operator-derived redemption plan for one side: the ordered slice
// prefix that covers the redemption + the per-slice out amounts (full
// slices contribute their whole amount; the boundary slice the remainder).
export interface RemoveSidePlan {
  sliceCids: ContractId<"PoolSlice">[];
  outs: Decimal[];
}

export interface RemovePlan {
  base: RemoveSidePlan;
  quote: RemoveSidePlan;
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

  /** All co-controlled LpDvpRules visible to the operator, by lpRegistrar. */
  private async lpDvpRules(): Promise<LpDvpRulesContract[]> {
    return this.ledger.query<LpDvpRulesContract>({
      templateId: "CantonDex.Dex.LpDvpRules:LpDvpRules",
      observingParty: this.operatorParty,
    });
  }

  /** The LpDvpRules cid for this operator + the pool's lpRegistrar, if any. */
  async dvpRulesCid(lpRegistrar: Party): Promise<ContractId<"LpDvpRules">> {
    const all = await this.lpDvpRules();
    const found = all.find(
      (r) => r.operator === this.operatorParty && r.lpRegistrar === lpRegistrar,
    );
    if (!found) {
      throw new Error(`no LpDvpRules contract for operator + lpRegistrar=${lpRegistrar}`);
    }
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
    const dvpRules = await this.lpDvpRules();
    const dvpCidFor = (lpRegistrar: Party): ContractId<"LpDvpRules"> | null =>
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

  // === DvP liquidity (DEX-53) ==========================================

  private requireDvpRules(pool: Pool): ContractId<"LpDvpRules"> {
    if (!pool.lpDvpRulesCid) {
      throw new Error(`pool ${pool.poolId} has no LpDvpRules; run admin bootstrap`);
    }
    return pool.lpDvpRulesCid;
  }

  private async fetchDvpPool(
    cid: ContractId<"Pool">,
  ): Promise<{ pool: Pool; dvpRulesCid: ContractId<"LpDvpRules"> }> {
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

  /**
   * Read back the just-created LiquidityAllocationRequest so /request can
   * hand the dApp the exact on-ledger specs (built by the choice) the
   * wallet must author.
   */
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
   * LP-token quote in EXACT fixed-point decimal (matches Daml's `Decimal`
   * mul/div round-half-even; sqrt floored). Binary floats lose precision
   * once reserves exceed ~15 significant digits, which would make the quote
   * miss the on-ledger dust bound for large pools — so we work in scaled
   * BigInt. First funding: sqrt(base*quote) (floored, conservative). Else:
   * min((base*supply)/reserveBase, (quote*supply)/reserveQuote), the same
   * sequence the Daml settle computes for `fairLp`.
   */
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

  /**
   * Operator half of the two-call DvP add: create the
   * LiquidityAllocationRequest the LP accepts. The wallet then authors the
   * deposit + receipt allocations from the request's specs and the dApp
   * calls settleAddLiquidity with their cids.
   */
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
          templateId: "CantonDex.Dex.LpDvpRules:LpDvpRules",
          contractId: dvpRulesCid,
          choice: "LpDvpRules_RequestAddLiquidity",
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

  /**
   * Operator + lpRegistrar settle the accepted add: the LP's deposit +
   * receipt allocation cids (authored by the wallet) plus both registries'
   * factories. Signed [operator, lpRegistrar] because the DvP choice
   * rewrites the operator-signed pool state AND drives the
   * lpRegistrar-controlled mint.
   */
  async settleAddLiquidity(input: PoolSettleAddLiquidityInput): Promise<unknown> {
    const { pool, dvpRulesCid } = await this.fetchDvpPool(input.poolCid);
    const lpPolicyCid = await this.fetchLpPolicy(pool);
    const { depositFactories, lpFactories, depositContext, lpContext } =
      await this.loadDvpSurface(pool);
    // Point A: the Daml choice accepts a single `extraArgs`, threaded to
    // both the base/quote and the LP factory/settle exercises. We use only
    // lpContext.disclosure here and pass depositContext.extraArgs — correct for the
    // self-registry (empty context). An external context-requiring LP
    // registry would need per-admin extraArgs at both layers (deferred).
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
          templateId: "CantonDex.Dex.LpDvpRules:LpDvpRules",
          contractId: dvpRulesCid,
          choice: "LpDvpRules_SettleAddLiquidity",
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
            extraArgs: depositContext.extraArgs,
          },
        },
      }),
    );
  }

  /**
   * Derive the redemption plan from CURRENT reserves + slices, in exact
   * decimal so the per-slice out amounts match the Daml settle to the last
   * digit. Mirrors Daml: share = redeem / supply; out = reserve * share;
   * then walk the head-first slice prefix — full slices contribute their
   * whole (verbatim) amount, the boundary slice the remainder.
   */
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
          outs.push(s.amount); // full slice: verbatim ledger string
          remaining -= amt;
        } else {
          outs.push(dec.formatDecimal(remaining)); // boundary: the remainder
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

  /** Operator half of the two-call DvP remove: create the request. */
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
          templateId: "CantonDex.Dex.LpDvpRules:LpDvpRules",
          contractId: dvpRulesCid,
          choice: "LpDvpRules_RequestRemoveLiquidity",
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

  /** Operator + lpRegistrar settle the accepted remove. */
  async settleRemoveLiquidity(input: PoolSettleRemoveLiquidityInput): Promise<unknown> {
    const { pool, dvpRulesCid } = await this.fetchDvpPool(input.poolCid);
    // Re-derive the slice prefix from CURRENT state. If reserves/slices
    // drifted since /request, the recomputed delivery legs won't match the
    // wallet's request-time receipt legs and the SettleBatch aborts.
    const plan = this.deriveRemovePlan(pool, input.lpTokensToRedeem, input.knownTotalLpSupply);
    const lpPolicyCid = await this.fetchLpPolicy(pool);
    const { depositFactories, lpFactories, depositContext, lpContext } =
      await this.loadDvpSurface(pool);
    // Point A: the Daml choice accepts a single `extraArgs`, threaded to
    // both the base/quote and the LP factory/settle exercises. We use only
    // lpContext.disclosure here and pass depositContext.extraArgs — correct for the
    // self-registry (empty context). An external context-requiring LP
    // registry would need per-admin extraArgs at both layers (deferred).
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
          templateId: "CantonDex.Dex.LpDvpRules:LpDvpRules",
          contractId: dvpRulesCid,
          choice: "LpDvpRules_SettleRemoveLiquidity",
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
            extraArgs: depositContext.extraArgs,
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
