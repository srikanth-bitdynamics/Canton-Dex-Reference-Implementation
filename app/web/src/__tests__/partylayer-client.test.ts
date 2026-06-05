import { describe, it, expect, vi, beforeEach } from "vitest";

const sdk = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  submitTransaction: vi.fn(),
}));

vi.mock("@partylayer/sdk", () => ({
  ConsoleAdapter: class ConsoleAdapter {},
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
});
