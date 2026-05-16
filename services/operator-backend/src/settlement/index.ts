// Settlement orchestrator helpers shared between MatchedTrade and Pool flows.

import type { Party, V2TransferLeg } from "../types.js";

/**
 * Group transfer legs by admin. Stable surface: admin from
 * instrumentId.admin. PR 5333: caller-supplied since admin moved to
 * AllocationSpecification.
 */
export function groupLegsByAdmin(
  legs: V2TransferLeg[],
  adminOfLeg: (leg: V2TransferLeg) => Party,
): Map<Party, V2TransferLeg[]> {
  const out = new Map<Party, V2TransferLeg[]>();
  for (const leg of legs) {
    const admin = adminOfLeg(leg);
    const existing = out.get(admin);
    if (existing) {
      existing.push(leg);
    } else {
      out.set(admin, [leg]);
    }
  }
  return out;
}
