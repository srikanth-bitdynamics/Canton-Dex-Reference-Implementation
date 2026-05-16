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
    return retryOnContention(() =>
      this.ledger.submit<ContractId<"Pool">>({
        actAs: [this.operatorParty],
        commandId: `pool-create:${input.baseInstrumentId}:${input.quoteInstrumentId}`,
        command: {
          kind: "create",
          templateId: "CantonDex.Dex.Pool:Pool",
          argument: {
            operator: this.operatorParty,
            lpRegistrar: input.lpRegistrar,
            admin: input.admin,
            baseInstrumentId: input.baseInstrumentId,
            quoteInstrumentId: input.quoteInstrumentId,
            lpInstrumentId: input.lpInstrumentId,
            feeBps: input.feeBps,
            status: "PS_Unfunded",
            reserves: { baseAmount: zero, quoteAmount: zero },
            totalLpSupply: zero,
            baseSlices: [],
            quoteSlices: [],
            operatorFeeBps: null,
            accumulatedOperatorFees: null,
            publicReaders: null,
          },
        },
      }),
    );
  }
}
