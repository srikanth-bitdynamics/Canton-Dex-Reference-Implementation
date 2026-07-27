import { describe, it, expect, vi, beforeEach } from "vitest";

const sdk = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  submitTransaction: vi.fn(),
  listWallets: vi.fn(),
  getAdapter: vi.fn(),
}));

vi.mock("@partylayer/sdk", () => ({
  ConsoleAdapter: class ConsoleAdapter {},
  LoopAdapter: class LoopAdapter {},
  NightlyAdapter: class NightlyAdapter {},
  SendAdapter: class SendAdapter {},
  createPartyLayer: vi.fn(() => sdk),
}));

import { createDexPartyLayerClient } from "@/wallet/partylayer-client";

function missingWallet(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "WALLET_NOT_INSTALLED" });
}

describe("createDexPartyLayerClient", () => {
  beforeEach(() => {
    sdk.connect.mockReset();
    sdk.disconnect.mockReset();
    sdk.submitTransaction.mockReset();
    sdk.listWallets.mockReset();
    sdk.getAdapter.mockReset();
  });

  it("tries supported wallets in order until one connects", async () => {
    sdk.connect
      .mockRejectedValueOnce(missingWallet("console missing"))
      .mockRejectedValueOnce(missingWallet("nightly missing"))
      .mockResolvedValueOnce({
        partyId: "alice::1220a",
        walletId: "send",
        capabilitiesSnapshot: ["submitTransaction"],
      });

    const client = createDexPartyLayerClient({
      appName: "Canton DEX",
      network: "canton:devnet",
    });
    const session = await client.connect({
      requiredCapabilities: ["submitTransaction"],
    });

    expect(session.partyId).toBe("alice::1220a");
    expect(session.walletId).toBe("send");
    expect(sdk.connect).toHaveBeenCalledTimes(3);
    expect(sdk.connect.mock.calls.map(([arg]) => arg.walletId)).toEqual([
      "console",
      "nightly",
      "send",
    ]);
  });

  it("reports each attempted wallet when none are installed", async () => {
    sdk.connect
      .mockRejectedValueOnce(missingWallet("console missing"))
      .mockRejectedValueOnce(missingWallet("send missing"));

    const client = createDexPartyLayerClient({
      appName: "Canton DEX",
      network: "canton:devnet",
      walletIds: ["console", "send"],
    });

    await expect(client.connect()).rejects.toThrow(
      /No supported PartyLayer wallet is installed or detected \(console, send\).*console missing.*send missing/,
    );
  });

  it("allows an explicit 5N Loop wallet selection", async () => {
    sdk.connect.mockResolvedValueOnce({
      partyId: "alice::1220a",
      walletId: "loop",
      capabilitiesSnapshot: ["submitTransaction"],
    });

    const client = createDexPartyLayerClient({
      appName: "Canton DEX",
      network: "canton:devnet",
      walletIds: ["loop"],
    });
    const session = await client.connect();

    expect(session.walletId).toBe("loop");
    expect(sdk.connect.mock.calls[0][0].walletId).toBe("loop");
  });

  it("connects directly to a picker-chosen walletId without probing the list", async () => {
    sdk.connect.mockResolvedValueOnce({
      partyId: "alice::1220a",
      walletId: "loop",
      capabilitiesSnapshot: ["submitTransaction"],
    });

    // Configured list is console/send, but the picker chose loop — connect must
    // go straight to loop and not iterate the configured ids.
    const client = createDexPartyLayerClient({
      appName: "Canton DEX",
      network: "canton:devnet",
      walletIds: ["console", "send"],
    });
    const session = await client.connect({ walletId: "loop" });

    expect(session.walletId).toBe("loop");
    expect(sdk.connect).toHaveBeenCalledTimes(1);
    expect(sdk.connect.mock.calls[0][0].walletId).toBe("loop");
  });

  it("listWallets omits registry wallets that have no adapter, and detects install state", async () => {
    // The remote registry catalog includes wallets this dApp did not configure
    // an adapter for (cantor8, bron) — those cannot be connected, so must not
    // be advertised. loop has an adapter and is detected installed; console has
    // an adapter but is not installed.
    sdk.listWallets.mockResolvedValueOnce([
      { walletId: "loop", name: "5N Loop", website: "https://loop.example", icons: { lg: "loop-lg.png" } },
      { walletId: "console", name: "Console", website: "https://console.example", icons: { md: "c.png" } },
      { walletId: "cantor8", name: "Cantor8" },
      { walletId: "bron", name: "Bron" },
    ]);
    sdk.getAdapter.mockImplementation((id: string) => {
      if (id === "loop") return { detectInstalled: async () => ({ installed: true }) };
      if (id === "console") return { detectInstalled: async () => ({ installed: false }) };
      return undefined; // cantor8, bron: no adapter configured
    });

    const client = createDexPartyLayerClient({ appName: "Canton DEX", network: "canton:devnet" });
    const wallets = await client.listWallets!();

    expect(wallets.map((w) => w.walletId)).toEqual(["loop", "console"]);
    // lg icon is used when md/sm are absent.
    expect(wallets[0]).toMatchObject({
      walletId: "loop",
      name: "5N Loop",
      installUrl: "https://loop.example",
      icon: "loop-lg.png",
      installed: true,
    });
    expect(wallets[1]).toMatchObject({ walletId: "console", installed: false, icon: "c.png" });
  });
});
