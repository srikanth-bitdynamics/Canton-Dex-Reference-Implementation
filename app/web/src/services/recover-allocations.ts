// Recover the Allocation cid a single AllocationFactory_Allocate submission
// created, from the committed transaction's updateId.
//
// Used by the sequential single-command submit path (wallet/sequential-submit.ts):
// when a wallet only authorizes one command per request, each request creates
// exactly one allocation, so `expected` is 1 and the first (only) cid is
// returned. The backend derives the cids from the transaction tree, so an
// updateId-only wallet still yields explicit cids for the operator settle.

import type { Party } from "@/wallet/types";
import { apiAuthHeaders } from "./api-auth";

const API_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? "http://localhost:8080";

interface RecoverDvpAllocationsResult {
  allocationCids?: string[];
  acceptanceCid?: string;
}

/**
 * Recover the single created Allocation cid for one submission's `updateId`.
 * Throws with an actionable message when the backend cannot serve the tree or
 * the expected allocation is absent.
 */
export async function recoverCreatedAllocationCid(
  updateId: string,
  party: Party,
): Promise<string> {
  const path = "/v1/pools/recover-dvp-allocations";
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...apiAuthHeaders(path, "POST") },
    body: JSON.stringify({ updateId, party, expected: 1 }),
  });
  if (!res.ok) {
    throw new Error(
      `recover-dvp-allocations ${res.status}: ${(await res.text()).slice(0, 300)}`,
    );
  }
  const json = (await res.json()) as RecoverDvpAllocationsResult;
  const cid = json.allocationCids?.[0];
  if (!cid) {
    throw new Error(
      `recover-dvp-allocations returned no allocation cid for updateId ${updateId}`,
    );
  }
  return cid;
}
