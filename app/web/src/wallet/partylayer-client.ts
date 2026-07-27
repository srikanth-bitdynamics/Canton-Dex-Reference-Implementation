// Real PartyLayer SDK binding, kept in a separate lazily-imported module so the
// main wallet registry can stay light until PartyLayer is enabled and selected.

import {
  ConsoleAdapter,
  LoopAdapter,
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
  PartyLayerLedgerApiParams,
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
    new LoopAdapter(),
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

function formatError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

function missingWalletMessage(attempts: Array<{ walletId: string; error: unknown }>): string {
  const attempted = attempts.map(({ walletId }) => walletId).join(", ");
  const details = attempts
    .map(({ walletId, error }) => `${walletId}: ${formatError(error)}`)
    .join(" | ");
  return `No supported PartyLayer wallet is installed or detected (${attempted}). Tried ${details}`;
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
      // The combined picker passes the chosen wallet id — connect straight to it
      // rather than probing the configured list in order.
      if (connectOptions?.walletId) {
        const session = await client.connect({
          ...connectOptions,
          walletId: connectOptions.walletId as WalletId,
        });
        return mapSession(session);
      }
      const missingWalletAttempts: Array<{ walletId: string; error: unknown }> = [];
      for (const walletId of walletIds) {
        try {
          const session = await client.connect({
            ...connectOptions,
            walletId: walletId as WalletId,
          });
          return mapSession(session);
        } catch (err) {
          if (!isMissingWalletError(err)) throw err;
          missingWalletAttempts.push({ walletId, error: err });
        }
      }
      throw new Error(missingWalletMessage(missingWalletAttempts));
    },
    async listWallets() {
      // `client.listWallets()` returns the FULL remote registry catalog (every
      // wallet the registry knows), but this dApp can only connect wallets it
      // configured an adapter for — `client.connect({ walletId })` rejects for
      // any other. So keep only adapter-backed wallets; advertising the rest
      // would list rows that fail on click. For each kept wallet, probe
      // install state via the adapter so the picker can grey out / link
      // not-installed ones.
      const infos = await client.listWallets();
      const out = await Promise.all(
        infos.map(async (info) => {
          const adapter = client.getAdapter(info.walletId);
          if (!adapter) return null; // no adapter here — not connectable
          let installed: boolean | undefined;
          try {
            installed = (await adapter.detectInstalled?.())?.installed;
          } catch {
            /* detection failed — leave `installed` undefined (no opinion) */
          }
          const icons = (info as { icons?: { sm?: string; md?: string; lg?: string } }).icons;
          return {
            walletId: String(info.walletId),
            name: info.name ?? String(info.walletId),
            installUrl: (info as { website?: string }).website,
            icon: icons?.md ?? icons?.sm ?? icons?.lg,
            installed,
          };
        }),
      );
      return out.filter((w): w is NonNullable<typeof w> => w !== null);
    },
    async disconnect() {
      await client.disconnect();
    },
    async submitTransaction(params: { signedTx: PartyLayerCommandSubmission }) {
      return client.submitTransaction(params);
    },
    async ledgerApi(params: PartyLayerLedgerApiParams) {
      return client.ledgerApi(params);
    },
  };
}
