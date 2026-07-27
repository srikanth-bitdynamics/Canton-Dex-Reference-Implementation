import { describe, it, expect, vi, beforeEach } from "vitest";

import type { DetectedWallet, WalletProvider } from "@/wallet/types";

// discoverWallets() reads the provider registry + the default-provider id, so we
// mock the registry module and drive it with fake providers. capabilities.ts is
// left real so the "other providers become one row" mapping is exercised end to
// end.
const reg = vi.hoisted(() => ({
  map: new Map<string, WalletProvider>(),
  defaultId: null as string | null,
}));

vi.mock("@/wallet/registry", () => ({
  getProviders: () => reg.map,
  get DEFAULT_PROVIDER_ID() {
    return reg.defaultId;
  },
}));

import { discoverWallets } from "@/wallet/detection";

function detectionProvider(
  id: string,
  wallets: DetectedWallet[],
): WalletProvider {
  return {
    id,
    label: id,
    listWallets: vi.fn(async () => wallets),
    connect: vi.fn(),
    disconnect: vi.fn(),
    getStatus: vi.fn(() => ({ kind: "disconnected" }) as const),
    onStatusChange: vi.fn(() => () => {}),
    submit: vi.fn(),
  } as unknown as WalletProvider;
}

function simpleProvider(id: string, label: string): WalletProvider {
  return {
    id,
    label,
    connect: vi.fn(),
    disconnect: vi.fn(),
    getStatus: vi.fn(() => ({ kind: "disconnected" }) as const),
    onStatusChange: vi.fn(() => () => {}),
    submit: vi.fn(),
  } as unknown as WalletProvider;
}

const gatewayWallet: DetectedWallet = {
  id: "sdk:remote:gw",
  providerId: "sdk",
  walletId: "remote:gw",
  name: "Canton wallet gateway",
  installed: true,
  badge: "Gateway",
};
const loopWallet: DetectedWallet = {
  id: "partylayer:loop",
  providerId: "partylayer",
  walletId: "loop",
  name: "Loop",
  installed: true,
  badge: "Loop",
};

describe("discoverWallets", () => {
  beforeEach(() => {
    reg.map = new Map();
    reg.defaultId = null;
  });

  it("merges detected wallets from every detection-capable provider", async () => {
    reg.map.set("sdk", detectionProvider("sdk", [gatewayWallet]));
    reg.map.set("partylayer", detectionProvider("partylayer", [loopWallet]));

    const rows = await discoverWallets();
    expect(rows.map((r) => r.id)).toEqual(["sdk:remote:gw", "partylayer:loop"]);
    expect(rows[0]).toMatchObject({ providerId: "sdk", walletId: "remote:gw", badge: "Gateway" });
    expect(rows[1]).toMatchObject({ providerId: "partylayer", walletId: "loop", badge: "Loop" });
  });

  it("appends non-detection providers as single rows with their capability note", async () => {
    reg.map.set("sdk", detectionProvider("sdk", [gatewayWallet]));
    reg.map.set("walletconnect", simpleProvider("walletconnect", "WalletConnect"));
    reg.map.set("token-standard", simpleProvider("token-standard", "Operator relay (dev)"));

    const rows = await discoverWallets();
    const wc = rows.find((r) => r.id === "provider:walletconnect");
    const relay = rows.find((r) => r.id === "provider:token-standard");
    expect(wc).toMatchObject({ providerId: "walletconnect" });
    expect(wc?.walletId).toBeUndefined();
    // token-standard is dev-only in the capability table.
    expect(relay).toMatchObject({ providerId: "token-standard", devOnly: true, badge: "Dev" });
  });

  it("hides not-installed catalog entries by default", async () => {
    reg.map.set(
      "partylayer",
      detectionProvider("partylayer", [
        loopWallet,
        {
          id: "partylayer:console",
          providerId: "partylayer",
          walletId: "console",
          name: "Console",
          installed: false,
          installUrl: "https://console.example",
          badge: "Hosted",
        },
      ]),
    );
    const rows = await discoverWallets();
    expect(rows.map((r) => r.id)).toEqual(["partylayer:loop"]);
  });

  it("dedupes wallets that surface with the same id", async () => {
    reg.map.set("sdk", detectionProvider("sdk", [gatewayWallet]));
    reg.map.set("dup", detectionProvider("dup", [gatewayWallet]));
    const rows = await discoverWallets();
    expect(rows.filter((r) => r.id === "sdk:remote:gw")).toHaveLength(1);
  });

  it("marks the default provider's rows as recommended", async () => {
    reg.defaultId = "partylayer";
    reg.map.set("partylayer", detectionProvider("partylayer", [loopWallet]));
    const rows = await discoverWallets();
    expect(rows[0]?.recommended).toBe(true);
  });

  it("recommends exactly one (first installed) wallet of a multi-wallet default provider", async () => {
    reg.defaultId = "partylayer";
    reg.map.set(
      "partylayer",
      detectionProvider("partylayer", [
        {
          id: "partylayer:console",
          providerId: "partylayer",
          walletId: "console",
          name: "Console",
          installed: false,
          badge: "Hosted",
          installUrl: "https://console.example",
        },
        loopWallet, // installed
        {
          id: "partylayer:cantor8",
          providerId: "partylayer",
          walletId: "cantor8",
          name: "Cantor8",
          installed: true,
          badge: "Hosted",
        },
      ]),
    );
    const rows = await discoverWallets();
    const recommended = rows.filter((r) => r.recommended);
    expect(recommended).toHaveLength(1);
    // Console is not-installed (hidden by default anyway); Loop, the first
    // installed default-provider wallet, is the single recommended row.
    expect(recommended[0]?.walletId).toBe("loop");
  });

  it("survives a provider whose discovery throws", async () => {
    const boom = detectionProvider("boom", []);
    (boom.listWallets as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("sdk load failed"));
    reg.map.set("boom", boom);
    reg.map.set("sdk", detectionProvider("sdk", [gatewayWallet]));
    const rows = await discoverWallets();
    expect(rows.map((r) => r.id)).toContain("sdk:remote:gw");
  });
});
