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

import { normalizeSwapFunding, resolveCoveringFundingCids } from "@/services/ledger";

const h = (contractId: string, amountRaw: string): Holding => ({
  contractId,
  owner: OWNER,
  admin: "cc-admin",
  instrumentId: "Amulet",
  amount: Number(amountRaw),
  amountRaw,
  locked: false,
});

describe("liquidity funding resolution", () => {
  const request = { party: OWNER, admin: "usdc-admin", instrumentId: "USDCx", amount: "1" };
  const usdc = (amountRaw: string): Holding => ({
    ...h("00usdc", amountRaw), admin: request.admin, instrumentId: request.instrumentId,
  });

  it("returns a covering USDCx holding to the liquidity flow", async () => {
    providerMock = { resolveSpendableHoldings: vi.fn(async () => [usdc("1.5")]) };
    await expect(resolveCoveringFundingCids(request)).resolves.toEqual(["00usdc"]);
  });

  it.each([
    { holdings: [] },
    { holdings: [usdc("0.5")] },
    { holdings: [{ ...usdc("2"), locked: true }] },
    { holdings: [{ ...usdc("2"), admin: "another-issuer" }] },
  ])("rejects missing or insufficient spendable USDCx instead of returning empty funding", async ({ holdings }) => {
    providerMock = { resolveSpendableHoldings: vi.fn(async () => holdings) };
    await expect(resolveCoveringFundingCids(request)).rejects.toThrow(/Cannot fund 1 USDCx/);
  });
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
