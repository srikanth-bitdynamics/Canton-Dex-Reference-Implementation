// Client-side replay of the operator's RFQ ranking policy v2.0.
//
// Sort chain (mirrors `applyPolicy` in `trading/CantonDex/Dex/Rfq.daml`):
//   1. whitelist-preference: trusted-tier dealers rank above
//      whitelist-tier (filter-then-rank — only whitelisted dealers
//      can post on an RFQ in the first place).
//   2. expiry: later `expiresAt` ranks higher — more time to act.
//   3. createdAt: earlier `postedAt` ranks higher — first-mover.
//   4. venue tie-breaker: dealer party id string compare.
//
// `side` is no longer used by `policy` mode (price isn't part of the
// policy chain — the trader chooses from the policy-ranked candidates).
// `side` is still consumed by the other sort modes the UI exposes.
//
// On-ledger `PolicyReceipt.policyVersion` is "v2.0" /
// `policyHash` is "sha256:rfq-policy-v2.0" matching the Daml.

import type { RfqQuote, RfqSide } from '@/types/rfq';
import type { Dealer } from '@/primitives/dealers';

export const POLICY_VERSION = 'v2.0';
export const POLICY_HASH = 'sha256:rfq-policy-v2.0';

export function rankQuotes(
  side: RfqSide,
  quotes: RfqQuote[],
  sortMode: 'policy' | 'price' | 'earliest' | 'trusted' = 'policy',
): RfqQuote[] {
  const valid = quotes.filter((q) => q.validFor > 0);
  if (sortMode === 'price') {
    return [...valid].sort((a, b) =>
      side === 'RFQ_Buy' ? a.price - b.price : b.price - a.price,
    );
  }
  if (sortMode === 'earliest') {
    return [...valid].sort((a, b) => a.postedAt.localeCompare(b.postedAt));
  }
  if (sortMode === 'trusted') {
    return [...valid].sort(
      (a, b) =>
        (a.tier === 'trusted' ? 0 : 1) - (b.tier === 'trusted' ? 0 : 1),
    );
  }
  // policy v2.0: tier → expiry (later first) → postedAt (earlier first) → dealer id.
  return [...valid].sort((a, b) => {
    const tierA = a.tier === 'trusted' ? 0 : 1;
    const tierB = b.tier === 'trusted' ? 0 : 1;
    if (tierA !== tierB) return tierA - tierB;
    // "later expiry first" → larger validFor wins → reverse-cmp on validFor
    if (a.validFor !== b.validFor) return b.validFor - a.validFor;
    // earlier postedAt first
    const postedCmp = a.postedAt.localeCompare(b.postedAt);
    if (postedCmp !== 0) return postedCmp;
    // deterministic tie-breaker on dealer party id
    return a.dealer.localeCompare(b.dealer);
  });
}

/** Whitelisted dealers, used by the compose form. Takes the live
 * dealer list explicitly so this function doesn't depend on a global
 * fetch — callers thread `useDealers().data` in. */
export function whitelistedDealers(all: Dealer[] | undefined) {
  return (all ?? []).filter((d) => d.whitelisted);
}
