// Admin flow.
//
// The operator's administrative actions: list/create DexPairs, toggle
// active state, update fee or trading-mode, and seed Pool contracts in
// PS_Unfunded state ready for first-touch initialization.
//
// Choice vocabulary:
//   - DexPair (create) — operator-signed
//   - DexPair_UpdateFeeModel
//   - DexPair_SetActive
//   - DexPair_UpdateTradingMode
//   - Pool (create) — operator-signed, status defaults to PS_Unfunded
//
// Every choice in this module is operator-controlled; no wallet
// handoff is involved.

import type { ContractId } from "@canton-dex/registry-client";
import { RegistryClient } from "@canton-dex/registry-client";

import { LedgerSubmitter } from "../ledger/index.js";
import { retryOnContention } from "../ledger/submit-with-retry.js";
import type { Decimal, Party } from "../types.js";

export type TradingMode = "TM_OrderBook" | "TM_Pool" | "TM_Both";

export interface FeeModel {
  makerFeeBps: number;
  takerFeeBps: number;
  poolFeeBps: number;
}

export interface CreatePairInput {
  admin: Party;
  baseInstrumentId: string;
  quoteInstrumentId: string;
  tradingMode: TradingMode;
  feeModel: FeeModel;
  active?: boolean;
}

export interface CreatePoolInput {
  lpRegistrar: Party;
  admin: Party;
  baseInstrumentId: string;
  quoteInstrumentId: string;
  lpInstrumentId: string;
  feeBps: number;
}

export class AdminService {
  constructor(
    private readonly ledger: LedgerSubmitter,
    private readonly _registry: RegistryClient,
    private readonly operatorParty: Party,
  ) {}

  async createPair(input: CreatePairInput): Promise<ContractId<"DexPair">> {
    return retryOnContention(() =>
      this.ledger.submit<ContractId<"DexPair">>({
        actAs: [this.operatorParty],
        commandId: `pair-create:${input.baseInstrumentId}:${input.quoteInstrumentId}`,
        command: {
          kind: "create",
          templateId: "CantonDex.Dex.DexPair:DexPair",
          argument: {
            operator: this.operatorParty,
            admin: input.admin,
            baseInstrumentId: input.baseInstrumentId,
            quoteInstrumentId: input.quoteInstrumentId,
            tradingMode: input.tradingMode,
            feeModel: input.feeModel,
            active: input.active ?? true,
            publicReaders: null,
            accumulatedMakerFees: null,
            accumulatedTakerFees: null,
          },
        },
      }),
    );
  }

  async updatePairFeeModel(input: {
    pairCid: ContractId<"DexPair">;
    newFeeModel: FeeModel;
  }): Promise<ContractId<"DexPair">> {
    return retryOnContention(() =>
      this.ledger.submit<ContractId<"DexPair">>({
        actAs: [this.operatorParty],
        commandId: `pair-fee:${input.pairCid}:${Date.now()}`,
        command: {
          kind: "exercise",
          templateId: "CantonDex.Dex.DexPair:DexPair",
          contractId: input.pairCid,
          choice: "DexPair_UpdateFeeModel",
          argument: { newFeeModel: input.newFeeModel },
        },
      }),
    );
  }

  async setPairActive(input: {
    pairCid: ContractId<"DexPair">;
    active: boolean;
  }): Promise<ContractId<"DexPair">> {
    return retryOnContention(() =>
      this.ledger.submit<ContractId<"DexPair">>({
        actAs: [this.operatorParty],
        commandId: `pair-active:${input.pairCid}:${input.active}`,
        command: {
          kind: "exercise",
          templateId: "CantonDex.Dex.DexPair:DexPair",
          contractId: input.pairCid,
          choice: "DexPair_SetActive",
          argument: { newActive: input.active },
        },
      }),
    );
  }

  async updateTradingMode(input: {
    pairCid: ContractId<"DexPair">;
    newTradingMode: TradingMode;
  }): Promise<ContractId<"DexPair">> {
    return retryOnContention(() =>
      this.ledger.submit<ContractId<"DexPair">>({
        actAs: [this.operatorParty],
        commandId: `pair-mode:${input.pairCid}:${input.newTradingMode}`,
        command: {
          kind: "exercise",
          templateId: "CantonDex.Dex.DexPair:DexPair",
          contractId: input.pairCid,
          choice: "DexPair_UpdateTradingMode",
          argument: { newTradingMode: input.newTradingMode },
        },
      }),
    );
  }

