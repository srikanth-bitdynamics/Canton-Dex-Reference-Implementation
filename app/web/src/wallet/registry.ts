// Provider registry. The dApp picks the active wallet provider from a
// single place; adding a future provider is one new module + one
// registry entry. Components import `useActiveWallet` and the active
// provider's methods, not concrete classes.

import { CantonDirectProvider } from "./canton-direct-provider";
import { MockWalletProvider } from "./mock-provider";
import { TokenStandardProvider } from "./token-standard-provider";
import { WalletConnectProvider } from "./walletconnect-provider";
import type { WalletProvider } from "./types";

export type WalletProviderId =
  | "token-standard"
  | "walletconnect"
  | "canton-direct"
  | "mock";

let providers: Map<WalletProviderId, WalletProvider> | null = null;

function buildRegistry(): Map<WalletProviderId, WalletProvider> {
  const projectId = (import.meta.env.VITE_WC_PROJECT_ID ?? "") as string;
  const networkId = (import.meta.env.VITE_CANTON_NETWORK_ID ??
    "canton:devnet") as string;
  const ledgerUrl = (import.meta.env.VITE_CANTON_LEDGER_URL ?? "") as string;
  const authToken = (import.meta.env.VITE_CANTON_AUTH_TOKEN ?? "") as string;
  const apiBase = (import.meta.env.VITE_API_BASE ?? "") as string;

  const map = new Map<WalletProviderId, WalletProvider>();

  // Token Standard V2 is the canonical Canton-native provider.
  map.set(
    "token-standard",
    new TokenStandardProvider(ledgerUrl, authToken, apiBase),
  );

  // WalletConnect for external wallets supporting CIP-0103 over WC v2.
  if (projectId) {
    map.set("walletconnect", new WalletConnectProvider(projectId, networkId));
  }

  // Direct Canton ledger access (advanced fallback).
  if (ledgerUrl && authToken) {
    map.set("canton-direct", new CantonDirectProvider(ledgerUrl, authToken));
  }

  // Mock available only in dev. Production builds drop this provider
  // entirely so end users can't accidentally pick it.
  if (import.meta.env.DEV) {
    map.set("mock", new MockWalletProvider());
  }

  return map;
}

export function getProviders(): Map<WalletProviderId, WalletProvider> {
  if (!providers) providers = buildRegistry();
  return providers;
}

export function getProvider(id: WalletProviderId): WalletProvider {
  const p = getProviders().get(id);
  if (!p) throw new Error(`unknown or unavailable wallet provider: ${id}`);
  return p;
}

/**
 * The default provider the UI offers first. Token Standard is the
 * canonical Canton-native path. WalletConnect and the direct/mock
 * providers are reachable from the Connect Wallet menu.
 */
export const DEFAULT_PROVIDER_ID: WalletProviderId = "token-standard";
