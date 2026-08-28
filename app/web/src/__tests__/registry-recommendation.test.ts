import { afterEach, describe, expect, it, vi } from "vitest";

async function recommendation(env: {
  sdk?: string;
  partyLayer?: string;
  walletConnect?: string;
}) {
  vi.resetModules();
  vi.stubEnv("VITE_ENABLE_SDK", env.sdk ?? "0");
  vi.stubEnv("VITE_ENABLE_PARTYLAYER", env.partyLayer ?? "0");
  vi.stubEnv("VITE_WC_PROJECT_ID", env.walletConnect ?? "");
  return (await import("@/wallet/registry")).DEFAULT_PROVIDER_ID;
}

describe("production-facing wallet recommendation order", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers the DvP-ready dapp SDK when every adapter is enabled", async () => {
    await expect(
      recommendation({ sdk: "1", partyLayer: "1", walletConnect: "project" }),
    ).resolves.toBe("sdk");
  });

  it("falls through to PartyLayer, then WalletConnect", async () => {
    await expect(
      recommendation({ partyLayer: "1", walletConnect: "project" }),
    ).resolves.toBe("partylayer");
    await expect(recommendation({ walletConnect: "project" })).resolves.toBe(
      "walletconnect",
    );
  });
});
