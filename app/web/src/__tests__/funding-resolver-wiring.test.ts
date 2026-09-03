import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Holding } from "@/types/contracts";
import type { WalletProvider } from "@/wallet/types";

// Proves the swap/order funding path (normalizeSwapFunding) sources its
// spendable cids from the provider's resolveSpendableHoldings resolver — the
// interface→concrete-template path — rather than the whole-portfolio read.

const OWNER = "alice::1220a";
let providerMock: Partial<WalletProvider>;

vi.mock("@/wallet/store", () => ({
  useWalletStore: {
    getState: () => ({ activeProviderId: "partylayer", account: { party: OWNER } }),
  },
}));
vi.mock("@/wallet/registry", () => ({
  getProvider: () => providerMock,
}));
// External wallet: no admin co-sign, so funding takes the exact/covering-subset
// path over the resolver's holdings (never split/merge).
vi.mock("@/wallet/capabilities", () => ({ coSignsAdmin: () => false }));

import { normalizeSwapFunding } from "@/services/ledger";

const h = (contractId: string, amountRaw: string): Holding => ({
  contractId,
  owner: OWNER,
  admin: "cc-admin",
  instrumentId: "Amulet",
  amount: Number(amountRaw),
  amountRaw,
  locked: false,
});

beforeEach(() => {
  providerMock = {};
});

describe("normalizeSwapFunding funding path", () => {
  it("funds from the provider's spendable resolver for the target instrument", async () => {
    providerMock = {
      resolveSpendableHoldings: vi.fn(async () => [h("00realccid", "2.5000000000")]),
    };

    const cids = await normalizeSwapFunding({
      admin: "cc-admin",
      party: OWNER,
      instrumentId: "Amulet",
      amount: "2.5",
    });

    expect(cids).toEqual(["00realccid"]);
    expect(providerMock.resolveSpendableHoldings).toHaveBeenCalledWith(OWNER, {
      admin: "cc-admin",
      id: "Amulet",
    });
  });

  it("reports insufficient balance when the resolver returns nothing", async () => {
    providerMock = { resolveSpendableHoldings: vi.fn(async () => []) };

    const cids = await normalizeSwapFunding({
      admin: "cc-admin",
      party: OWNER,
      instrumentId: "Amulet",
      amount: "2.5",
    });

    expect(cids).toBeNull();
  });
});
