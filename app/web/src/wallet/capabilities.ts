// Per-provider capability descriptors, surfaced in the Connect Wallet menu so a
// user can see which wallet can drive DvP (swap / add / remove liquidity) before
// they pick one. Kept here (not on the provider classes) so it's a single,
// reviewable table and providers stay focused on transport.

import type { WalletProviderId } from "./registry";

export type DvpReadiness =
  // Proven to complete swap/LP DvP (created cids recoverable: dApp-return or
  // operator-discovery).
  | "ready"
  // Capable by design but not yet proven on LocalNet (gated on a live run).
  | "unproven"
  // Cannot drive DvP (can't surface created cids and the operator can't recover
  // them) — settlement-accept flows only.
  | "unsupported";

export interface WalletCapability {
  dvp: DvpReadiness;
  /** Short human note shown in the connect menu. */
  note: string;
}

export const WALLET_CAPABILITIES: Record<WalletProviderId, WalletCapability> = {
  "token-standard": {
    dvp: "ready",
    note: "Operator-relay; full DvP. Dev/default.",
  },
  sdk: {
    dvp: "ready",
    note: "CIP-0103 wallet; full DvP.",
  },
  mock: {
    dvp: "ready",
    note: "Dev mock; deterministic cids.",
  },
  partylayer: {
    dvp: "unproven",
    note: "Multi-wallet (Console / Nightly / Send / Cantor8). Swap + LP add/remove via operator-discovery; needs the @partylayer binding + LocalNet proof (DEX-94).",
  },
  walletconnect: {
    dvp: "unsupported",
    note: "Settlement-accept only; cannot complete LP DvP.",
  },
  "canton-direct": {
    dvp: "unsupported",
    note: "Settlement-accept only; cannot complete LP DvP.",
  },
};

export function capabilityFor(id: WalletProviderId): WalletCapability {
  return (
    WALLET_CAPABILITIES[id] ?? { dvp: "unproven", note: "Capability unknown." }
  );
}

/** A short badge label + tone for a readiness level (UI helper). */
export function dvpBadge(dvp: DvpReadiness): { label: string; tone: "ok" | "warn" | "muted" } {
  switch (dvp) {
    case "ready":
      return { label: "DvP ready", tone: "ok" };
    case "unproven":
      return { label: "DvP (unproven)", tone: "warn" };
    case "unsupported":
      return { label: "no DvP", tone: "muted" };
  }
}
