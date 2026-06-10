// Operator policy module. Mirrors the on-ledger ranking applied by
// Rfq_Accept in trading/CantonDex/Dex/Rfq.daml. The two MUST agree.

import { createHash, createHmac } from "node:crypto";

import { parseDecimal } from "../pool/decimal.js";
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

// Compare two Daml Decimal strings exactly (10dp, no IEEE-754) so the
// ranking agrees with the on-ledger Decimal ordering in
// trading/CantonDex/Dex/Rfq.daml (DEX-106). Returns -1 / 0 / 1.
export function compareDecimal(a: string, b: string): number {
  const da = parseDecimal(a);
  const db = parseDecimal(b);
  return da < db ? -1 : da > db ? 1 : 0;
}

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
    // Exact decimal-string price comparison (matches the Daml Decimal order).
    const priceCmp = compareDecimal(a.price, b.price);
    if (priceCmp !== 0) return side === "RFQ_Buy" ? priceCmp : -priceCmp;
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

// DEX-109: the `signature` field is an off-chain *replay digest*, not the
// trust anchor — origin authenticity is established on-ledger by the
// MatchedTrade signatory (PolicyReceipt.signedBy == venue, enforced by the
// Daml `ensure`). On-ledger the string is stored opaquely (it is never
// recomputed), so off-chain we are free to upgrade the digest to a keyed
// HMAC-SHA256 when DEX_RECEIPT_HMAC_KEY is configured; otherwise we keep the
// historical unkeyed SHA-256 so existing digest-parity holds. Either way the
// digest only proves the receipt inputs were not tampered with in transit.
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
  const key = process.env.DEX_RECEIPT_HMAC_KEY;
  if (key) {
    return "0x" + createHmac("sha256", key).update(canonical).digest("hex");
  }
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
