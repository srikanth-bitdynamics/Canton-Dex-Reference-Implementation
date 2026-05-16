// Adapter from on-ledger Rfq / RfqQuote shapes to the RfqPage UI
// shape. Keeps the page rendering logic stable while swapping the data
// source from `rfq-mock.ts` to `/v1/rfq` reads.

import type {
  LedgerRfq,
  LedgerRfqQuote,
} from '@/services/operator-api';
import type { Rfq, RfqQuote } from '@/types/rfq';

function secondsUntil(iso: string, nowMs: number): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.round((t - nowMs) / 1000));
}

function formatHHMM(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function adaptQuote(
  q: LedgerRfqQuote,
  nowMs: number,
): RfqQuote {
  return {
    contractId: q.contractId,
    dealer: q.dealer,
    rfqId: q.rfqId,
    price: parseFloat(q.price),
    validFor: secondsUntil(q.expiresAt, nowMs),
    postedAt: formatHHMM(q.postedAt),
    tier: q.tier === 'TierTrusted' ? 'trusted' : 'whitelist',
  };
}

export function adaptRfqs(
  rfqs: LedgerRfq[],
  quotes: LedgerRfqQuote[],
  nowMs = Date.now(),
): Rfq[] {
  const byRfqId = new Map<string, RfqQuote[]>();
  for (const q of quotes) {
    const list = byRfqId.get(q.rfqId) ?? [];
    list.push(adaptQuote(q, nowMs));
    byRfqId.set(q.rfqId, list);
  }
  return rfqs.map<Rfq>((r) => {
    const rqs = byRfqId.get(r.rfqId) ?? [];
    const expiresIn = secondsUntil(r.expiresAt, nowMs);
    return {
      contractId: r.contractId,
      trader: r.trader,
      operator: r.operator,
      rfqId: r.rfqId,
      pair: r.pair,
      side: r.side,
      size: parseFloat(r.size),
      expiresIn,
      whitelist: r.whitelist,
      createdAt: formatHHMM(r.createdAt),
      status: rqs.length > 0 ? 'RFQ_Quoted' : 'RFQ_Open',
      quotes: rqs,
    };
  });
}
