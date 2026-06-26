import { describe, it, expect, vi, beforeEach } from "vitest";

import type { RequestSwapIntent, WalletIntent } from "@/wallet/types";

// SdkProvider talks to @canton-network/dapp-sdk through module-level function
// imports (not an injected client), so we mock the module surface. vi.hoisted
// keeps the mock fns + captured listeners addressable from both the factory and
// the tests. These cover the bug class the audit flagged as previously untested:
// the result shape (updateId-only), disclosure forwarding, and the nested
// connection.isConnected disconnect signal.
const sdk = vi.hoisted(() => ({
  init: vi.fn(async () => {}),
  connect: vi.fn(async () => ({ isConnected: true }) as { isConnected: boolean; reason?: string }),
  disconnect: vi.fn(async () => {}),
  listAccounts: vi.fn(async () => [
    { primary: true, partyId: "alice::1220a", hint: "Alice" },
  ]),
  prepareExecuteAndWait: vi.fn(async (_params: Record<string, unknown>) => ({
    tx: { status: "executed", commandId: "c1", payload: { updateId: "update-xyz", completionOffset: 1 } },
  })),
  removeOnStatusChanged: vi.fn(async () => {}),
  removeOnAccountsChanged: vi.fn(async () => {}),
  statusListeners: [] as Array<(e: unknown) => void>,
  accountsListeners: [] as Array<(e: unknown) => void>,
}));

vi.mock("@canton-network/dapp-sdk", () => ({
  init: sdk.init,
  connect: sdk.connect,
  disconnect: sdk.disconnect,
  listAccounts: sdk.listAccounts,
  prepareExecuteAndWait: sdk.prepareExecuteAndWait,
  onStatusChanged: (cb: (e: unknown) => void) => { sdk.statusListeners.push(cb); },
  onAccountsChanged: (cb: (e: unknown) => void) => { sdk.accountsListeners.push(cb); },
  removeOnStatusChanged: sdk.removeOnStatusChanged,
  removeOnAccountsChanged: sdk.removeOnAccountsChanged,
}));

import { SdkProvider } from "@/wallet/sdk-provider";

const swapIntent: WalletIntent = {
  kind: "request-swap",
  poolId: "pool1234567890",
  allocationSpec: {
    admin: "ad::1",
    authorizer: { owner: "alice::1220a", provider: null, id: "" },
    transferLegSides: [],
    settlementDeadline: null,
    nextIterationFunding: { USDC: "1000.0" },
    committed: false,
    meta: { values: {} },
  } as unknown as RequestSwapIntent["allocationSpec"],
  settlement: {
    executor: "op::1",
    settlementRef: { id: "DexPool", cid: "pool1234567890" },
  } as unknown as RequestSwapIntent["settlement"],
  factoryCid: "factory1",
  allocationFactoryExtraArgs: { context: { values: {} }, meta: { values: {} } },
  disclosure: [
    { contractId: "#ctx:0", templateId: "Registry:Context", createdEventBlob: "blob" },
  ],
  inputHoldingCids: ["h1"],
};

describe("SdkProvider", () => {
  beforeEach(() => {
    sdk.statusListeners.length = 0;
    sdk.accountsListeners.length = 0;
    sdk.init.mockClear();
    sdk.connect.mockClear().mockResolvedValue({ isConnected: true });
    sdk.disconnect.mockClear();
    sdk.listAccounts.mockClear().mockResolvedValue([
      { primary: true, partyId: "alice::1220a", hint: "Alice" },
    ]);
    sdk.prepareExecuteAndWait.mockClear().mockResolvedValue({
      tx: { status: "executed", commandId: "c1", payload: { updateId: "update-xyz", completionOffset: 1 } },
    });
    sdk.removeOnStatusChanged.mockClear();
    sdk.removeOnAccountsChanged.mockClear();
  });

  it("submit() returns an updateId-only result (no client-side cid extraction)", async () => {
    const provider = new SdkProvider("#canton-dex-trading");
    await provider.connect();
    const res = await provider.submit(swapIntent);
    expect(res).toEqual({
      submittedBy: "alice::1220a",
      primaryCid: "update-xyz",
      auxiliaryCids: { updateId: "update-xyz" },
    });
    // prepareExecuteAndWait carries no created events, so the provider must not
    // try to parse created allocation cids client-side.
    expect(res.createdAllocationCids).toBeUndefined();
  });

  it("submit() forwards disclosedContracts to prepareExecuteAndWait", async () => {
    const provider = new SdkProvider("#canton-dex-trading");
    await provider.connect();
    await provider.submit(swapIntent);
    const params = sdk.prepareExecuteAndWait.mock.calls[0]![0] as {
      disclosedContracts?: unknown[];
    };
    expect(params.disclosedContracts).toEqual(swapIntent.disclosure);
  });

  it("submit() throws when the wallet returns no updateId", async () => {
    sdk.prepareExecuteAndWait.mockResolvedValue({
      tx: { status: "executed", commandId: "c1", payload: { updateId: "", completionOffset: 1 } },
    });
    const provider = new SdkProvider("#canton-dex-trading");
    await provider.connect();
    await expect(provider.submit(swapIntent)).rejects.toThrow(/no updateId/);
  });

  it("detects a wallet-side disconnect via connection.isConnected", async () => {
    const provider = new SdkProvider("#canton-dex-trading");
    await provider.connect();
    expect(provider.getStatus().kind).toBe("connected");
    // The SDK emits a StatusEvent with the flag nested under .connection — the
    // bug read e.isConnected (always undefined) and never transitioned.
    sdk.statusListeners[0]!({ connection: { isConnected: false } });
    expect(provider.getStatus().kind).toBe("disconnected");
  });

  it("re-wires event listeners after a reconnect", async () => {
    const provider = new SdkProvider("#canton-dex-trading");
    await provider.connect();
    await provider.disconnect();
    await provider.connect();
    // disconnect() now tears down + nulls the listeners, so the second connect
    // re-subscribes. Before the fix, wireEvents() was skipped and the provider
    // stayed deaf to status/account events against the new client.
    expect(sdk.statusListeners.length).toBe(2);
    expect(sdk.removeOnStatusChanged).toHaveBeenCalled();
  });
});
