// Frontend-side mirror of the on-ledger contract shapes. Field names
// match the Daml templates so JSON wire decoding is identity. Decimal
// values are represented as `number` here for UI display convenience;
// the backend's typed client (`@canton-dex/operator-backend`) keeps
// them as strings on the wire.

export interface Account {
  owner: string;
  provider: string | null;
  id: string;
}

export type TradingMode = 'OrderBook' | 'Pool' | 'Both';

export interface FeeModel {
  makerFeeBps: number;
  takerFeeBps: number;
  poolFeeBps: number;
}

export interface DexPair {
  contractId: string;
  operator: string;
  admin: string;
  baseInstrumentId: string;
  quoteInstrumentId: string;
  tradingMode: TradingMode;
  feeModel: FeeModel;
  active: boolean;
  publicReaders: string[] | null;
  accumulatedMakerFees: Record<string, number> | null;
  accumulatedTakerFees: Record<string, number> | null;
}

export type Side = 'Bid' | 'Ask';
export type OrderStatus = 'Pending' | 'Funded' | 'PartiallyFilled';

export interface Order {
  contractId: string;
  operator: string;
  trader: string;
  admin: string;
  baseInstrumentId: string;
  quoteInstrumentId: string;
  side: Side;
  limitPrice: number;
  remainingQty: number;
  expiry: string | null;
  status: OrderStatus;
  allocationCid: string | null;
}

export type PoolStatus = 'Unfunded' | 'Active' | 'Paused';

export interface PoolReserves {
  baseAmount: number;
  quoteAmount: number;
}

export interface PoolSlice {
  allocationCid: string;
  amount: number;
}

/** Token Standard V2 instrument identity: registry admin + textual id. */
export interface InstrumentId {
  admin: string;
  id: string;
}

export interface Pool {
  contractId: string;
  operator: string;
  lpRegistrar: string;
  admin: string;
  baseInstrumentId: string;
  quoteInstrumentId: string;
  lpInstrumentId: InstrumentId;
  feeBps: number;
  status: PoolStatus;
  reserves: PoolReserves;
  totalLpSupply: number;
  baseSlices: PoolSlice[];
  quoteSlices: PoolSlice[];
  operatorFeeBps: number | null;
  accumulatedOperatorFees: Record<string, number> | null;
  publicReaders: string[] | null;
}

export interface LPTokenPolicy {
  contractId: string;
  lpRegistrar: string;
  operator: string;
  lpInstrumentId: InstrumentId;
  baseInstrumentId: string;
  quoteInstrumentId: string;
  totalSupply: number;
  active: boolean;
}

export type SwapDirection = 'BaseToQuote' | 'QuoteToBase';

export interface SwapRequest {
  contractId: string;
  operator: string;
  trader: string;
  baseInstrumentId: string;
  quoteInstrumentId: string;
  direction: SwapDirection;
  inputAmount: number;
  minOutputAmount: number;
  deadline: string | null;
}

export interface Holding {
  contractId: string;
  owner: string;
  admin: string;
  instrumentId: string;
  amount: number;
  locked: boolean;
}

export interface RankedDealer {
  party: string;
  rank: number;
  price: string;
  tier: string;
}

export interface PolicyReceipt {
  policyVersion: string;
  policyHash: string;
  rfqId: string;
  rankedDealers: RankedDealer[];
  acceptedDealer: string;
  acceptedRank: number;
  consideredCount: number;
  signedBy: string;
  signedAt: string;
  signature: string;
}

export interface TransactionEvent {
  id: string;
  type:
    | 'Swap'
    | 'OrderPlace'
    | 'OrderFill'
    | 'AddLiquidity'
    | 'RemoveLiquidity'
    | 'Trade'
    | 'Rfq';
  timestamp: string;
  details: string;
  status: 'Pending' | 'Settled' | 'Failed' | 'Cancelled';
  amounts: { asset: string; amount: number }[];
  // Optional policy receipt context surfaced from RFQ-derived trades.
  tradeCid?: string;
  policyCid?: string;
  policyVer?: string;
  rank?: number;
  considered?: number;
}
