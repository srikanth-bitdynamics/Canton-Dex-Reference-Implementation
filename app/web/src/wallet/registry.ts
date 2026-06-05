// Wallet provider registry. Single place to add or gate providers.

import { CantonDirectProvider } from "./canton-direct-provider";
import { MockWalletProvider } from "./mock-provider";
import { PartyLayerProvider, type PartyLayerClient } from "./partylayer-provider";
import { SdkProvider } from "./sdk-provider";
import { TokenStandardProvider } from "./token-standard-provider";
import { WalletConnectProvider } from "./walletconnect-provider";
import type { WalletProvider } from "./types";

export type WalletProviderId =
  | "sdk"
  | "partylayer"
  | "token-standard"
  | "walletconnect"
  | "canton-direct"
  | "mock";

// Concrete PartyLayer client binding. Replace this body with the real adapter
// once `@partylayer/sdk` is installed:
//   const client = createPartyLayer({ network, appName, adapters: [...] });
//   await client.connect(); return adaptToPartyLayerClient(client);
// Kept as a loud failure (not a silent stub) so an unconfigured PartyLayer
// provider never mis-routes a submission. See docs/wallet-providers.md.
async function partyLayerClientFactory(): Promise<PartyLayerClient> {
  throw new Error(
    "PartyLayer client not wired: install @partylayer/sdk and provide a " +
      "createPartyLayer(...) → PartyLayerClient binding in registry.ts.",
  );
}

let providers: Map<WalletProviderId, WalletProvider> | null = null;

function buildRegistry(): Map<WalletProviderId, WalletProvider> {
  const projectId = (import.meta.env.VITE_WC_PROJECT_ID ?? "") as string;
  const networkId = (import.meta.env.VITE_CANTON_NETWORK_ID ??
    "canton:devnet") as string;
  const ledgerUrl = (import.meta.env.VITE_CANTON_LEDGER_URL ?? "") as string;
  const authToken = (import.meta.env.VITE_CANTON_AUTH_TOKEN ?? "") as string;
  const apiBase =
    (import.meta.env.VITE_API_BASE ?? "http://localhost:8080") as string;
  const enableSdk =
    (import.meta.env.VITE_ENABLE_SDK ?? "") === "1";
  const enablePartyLayer =
    (import.meta.env.VITE_ENABLE_PARTYLAYER ?? "") === "1";
  const packagePrefix = (import.meta.env.VITE_CANTON_DEX_PACKAGE_ID ??
    "#canton-dex-trading") as string;

  const map = new Map<WalletProviderId, WalletProvider>();

  if (enableSdk) map.set("sdk", new SdkProvider(packagePrefix));
  if (enablePartyLayer) {
    // The concrete client is wired only once `@partylayer/sdk` is installed and
    // the binding adapter (createPartyLayer(...) → PartyLayerClient) is added.
    // Until then the factory fails loudly rather than silently mis-routing.
    map.set(
      "partylayer",
      new PartyLayerProvider(packagePrefix, partyLayerClientFactory),
    );
  }
  map.set("token-standard", new TokenStandardProvider(ledgerUrl, authToken, apiBase));
  if (projectId) map.set("walletconnect", new WalletConnectProvider(projectId, networkId));
  if (ledgerUrl && authToken) map.set("canton-direct", new CantonDirectProvider(ledgerUrl, authToken));
  if (import.meta.env.DEV) map.set("mock", new MockWalletProvider());

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

export const DEFAULT_PROVIDER_ID: WalletProviderId = "token-standard";
