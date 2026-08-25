import type { DisclosedContract } from "@canton-dex/registry-client";

/**
 * Merge transaction-wide disclosures by contract id.
 *
 * Disclosure order has no settlement meaning. Exact repeats are collapsed;
 * different payloads for the same id indicate stale or inconsistent registry
 * discovery and must not be submitted.
 */
export function mergeDisclosures(
  ...groups: ReadonlyArray<ReadonlyArray<DisclosedContract>>
): DisclosedContract[] {
  const byContractId = new Map<string, DisclosedContract>();
  for (const group of groups) {
    for (const disclosure of group) {
      const existing = byContractId.get(disclosure.contractId);
      if (!existing) {
        byContractId.set(disclosure.contractId, disclosure);
        continue;
      }
      if (
        existing.templateId !== disclosure.templateId ||
        existing.createdEventBlob !== disclosure.createdEventBlob
      ) {
        throw new Error(
          `conflicting disclosures for contract ${disclosure.contractId}`,
        );
      }
    }
  }
  return [...byContractId.values()];
}
