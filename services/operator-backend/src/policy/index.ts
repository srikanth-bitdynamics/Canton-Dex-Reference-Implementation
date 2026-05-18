// Operator policy module. Mirrors the on-ledger ranking applied by
// Rfq_Accept in trading/CantonDex/Dex/Rfq.daml. The two MUST agree.

import { createHash } from "node:crypto";

import type {
  Decimal,
  Party,
  PolicyReceipt,
  RankedDealer,
  RfqQuote,
  RfqSide,
  Time,
} from "../types.js";

export const POLICY_VERSION = "v1.4";
export const POLICY_HASH = "sha256:rfq-policy-v1.4";

export function rankQuotes(
  side: RfqSide,
  quotes: RfqQuote[],
  now: Time,
): RfqQuote[] {
  const valid = quotes.filter(
    (q) => Date.parse(q.expiresAt) > Date.parse(now),
  );
  return [...valid].sort((a, b) => {
    const tierA = a.tier === "TierTrusted" ? 0 : 1;
    const tierB = b.tier === "TierTrusted" ? 0 : 1;
    if (tierA !== tierB) return tierA - tierB;
    const pa = parseFloat(a.price);
    const pb = parseFloat(b.price);
    if (pa !== pb) return side === "RFQ_Buy" ? pa - pb : pb - pa;
    const ta = Date.parse(a.postedAt);
    const tb = Date.parse(b.postedAt);
    if (ta !== tb) return ta - tb;
    return a.dealer.localeCompare(b.dealer);
  });
}

export function rankedDealersOf(ranked: RfqQuote[]): RankedDealer[] {
  return ranked.map((q, i) => ({
    party: q.dealer,
    rank: i + 1,
    price: q.price,
    tier: q.tier === "TierTrusted" ? "trusted" : "whitelist",
  }));
}

export function buildReceipt(args: {
  rfqId: string;
  side: RfqSide;
  quotes: RfqQuote[];
  acceptedDealer: Party;
  signedBy: Party;
  signedAt: Time;
  now?: Time;
}): PolicyReceipt {
  const now = args.now ?? args.signedAt;
  const ranked = rankQuotes(args.side, args.quotes, now);
  const rankedDealers = rankedDealersOf(ranked);
  const idx = rankedDealers.findIndex((d) => d.party === args.acceptedDealer);
  if (idx < 0) {
    throw new Error(
      `accepted dealer ${args.acceptedDealer} not in ranked set`,
    );
  }
  const acceptedRank = idx + 1;
  const consideredCount = rankedDealers.length;

  const unsigned: Omit<PolicyReceipt, "signature"> = {
    policyVersion: POLICY_VERSION,
    policyHash: POLICY_HASH,
    rfqId: args.rfqId,
    rankedDealers,
    acceptedDealer: args.acceptedDealer,
    acceptedRank,
    consideredCount,
    signedBy: args.signedBy,
    signedAt: args.signedAt,
  };
  return { ...unsigned, signature: signReceipt(unsigned) };
}

export function signReceipt(r: Omit<PolicyReceipt, "signature">): string {
  const canonical = JSON.stringify({
    policyHash: r.policyHash,
    rankedDealers: r.rankedDealers.map((d) => ({
      party: d.party,
      rank: d.rank,
      price: d.price,
      tier: d.tier,
    })),
    acceptedDealer: r.acceptedDealer,
    acceptedRank: r.acceptedRank,
    signedAt: r.signedAt,
  });
  return "0x" + createHash("sha256").update(canonical).digest("hex");
}

export function verifyReceipt(r: PolicyReceipt): boolean {
  return signReceipt({ ...r }) === r.signature;
}

export function toFloat(d: Decimal): number {
  const n = parseFloat(d);
  if (Number.isNaN(n)) throw new Error(`bad decimal: ${d}`);
  return n;
}
