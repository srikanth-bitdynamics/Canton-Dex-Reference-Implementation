// Wallet provider registry. Single place to add or gate providers.

import { MockWalletProvider } from "./mock-provider";
import {
  DEFAULT_PARTYLAYER_CONNECT_TIMEOUT_MS,
  PartyLayerProvider,
  type PartyLayerClient,
} from "./partylayer-provider";
import { SdkProvider } from "./sdk-provider";
import { TokenStandardProvider } from "./token-standard-provider";
import { WalletConnectProvider } from "./walletconnect-provider";
import type { WalletProvider } from "./types";

export type WalletProviderId =
  | "sdk"
  | "partylayer"
  | "token-standard"
  | "walletconnect"
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

function optionalPositiveInt(name: string): number | undefined {
  const raw = optionalEnv(name);
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
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
  // An older, now-disabled Direct Canton experiment persisted a participant
  // bearer credential at this key. Remove it during app startup even though the
  // provider itself is no longer constructed.
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem("canton-dex:direct:session");
    } catch {
      // Storage can be unavailable in locked-down browser contexts. Direct
      // Canton is still absent from the registry, so fail closed without
      // preventing the safe wallet adapters from loading.
    }
  }
  const projectId = (import.meta.env.VITE_WC_PROJECT_ID ?? "") as string;
  const networkId = (import.meta.env.VITE_CANTON_NETWORK_ID ??
    "canton:devnet") as string;
  // Loop (`loop_connect`) and PartyLayer (`active_session`) persist a connection
  // without recording its network. A session restored after the deployment
  // network changes still carries a ticket minted against the old network, so
  // connect fails with "ticket invalid or expired". Drop those sessions whenever
  // the configured network differs from the last one this browser saw.
  if (typeof window !== "undefined") {
    try {
      const seenKey = "canton-dex:wallet-network";
      if (window.localStorage.getItem(seenKey) !== networkId) {
        window.localStorage.removeItem("loop_connect");
        window.localStorage.removeItem("active_session");
        window.localStorage.setItem(seenKey, networkId);
      }
    } catch {
      // Storage may be unavailable; the adapters still load.
    }
  }
  const apiBase =
    (import.meta.env.VITE_API_BASE ?? "http://localhost:8080") as string;
  const enableSdk =
    (import.meta.env.VITE_ENABLE_SDK ?? "") === "1";
  const enablePartyLayer =
    (import.meta.env.VITE_ENABLE_PARTYLAYER ?? "") === "1";
  const packagePrefix = (import.meta.env.VITE_CANTON_DEX_PACKAGE_ID ??
    "#canton-dex-trading-v2") as string;

  const map = new Map<WalletProviderId, WalletProvider>();

  if (enableSdk) {
    map.set(
      "sdk",
      new SdkProvider(packagePrefix, {
        gatewayUrl: optionalEnv("VITE_WALLET_GATEWAY_URL"),
        gatewayName: optionalEnv("VITE_WALLET_GATEWAY_NAME"),
      }),
    );
  }
  // PartyLayer is env-gated because it opens external wallet surfaces. The real
  // SDK client is lazily imported only when selected.
  if (enablePartyLayer) {
    map.set(
      "partylayer",
      new PartyLayerProvider(
        packagePrefix,
        partyLayerClientFactory(networkId),
        optionalPositiveInt("VITE_PARTYLAYER_CONNECT_TIMEOUT_MS") ??
          DEFAULT_PARTYLAYER_CONNECT_TIMEOUT_MS,
      ),
    );
  }
  // This provider sends trader-authority commands through the operator relay.
  // Keep the implementation available for local diagnosis, but do not expose
  // it in a production bundle where it could be mistaken for self-custody.
  if (import.meta.env.DEV) {
    map.set("token-standard", new TokenStandardProvider(apiBase));
  }
  if (projectId) map.set("walletconnect", new WalletConnectProvider(projectId, networkId, packagePrefix));
  // Direct Canton is intentionally not registered. A participant accepts
  // concrete Ledger API commands, not DEX wallet intents, and a browser should
  // never retain its bearer credential. See canton-direct-provider.ts.
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

// Default provider selection.
//
// We must NOT default to `token-standard` in real builds: that provider routes
// every trader-authority write through the operator signing relay, so the
// operator effectively signs on the user's behalf. The relay is a dev-only
// convenience and is gated behind `import.meta.env.DEV` below.
//
// Real-build recommendation order follows the capability table:
//   1. SDK when enabled — the full DvP path is implemented.
//   2. PartyLayer when explicitly enabled — the path is implemented but remains
//      marked unproven until the selected wallet passes live validation.
//   3. WalletConnect when configured — the current adapter is marked no-DvP.
//   4. `null` (no auto-default): the user must pick a provider in the Connect
//      menu. We deliberately do NOT silently fall back to the operator relay.
// In dev builds we keep `token-standard` as the convenient default so local
// flows work without a wallet, but it is clearly labelled "dev only".
function resolveDefaultProviderId(): WalletProviderId | null {
  const enablePartyLayer = (import.meta.env.VITE_ENABLE_PARTYLAYER ?? "") === "1";
  const hasWalletConnect = !!(import.meta.env.VITE_WC_PROJECT_ID ?? "");
  const enableSdk = (import.meta.env.VITE_ENABLE_SDK ?? "") === "1";

  if (enableSdk) return "sdk";
  if (enablePartyLayer) return "partylayer";
  if (hasWalletConnect) return "walletconnect";
  // Dev convenience only: the operator relay default. Never in prod.
  if (import.meta.env.DEV) return "token-standard";
  // No safe real wallet configured: force an explicit pick rather than routing
  // through the operator relay.
  return null;
}

export const DEFAULT_PROVIDER_ID: WalletProviderId | null =
  resolveDefaultProviderId();
