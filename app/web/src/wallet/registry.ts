// Wallet provider registry. Single place to add or gate providers.

import { CantonDirectProvider } from "./canton-direct-provider";
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

/**
 * Read VITE_CANTON_AUTH_TOKEN only in dev builds (DEX-117). In prod this
 * returns "" and logs an error if a token was nonetheless baked in, so the
 * relay/direct providers that depend on it stay disabled rather than shipping
 * a long-lived bearer credential to end users.
 */
export function devOnlyAuthToken(): string {
  const raw = (import.meta.env.VITE_CANTON_AUTH_TOKEN ?? "") as string;
  if (!raw) return "";
  if (import.meta.env.DEV) return raw;
  // eslint-disable-next-line no-console
  console.error(
    "[wallet] VITE_CANTON_AUTH_TOKEN is set in a production build; refusing to " +
      "use it. Direct/relay wallet providers that require it are disabled. " +
      "Remove this var from production env (see app/web/.env.example).",
  );
  return "";
}

let providers: Map<WalletProviderId, WalletProvider> | null = null;

function buildRegistry(): Map<WalletProviderId, WalletProvider> {
  const projectId = (import.meta.env.VITE_WC_PROJECT_ID ?? "") as string;
  const networkId = (import.meta.env.VITE_CANTON_NETWORK_ID ??
    "canton:devnet") as string;
  const ledgerUrl = (import.meta.env.VITE_CANTON_LEDGER_URL ?? "") as string;
  // VITE_CANTON_AUTH_TOKEN is a long-lived bearer credential. It must never be
  // read into a production bundle (DEX-117). In prod we refuse to read it and
  // log an error so a misconfigured deploy is loud, not silently insecure.
  const authToken = devOnlyAuthToken();
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
      new PartyLayerProvider(
        packagePrefix,
        partyLayerClientFactory(networkId),
        optionalPositiveInt("VITE_PARTYLAYER_CONNECT_TIMEOUT_MS") ??
          DEFAULT_PARTYLAYER_CONNECT_TIMEOUT_MS,
      ),
    );
  }
  map.set("token-standard", new TokenStandardProvider(ledgerUrl, authToken, apiBase));
  if (projectId) map.set("walletconnect", new WalletConnectProvider(projectId, networkId));
  // canton-direct relies on a long-lived bearer token in localStorage, so it is
  // gated to dev like `mock` (DEX-117). `authToken` is already "" in prod.
  if (import.meta.env.DEV && ledgerUrl && authToken) {
    map.set("canton-direct", new CantonDirectProvider(ledgerUrl, authToken));
  }
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

// Default provider selection (DEX-97).
//
// We must NOT default to `token-standard` in real builds: that provider routes
// every trader-authority write through the operator signing relay, so the
// operator effectively signs on the user's behalf. The relay is a dev-only
// convenience and is gated behind `import.meta.env.DEV` below.
//
// Real-build preference order:
//   1. PartyLayer when explicitly enabled (VITE_ENABLE_PARTYLAYER=1) — a real
//      external multi-wallet connector.
//   2. WalletConnect when a project id is configured — a real external wallet.
//   3. SDK when enabled — a real CIP-0103 wallet.
//   4. `null` (no auto-default): the user must pick a provider in the Connect
//      menu. We deliberately do NOT silently fall back to the operator relay.
// In dev builds we keep `token-standard` as the convenient default so local
// flows work without a wallet, but it is clearly labelled "dev only".
function resolveDefaultProviderId(): WalletProviderId | null {
  const enablePartyLayer = (import.meta.env.VITE_ENABLE_PARTYLAYER ?? "") === "1";
  const hasWalletConnect = !!(import.meta.env.VITE_WC_PROJECT_ID ?? "");
  const enableSdk = (import.meta.env.VITE_ENABLE_SDK ?? "") === "1";

  if (enablePartyLayer) return "partylayer";
  if (hasWalletConnect) return "walletconnect";
  if (enableSdk) return "sdk";
  // Dev convenience only: the operator relay default. Never in prod.
  if (import.meta.env.DEV) return "token-standard";
  // No safe real wallet configured: force an explicit pick rather than routing
  // through the operator relay.
  return null;
}

export const DEFAULT_PROVIDER_ID: WalletProviderId | null =
  resolveDefaultProviderId();
