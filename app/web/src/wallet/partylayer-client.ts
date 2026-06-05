// Real PartyLayer SDK binding, kept in a separate lazily-imported module so the
// main wallet registry can stay light until PartyLayer is enabled and selected.

import {
  ConsoleAdapter,
  NightlyAdapter,
  SendAdapter,
  createPartyLayer,
  type NetworkId,
  type WalletAdapter,
  type WalletId,
} from "@partylayer/sdk";

import type {
  PartyLayerClient,
  PartyLayerCommandSubmission,
} from "./partylayer-provider";

export interface DexPartyLayerClientOptions {
  appName: string;
  network: string;
  walletIds?: string[];
  registryUrl?: string;
  channel?: "stable" | "beta";
}

const DEFAULT_WALLET_IDS = ["console", "nightly", "send"];

function normalizeNetwork(network: string): NetworkId {
  switch (network) {
    case "canton:devnet":
      return "devnet";
    case "canton:testnet":
      return "testnet";
    case "canton:mainnet":
      return "mainnet";
    default:
      return network as NetworkId;
  }
}

function buildAdapters(): WalletAdapter[] {
  return [
    new ConsoleAdapter(),
    new NightlyAdapter(),
    new SendAdapter(),
  ];
}

function isMissingWalletError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const maybe = err as { code?: unknown; name?: unknown };
  return (
    maybe.code === "WALLET_NOT_INSTALLED" ||
    maybe.code === "WALLET_NOT_FOUND" ||
    maybe.name === "WalletNotInstalledError" ||
    maybe.name === "WalletNotFoundError"
  );
}

function missingWalletMessage(walletIds: string[], lastError: unknown): string {
  const suffix =
    lastError instanceof Error && lastError.message
      ? ` Last error: ${lastError.message}`
      : "";
  return `No supported PartyLayer wallet is installed or detected (${walletIds.join(", ")}).${suffix}`;
}

function mapSession(session: Awaited<ReturnType<ReturnType<typeof createPartyLayer>["connect"]>>) {
  return {
    partyId: String(session.partyId),
    label: `PartyLayer (${String(session.walletId)})`,
    walletId: String(session.walletId),
    capabilitiesSnapshot: session.capabilitiesSnapshot,
  };
}

export function createDexPartyLayerClient(
  options: DexPartyLayerClientOptions,
): PartyLayerClient {
  const walletIds = options.walletIds?.length ? options.walletIds : DEFAULT_WALLET_IDS;
  const client = createPartyLayer({
    app: { name: options.appName },
    network: normalizeNetwork(options.network),
    registryUrl: options.registryUrl,
    channel: options.channel,
    adapters: buildAdapters(),
    telemetry: { enabled: false },
  });

  return {
    async connect(connectOptions) {
      let lastMissingWalletError: unknown;
      for (const walletId of walletIds) {
        try {
          const session = await client.connect({
            ...connectOptions,
            walletId: walletId as WalletId,
          });
          return mapSession(session);
        } catch (err) {
          if (!isMissingWalletError(err)) throw err;
          lastMissingWalletError = err;
        }
      }
      throw new Error(missingWalletMessage(walletIds, lastMissingWalletError));
    },
    async disconnect() {
      await client.disconnect();
    },
    async submitTransaction(params: { signedTx: PartyLayerCommandSubmission }) {
      return client.submitTransaction(params);
    },
  };
}
