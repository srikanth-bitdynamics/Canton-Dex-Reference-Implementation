import { describe, it, expect, vi, beforeEach } from "vitest";

import type { RequestSwapIntent, WalletIntent } from "@/wallet/types";

// SdkProvider owns a private DappSDK instance (with a custom walletPicker) and
// a RemoteAdapter for the configured gateway. We mock those two classes so every
// instance delegates to the shared `sdk` mock fns; vi.hoisted keeps the fns +
// captured listeners addressable from both the factory and the tests. These
// cover the easy-to-regress behaviours: the result shape (updateId-only),
// disclosure forwarding, and the nested connection.isConnected disconnect signal.
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
  // When set, the mock DappSDK.connect first invokes the provider's walletPicker
  // with these entries — exercising the routing/rejection logic in pickWallet.
  pickerEntries: undefined as
    | undefined
    | Array<{ providerId: string; name: string; type: string }>,
}));

vi.mock("@canton-network/dapp-sdk", () => ({
  DappSDK: class {
    private readonly walletPicker?: (entries: unknown[]) => Promise<unknown>;
    constructor(opts?: { walletPicker?: (entries: unknown[]) => Promise<unknown> }) {
      this.walletPicker = opts?.walletPicker;
    }
    init = sdk.init;
    connect = async () => {
      if (sdk.pickerEntries) await this.walletPicker?.(sdk.pickerEntries);
      return sdk.connect();
    };
    disconnect = sdk.disconnect;
    listAccounts = sdk.listAccounts;
    prepareExecuteAndWait = sdk.prepareExecuteAndWait;
    open = vi.fn(async () => {});
    onStatusChanged = (cb: (e: unknown) => void) => { sdk.statusListeners.push(cb); };
    onAccountsChanged = (cb: (e: unknown) => void) => { sdk.accountsListeners.push(cb); };
    removeOnStatusChanged = sdk.removeOnStatusChanged;
    removeOnAccountsChanged = sdk.removeOnAccountsChanged;
  },
  RemoteAdapter: class {
    constructor(private readonly config: { providerId: string }) {}
    get providerId(): string {
      return this.config.providerId;
    }
  },
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
    sdk.pickerEntries = undefined;
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

  it("listWallets() surfaces the configured gateway as a Gateway row", async () => {
    const provider = new SdkProvider("#canton-dex-trading", {
      gatewayUrl: "http://gw.example/api/v0/dapp",
      gatewayName: "Example gateway",
    });
    const wallets = await provider.listWallets();
    // No window.canton / announced extensions in jsdom, so only the gateway.
    expect(wallets).toContainEqual(
      expect.objectContaining({
        providerId: "sdk",
        walletId: "remote:http://gw.example/api/v0/dapp",
        name: "Example gateway",
        badge: "Gateway",
        installed: true,
      }),
    );
  });

  it("fails the connect (not silently routes to the gateway) when the picked wallet is gone", async () => {
    const provider = new SdkProvider("#canton-dex-trading", {
      gatewayUrl: "http://gw.example/api/v0/dapp",
    });
    // SDK offers only the gateway, but the user picked an injected wallet that
    // is no longer present. pickWallet must reject, not connect the gateway.
    sdk.pickerEntries = [
      { providerId: "remote:http://gw.example/api/v0/dapp", name: "gw", type: "remote" },
    ];
    await expect(provider.connect("browser:canton")).rejects.toThrow(/no longer available/);
    expect(sdk.listAccounts).not.toHaveBeenCalled();
  });

  it("translates the SDK's opaque picker error into a gateway-unreachable message", async () => {
    const provider = new SdkProvider("#canton-dex-trading", {
      gatewayUrl: "http://gw.example/api/v0/dapp",
    });
    // The SDK masks a gateway-side failure as "Wallet picker is not open".
    sdk.connect.mockRejectedValueOnce(new Error("Wallet picker is not open"));
    const fetchMock = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(provider.connect()).rejects.toThrow(/not reachable/);
      const status = provider.getStatus();
      expect(status.kind).toBe("error");
      expect((status as { message: string }).message).toMatch(/not reachable/);
    } finally {
      vi.unstubAllGlobals();
    }
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
