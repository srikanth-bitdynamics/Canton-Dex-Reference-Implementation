import { describe, it, expect } from "vitest";

import { PartyLayerProvider, type PartyLayerClient } from "@/wallet/partylayer-provider";
import type { WalletIntent } from "@/wallet/types";

// A fake @partylayer/sdk client: records the submitted command tree and returns
// an updateId-only receipt, exactly like the real SDK (DEX-91).
function fakeClient(receipt: { updateId?: string; transactionHash?: string }) {
  const calls: Array<{ commandId: string; actAs: string[]; commands: unknown[] }> = [];
  let connected = false;
  const client: PartyLayerClient = {
    async connect() {
      connected = true;
      return { partyId: "alice::1220a", label: "Alice" };
    },
    async disconnect() {
      connected = false;
    },
    async submitTransaction(params) {
      calls.push(params);
      return receipt;
    },
  };
  return { client, calls, isConnected: () => connected };
}

const swapIntent: WalletIntent = {
  kind: "request-swap",
  poolId: "pool-abc",
  settlement: { executors: ["op"], id: "s", cid: null, meta: { values: {} } },
  allocationSpec: {
    admin: "admin",
    authorizer: { owner: "alice::1220a", provider: null, id: "" },
    transferLegSides: [],
    settlementDeadline: null,
    nextIterationFunding: null,
    committed: true,
    meta: {},
  },
  factoryCid: "fac",
  allocationFactoryExtraArgs: { context: { values: {} }, meta: { values: {} } },
  inputHoldingCids: ["h1"],
  disclosure: [],
} as unknown as WalletIntent;

describe("PartyLayerProvider", () => {
  const ctx = () => new PartyLayerProvider("#canton-dex-trading", async () => fake.client);
  let fake: ReturnType<typeof fakeClient>;

  it("connects and exposes the wallet party", async () => {
    fake = fakeClient({ updateId: "u-1" });
    const p = ctx();
    const acct = await p.connect();
    expect(acct.party).toBe("alice::1220a");
    expect(p.getStatus().kind).toBe("connected");
  });

  it("submit returns updateId as primaryCid and does NOT set createdAllocationCids", async () => {
    fake = fakeClient({ updateId: "update-xyz" });
    const p = ctx();
    await p.connect();
    const res = await p.submit(swapIntent);
    expect(res.primaryCid).toBe("update-xyz");
    expect(res.auxiliaryCids?.updateId).toBe("update-xyz");
    // updateId-only by design — the operator recovers the created cids from the
    // updateId for all DvP flows (LP add/remove, swap, order funding).
    expect(res.createdAllocationCids).toBeUndefined();
    // The composed command tree was handed to the wallet to sign.
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].actAs).toEqual(["alice::1220a"]);
  });

  it("falls back to transactionHash when updateId is absent", async () => {
    fake = fakeClient({ transactionHash: "tx-hash-9" });
    const p = ctx();
    await p.connect();
    const res = await p.submit(swapIntent);
    expect(res.primaryCid).toBe("tx-hash-9");
  });

  it("rejects submit when not connected", async () => {
    fake = fakeClient({ updateId: "u" });
    const p = ctx();
    await expect(p.submit(swapIntent)).rejects.toThrow(/not connected/);
  });

  it("disconnect resets status", async () => {
    fake = fakeClient({ updateId: "u" });
    const p = ctx();
    await p.connect();
    await p.disconnect();
    expect(p.getStatus().kind).toBe("disconnected");
  });
});
