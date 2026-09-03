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
  "mock",
];

describe("wallet capabilities", () => {
  it("covers every registered provider id with a valid readiness", () => {
    for (const id of ALL_IDS) {
      const cap = WALLET_CAPABILITIES[id];
      expect(cap, `missing capability for ${id}`).toBeDefined();
      expect(["ready", "unproven", "dev-only", "unsupported"]).toContain(cap.dvp);
      expect(cap.note.length).toBeGreaterThan(0);
    }
  });

  it("partylayer is DvP-unproven (operator-discovery, pending LocalNet)", () => {
    expect(capabilityFor("partylayer").dvp).toBe("unproven");
  });

  it("token-standard operator relay is marked dev-only, not recommended", () => {
    const cap = capabilityFor("token-standard");
    expect(cap.dvp).toBe("dev-only");
    // The note must flag the relay clearly, not advertise it as DvP-ready.
    expect(cap.note.toLowerCase()).toContain("dev only");
    expect(cap.note.toLowerCase()).not.toContain("recommended");
  });

  it("WalletConnect is marked no-DvP", () => {
    expect(capabilityFor("walletconnect").dvp).toBe("unsupported");
  });

  it("both non-wallet development adapters are marked dev-only", () => {
    expect(capabilityFor("token-standard").dvp).toBe("dev-only");
    expect(capabilityFor("mock").dvp).toBe("dev-only");
  });

  it("marks signMessage support on sdk, partylayer, and the operator relay", () => {
    expect(capabilityFor("sdk").supportsSignMessage).toBe(true);
    expect(capabilityFor("partylayer").supportsSignMessage).toBe(true);
    expect(capabilityFor("token-standard").supportsSignMessage).toBe(true);
    expect(capabilityFor("walletconnect").supportsSignMessage).toBe(false);
    expect(capabilityFor("mock").supportsSignMessage).toBe(false);
  });

  it("marks Token Standard V2 support on the real DvP providers only", () => {
    for (const id of ["sdk", "partylayer", "token-standard"] as const) {
      expect(capabilityFor(id).supportsTokenStandardV2, id).toBe(true);
    }
    for (const id of ["walletconnect", "mock"] as const) {
      expect(capabilityFor(id).supportsTokenStandardV2, id).toBe(false);
    }
  });

  it("no provider claims multi-command transaction support (default false)", () => {
    // Every wallet's transaction UI is assumed to authorize one command atom per
    // request until proven otherwise, so each allocation is submitted separately.
    for (const id of ALL_IDS) {
      expect(capabilityFor(id).supportsMultiCommandTransaction, id).toBe(false);
    }
  });

  it("dvpBadge maps readiness → tone", () => {
    expect(dvpBadge("ready").tone).toBe("ok");
    expect(dvpBadge("unproven").tone).toBe("warn");
    expect(dvpBadge("dev-only")).toEqual({ label: "dev only", tone: "warn" });
    expect(dvpBadge("unsupported").tone).toBe("muted");
  });
});
