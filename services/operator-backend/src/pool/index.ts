// Pool flow.

import type { ContractId } from "@canton-dex/registry-client";
import { RegistryClient } from "@canton-dex/registry-client";

import { LedgerSubmitter } from "../ledger/index.js";
import { retryOnContention } from "../ledger/submit-with-retry.js";
import { toFloat } from "../policy/index.js";
import type { Decimal, Party, Pool, Time, V2Account } from "../types.js";

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

export class PoolService {
  constructor(
    private readonly ledger: LedgerSubmitter,
    private readonly registry: RegistryClient,
    private readonly operatorParty: Party,
  ) {}

  async listActive(): Promise<Pool[]> {
    const pools = await this.ledger.query<Pool>({
      templateId: "CantonDex.Dex.Pool:Pool",
      observingParty: this.operatorParty,
    });
    // Daml serializes variant names with the PS_ prefix (PS_Active, PS_Unfunded,
    // PS_Paused). The InMemoryLedger seed in dev-server stores them without the
    // prefix to match the dApp's TypeScript type. Accept both forms here, and
    // include Unfunded so the UI can render newly-created pools that haven't
    // received their first liquidity yet.
    return pools.filter((p) => {
      const s = p.status as string;
      return s !== "PS_Paused" && s !== "Paused";
    });
  }

  async initialize(input: PoolInitializeInput): Promise<{
    poolCid: ContractId<"Pool">;
    lpTokensMinted: Decimal;
  }> {
    const pool = await this.fetchPool(input.poolCid);
    const factories = await this.registry.getFactories(pool.admin);
    return retryOnContention(() =>
      this.ledger.submit({
        actAs: [this.operatorParty],
        commandId: `pool-init:${input.poolCid}`,
        disclosure: factories.disclosure,
        command: {
          kind: "exercise",
          templateId: "CantonDex.Dex.Pool:Pool",
          contractId: input.poolCid,
          choice: "Pool_Initialize",
          argument: {
            recipient: input.recipient,
            baseFactoryCid: factories.allocationFactoryCid,
            quoteFactoryCid: factories.allocationFactoryCid,
            baseHoldingCids: input.baseHoldingCids,
            quoteHoldingCids: input.quoteHoldingCids,
            baseAmount: input.baseAmount,
            quoteAmount: input.quoteAmount,
            requestedAt: input.requestedAt,
          },
        },
      }),
    );
  }

  async addLiquidity(input: PoolAddLiquidityInput): Promise<unknown> {
    const pool = await this.fetchPool(input.poolCid);
    const factories = await this.registry.getFactories(pool.admin);
    return retryOnContention(() =>
      this.ledger.submit({
        actAs: [this.operatorParty],
        commandId: `pool-add:${input.poolCid}:${input.requestedAt}`,
        disclosure: factories.disclosure,
        command: {
          kind: "exercise",
          templateId: "CantonDex.Dex.Pool:Pool",
          contractId: input.poolCid,
          choice: "Pool_AddLiquidity",
          argument: {
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
          },
        },
      }),
    );
  }

  /**
   * Off-chain quote computation. Mirrors Pool.daml's Pool_ComputeSwapOut.
   * The on-chain Pool_Swap re-validates against `minOutputAmount`, so
   * the operator's quote is advisory not authoritative.
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
    return retryOnContention(() =>
      this.ledger.submit({
        actAs: [this.operatorParty],
        commandId: `pool-swap:${input.poolCid}:${Date.now()}`,
        disclosure: factories.disclosure,
        command: {
          kind: "exercise",
          templateId: "CantonDex.Dex.Pool:Pool",
          contractId: input.poolCid,
          choice: "Pool_Swap",
          argument: {
            swapperAccount: input.swapperAccount,
            inputInstrumentId: input.inputInstrumentId,
            inputAmount: input.inputAmount,
            minOutputAmount: input.minOutputAmount,
            swapperAllocationCid: input.swapperAllocationCid,
            factoryCid: factories.settlementFactoryCid,
          },
        },
      }),
    );
  }

  /**
   * Pool_RemoveLiquidity. Operator-driven, slice-local. Walks the pool's
   * slice list from the front, cancels only the slices needed to cover
   * the redemption, and re-allocates at most ONE boundary slice per side
   * from the operator-supplied boundary holdings. Slices beyond the
   * boundary stay untouched. The trader's LP-holding burn is a separate
   * wallet-handoff step (holder + lpRegistrar archive the holding via
   * LPBurnRequest_AcceptAndBurn against the LPBurnRequest this choice
   * creates).
   */
  async removeLiquidity(input: PoolRemoveLiquidityInput): Promise<unknown> {
    const pool = await this.fetchPool(input.poolCid);
    const factories = await this.registry.getFactories(pool.admin);
    return retryOnContention(() =>
      this.ledger.submit({
        actAs: [this.operatorParty],
        commandId: `pool-remove:${input.poolCid}:${input.requestedAt}`,
        disclosure: factories.disclosure,
        command: {
          kind: "exercise",
          templateId: "CantonDex.Dex.Pool:Pool",
          contractId: input.poolCid,
          choice: "Pool_RemoveLiquidity",
          argument: {
            holder: input.holder,
            lpTokensToRedeem: input.lpTokensToRedeem,
            knownTotalLpSupply: input.knownTotalLpSupply,
            minBaseOut: input.minBaseOut,
            minQuoteOut: input.minQuoteOut,
            baseFactoryCid: factories.allocationFactoryCid,
            quoteFactoryCid: factories.allocationFactoryCid,
            boundaryBaseHoldingCids: input.boundaryBaseHoldingCids,
            boundaryQuoteHoldingCids: input.boundaryQuoteHoldingCids,
            requestedAt: input.requestedAt,
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
}
