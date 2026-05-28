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

export interface V2Account {
  owner: Party;
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
  allocationCid: ContractId<"Allocation">;
  amount: Decimal;
}

/** Token Standard V2 instrument identity: registry admin + textual id. */
export interface InstrumentId {
  admin: Party;
  id: string;
}

export interface Pool {
  contractId: ContractId<"Pool">;
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
  // Optional in Daml v0.0.6 (smart-upgrade compat with v0.0.5).
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
