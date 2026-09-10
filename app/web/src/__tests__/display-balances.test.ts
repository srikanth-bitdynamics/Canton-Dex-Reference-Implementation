import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Holding } from "@/types/contracts";
import type { WalletProvider } from "@/wallet/types";

// ledger.getBalances reads the wallet's native aggregate (getBalances) for
// DISPLAY, and derives an aggregate from discovered holdings only when the
// wallet exposes none. Mock the store + registry so no real provider/network
// is touched.

const OWNER = "alice::1220a";
let activeProviderId: string | null = "partylayer";
let providerMock: Partial<WalletProvider>;

vi.mock("@/wallet/store", () => ({
  useWalletStore: {
    getState: () => ({ activeProviderId, account: { party: OWNER } }),
  },
}));

vi.mock("@/wallet/registry", () => ({
  getProvider: () => providerMock,
}));

import { ledger } from "@/services/ledger";

const h = (
  contractId: string,
  amount: number,
  admin: string,
  instrumentId: string,
  locked = false,
): Holding => ({ contractId, owner: OWNER, admin, instrumentId, amount, locked });

beforeEach(() => {
  activeProviderId = "partylayer";
  providerMock = {};
});

describe("ledger.getBalances (display path)", () => {
  it("prefers the wallet's native aggregate balances when present", async () => {
    const aggregate = [
      { instrumentId: { admin: "cc", id: "Amulet" }, available: 10, locked: 2 },
    ];
    providerMock = {
      getBalances: vi.fn(async () => aggregate),
      // A spendable resolver must NOT be consulted for display.
      resolveSpendableHoldings: vi.fn(async () => {
        throw new Error("resolver must not be used for display");
      }),
    };

    const balances = await ledger.getBalances(OWNER);

    expect(balances).toEqual(aggregate);
    expect(providerMock.getBalances).toHaveBeenCalledWith(OWNER);
    expect(providerMock.resolveSpendableHoldings).not.toHaveBeenCalled();
  });

  it("derives an aggregate from discovered holdings when the wallet exposes no native aggregate", async () => {
    providerMock = {
      listHoldings: vi.fn(async () => [
        h("a", 5, "cc", "Amulet"),
        h("b", 2, "cc", "Amulet", true),
        h("c", 1, "dx", "USDCx"),
      ]),
    };

    const balances = await ledger.getBalances(OWNER);

    expect(balances).toEqual([
      { instrumentId: { admin: "cc", id: "Amulet" }, available: 5, locked: 2 },
      { instrumentId: { admin: "dx", id: "USDCx" }, available: 1, locked: 0 },
    ]);
  });

  it("falls back to deriving from holdings when the native aggregate is empty", async () => {
    providerMock = {
      getBalances: vi.fn(async () => []),
      listHoldings: vi.fn(async () => [h("a", 4, "cc", "Amulet")]),
    };

    const balances = await ledger.getBalances(OWNER);

    expect(balances).toEqual([
      { instrumentId: { admin: "cc", id: "Amulet" }, available: 4, locked: 0 },
    ]);
    expect(providerMock.getBalances).toHaveBeenCalled();
    expect(providerMock.listHoldings).toHaveBeenCalled();
  });
});
