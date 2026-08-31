import { describe, it, expect, vi, beforeEach } from "vitest";

import type { RequestSwapIntent } from "@/wallet/types";

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
  // Returns the parsed ledger ACS response as an object (not a JSON string).
  ledgerApi: vi.fn(async (_params: { body?: { interfaceId?: string; templateId?: string } }) => ({}) as Record<string, unknown>),
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
    ledgerApi = sdk.ledgerApi;
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

const emptyArgs = { context: { values: {} }, meta: { values: {} } };
const swapSettlement = {
  executors: ["op::1"], id: "DexPool", cid: "pool1234567890", meta: { values: {} },
};
const opAccount = { owner: "op::1", provider: null, id: "" };
const alice = { owner: "alice::1220a", provider: null, id: "" };
const swapInLeg: RequestSwapIntent["allocations"][number]["transferLegSides"][number] = {
  transferLegId: "swap-in", side: "SenderSide", otherside: opAccount, amount: "0.1",
  instrumentId: "Amulet", meta: { values: {} },
};
const swapOutLeg: RequestSwapIntent["allocations"][number]["transferLegSides"][number] = {
  transferLegId: "swap-out-0", side: "ReceiverSide", otherside: opAccount, amount: "1974.31",
  instrumentId: "USDCx", meta: { values: {} },
};

// Single-admin: one combined spec with both swap-in and swap-out.
const swapIntent: RequestSwapIntent = {
  kind: "request-swap",
  poolId: "pool1234567890",
  requestCid: "swapReqSINGLE",
  settlement: swapSettlement,
  allocations: [
    {
      admin: "ad::1", authorizer: alice, transferLegSides: [swapInLeg, swapOutLeg],
      settlementDeadline: null, nextIterationFunding: null, committed: false, meta: { values: {} },
    },
  ],
  requestedAt: "2026-05-19T12:00:00.000Z",
  factoryCids: ["factory1"],
  allocationFactoryExtraArgs: [emptyArgs],
  allocationRequestExtraArgs: emptyArgs,
  disclosure: [
    { contractId: "#ctx:0", templateId: "Registry:Context", createdEventBlob: "blob" },
  ],
  inputHoldingCids: ["h1"],
};

