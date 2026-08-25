import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { DisclosedContract } from "@canton-dex/registry-client";

import { mergeDisclosures } from "../src/ledger/disclosure.js";

function disclosed(
  contractId: string,
  templateId = "Registry:Rules",
  createdEventBlob = `blob:${contractId}`,
): DisclosedContract {
  return { contractId, templateId, createdEventBlob };
}

describe("mergeDisclosures", () => {
  it("deduplicates transaction-wide disclosures without positional semantics", () => {
    const rules = disclosed("#rules");
    const factory = disclosed("#factory", "Registry:Factory");

    assert.deepEqual(
      mergeDisclosures([rules, factory], [rules]),
      [rules, factory],
    );
  });

  it("rejects conflicting payloads for one contract id", () => {
    assert.throws(
      () => mergeDisclosures(
        [disclosed("#rules", "Registry:Rules", "old")],
        [disclosed("#rules", "Registry:Rules", "new")],
      ),
      /conflicting disclosures for contract #rules/,
    );
  });
});
