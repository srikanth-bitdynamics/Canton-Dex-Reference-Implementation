// Pool orchestration and read models.

import { createHash } from "node:crypto";

import type { ContractId, DisclosedContract } from "@canton-dex/registry-client";
import { RegistryClient } from "@canton-dex/registry-client";

import { LedgerSubmitter } from "../ledger/index.js";
import { recoverCreatedAllocations } from "../ledger/recover.js";
import { retryOnContention } from "../ledger/submit-with-retry.js";
import * as dec from "./decimal.js";
import type {
  Decimal,
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

interface RegistryExtraArgs {
  context: { values: Record<string, unknown> };
  meta: { values: Record<string, unknown> };
}

export interface PoolSwapInput {
  poolCid: ContractId<"Pool">;
  swapperAccount: V2Account;
  inputInstrumentId: string;
  inputAmount: Decimal;
  minOutputAmount: Decimal;
  // Explicit created cid (dApp-return path). Omitted on the operator-discovery
  // path, where `updateId` is supplied and the operator recovers it.
  swapperAllocationCid?: ContractId<"Allocation">;
  // Operator-discovery path (updateId-only wallet, e.g. PartyLayer): the
  // swapper's single input allocation is recovered from the tree.
  updateId?: string | null;
  // Optional client-supplied idempotency key. When present the swap
  // commandId is derived from it; otherwise the commandId is derived
  // deterministically from the request content (DEX-107).
  idempotencyKey?: string;
}

// Short stable hash of request content for deterministic, replay-safe
// commandIds (DEX-107). Same content => same commandId, so a retried
// request collapses onto the cached submission instead of re-firing.
function contentHash(parts: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 16);
}

// The wallet-facing request for a swap: the operator builds (in Daml) the
// single prefunded/iterated input allocation the swapper must author before
// the swap can settle. Creates nothing on-ledger — PoolRules_Swap consumes the
// resulting allocation cid directly — so there is no requestCid to thread.
export interface PoolRequestSwapInput {
  poolCid: ContractId<"Pool">;
  swapper: Party;
  inputInstrumentId: string;
  inputAmount: Decimal;
}

export interface PoolRequestSwapResult {
  // The on-ledger spec the wallet authors via AllocationFactory_Allocate.
  allocationSpec: V2AllocationSpecification;
  settlement: V2SettlementInfo;
  // The pool-admin allocation factory the swapper allocates under.
  factoryCid: ContractId<"AllocationFactory">;
  allocationFactoryExtraArgs: RegistryExtraArgs;
  allocationFactoryDisclosure: DisclosedContract[];
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
  depositFactoryExtraArgs: RegistryExtraArgs;
  lpFactoryExtraArgs: RegistryExtraArgs;
  depositFactoryDisclosure: DisclosedContract[];
  lpFactoryDisclosure: DisclosedContract[];
}