// Cross-admin: swap-in under the input admin, swap-out receipt under the output.
const crossAdminSwapIntent: RequestSwapIntent = {
  kind: "request-swap",
  poolId: "pool1234567890",
  requestCid: "swapReqXADMIN",
  settlement: swapSettlement,
  allocations: [
    {
      admin: "cc-admin", authorizer: alice, transferLegSides: [swapInLeg],
      settlementDeadline: null, nextIterationFunding: null, committed: false, meta: { values: {} },
    },
    {
      admin: "usdc-admin", authorizer: alice, transferLegSides: [swapOutLeg],
      settlementDeadline: null, nextIterationFunding: null, committed: false, meta: { values: {} },
    },
  ],
  requestedAt: "2026-05-19T12:00:00.000Z",
  factoryCids: ["ccFactory", "usdcFactory"],
  allocationFactoryExtraArgs: [emptyArgs, emptyArgs],
  allocationRequestExtraArgs: emptyArgs,
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
    sdk.ledgerApi.mockClear().mockResolvedValue({});
    sdk.pickerEntries = undefined;
  });

  it("submit() returns an updateId-only result (no client-side cid extraction)", async () => {
    const provider = new SdkProvider("#canton-dex-trading-v2");
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

  it("submits a cross-admin (2-allocation) batch as one updateId-only command", async () => {
    const provider = new SdkProvider("#canton-dex-trading-v2");
    await provider.connect();
    const res = await provider.submit(crossAdminSwapIntent);
    // updateId-only: the operator recovers BOTH created allocation cids from it.
    expect(res.auxiliaryCids?.updateId).toBe("update-xyz");
    expect(res.createdAllocationCids).toBeUndefined();
    const params = sdk.prepareExecuteAndWait.mock.calls[0]![0] as { commands: unknown[] };
    // A cross-admin swap is still ONE top-level BatchingUtilityV2 command.
    expect(params.commands).toHaveLength(1);
    const cmd = (params.commands[0] as {
      CreateAndExerciseCommand: { choice: string; choiceArgument: { actions: { tag: string }[] } };
    }).CreateAndExerciseCommand;
    expect(cmd.choice).toBe("BatchingUtility_ExecuteBatch");
    // Accept the request, then one allocate per admin (two here).
    expect(cmd.choiceArgument.actions.map((a) => a.tag)).toEqual([
      "TSA_AllocationRequest_AcceptV2",
      "TSA_AllocationFactory_AllocateV2",
      "TSA_AllocationFactory_AllocateV2",
    ]);
  });

  it("submit() forwards disclosedContracts to prepareExecuteAndWait", async () => {
    const provider = new SdkProvider("#canton-dex-trading-v2");
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
    const provider = new SdkProvider("#canton-dex-trading-v2");
    await provider.connect();
    await expect(provider.submit(swapIntent)).rejects.toThrow(/no updateId/);
  });

  it("detects a wallet-side disconnect via connection.isConnected", async () => {
    const provider = new SdkProvider("#canton-dex-trading-v2");
    await provider.connect();
    expect(provider.getStatus().kind).toBe("connected");
    // The SDK exposes connection state under StatusEvent.connection.
    sdk.statusListeners[0]!({ connection: { isConnected: false } });
    expect(provider.getStatus().kind).toBe("disconnected");
  });

  it("listWallets() surfaces the configured gateway as a Gateway row", async () => {
    const provider = new SdkProvider("#canton-dex-trading-v2", {
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
    const provider = new SdkProvider("#canton-dex-trading-v2", {
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
    const provider = new SdkProvider("#canton-dex-trading-v2", {
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

  it("discovers a foreign-registry holding across the interface + template reads", async () => {
    // The token-standard Holding interface surfaces the Amulet holding (issued
    // by cc-admin) via its interface view; the DEX Registry.V2 template read
    // surfaces the USDCx one via createArgument. Both come from
    // /v2/state/active-contracts at the ledger-end offset, not the /acs shorthand.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sdk.ledgerApi.mockImplementation(async (params: any) => {
      if (params.resource === "/v2/state/ledger-end") return { offset: 42 };
      const cumulative =
        params.body?.filter?.filtersByParty?.["alice::1220a"]?.cumulative?.[0];
      const identifierFilter = cumulative?.identifierFilter ?? {};
      if (identifierFilter.InterfaceFilter) {
        return {
          activeContracts: [
            {
              contractId: "holding-amulet",
              interfaceViews: [
                {
                  interfaceId:
                    "#splice-api-token-holding-v2:Splice.Api.Token.HoldingV2:Holding",
                  viewValue: {
                    account: { owner: "alice::1220a", provider: null, id: "" },
                    instrumentId: { admin: "cc-admin", id: "Amulet" },
                    amount: "1.0000000000",
                    lock: null,
                  },
                },
              ],
            },
          ],
        };
      }
      return {
        activeContracts: [
          {
            contractId: "holding-usdcx",
            createArgument: {
              owner: "alice::1220a",
              admin: "dex-admin",
              instrumentId: "USDCx",
              amount: "12.5000000000",
              locked: false,
            },
          },
        ],
      };
    });

    const provider = new SdkProvider("#canton-dex-trading-v2");
    await provider.connect();
    const holdings = await provider.listHoldings("alice::1220a");

    // ledger-end fetched, then one active-contracts read per filter.
    expect(sdk.ledgerApi).toHaveBeenCalledTimes(3);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calls = sdk.ledgerApi.mock.calls.map((c) => c[0] as any);
    expect(calls[0]).toMatchObject({
      requestMethod: "get",
      resource: "/v2/state/ledger-end",
    });
    const acsCalls = calls.filter((c) => c.resource === "/v2/state/active-contracts");
    expect(acsCalls).toHaveLength(2);
    for (const c of acsCalls) {
      expect(c.requestMethod).toBe("post");
      expect(c.body.activeAtOffset).toBe(42);
      expect(Object.keys(c.body.filter.filtersByParty)).toEqual(["alice::1220a"]);
    }
    const identifierFilters = acsCalls.map(
      (c) => c.body.filter.filtersByParty["alice::1220a"].cumulative[0].identifierFilter,
    );
    expect(
      identifierFilters.some(
        (f) =>
          f.InterfaceFilter?.value?.interfaceId ===
            "#splice-api-token-holding-v2:Splice.Api.Token.HoldingV2:Holding" &&
          f.InterfaceFilter?.value?.includeInterfaceView === true,
      ),
    ).toBe(true);
    expect(
      identifierFilters.some(
        (f) =>
          f.TemplateFilter?.value?.templateId ===
          "#canton-dex-trading-v2:CantonDex.Registry.V2:Holding",
      ),
    ).toBe(true);
    expect(holdings).toEqual([
      {
        contractId: "holding-amulet",
        owner: "alice::1220a",
        admin: "cc-admin",
        instrumentId: "Amulet",
        amount: 1,
        amountRaw: "1.0000000000",
        locked: false,
      },
      {
        contractId: "holding-usdcx",
        owner: "alice::1220a",
        admin: "dex-admin",
        instrumentId: "USDCx",
        amount: 12.5,
        amountRaw: "12.5000000000",
        locked: false,
      },
    ]);
  });

  it("re-wires event listeners after a reconnect", async () => {
    const provider = new SdkProvider("#canton-dex-trading-v2");
    await provider.connect();
    await provider.disconnect();
    await provider.connect();
    // A disconnect removes the old listeners; reconnecting must subscribe the
    // replacement client to status and account events.
    expect(sdk.statusListeners.length).toBe(2);
    expect(sdk.removeOnStatusChanged).toHaveBeenCalled();
  });
});
