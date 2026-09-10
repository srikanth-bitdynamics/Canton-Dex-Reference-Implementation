// Recovery tests — recoverCreatedAllocations reads the created allocation cids
// registry-agnostically from the AllocationFactory_Allocate exercise results
// (via treeAllocationCids), so it works for external-registry deposits (Amulet,
// USDCx) whose allocation is not our template. Falls back to the created-event
// template scan for any ledger without the method.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { recoverCreatedAllocations } from "../src/ledger/recover.js";
import { allocationCidFromResult } from "../src/ledger/json-api.js";
import type {
  LedgerSubmitter,
  CreatedEventRef,
  SubscriptionFilter,
  LedgerEvent,
} from "../src/ledger/index.js";
import type { Party } from "@canton-dex/registry-client";

const PARTY = "lp" as Party;
const CID = "00d5bd19f0b2b1c39c9d797";

abstract class BaseLedger implements LedgerSubmitter {
  async submit<R>(): Promise<R> {
    throw new Error("not used");
  }
  async *subscribe<T>(_f: SubscriptionFilter): AsyncIterable<LedgerEvent<T>> {}
  async query<T>(): Promise<T[]> {
    return [];
  }
}

// Registry-agnostic path only: serves allocation cids, cannot serve trees.
class AllocationOnlyLedger extends BaseLedger {
  constructor(private readonly cids: string[]) {
    super();
  }
  async treeAllocationCids(): Promise<string[]> {
    return this.cids;
  }
}

// Registry-agnostic path plus created events for the acceptance lookup.
class AllocationWithCreatedLedger extends BaseLedger {
  constructor(
    private readonly cids: string[],
    private readonly created: CreatedEventRef[],
  ) {
    super();
  }
  async treeAllocationCids(): Promise<string[]> {
    return this.cids;
  }
  async treeCreatedEvents(): Promise<CreatedEventRef[]> {
    return this.created;
  }
}

// No treeAllocationCids — exercises the created-event template-scan fallback.
class CreatedEventsLedger extends BaseLedger {
  constructor(private readonly created: CreatedEventRef[]) {
    super();
  }
  async treeCreatedEvents(): Promise<CreatedEventRef[]> {
    return this.created;
  }
}

describe("recoverCreatedAllocations", () => {
  it("returns the allocation cids from treeAllocationCids without needing trees", async () => {
    const ledger = new AllocationOnlyLedger([CID]);
    const got = await recoverCreatedAllocations(ledger, PARTY, "update-1", 1);
    assert.deepEqual(got.allocationCids, [CID]);
    assert.equal(got.acceptanceCid, undefined);
  });

  it("throws the count error when the recovered count does not match", async () => {
    const ledger = new AllocationOnlyLedger([CID, "00other"]);
    await assert.rejects(
      recoverCreatedAllocations(ledger, PARTY, "update-1", 1),
      /expected 1 Allocation creates for updateId=update-1, found 2/,
    );
  });

  it("also recovers the acceptance cid from created events when present", async () => {
    const ledger = new AllocationWithCreatedLedger(
      [CID],
      [
        { contractId: "#acc:0", templateId: "x:CantonDex.Dex.LiquidityAllocationRequest:LiquidityAllocationAcceptance" },
      ],
    );
    const got = await recoverCreatedAllocations(ledger, PARTY, "update-1", 1);
    assert.deepEqual(got.allocationCids, [CID]);
    assert.equal(got.acceptanceCid, "#acc:0");
  });

  it("falls back to the created-event template scan when treeAllocationCids is absent", async () => {
    const ledger = new CreatedEventsLedger([
      { contractId: CID, templateId: "abcdef:CantonDex.Registry.V2:Allocation" },
    ]);
    const got = await recoverCreatedAllocations(ledger, PARTY, "update-1", 1);
    assert.deepEqual(got.allocationCids, [CID]);
  });
});

describe("allocationCidFromResult", () => {
  it("extracts the cid from a Completed result", () => {
    const result = {
      output: {
        tag: "AllocationInstructionResult_Completed",
        value: { allocationCid: CID },
      },
    };
    assert.equal(allocationCidFromResult(result), CID);
  });

  it("returns null for a Pending result", () => {
    const result = {
      output: {
        tag: "AllocationInstructionResult_Pending",
        value: { allocationInstructionCid: "#inst:0" },
      },
    };
    assert.equal(allocationCidFromResult(result), null);
  });

  it("returns null for a Failed result", () => {
    const result = { output: { tag: "AllocationInstructionResult_Failed", value: {} } };
    assert.equal(allocationCidFromResult(result), null);
  });

  it("returns null for garbage", () => {
    assert.equal(allocationCidFromResult(null), null);
    assert.equal(allocationCidFromResult({}), null);
    assert.equal(allocationCidFromResult({ output: { tag: "AllocationInstructionResult_Completed" } }), null);
  });
});
