import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TestnetHostedProvider,
  type TestnetPartyClient,
} from "@/wallet/testnet-hosted-provider";
import type { TestnetPartyResult } from "@/services/operator-api";
import type { WalletIntent } from "@/wallet/types";

// A fake operator-backend client: records the create calls and returns the
// party + airdrops the testnet route promises.
function fakeClient(result: TestnetPartyResult) {
  const calls: Array<{ label?: string }> = [];
  const client: TestnetPartyClient = {
    async createTestnetParty(req) {
      calls.push(req);
      return result;
    },
  };
  return { client, calls };
}

function failingClient(error: Error) {
  const client: TestnetPartyClient = {
    async createTestnetParty() {
      throw error;
    },
  };
  return { client };
}

const swapIntent: WalletIntent = {
  kind: "request-swap",
  poolId: "pool-abc",
  settlement: { executors: ["op"], id: "s", cid: null, meta: { values: {} } },
  allocationSpec: {
    admin: "admin",
    authorizer: { owner: "demo::1220a", provider: null, id: "" },
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

const partyResult: TestnetPartyResult = {
  partyId: "demo::1220a",
  airdrops: [{ instrumentId: "dUSD", amount: "10000" }],
};

const provider = (client: TestnetPartyClient) =>
  new TestnetHostedProvider(
    "http://backend.test",
    "#canton-dex-trading",
    client,
  );

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  window.localStorage.clear();
});

describe("TestnetHostedProvider", () => {
  it("connects by creating a party and uses the returned party id", async () => {
    const fake = fakeClient(partyResult);
    const p = provider(fake.client);

    const account = await p.connect();

    expect(account.party).toBe("demo::1220a");
    expect(p.getStatus()).toMatchObject({
      kind: "connected",
      account: { party: "demo::1220a" },
      providerId: "testnet-hosted",
    });
    expect(fake.calls).toHaveLength(1);
    expect(p.getAirdrops()).toEqual([
      { instrumentId: "dUSD", amount: "10000" },
    ]);
  });

  it("reuses the stored party instead of creating a second one", async () => {
    const first = fakeClient(partyResult);
    await provider(first.client).connect();

    const second = fakeClient({ partyId: "other::1220b", airdrops: [] });
    const rehydrated = provider(second.client);

    expect(rehydrated.getStatus().kind).toBe("connected");
    const account = await rehydrated.connect();
    expect(account.party).toBe("demo::1220a");
    expect(second.calls).toHaveLength(0);
  });

  it("surfaces a disabled testnet route as an actionable error", async () => {
    const p = provider(failingClient(new Error("404: not found")).client);

    await expect(p.connect()).rejects.toThrow(/404/);
    expect(p.getStatus()).toEqual({
      kind: "error",
      message: "Testnet party creation is not enabled on this deployment.",
    });
  });

  it("surfaces the daily cap as an actionable error", async () => {
    const p = provider(failingClient(new Error("429: cap reached")).client);

    await expect(p.connect()).rejects.toThrow(/429/);
    expect(p.getStatus()).toMatchObject({ kind: "error" });
    expect((p.getStatus() as { message: string }).message).toMatch(
      /daily limit/,
    );
  });

  it("rejects submit when not connected", async () => {
    const p = provider(fakeClient(partyResult).client);
    await expect(p.submit(swapIntent)).rejects.toThrow(/not connected/);
  });

  it("relays the composed tree and returns created cids plus the updateId", async () => {
    const p = provider(fakeClient(partyResult).client);
    await p.connect();
    const submissions: Array<{ url: string; body: Record<string, unknown> }> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        submissions.push({
          url: String(input),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return new Response(
          JSON.stringify({
            updateId: "update-1",
            createdEvents: [
              {
                contractId: "alloc-1",
                templateId: "abcd:CantonDex.Registry.V2:Allocation",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );

    const res = await p.submit(swapIntent);

    expect(submissions).toHaveLength(1);
    expect(submissions[0].url).toBe("http://backend.test/v1/wallet/submit");
    expect(submissions[0].body).toMatchObject({
      actAs: ["demo::1220a"],
      commandId: expect.stringMatching(/^swap-pool-abc-/),
    });
    expect(res).toEqual({
      submittedBy: "demo::1220a",
      primaryCid: "alloc-1",
      createdAllocationCids: ["alloc-1"],
      createdHoldingCids: undefined,
      auxiliaryCids: { updateId: "update-1" },
    });
  });

  it("falls back to operator-discovery when the relay reports no created events", async () => {
    const p = provider(fakeClient(partyResult).client);
    await p.connect();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ updateId: "update-2" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const res = await p.submit(swapIntent);

    expect(res.createdAllocationCids).toBeUndefined();
    expect(res.primaryCid).toBe("update-2");
    expect(res.auxiliaryCids?.updateId).toBe("update-2");
  });

  it("disconnect clears the stored session", async () => {
    const p = provider(fakeClient(partyResult).client);
    await p.connect();

    await p.disconnect();

    expect(p.getStatus().kind).toBe("disconnected");
    expect(window.localStorage.getItem("canton-dex:testnet-hosted:session")).toBeNull();
  });
});

describe("testnet-hosted registration", () => {
  // The registry memoizes its map at module level, so each case re-imports it
  // with the env flag stubbed.
  async function freshRegistry(flag?: string) {
    vi.resetModules();
    if (flag === undefined) {
      vi.stubEnv("VITE_ENABLE_TESTNET_PARTY", "");
    } else {
      vi.stubEnv("VITE_ENABLE_TESTNET_PARTY", flag);
    }
    return import("@/wallet/registry");
  }

  it("is absent unless VITE_ENABLE_TESTNET_PARTY=1", async () => {
    const registry = await freshRegistry();
    expect(registry.getProviders().has("testnet-hosted")).toBe(false);
    expect(() => registry.getProvider("testnet-hosted")).toThrow(
      /unknown or unavailable/,
    );
  });

  it("is registered when VITE_ENABLE_TESTNET_PARTY=1", async () => {
    const registry = await freshRegistry("1");
    const p = registry.getProvider("testnet-hosted");
    expect(p.id).toBe("testnet-hosted");
    expect(p.label).toBe("Create testnet party");
  });

  it("is never the default provider", async () => {
    const registry = await freshRegistry("1");
    expect(registry.DEFAULT_PROVIDER_ID).not.toBe("testnet-hosted");
  });
});
