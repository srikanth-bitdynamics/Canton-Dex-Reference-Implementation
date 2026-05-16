// Provider registry. The dApp picks the active wallet provider from a
// single place; adding a future provider (CIP-0103 native, Dfns,
// embedded testnet wallet, ...) is one new module + one registry
// entry. Components import `useActiveWallet` and the active provider's
// methods, not concrete classes.

import { MockWalletProvider } from "./mock-provider";
import { WalletConnectProvider } from "./walletconnect-provider";
import type { WalletProvider } from "./types";

export type WalletProviderId = "walletconnect" | "mock";

let providers: Map<WalletProviderId, WalletProvider> | null = null;

function buildRegistry(): Map<WalletProviderId, WalletProvider> {
  const projectId = (import.meta.env.VITE_WC_PROJECT_ID ?? "") as string;
  const networkId = (import.meta.env.VITE_CANTON_NETWORK_ID ??
    "canton:devnet") as string;

  const map = new Map<WalletProviderId, WalletProvider>();
  map.set(
    "walletconnect",
    new WalletConnectProvider(projectId, networkId),
  );
  map.set("mock", new MockWalletProvider());
  return map;
}

export function getProviders(): Map<WalletProviderId, WalletProvider> {
  if (!providers) providers = buildRegistry();
  return providers;
}

export function getProvider(id: WalletProviderId): WalletProvider {
  const p = getProviders().get(id);
  if (!p) throw new Error(`unknown wallet provider: ${id}`);
  return p;
}

/**
 * The default provider the UI offers first. WalletConnect is the
 * canonical path; the mock is reachable from the Connect Wallet menu
 * for dev convenience.
 */
export const DEFAULT_PROVIDER_ID: WalletProviderId = "walletconnect";