  async createPool(input: CreatePoolInput): Promise<ContractId<"Pool">> {
    const zero: Decimal = "0.0";
    // LP instrument is administered by the lpRegistrar; build the
    // structured V2 InstrumentId from the supplied textual id.
    const lpInstrumentId = { admin: input.lpRegistrar, id: input.lpInstrumentId };
    const poolId = `${input.baseInstrumentId}-${input.quoteInstrumentId}`;

    // DEX-40/41 split: create the immutable config, the Unfunded state,
    // and (idempotently) the per-venue rules contract.
    const poolCid = await retryOnContention(() =>
      this.ledger.submit<ContractId<"Pool">>({
        actAs: [this.operatorParty],
        commandId: `pool-create:${input.baseInstrumentId}:${input.quoteInstrumentId}`,
        command: {
          kind: "create",
          templateId: "CantonDex.Dex.Pool:Pool",
          argument: {
            poolId,
            operator: this.operatorParty,
            lpRegistrar: input.lpRegistrar,
            admin: input.admin,
            baseInstrumentId: input.baseInstrumentId,
            quoteInstrumentId: input.quoteInstrumentId,
            lpInstrumentId,
            feeBps: input.feeBps,
            operatorFeeBps: 0,
          },
        },
      }),
    );

    await retryOnContention(() =>
      this.ledger.submit({
        actAs: [this.operatorParty],
        commandId: `pool-state-create:${poolId}`,
        command: {
          kind: "create",
          templateId: "CantonDex.Dex.PoolState:PoolState",
          argument: {
            poolId,
            operator: this.operatorParty,
            lpRegistrar: input.lpRegistrar,
            status: "PS_Unfunded",
            reserves: { baseAmount: zero, quoteAmount: zero },
            totalLpSupply: zero,
            publicReaders: [],
          },
        },
      }),
    );

    await this.ensurePoolRules();
    await this.ensureLpDvpRules(input.lpRegistrar);

    // Create the matching LPTokenPolicy (lpRegistrar-signed) so the pool's
    // mint/burn flow has a policy to reference. Pool_Initialize /
    // _AddLiquidity / _RemoveLiquidity require its cid; PoolService looks
    // it up by lpInstrumentId.
    await retryOnContention(() =>
      this.ledger.submit({
        actAs: [input.lpRegistrar],
        commandId: `lp-policy-create:${input.lpInstrumentId}`,
        command: {
          kind: "create",
          templateId: "CantonDex.Dex.LPToken:LPTokenPolicy",
          argument: {
            lpRegistrar: input.lpRegistrar,
            operator: this.operatorParty,
            lpInstrumentId,
            baseInstrumentId: input.baseInstrumentId,
            quoteInstrumentId: input.quoteInstrumentId,
            poolCid,
            totalSupply: zero,
            active: true,
          },
        },
      }),
    );

    return poolCid;
  }

  /** Create the per-venue PoolRules if the operator doesn't have one yet. */
  private async ensurePoolRules(): Promise<void> {
    const existing = await this.ledger.query<{ contractId: ContractId<"PoolRules">; operator: Party }>({
      templateId: "CantonDex.Dex.PoolRules:PoolRules",
      observingParty: this.operatorParty,
    });
    if (existing.some((r) => r.operator === this.operatorParty)) return;
    await retryOnContention(() =>
      this.ledger.submit({
        actAs: [this.operatorParty],
        commandId: `pool-rules-create:${this.operatorParty}`,
        command: {
          kind: "create",
          templateId: "CantonDex.Dex.PoolRules:PoolRules",
          argument: { operator: this.operatorParty },
        },
      }),
    );
  }

  /**
   * Create the per-venue co-controlled LpDvpRules (operator + lpRegistrar)
   * if this (operator, lpRegistrar) venue doesn't have one yet. Hosts the
   * DvP liquidity request/settle choices; created once, reused.
   */
  private async ensureLpDvpRules(lpRegistrar: Party): Promise<void> {
    const existing = await this.ledger.query<{
      contractId: ContractId<"LpDvpRules">;
      operator: Party;
      lpRegistrar: Party;
    }>({
      templateId: "CantonDex.Dex.LpDvpRules:LpDvpRules",
      observingParty: this.operatorParty,
    });
    if (existing.some((r) => r.operator === this.operatorParty && r.lpRegistrar === lpRegistrar)) {
      return;
    }
    await retryOnContention(() =>
      this.ledger.submit({
        // Co-signed: LpDvpRules is signatory operator, lpRegistrar.
        actAs: [this.operatorParty, lpRegistrar],
        commandId: `lp-dvp-rules-create:${this.operatorParty}:${lpRegistrar}`,
        command: {
          kind: "create",
          templateId: "CantonDex.Dex.LpDvpRules:LpDvpRules",
          argument: { operator: this.operatorParty, lpRegistrar },
        },
      }),
    );
  }
}
