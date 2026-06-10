// Per-provider capability descriptors, surfaced in the Connect Wallet menu so a
// user can see which wallet can drive DvP (swap / add / remove liquidity) before
// they pick one. Kept here (not on the provider classes) so it's a single,
// reviewable table and providers stay focused on transport.

import type { WalletProviderId } from "./registry";

export type DvpReadiness =
  // Proven to complete swap/LP DvP (created cids recoverable: dApp-return or
  // operator-discovery).
  | "ready"
  // Exposes the necessary submit surface, but deployments should verify the
  // configured wallet returns enough correlation data for DvP discovery.
  | "unproven"
  // Dev-only relay: the operator co-signs on the user's behalf. Functional for
  // local development but NOT a real wallet — do not use in production.
  | "dev-only"
  // Cannot drive DvP (can't surface created cids and the operator can't recover
  // them) — settlement-accept flows only.
  | "unsupported";

export interface WalletCapability {
  dvp: DvpReadiness;
  /** Short human note shown in the connect menu. */
  note: string;
  /**
   * Whether this provider can co-sign as the instrument admin. The registry's
   * Holding_Split / Holding_Merge choices are `controller admin, owner`
   * (trading/CantonDex/Registry/V2.daml), so funding normalization that
   * splits/merges holdings needs admin authority. Only the operator-relay /
   * dev providers route through a path that can co-sign as admin; real external
   * wallets (sdk, partylayer, walletconnect) hold only the user's authority and
   * must NOT compose split/merge commands.
   */
  coSignsAdmin: boolean;
}

export const WALLET_CAPABILITIES: Record<WalletProviderId, WalletCapability> = {
  "token-standard": {
    // The operator signing relay: the operator signs trader writes on the
    // user's behalf. Convenient for local dev, but it is NOT a real wallet and
    // must not be the production default.
    dvp: "dev-only",
    note: "Dev only — operator signing relay (operator co-signs your actions). Not a real wallet.",
    coSignsAdmin: true,
  },
  sdk: {
    dvp: "ready",
    note: "CIP-0103 wallet; full DvP.",
    coSignsAdmin: false,
  },
  mock: {
    dvp: "ready",
    note: "Dev mock; deterministic cids.",
    coSignsAdmin: true,
  },
  partylayer: {
    dvp: "unproven",
    note: "Multi-wallet SDK; tries configured submit-capable wallets. Swap, order funding, and LP DvP use operator-discovery.",
    coSignsAdmin: false,
  },
  walletconnect: {
    dvp: "unsupported",
    note: "Settlement-accept only; cannot complete LP DvP.",
    coSignsAdmin: false,
  },
  "canton-direct": {
    dvp: "unsupported",
    note: "Settlement-accept only; cannot complete LP DvP.",
    coSignsAdmin: true,
  },
};

/**
 * Whether the given provider can co-sign as the instrument admin (needed for
 * the registry's Holding_Split/Holding_Merge normalization). Unknown providers
 * are treated as user-authority-only (the safe default).
 */
export function coSignsAdmin(id: WalletProviderId): boolean {
  return WALLET_CAPABILITIES[id]?.coSignsAdmin ?? false;
}

export function capabilityFor(id: WalletProviderId): WalletCapability {
  return (
    WALLET_CAPABILITIES[id] ?? {
      dvp: "unproven",
      note: "Capability unknown.",
      coSignsAdmin: false,
    }
  );
}

/** A short badge label + tone for a readiness level (UI helper). */
export function dvpBadge(dvp: DvpReadiness): { label: string; tone: "ok" | "warn" | "muted" } {
  switch (dvp) {
    case "ready":
      return { label: "DvP ready", tone: "ok" };
    case "unproven":
      return { label: "DvP (unproven)", tone: "warn" };
    case "dev-only":
      return { label: "dev only", tone: "warn" };
    case "unsupported":
      return { label: "no DvP", tone: "muted" };
  }
}
