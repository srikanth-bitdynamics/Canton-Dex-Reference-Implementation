// RFQ-specific types. Mirror the Daml templates in
// pr5333/CantonDex/Dex/Rfq.daml so JSON wire decoding is identity.

import type { PolicyReceipt } from './contracts';

export type RfqSide = 'RFQ_Buy' | 'RFQ_Sell';
export type RfqStatus =
  | 'RFQ_Open'
  | 'RFQ_Quoted'
  | 'RFQ_Accepted'
  | 'RFQ_Settling'
  | 'RFQ_Settled'
  | 'RFQ_Cancelled'
  | 'RFQ_Expired';
export type DealerTier = 'TierTrusted' | 'TierWhitelist';

export interface Rfq {
  contractId: string;
  trader: string;
  operator: string;
  rfqId: string;
  pair: string;
  side: RfqSide;
  size: number;
  /** Seconds until expiry; the RFQ page sweeps this at 1Hz. */
  expiresIn: number;
  whitelist: string[];
  createdAt: string;
  status: RfqStatus;
  quotes: RfqQuote[];
  acceptedDealer?: string;
  acceptedRank?: number;
  acceptedConsidered?: number;
  /** Settled-trade reference once the RFQ flips to RFQ_Settled. */
  settledTrade?: SettledTrade;
}

export interface RfqQuote {
  contractId: string;
  dealer: string;
  rfqId: string;
  price: number;
  /** Seconds the dealer's price is valid; sweeps with the parent RFQ. */
  validFor: number;
  postedAt: string;
  tier: 'trusted' | 'whitelist';
}

export interface SettledTrade {
  id: string;
  pair: string;
  side: RfqSide;
  size: number;
  price: number;
  dealer: string;
  settledAt: string;
  tradeCid: string;
  policyVer: string;
  policyCid: string;
  rank: number;
  considered: number;
  receipt?: PolicyReceipt;
}

export interface ExpiredRfq {
  id: string;
  pair: string;
  side: RfqSide;
  size: number;
  expiredAt: string;
  whitelist: string[];
  quoteCount: number;
  bestPrice: number | null;
  reason: string;
}