export interface PoolSettleAddLiquidityInput {
  poolCid: ContractId<"Pool">;
  // The settle binds to EITHER the live request (legacy direct-allocation
  // flow) OR the acceptance evidence (canonical accept flow, where accept
  // consumed the request). Exactly one is supplied.
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
  depositFactoryCid: ContractId<"AllocationFactory">;
  lpFactoryCid: ContractId<"AllocationFactory">;
  depositFactoryExtraArgs: RegistryExtraArgs;
  lpFactoryExtraArgs: RegistryExtraArgs;
  depositFactoryDisclosure: DisclosedContract[];
  lpFactoryDisclosure: DisclosedContract[];
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
// on-ledger reserve accounting (DEX-106).
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
      const status = state.status as string;
      if (status === "PS_Paused" || status === "Paused") continue;
      combined.push({
        contractId: cfg.contractId,
        poolId: cfg.poolId,
        poolStateCid: state.contractId,
        rulesCid: rulesCid ?? ("" as ContractId<"PoolRules">),
        poolLiquidityRulesCid: liquidityRulesCidFor(cfg.lpRegistrar),
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
        // Retained for wire-shape stability.
        accumulatedOperatorFees: null,
        publicReaders: state.publicReaders,
      });
    }
    return combined;
  }

  /**
   * Off-chain quote computation for the constant-product pool, in exact
   * fixed-point decimal (10dp, round-half-even) so it agrees with the
   * on-ledger PoolRules_Swap computation to the last digit (DEX-106). This
   * is advisory; the on-chain choice re-validates.
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
    const rIn = dec.parseDecimal(reserveIn);
    const rOut = dec.parseDecimal(reserveOut);
    // feeMul = (10000 - feeBps) / 10000, as a scaled decimal.
    const feeNum = dec.parseDecimal(String(10000 - pool.feeBps));
    const feeDen = dec.parseDecimal("10000");
    const dx = dec.div(dec.mul(dec.parseDecimal(inputAmount), feeNum), feeDen);
    const out = dec.div(dec.mul(rOut, dx), rIn + dx);
    return dec.formatDecimal(out);
  }

  async swap(input: PoolSwapInput): Promise<unknown> {
    const pool = await this.fetchPool(input.poolCid);
    // Operator-discovery: recover the single swap input allocation from the tree
    // when the wallet returned only an updateId.
    let swapperAllocationCid = input.swapperAllocationCid;
    if (input.updateId) {
      const { allocationCids } = await recoverCreatedAllocations(
        this.ledger, this.operatorParty, input.updateId, 1,
      );
      swapperAllocationCid = allocationCids[0] as ContractId<"Allocation">;
    }
    if (!swapperAllocationCid) {
      throw new Error("swap: supply swapperAllocationCid or an updateId to recover it");
    }
    const factories = await this.registry.getFactories(pool.admin);
    const ctx = await this.choiceContext(pool.admin);
    const inputIsBase = input.inputInstrumentId === pool.baseInstrumentId;
    const inputSlices = inputIsBase ? pool.baseSlices : pool.quoteSlices;
    const outputSlices = inputIsBase ? pool.quoteSlices : pool.baseSlices;
    const headInput = inputSlices[0];
    if (!headInput) throw new Error("pool has no input-side slice");
    const amountOut = dec.parseDecimal(
      this.computeQuote(pool, input.inputInstrumentId, input.inputAmount),
    );
    const outputSliceCids = selectCoveringPrefix(outputSlices, amountOut);
    // Deterministic, replay-safe commandId (DEX-107): computed ONCE here,
    // outside the retry closure, from a client key or the request content.
    const swapKey =
      input.idempotencyKey ??
      contentHash({
        poolCid: input.poolCid,
        swapper: input.swapperAccount.owner,
        inputInstrumentId: input.inputInstrumentId,
        inputAmount: input.inputAmount,
        minOutputAmount: input.minOutputAmount,
        swapperAllocationCid,
        updateId: input.updateId ?? null,
      });
    const commandId = `pool-swap:${input.poolCid}:${swapKey}`;
    return retryOnContention(() =>
      this.ledger.submit({
        actAs: [this.operatorParty],
        readAs: input.swapperAccount.owner ? [input.swapperAccount.owner] : [],
        commandId,
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
            swapperAllocationCid,
            inputSliceCid: headInput.contractId,
            outputSliceCids,
            factoryCid: factories.settlementFactoryCid,
            extraArgs: ctx.extraArgs,
          },
        },
      }),
    );
  }

  // Build the swapper's input allocation spec + settlement descriptor (in
  // Daml, via the nonconsuming PoolRules_RequestSwap), so the wallet authors a
  // spec that exactly matches what PoolRules_Swap settles against. Returns the
  // pool-admin allocation factory the wallet allocates under.
  async requestSwap(input: PoolRequestSwapInput): Promise<PoolRequestSwapResult> {
    const pool = await this.fetchPool(input.poolCid);
    const [factories, ctx] = await Promise.all([
      this.registry.getFactories(pool.admin),
      this.choiceContext(pool.admin),
    ]);
    const result = await this.ledger.submit<{
      settlement: V2SettlementInfo;
      allocationSpec: V2AllocationSpecification;
    }>({
      actAs: [this.operatorParty],
      commandId: `pool-swap-req:${input.poolCid}:${contentHash({
        swapper: input.swapper,
        inputInstrumentId: input.inputInstrumentId,
        inputAmount: input.inputAmount,
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
        },
      },
    });
    return {
      allocationSpec: result.allocationSpec,
      settlement: result.settlement,
      factoryCid: factories.allocationFactoryCid,
      allocationFactoryExtraArgs: ctx.extraArgs,
      allocationFactoryDisclosure: [...factories.disclosure, ...ctx.disclosure],
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

  private async loadLiquidityFactories(pool: Pool) {
    const [depositFactories, lpFactories] = await Promise.all([
      this.registry.getFactories(pool.admin),
      this.registry.getFactories(pool.lpRegistrar),
    ]);
    return { depositFactories, lpFactories };
  }

  private async loadLiquiditySurface(pool: Pool) {
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
    const { pool, liquidityRulesCid } = await this.fetchLiquidityPool(input.poolCid);
    const lpAmount = this.lpQuote(pool, input.baseAmount, input.quoteAmount);
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
            lpAmount,
            requestedAt: input.requestedAt,
            settleAt: input.settleAt ?? null,
          },
        },
      }),
    );
    const req = await this.fetchRequest(requestCid);
    const { depositFactories, lpFactories, depositContext, lpContext } =
      await this.loadLiquiditySurface(pool);
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
      depositFactoryExtraArgs: depositContext.extraArgs,
      lpFactoryExtraArgs: lpContext.extraArgs,
      depositFactoryDisclosure: [
        ...depositFactories.disclosure,
        ...depositContext.disclosure,
      ],
      lpFactoryDisclosure: [...lpFactories.disclosure, ...lpContext.disclosure],
    };
  }

  /** Settle a DvP add. */
  async settleAddLiquidity(input: PoolSettleAddLiquidityInput): Promise<unknown> {
    const { pool, liquidityRulesCid } = await this.fetchLiquidityPool(input.poolCid);
    const lpPolicyCid = await this.fetchLpAssetPolicy(pool);
    const { depositFactories, lpFactories, depositContext, lpContext } =
      await this.loadLiquiditySurface(pool);

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

    // Split-admin DvP: the base/quote batch settles under pool.admin and the
    // LP-mint batch under pool.lpRegistrar, so each carries its own registry
    // choice context. For the self-registry both contexts are empty.
    return retryOnContention(() =>
      this.ledger.submit({
        actAs: [this.operatorParty, pool.lpRegistrar],
        commandId: `lp-add-settle:${requestCid ?? acceptanceCid ?? input.updateId}`,
        disclosure: [
          ...depositFactories.disclosure,
          ...lpFactories.disclosure,
          ...depositContext.disclosure,
          ...lpContext.disclosure,
        ],
        command: {
          kind: "exercise",
          templateId: "CantonDex.Dex.PoolLiquidityRules:PoolLiquidityRules",
          contractId: liquidityRulesCid,
          choice: "PoolLiquidityRules_SettleAddLiquidity",
          argument: {
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
    const { depositFactories, lpFactories, depositContext, lpContext } =
      await this.loadLiquiditySurface(pool);
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
      depositFactoryExtraArgs: depositContext.extraArgs,
      lpFactoryExtraArgs: lpContext.extraArgs,
      depositFactoryDisclosure: [
        ...depositFactories.disclosure,
        ...depositContext.disclosure,
      ],
      lpFactoryDisclosure: [...lpFactories.disclosure, ...lpContext.disclosure],
    };
  }

  /** Settle a DvP remove. */
  async settleRemoveLiquidity(input: PoolSettleRemoveLiquidityInput): Promise<unknown> {
    const { pool, liquidityRulesCid } = await this.fetchLiquidityPool(input.poolCid);
    // Re-derive from current state; drift since /request aborts at settle.
    const plan = this.deriveRemovePlan(pool, input.lpTokensToRedeem, input.knownTotalLpSupply);
    const lpPolicyCid = await this.fetchLpAssetPolicy(pool);
    const { depositFactories, lpFactories, depositContext, lpContext } =
      await this.loadLiquiditySurface(pool);

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

    // Split-admin DvP: base/quote batch under pool.admin, LP-burn batch under
    // pool.lpRegistrar — each carries its own registry choice context.
    // For the self-registry both contexts are empty.
    return retryOnContention(() =>
      this.ledger.submit({
        actAs: [this.operatorParty, pool.lpRegistrar],
        commandId: `lp-remove-settle:${requestCid ?? acceptanceCid ?? input.updateId}`,
        disclosure: [
          ...depositFactories.disclosure,
          ...lpFactories.disclosure,
          ...depositContext.disclosure,
          ...lpContext.disclosure,
        ],
        command: {
          kind: "exercise",
          templateId: "CantonDex.Dex.PoolLiquidityRules:PoolLiquidityRules",
          contractId: liquidityRulesCid,
          choice: "PoolLiquidityRules_SettleRemoveLiquidity",
          argument: {
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
