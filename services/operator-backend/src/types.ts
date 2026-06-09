// Shared types across operator-backend modules.

import type {
  ContractId,
  Party,
  Decimal,
  Time,
} from "@canton-dex/registry-client";

export type { ContractId, Party, Decimal, Time };

export interface V2Reference {
  id: string;
  cid: string | null;
}

// `owner` is nullable so the wire shape can represent mint/burn accounts.
export interface V2Account {
  owner: Party | null;
  provider: Party | null;
  id: string;
}

export interface V2TransferLeg {
  transferLegId: string;
  sender: V2Account;
  receiver: V2Account;
  amount: Decimal;
  instrumentId: string;
  meta: Record<string, string>;
}

export type V2TransferLegSideKind = "SenderSide" | "ReceiverSide";

// One authorizer's projected side of a transfer leg.
export interface V2TransferLegSide {
  transferLegId: string;
  side: V2TransferLegSideKind;
  otherside: V2Account;
  amount: Decimal;
  instrumentId: string;
  meta: Record<string, string>;
}

// Mirrors Daml `AllocationV2.AllocationSpecification`.
export interface V2AllocationSpecification {
  admin: Party;
  authorizer: V2Account;
  transferLegSides: V2TransferLegSide[];
  settlementDeadline: Time | null;
  nextIterationFunding: Record<string, Decimal> | null;
  committed: boolean;
  meta: Record<string, string>;
}

export interface V2SettlementInfo {
  executors: Party[];
  id: string;
  cid: string | null;
  meta: Record<string, string>;
}

export type Side = "Bid" | "Ask";
export type OrderStatus = "Pending" | "Funded" | "PartiallyFilled";

export interface Order {
  contractId: ContractId<"Order">;
  operator: Party;
  trader: Party;
  admin: Party;
  baseInstrumentId: string;
  quoteInstrumentId: string;
  side: Side;
  limitPrice: Decimal;
  remainingQty: Decimal;
  expiry: Time | null;
  status: OrderStatus;
  allocationCid: ContractId<"Allocation"> | null;
  settlementRef: V2Reference;
}

export type PoolStatus = "Unfunded" | "Active" | "Paused";

export interface PoolReserves {
  baseAmount: Decimal;
  quoteAmount: Decimal;
}

export interface PoolSlice {
  contractId: ContractId<"PoolSlice">;
  allocationCid: ContractId<"Allocation">;
  amount: Decimal;
  side: "BaseSide" | "QuoteSide";
}

export interface InstrumentId {
  admin: Party;
  id: string;
}

// Raw on-ledger contract shapes.
export interface PoolConfigContract {
  contractId: ContractId<"Pool">;
  poolId: string;
  operator: Party;
  lpRegistrar: Party;
  admin: Party;
  baseInstrumentId: string;
  quoteInstrumentId: string;
  lpInstrumentId: InstrumentId;
  feeBps: number;
  operatorFeeBps: number;
}

export interface PoolStateContract {
  contractId: ContractId<"PoolState">;
  poolId: string;
  operator: Party;
  lpRegistrar: Party;
  status: PoolStatus;
  reserves: PoolReserves;
  totalLpSupply: Decimal;
  publicReaders: Party[];
}

export interface PoolSliceContract {
  contractId: ContractId<"PoolSlice">;
  poolId: string;
  operator: Party;
  side: "BaseSide" | "QuoteSide";
  allocationCid: ContractId<"Allocation">;
  amount: Decimal;
}

export interface PoolRulesContract {
  contractId: ContractId<"PoolRules">;
  operator: Party;
}

export interface PoolLiquidityRulesContract {
  contractId: ContractId<"PoolLiquidityRules">;
  operator: Party;
  lpRegistrar: Party;
}

export interface LiquidityAllocationRequestContract {
  contractId: ContractId<"LiquidityAllocationRequest">;
  operator: Party;
  lp: Party;
  settlement: V2SettlementInfo;
  allocations: V2AllocationSpecification[];
  requestedAt: Time;
  settleAt: Time | null;
}

// Operator-visible evidence left by AllocationRequest_Accept before it consumes
// the request (DEX-90). Keyed by `originalRequestCid` (globally unique). The
// operator recovers it either from the update tree (updateId path, alongside the
// created Allocation cids) or via discoverAcceptance(requestCid). (lp,
// settlement.id) is NOT unique — poolSettlement uses a constant settlement id.
export interface LiquidityAllocationAcceptanceContract {
  contractId: ContractId<"LiquidityAllocationAcceptance">;
  operator: Party;
  lp: Party;
  settlement: V2SettlementInfo;
  allocations: V2AllocationSpecification[];
  settleAt: Time | null;
  acceptedAt: Time;
  /** The consumed request's cid — the unique key discovery matches on. */
  originalRequestCid: ContractId<"LiquidityAllocationRequest">;
}

// Combined API view assembled from the split pool contracts.
export interface Pool {
  contractId: ContractId<"Pool">;
  poolId: string;
  poolStateCid: ContractId<"PoolState">;
  rulesCid: ContractId<"PoolRules">;
  lpDvpRulesCid: ContractId<"PoolLiquidityRules"> | null;
  operator: Party;
  lpRegistrar: Party;
  admin: Party;
  baseInstrumentId: string;
  quoteInstrumentId: string;
  lpInstrumentId: InstrumentId;
  feeBps: number;
  status: PoolStatus;
  reserves: PoolReserves;
  totalLpSupply: Decimal;
  baseSlices: PoolSlice[];
  quoteSlices: PoolSlice[];
  operatorFeeBps: number | null;
  accumulatedOperatorFees: Record<string, Decimal> | null;
  publicReaders: Party[] | null;
}

export interface LPTokenPolicy {
  contractId: ContractId<"LPTokenPolicy">;
  lpRegistrar: Party;
  operator: Party;
  lpInstrumentId: InstrumentId;
  totalSupply: Decimal;
  active: boolean;
}

export type RfqSide = "RFQ_Buy" | "RFQ_Sell";
export type DealerTier = "TierTrusted" | "TierWhitelist";

export interface Rfq {
  contractId: ContractId<"Rfq">;
  trader: Party;
  operator: Party;
  rfqId: string;
  pair: string;
  side: RfqSide;
  size: Decimal;
  expiresAt: Time;
  whitelist: Party[];
  createdAt: Time;
}

export interface RfqQuote {
  contractId: ContractId<"RfqQuote">;
  dealer: Party;
  trader: Party;
  operator: Party;
  rfqId: string;
  price: Decimal;
  expiresAt: Time;
  postedAt: Time;
  tier: DealerTier;
}

export interface RankedDealer {
  party: Party;
  rank: number;
  price: Decimal;
  tier: string;
}

export interface PolicyReceipt {
  policyVersion: string;
  policyHash: string;
  rfqId: string;
  rankedDealers: RankedDealer[];
  acceptedDealer: Party;
  acceptedRank: number;
  consideredCount: number;
  signedBy: Party;
  signedAt: Time;
  signature: string;
}
