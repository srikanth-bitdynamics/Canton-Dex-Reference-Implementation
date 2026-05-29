// Shared types across operator backend modules. Mirror the Daml templates
// one-to-one. Field names match the on-ledger shape so the JSON wire
// form deserializes directly.

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

// `owner` is nullable: the canonical Token-Standard mint/burn accounts
// (cip-112/mint, cip-112/burn) carry `owner = null` (and `provider =
// null`). DvP LP mint/burn specs reference those accounts, so the wire
// type must allow a null owner rather than assuming a real party.
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

// One authorizer's projected side of a transfer leg, mirroring the Daml
// `AllocationV2.TransferLegSide`. The backend projects legs to sides at
// the spec-construction boundary (same as `Utils.legsToSides`).
export interface V2TransferLegSide {
  transferLegId: string;
  side: V2TransferLegSideKind;
  otherside: V2Account;
  amount: Decimal;
  instrumentId: string;
  meta: Record<string, string>;
}

// Mirrors Daml `AllocationV2.AllocationSpecification`. The backend builds
// these for the LiquidityAllocationRequest the LP/holder accepts; the
// on-ledger settle validates supplied allocations against this exact shape.
export interface V2AllocationSpecification {
  admin: Party;
  authorizer: V2Account;
  transferLegSides: V2TransferLegSide[];
  settlementDeadline: Time | null;
  nextIterationFunding: Record<string, Decimal> | null;
  committed: boolean;
  meta: Record<string, string>;
}

// As of the V2 pre-freeze API, SettlementInfo carries the settlement
// reference inline (id/cid) and no longer holds settlementDeadline,
// which moved onto AllocationSpecification.
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

/** Token Standard V2 instrument identity: registry admin + textual id. */
export interface InstrumentId {
  admin: Party;
  id: string;
}

// Raw on-ledger contract shapes after the DEX-40/41 split. The Pool is
// now immutable config; reserves/status/supply live on PoolState; each
// committed allocation is its own PoolSlice contract; the operational
// choices live on a per-venue PoolRules.
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

// The co-controlled DvP rules contract (operator + lpRegistrar), one per
// venue. Hosts the LpDvpRules_Request*/Settle* choices.
export interface LpDvpRulesContract {
  contractId: ContractId<"LpDvpRules">;
  operator: Party;
  lpRegistrar: Party;
}

// Combined API view assembled by PoolService from the split contracts.
// Keeps the wire shape the dApp + http layer consume, plus the cids the
// PoolRules choices need.
export interface Pool {
  contractId: ContractId<"Pool">;
  poolId: string;
  poolStateCid: ContractId<"PoolState">;
  rulesCid: ContractId<"PoolRules">;
  lpDvpRulesCid: ContractId<"LpDvpRules"> | null;
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
  baseInstrumentId: string;
  quoteInstrumentId: string;
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
