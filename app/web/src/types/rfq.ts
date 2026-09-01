// RFQ-specific types. Open, Accepted, Cancelled, and Expired mirror the Daml
// lifecycle. Quoted and Accepting are page-only projections.

import type { PolicyReceipt } from './contracts';

export type RfqSide = 'RFQ_Buy' | 'RFQ_Sell';
export type RfqStatus =
  | 'RFQ_Open'
  | 'RFQ_Quoted'
  | 'RFQ_Accepting'
  | 'RFQ_Accepted'
  | 'RFQ_Cancelled'
  | 'RFQ_Expired';
export type DealerTier = 'TierTrusted' | 'TierWhitelist';

export interface Rfq {
  contractId: string;
  trader: string;
  operator: string;
  rfqId: string;
  /** Display label `base/quote`, derived from the two instrument ids. */
  pair: string;
  baseInstrumentId: { admin: string; id: string };
  quoteInstrumentId: { admin: string; id: string };
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
  /** MatchedTrade and policy receipt produced when a quote is accepted. */
  acceptedTrade?: AcceptedTrade;
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

export interface AcceptedTrade {
  id: string;
  pair: string;
  side: RfqSide;
  size: number;
  price: number;
  dealer: string;
  recordedAt: string;
  tradeCid: string;
  policyVer: string;
  policyCid: string;
  rank: number;
  considered: number;
  policyReceipt?: PolicyReceipt;
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
