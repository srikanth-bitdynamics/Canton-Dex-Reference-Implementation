// Operator-discovery recovery: recover created contract ids from a committed
// transaction by `updateId`, for wallets whose receipt is updateId-only. Shared
// by the pool DvP settle, swap, and order funding so the tree-walk + template
// classification live in one place.

import type { Party } from "@canton-dex/registry-client";
import type { LedgerSubmitter } from "./index.js";

const ALLOCATION_SUFFIX = "CantonDex.Registry.V2:Allocation";
const ACCEPTANCE_SUFFIX =
  "CantonDex.Dex.LiquidityAllocationRequest:LiquidityAllocationAcceptance";

/**
 * Recover the created `Allocation` cids (in node/command order) and the optional
 * `LiquidityAllocationAcceptance` cid from a transaction tree by `updateId`.
 * Throws if the ledger can't serve trees or the allocation count doesn't match.
 */
export async function recoverCreatedAllocations(
  ledger: LedgerSubmitter,
  party: Party,
  updateId: string,
  expectedAllocations: number,
): Promise<{ allocationCids: string[]; acceptanceCid?: string }> {
  if (!ledger.treeCreatedEvents) {
    throw new Error(
      "ledger does not support transaction-tree recovery (treeCreatedEvents)",
    );
  }
  const created = await ledger.treeCreatedEvents(updateId, party);
  const allocationCids = created
    .filter((e) => e.templateId.endsWith(ALLOCATION_SUFFIX))
    .map((e) => e.contractId);
  if (allocationCids.length !== expectedAllocations) {
    throw new Error(
      `recoverCreatedAllocations: expected ${expectedAllocations} Allocation creates ` +
        `for updateId=${updateId}, found ${allocationCids.length}`,
    );
  }
  const acceptanceCid = created.find((e) =>
    e.templateId.endsWith(ACCEPTANCE_SUFFIX),
  )?.contractId;
  return { allocationCids, acceptanceCid };
}
