// Operator-discovery recovery: recover created contract ids from a committed
// transaction by `updateId`, for wallets whose receipt is updateId-only. Shared
// by the pool DvP settle, swap, and order funding so the tree-walk + template
// classification live in one place.

import type { Party } from "@canton-dex/registry-client";
import type { LedgerSubmitter } from "./index.js";

const ALLOCATION_SUFFIX = "CantonDex.Registry.V2:Allocation";
const ACCEPTANCE_SUFFIX =
  "CantonDex.Dex.LiquidityAllocationRequest:LiquidityAllocationAcceptance";
const ORDER_FUNDING_REQUEST_SUFFIX =
  "CantonDex.Dex.OrderFundingRequest:OrderFundingRequest";

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

/**
 * Recover the single created `OrderFundingRequest` cid from a transaction tree
 * by `updateId`, for the place-order flow when the wallet returned only an
 * updateId (CIP-0103 SDK / PartyLayer). Mirrors `recoverCreatedAllocations` —
 * the bind step needs the funding-request cid the wallet just created, which
 * an updateId-only receipt doesn't carry. Throws if the ledger can't serve
 * trees or the funding-request count isn't exactly one.
 */
export async function recoverCreatedFundingRequest(
  ledger: LedgerSubmitter,
  party: Party,
  updateId: string,
): Promise<string> {
  if (!ledger.treeCreatedEvents) {
    throw new Error(
      "ledger does not support transaction-tree recovery (treeCreatedEvents)",
    );
  }
  const created = await ledger.treeCreatedEvents(updateId, party);
  const cids = created
    .filter((e) => e.templateId.endsWith(ORDER_FUNDING_REQUEST_SUFFIX))
    .map((e) => e.contractId);
  if (cids.length !== 1) {
    throw new Error(
      `recoverCreatedFundingRequest: expected 1 OrderFundingRequest create ` +
        `for updateId=${updateId}, found ${cids.length}`,
    );
  }
  return cids[0]!;
}
