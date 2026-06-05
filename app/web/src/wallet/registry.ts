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

function optionalEnv(name: string): string | undefined {
  const value = import.meta.env[name] as string | undefined;
  return value && value.trim().length > 0 ? value : undefined;
}

function optionalEnvList(name: string): string[] | undefined {
  const values = optionalEnv(name)
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return values && values.length > 0 ? values : undefined;
}

function partyLayerClientFactory(networkId: string): () => Promise<PartyLayerClient> {
  return async () => {
    const { createDexPartyLayerClient } = await import("./partylayer-client");
    return createDexPartyLayerClient({
      appName: optionalEnv("VITE_PARTYLAYER_APP_NAME") ?? "Canton DEX",
      network: optionalEnv("VITE_PARTYLAYER_NETWORK") ?? networkId,
      walletIds: optionalEnvList("VITE_PARTYLAYER_WALLET_IDS"),
      registryUrl: optionalEnv("VITE_PARTYLAYER_REGISTRY_URL"),
      channel:
        optionalEnv("VITE_PARTYLAYER_REGISTRY_CHANNEL") === "beta"
          ? "beta"
          : "stable",
    });
  };
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
  // PartyLayer is env-gated because it opens external wallet surfaces. The real
  // SDK client is lazily imported only when selected.
  if (enablePartyLayer) {
    map.set(
      "partylayer",
      new PartyLayerProvider(packagePrefix, partyLayerClientFactory(networkId)),
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
