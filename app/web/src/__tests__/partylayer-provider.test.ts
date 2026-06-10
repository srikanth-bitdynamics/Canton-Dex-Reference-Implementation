import { describe, it, expect } from "vitest";

import {
  DEFAULT_PARTYLAYER_CONNECT_TIMEOUT_MS,
  PartyLayerProvider,
  parsePartyLayerHoldings,
  type PartyLayerClient,
} from "@/wallet/partylayer-provider";
import type { WalletIntent } from "@/wallet/types";

// A fake @partylayer/sdk client: records the submitted command tree and returns
// an updateId-only receipt, matching the provider contract.
function fakeClient(receipt: { updateId?: string; transactionHash?: string }) {
  const connectCalls: unknown[] = [];
  const calls: Array<Parameters<PartyLayerClient["submitTransaction"]>[0]> = [];
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
      calls.push(params);
      return receipt;
    },
    async ledgerApi(params) {
      ledgerApiCalls.push(params);
      const filter = JSON.parse(params.body ?? "{}") as {
        interfaceId?: string;
        templateId?: string;
      };
      if (filter.interfaceId) {
        return {
          response: JSON.stringify({
            activeContracts: [
              {
                contractId: "holding-cbtc",
                view: {
                  account: { owner: "alice::1220a", provider: null, id: "" },
                  instrumentId: { admin: "cbtc-admin", id: "CBTC" },
                  amount: "1.0000000000",
                  lock: null,
                },
              },
              {
                contractId: "holding-1",
                createArgument: {
                  owner: "alice::1220a",
                  admin: "dex-admin",
                  instrumentId: "BTC",
                  amount: "0.3350000000",
                  locked: false,
                },
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
                instrumentId: "BTC",
                amount: "0.3350000000",
                locked: false,
              },
            },
          ],
        }),
      };
    },
  };
  return { client, calls, connectCalls, ledgerApiCalls, isConnected: () => connected };
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
    expect(fake.connectCalls[0]).toMatchObject({
      requiredCapabilities: ["submitTransaction", "ledgerApi"],
      preferInstalled: true,
      timeoutMs: DEFAULT_PARTYLAYER_CONNECT_TIMEOUT_MS,
    });
  });

  it("allows the connect timeout to be overridden", async () => {
    fake = fakeClient({ updateId: "u-1" });
    const p = new PartyLayerProvider("#canton-dex-trading", async () => fake.client, 240_000);
    await p.connect();
    expect(fake.connectCalls[0]).toMatchObject({ timeoutMs: 240_000 });
  });

  it("disconnects the SDK client after a failed connect attempt", async () => {
    const f = failingClient(new Error("connect timed out"));
    const p = new PartyLayerProvider("#canton-dex-trading", async () => f.client);
    await expect(p.connect()).rejects.toThrow(/connect timed out/);
    expect(f.disconnectCalls).toHaveLength(1);
    expect(p.getStatus()).toMatchObject({
      kind: "error",
      message: "connect timed out",
    });
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
    expect(fake.calls[0].signedTx.actAs).toEqual(["alice::1220a"]);
    expect(fake.calls[0].signedTx.commandId).toMatch(/^swap-pool-abc-/);
    expect(fake.calls[0].signedTx.commands).toHaveLength(1);
  });

  it("rejects submit when the wallet receipt has no updateId", async () => {
    fake = fakeClient({ transactionHash: "tx-hash-9" });
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

    expect(fake.ledgerApiCalls).toHaveLength(2);
    expect(fake.ledgerApiCalls[0]).toMatchObject({
      requestMethod: "POST",
      resource: "/v2/state/acs",
    });
    expect(JSON.parse(fake.ledgerApiCalls[0].body ?? "{}")).toEqual({
      interfaceId: "#splice-api-token-holding-v2:Splice.Api.Token.HoldingV2:Holding",
    });
    expect(JSON.parse(fake.ledgerApiCalls[1].body ?? "{}")).toEqual({
      templateId: "#canton-dex-trading:CantonDex.Registry.V2:Holding",
    });
    expect(holdings).toEqual([
      {
        contractId: "holding-cbtc",
        owner: "alice::1220a",
        admin: "cbtc-admin",
        instrumentId: "CBTC",
        amount: 1,
        amountRaw: "1.0000000000",
        locked: false,
      },
      {
        contractId: "holding-1",
        owner: "alice::1220a",
        admin: "dex-admin",
        instrumentId: "BTC",
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
                    instrumentId: { admin: "dex-admin", id: "USDC" },
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
              instrumentId: "BTC",
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
        instrumentId: "USDC",
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
            contract_id: "holding-snake-cbtc",
            interface_views: {
              "#splice-api-token-holding-v2:Splice.Api.Token.HoldingV2:Holding": {
                view_value: {
                  account: { owner: "alice::1220a", provider: null, id: "" },
                  instrument_id: { instrument_admin: "cbtc-admin", id: "CBTC" },
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
        contractId: "holding-snake-cbtc",
        owner: "alice::1220a",
        admin: "cbtc-admin",
        instrumentId: "CBTC",
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
});
