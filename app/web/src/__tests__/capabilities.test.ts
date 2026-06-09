import { describe, it, expect } from "vitest";

import {
  WALLET_CAPABILITIES,
  capabilityFor,
  dvpBadge,
} from "@/wallet/capabilities";
import type { WalletProviderId } from "@/wallet/registry";

const ALL_IDS: WalletProviderId[] = [
  "sdk",
  "partylayer",
  "token-standard",
  "walletconnect",
  "canton-direct",
  "mock",
];

describe("wallet capabilities", () => {
  it("covers every registered provider id with a valid readiness", () => {
    for (const id of ALL_IDS) {
      const cap = WALLET_CAPABILITIES[id];
      expect(cap, `missing capability for ${id}`).toBeDefined();
      expect(["ready", "unproven", "unsupported"]).toContain(cap.dvp);
      expect(cap.note.length).toBeGreaterThan(0);
    }
  });

  it("partylayer is DvP-unproven (operator-discovery, pending LocalNet)", () => {
    expect(capabilityFor("partylayer").dvp).toBe("unproven");
  });

  it("relay-only providers are marked no-DvP", () => {
    expect(capabilityFor("walletconnect").dvp).toBe("unsupported");
    expect(capabilityFor("canton-direct").dvp).toBe("unsupported");
  });

  it("dvpBadge maps readiness → tone", () => {
    expect(dvpBadge("ready").tone).toBe("ok");
    expect(dvpBadge("unproven").tone).toBe("warn");
    expect(dvpBadge("unsupported").tone).toBe("muted");
  });
});
