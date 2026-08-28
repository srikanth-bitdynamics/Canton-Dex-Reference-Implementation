// Operator policy module. Mirrors the on-ledger ranking applied by
// Rfq_Accept in trading/CantonDex/Dex/Rfq.daml. The two MUST agree.

import { createHash, createHmac } from "node:crypto";

import type {
  Decimal,
  Party,
  PolicyReceipt,
  RankedDealer,
  RfqQuote,
  Time,
} from "../types.js";

// Must name the ordering policyCmp implements in Rfq.daml: the receipt is
// replayed against it on-ledger, so a mismatch fails every verifyReceipt.
export const POLICY_VERSION = "v2.0";
export const POLICY_HASH = "sha256:rfq-policy-v2.0";

export function rankQuotes(
  quotes: RfqQuote[],
  now: Time,
): RfqQuote[] {
  const valid = quotes.filter(
    (q) => Date.parse(q.expiresAt) > Date.parse(now),
  );
  // Reproduces `policyCmp` in Rfq.daml exactly: trusted tier first,
  // then LATER expiresAt (more time to act), then EARLIER postedAt
  // (first-mover), then a deterministic dealer-party tie-break.
  //
  // [POLICY] Deliberately not ranked by price or direction. The trader picks
  // among ranked candidates; adding either key would disagree with the
  // on-ledger receipt verification.
  return [...valid].sort((a, b) => {
    const tierA = a.tier === "TierTrusted" ? 0 : 1;
    const tierB = b.tier === "TierTrusted" ? 0 : 1;
    if (tierA !== tierB) return tierA - tierB;
    const expA = Date.parse(a.expiresAt);
    const expB = Date.parse(b.expiresAt);
    if (expA !== expB) return expB - expA;
    const ta = Date.parse(a.postedAt);
    const tb = Date.parse(b.postedAt);
    if (ta !== tb) return ta - tb;
    // Daml compares the party TEXT; localeCompare is locale-sensitive and can
    // disagree on the same strings, so compare by code unit as Daml does.
    return a.dealer < b.dealer ? -1 : a.dealer > b.dealer ? 1 : 0;
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
  quotes: RfqQuote[];
  acceptedDealer: Party;
  signedBy: Party;
  signedAt: Time;
  now?: Time;
}): PolicyReceipt {
  const now = args.now ?? args.signedAt;
  const ranked = rankQuotes(args.quotes, now);
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

// The `signature` field is an off-chain *replay digest*, not the
// trust anchor — origin authenticity is established on-ledger by the
// MatchedTrade signatory (PolicyReceipt.signedBy == venue, enforced by the
// Daml `ensure`). On-ledger the string is stored opaquely. A configured
// DEX_RECEIPT_HMAC_KEY selects HMAC-SHA256; otherwise the reference uses plain
// SHA-256. The digest only detects changes to the receipt inputs in transit.
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
