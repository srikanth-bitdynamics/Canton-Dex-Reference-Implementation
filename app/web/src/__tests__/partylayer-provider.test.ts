import { describe, it, expect, vi, beforeEach } from "vitest";

// The provider submits each allocation command as its own single-command request
// (supportsMultiCommandTransaction is false) and recovers the one created cid per
// request from its updateId. Mock the recovery so tests stay backend-free; a
// counter yields distinct cids in submission order.
vi.mock("@/services/recover-allocations", () => ({
  recoverCreatedAllocationCid: vi.fn(),
}));

import {
  DEFAULT_PARTYLAYER_CONNECT_TIMEOUT_MS,
  PartyLayerProvider,
  parsePartyLayerHoldings,
  type PartyLayerClient,
  type PartyLayerCommandSubmission,
  type PartyLayerTxReceipt,
} from "@/wallet/partylayer-provider";
import { recoverCreatedAllocationCid } from "@/services/recover-allocations";
import type { AddLiquidityIntent, RequestSwapIntent } from "@/wallet/types";

const recoverMock = vi.mocked(recoverCreatedAllocationCid);

// A fake @partylayer/sdk client. submitOne submits through the SDK
// submitTransaction method (the path that drives the wallet signing tab), so the
// fake records the submitted command trees and answers with a receipt carrying
// the committed updateId. ACS reads over ledgerApi are answered as before.
function fakeClient(
  receipt: PartyLayerTxReceipt = { updateId: "00feed", transactionHash: "h" },
) {
  const connectCalls: unknown[] = [];
  const submitCalls: PartyLayerCommandSubmission[] = [];
  const ledgerApiCalls: Array<Parameters<PartyLayerClient["ledgerApi"]>[0]> = [];
  let connected = false;
  const client: PartyLayerClient = {
    async connect(options) {
      connectCalls.push(options);
      connected = true;
      return { partyId: "alice::1220a", label: "Alice" };
    },
    async disconnect() {
      connected = false;
    },
    async submitTransaction(params) {
      submitCalls.push(params.signedTx);
      return receipt;
    },
    async ledgerApi(params) {
      ledgerApiCalls.push(params);
      if (params.resource === "/v2/state/ledger-end") {
        return { response: JSON.stringify({ offset: 3 }) };
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = JSON.parse(params.body ?? "{}") as any;
      const identifierFilter =
        body.filter.filtersByParty["alice::1220a"].cumulative[0].identifierFilter;
      if (identifierFilter.InterfaceFilter) {
        return {
          response: JSON.stringify({
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
          }),
        };
      }
      return {
        response: JSON.stringify({
          activeContracts: [
            {
              contractId: "holding-1",
              createArgument: {
                owner: "alice::1220a",
                admin: "dex-admin",
                instrumentId: "USDCx",
                amount: "0.3350000000",
                locked: false,
              },
            },
          ],
        }),
      };
    },
  };
  return { client, submitCalls, connectCalls, ledgerApiCalls, isConnected: () => connected };
}

function failingClient(error: Error) {
  const disconnectCalls: unknown[] = [];
  const client: PartyLayerClient = {
    async connect() {
      throw error;
    },
    async disconnect() {
      disconnectCalls.push(null);
    },
    async submitTransaction() {
      return {};
    },
    async ledgerApi() {
      return { response: JSON.stringify({ activeContracts: [] }) };
    },
  };
  return { client, disconnectCalls };
}

const emptyArgs = { context: { values: {} }, meta: { values: {} } };
const alice = { owner: "alice::1220a", provider: null, id: "" };
const opAccount = { owner: "op", provider: null, id: "" };
const swapInLeg: RequestSwapIntent["allocations"][number]["transferLegSides"][number] = {
  transferLegId: "swap-in", side: "SenderSide", otherside: opAccount, amount: "0.1",
  instrumentId: "Amulet", meta: { values: {} },
};
const swapOutLeg: RequestSwapIntent["allocations"][number]["transferLegSides"][number] = {
  transferLegId: "swap-out-0", side: "ReceiverSide", otherside: opAccount, amount: "1974.31",
  instrumentId: "USDCx", meta: { values: {} },
};

// Single-admin: one combined spec.
const swapIntent: RequestSwapIntent = {
  kind: "request-swap",
  poolId: "pool-abc",
  requestCid: "swapReqSINGLE",
  settlement: { executors: ["op"], id: "s", cid: null, meta: { values: {} } },
  allocations: [
    {
      admin: "admin", authorizer: alice, transferLegSides: [swapInLeg, swapOutLeg],
      settlementDeadline: null, nextIterationFunding: null, committed: false, meta: { values: {} },
    },
  ],
  requestedAt: "2026-05-19T12:00:00.000Z",
  factoryCids: ["fac"],
  allocationFactoryExtraArgs: [emptyArgs],
  allocationRequestExtraArgs: emptyArgs,
  inputHoldingCids: ["h1"],
  disclosure: [],
};

// Cross-admin: swap-in under the input admin, swap-out receipt under the output.
const crossAdminSwapIntent: RequestSwapIntent = {
  kind: "request-swap",
  poolId: "pool-abc",
  requestCid: "swapReqXADMIN",
  settlement: { executors: ["op"], id: "s", cid: null, meta: { values: {} } },
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
  inputHoldingCids: ["h1"],
  disclosure: [],
};

// DvP add: three allocations (base deposit, quote deposit, LP receipt) authored
// as three separate single-command requests.
const lpBaseLeg = { ...swapInLeg, transferLegId: "lp-base", instrumentId: "Amulet" };
const lpQuoteLeg = { ...swapInLeg, transferLegId: "lp-quote", instrumentId: "USDCx" };
const lpReceiptLeg = {
  ...swapOutLeg, transferLegId: "lp-mint", side: "ReceiverSide" as const, instrumentId: "AMM-LP",
};
const addLiquidityIntent: AddLiquidityIntent = {
  kind: "add-liquidity",
  requestCid: "lpReqABCDEFGH",
  settlement: { executors: ["op"], id: "lp-s", cid: null, meta: { values: {} } },
  allocations: [
    {
      admin: "dep-admin", authorizer: alice, transferLegSides: [lpBaseLeg],
      settlementDeadline: null, nextIterationFunding: null, committed: true, meta: { values: {} },
    },
    {
      admin: "dep-admin", authorizer: alice, transferLegSides: [lpQuoteLeg],
      settlementDeadline: null, nextIterationFunding: null, committed: true, meta: { values: {} },
    },
    {
      admin: "lp-admin", authorizer: alice, transferLegSides: [lpReceiptLeg],
      settlementDeadline: null, nextIterationFunding: null, committed: false, meta: { values: {} },
    },
  ],
  requestedAt: "2026-05-19T12:00:00.000Z",
  factoryCids: ["depF", "depF", "lpF"],
  allocationFactoryExtraArgs: [emptyArgs, emptyArgs, emptyArgs],
  allocationRequestExtraArgs: emptyArgs,
  disclosure: [],
  baseHoldingCids: ["b1"],
  quoteHoldingCids: ["q1"],
};

describe("PartyLayerProvider", () => {
  const ctx = () => new PartyLayerProvider("#canton-dex-trading-v2", async () => fake.client);
  let fake: ReturnType<typeof fakeClient>;

  beforeEach(() => {
    // Distinct recovered cids per submission, in call order.
    let n = 0;
    recoverMock.mockReset();
    recoverMock.mockImplementation(async () => `alloc-${++n}`);
  });

  it("connects and exposes the wallet party", async () => {
    fake = fakeClient({ updateId: "u-1" });
    const p = ctx();
    const acct = await p.connect();
    expect(acct.party).toBe("alice::1220a");
    expect(p.getStatus().kind).toBe("connected");
    expect(fake.connectCalls[0]).toMatchObject({
      requiredCapabilities: ["submitTransaction", "ledgerApi"],
      preferInstalled: true,
      timeoutMs: DEFAULT_PARTYLAYER_CONNECT_TIMEOUT_MS,
    });
  });

  it("allows the connect timeout to be overridden", async () => {
    fake = fakeClient({ updateId: "u-1" });
    const p = new PartyLayerProvider("#canton-dex-trading-v2", async () => fake.client, 240_000);
    await p.connect();
    expect(fake.connectCalls[0]).toMatchObject({ timeoutMs: 240_000 });
  });

  it("disconnects the SDK client after a failed connect attempt", async () => {
    const f = failingClient(new Error("connect timed out"));
    const p = new PartyLayerProvider("#canton-dex-trading-v2", async () => f.client);
    await expect(p.connect()).rejects.toThrow(/connect timed out/);
    expect(f.disconnectCalls).toHaveLength(1);
    expect(p.getStatus()).toMatchObject({
      kind: "error",
      message: "connect timed out",
    });
  });

  it("single-admin swap: one command → one updateId-only request (no split, no recover)", async () => {
    fake = fakeClient({ updateId: "00feed", transactionHash: "h" });
    const p = ctx();
    await p.connect();
    const res = await p.submit(swapIntent);
    expect(res.primaryCid).toBe("00feed");
    expect(res.auxiliaryCids?.updateId).toBe("00feed");
    // One command: nothing to split, so the updateId-only shape is kept and the
    // operator recovers the single cid at settle (operator-discovery).
    expect(res.createdAllocationCids).toBeUndefined();
    expect(recoverMock).not.toHaveBeenCalled();
    // Submit went through the SDK submit method, carrying the composed command tree.
    expect(fake.submitCalls).toHaveLength(1);
    expect(fake.submitCalls[0].actAs).toEqual(["alice::1220a"]);
    expect(fake.submitCalls[0].commandId).toMatch(/^swap-batch-/);
    expect(fake.submitCalls[0].commands).toHaveLength(1);
    expect(fake.submitCalls[0].commands[0]).toHaveProperty(
      "ExerciseCommand.choice",
      "AllocationFactory_Allocate",
    );
  });

  it("cross-admin swap: two separate single-command requests, cids aggregated in order", async () => {
    fake = fakeClient({ updateId: "00feed", transactionHash: "h" });
    const p = ctx();
    await p.connect();
    const res = await p.submit(crossAdminSwapIntent);
    // Two separate wallet requests, each carrying exactly one Allocate.
    expect(fake.submitCalls).toHaveLength(2);
    for (const call of fake.submitCalls) {
      const cmds = call.commands as Array<{ ExerciseCommand: { choice: string } }>;
      expect(cmds).toHaveLength(1);
      expect(cmds[0].ExerciseCommand.choice).toBe("AllocationFactory_Allocate");
    }
    // Distinct command ids per request (dedup on the ledger).
    expect(fake.submitCalls[0].commandId).not.toBe(fake.submitCalls[1].commandId);
    // The two recovered cids, in canonical order, are what the settle consumes,
    // recovered by the committed updateId each submit returned.
    expect(recoverMock).toHaveBeenCalledTimes(2);
    expect(recoverMock.mock.calls.map((c) => c[0])).toEqual(["00feed", "00feed"]);
    expect(recoverMock.mock.calls.map((c) => c[1])).toEqual(["alice::1220a", "alice::1220a"]);
    expect(res.createdAllocationCids).toEqual(["alloc-1", "alloc-2"]);
    expect(res.primaryCid).toBe("alloc-1");
  });

  it("add-liquidity: three separate single-command requests, three cids aggregated", async () => {
    fake = fakeClient({ updateId: "00feed", transactionHash: "h" });
    const p = ctx();
    await p.connect();
    const res = await p.submit(addLiquidityIntent);
    // Three separate wallet requests, one Allocate each, in canonical order
    // [base deposit, quote deposit, LP receipt].
    expect(fake.submitCalls).toHaveLength(3);
    for (const call of fake.submitCalls) {
      const cmds = call.commands as Array<{ ExerciseCommand: { choice: string } }>;
      expect(cmds).toHaveLength(1);
      expect(cmds[0].ExerciseCommand.choice).toBe("AllocationFactory_Allocate");
    }
    expect(new Set(fake.submitCalls.map((c) => c.commandId)).size).toBe(3);
    expect(recoverMock).toHaveBeenCalledTimes(3);
    expect(res.createdAllocationCids).toEqual(["alloc-1", "alloc-2", "alloc-3"]);
  });

  it("surfaces which allocation failed mid-sequence", async () => {
    fake = fakeClient();
    // Fail the second submit only.
    let n = 0;
    fake.client.submitTransaction = async () => {
      n += 1;
      if (n === 2) throw new Error("package not vetted");
      return { updateId: "00feed", transactionHash: "h" };
    };
    const p = ctx();
    await p.connect();
    await expect(p.submit(addLiquidityIntent)).rejects.toThrow(
      /add-liquidity: wallet request for allocation 2 of 3 failed .*package not vetted/,
    );
  });

  it("rejects submit when the receipt carries no updateId", async () => {
    fake = fakeClient({ transactionHash: "h" });
    const p = ctx();
    await p.connect();
    await expect(p.submit(swapIntent)).rejects.toThrow(/no updateId/);
  });

  it("rejects submit when not connected", async () => {
    fake = fakeClient({ updateId: "u" });
    const p = ctx();
    await expect(p.submit(swapIntent)).rejects.toThrow(/not connected/);
  });

  it("lists connected-party holdings through PartyLayer ledgerApi", async () => {
    fake = fakeClient({ updateId: "u" });
    const p = ctx();
    await p.connect();

    const holdings = await p.listHoldings("alice::1220a");

    // ledger-end fetched at GET, then one active-contracts read per filter
    // (HoldingV2 interface, HoldingV1 interface, Registry.V2 template).
    expect(fake.ledgerApiCalls).toHaveLength(4);
    expect(fake.ledgerApiCalls[0]).toMatchObject({
      requestMethod: "GET",
      resource: "/v2/state/ledger-end",
    });
    const acsCalls = fake.ledgerApiCalls.filter(
      (c) => c.resource === "/v2/state/active-contracts",
    );
    expect(acsCalls).toHaveLength(3);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const acsBodies = acsCalls.map((c) => JSON.parse(c.body ?? "{}") as any);
    for (let i = 0; i < acsCalls.length; i++) {
      expect(acsCalls[i]!.requestMethod).toBe("POST");
      expect(acsBodies[i].activeAtOffset).toBe(3);
      expect(Object.keys(acsBodies[i].filter.filtersByParty)).toEqual(["alice::1220a"]);
    }
    const identifierFilters = acsBodies.map(
      (b) => b.filter.filtersByParty["alice::1220a"].cumulative[0].identifierFilter,
    );
    expect(
      identifierFilters.some(
        (f) =>
          f.InterfaceFilter?.value?.interfaceId ===
          "#splice-api-token-holding-v2:Splice.Api.Token.HoldingV2:Holding",
      ),
    ).toBe(true);
    expect(
      identifierFilters.some(
        (f) =>
          f.InterfaceFilter?.value?.interfaceId ===
          "#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding",
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
        contractId: "holding-1",
        owner: "alice::1220a",
        admin: "dex-admin",
        instrumentId: "USDCx",
        amount: 0.335,
        amountRaw: "0.3350000000",
        locked: false,
      },
    ]);
  });

  it("parses PartyLayer ACS holding views and filters other owners", () => {
    const holdings = parsePartyLayerHoldings(
      JSON.stringify({
        result: [
          {
            contractEntry: {
              JsActiveContract: {
                createdEvent: {
                  contractId: "holding-view-1",
                  view: {
                    account: { owner: "alice::1220a", provider: null, id: "" },
                    instrumentId: { admin: "dex-admin", id: "USDCx" },
                    amount: "125.2500000000",
                    lock: null,
                  },
                },
              },
            },
          },
          {
            contractId: "other-owner",
            createArgument: {
              owner: "bob::1220b",
              admin: "dex-admin",
              instrumentId: "USDCx",
              amount: "1.0000000000",
              locked: false,
            },
          },
        ],
      }),
      "alice::1220a",
    );

    expect(holdings).toEqual([
      {
        contractId: "holding-view-1",
        owner: "alice::1220a",
        admin: "dex-admin",
        instrumentId: "USDCx",
        amount: 125.25,
        amountRaw: "125.2500000000",
        locked: false,
      },
    ]);
  });

  it("parses snake_case ACS entries with interface views", () => {
    const holdings = parsePartyLayerHoldings(
      JSON.stringify({
        active_contracts: [
          {
            contract_id: "holding-snake-amulet",
            interface_views: {
              "#splice-api-token-holding-v2:Splice.Api.Token.HoldingV2:Holding": {
                view_value: {
                  account: { owner: "alice::1220a", provider: null, id: "" },
                  instrument_id: { instrument_admin: "cc-admin", id: "Amulet" },
                  amount: "1.0000000000",
                  lock: null,
                },
              },
            },
          },
        ],
      }),
      "alice::1220a",
    );

    expect(holdings).toEqual([
      {
        contractId: "holding-snake-amulet",
        owner: "alice::1220a",
        admin: "cc-admin",
        instrumentId: "Amulet",
        amount: 1,
        amountRaw: "1.0000000000",
        locked: false,
      },
    ]);
  });

  it("disconnect resets status", async () => {
    fake = fakeClient({ updateId: "u" });
    const p = ctx();
    await p.connect();
    await p.disconnect();
    expect(p.getStatus().kind).toBe("disconnected");
  });

  it("connect(walletId) routes the chosen wallet through to the client", async () => {
    fake = fakeClient({ updateId: "u" });
    const p = ctx();
    await p.connect("loop");
    expect(fake.connectCalls[0]).toMatchObject({ walletId: "loop" });
  });

  it("connect() without a walletId omits it (client probes its configured list)", async () => {
    fake = fakeClient({ updateId: "u" });
    const p = ctx();
    await p.connect();
    expect((fake.connectCalls[0] as { walletId?: string }).walletId).toBeUndefined();
  });

  it("listWallets() maps the PartyLayer catalog into picker entries", async () => {
    const client: PartyLayerClient = {
      async connect() {
        return { partyId: "a", label: "A" };
      },
      async disconnect() {},
      async submitTransaction() {
        return {};
      },
      async ledgerApi() {
        return { response: "{}" };
      },
      async listWallets() {
        return [
          { walletId: "loop", name: "Loop", installUrl: "https://loop.example", installed: true },
          { walletId: "console", name: "Console", installed: false },
        ];
      },
    };
    const p = new PartyLayerProvider("#canton-dex-trading-v2", async () => client);
    const wallets = await p.listWallets();
    expect(wallets).toEqual([
      {
        id: "partylayer:loop",
        providerId: "partylayer",
        walletId: "loop",
        name: "Loop",
        description: undefined,
        icon: undefined,
        installed: true,
        installUrl: "https://loop.example",
        badge: "Loop",
      },
      {
        id: "partylayer:console",
        providerId: "partylayer",
        walletId: "console",
        name: "Console",
        description: undefined,
        icon: undefined,
        installed: false,
        installUrl: undefined,
        badge: "Hosted",
      },
    ]);
  });

  it("listWallets() is empty when the client cannot enumerate", async () => {
    fake = fakeClient({ updateId: "u" }); // fakeClient has no listWallets
    const p = ctx();
    expect(await p.listWallets()).toEqual([]);
  });
});
