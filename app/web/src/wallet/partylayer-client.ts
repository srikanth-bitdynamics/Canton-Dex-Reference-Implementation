// Real PartyLayer SDK binding, kept in a separate lazily-imported module so the
// main wallet registry can stay light until PartyLayer is enabled and selected.

import {
  ConsoleAdapter,
  LoopAdapter,
  NightlyAdapter,
  SendAdapter,
  createPartyLayer,
  type CIP0103Account,
  type NetworkId,
  type WalletAdapter,
  type WalletId,
} from "@partylayer/sdk";

import type { DisplayBalance } from "@/types/contracts";
import type {
  PartyLayerClient,
  PartyLayerCommandSubmission,
  PartyLayerLedgerApiParams,
} from "./partylayer-provider";

// The subset of Loop's SDK aggregate Holding we read for display. Loop's
// getHolding() reports per-instrument available/locked totals with no contract
// id; it is display-only and never a funding source.
interface LoopAggregateHolding {
  instrument_id: { admin: string; id: string };
  total_unlocked_coin: string;
  total_locked_coin: string;
}

interface LoopBalanceProvider {
  getHolding?(): Promise<LoopAggregateHolding[]>;
}

function toDisplayNumber(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

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

// A Loop pairing that never completes leaves `loop_connect` carrying a stale
// ticketId but no authToken. The SDK's autoConnect then reuses that dead ticket
// instead of minting a fresh one, and the connect page loads an expired ticket
// ("Failed to Load Connection"). Drop an unauthorized pairing before each
// connect so every attempt starts from a fresh ticket; a completed session
// (with an authToken) is left intact for reconnect.
function clearIncompleteLoopSession(): void {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem("loop_connect");
    if (!raw) return;
    const parsed = JSON.parse(raw) as { authToken?: unknown };
    if (!parsed.authToken) window.localStorage.removeItem("loop_connect");
  } catch {
    try {
      window.localStorage.removeItem("loop_connect");
    } catch {
      /* storage unavailable */
    }
  }
}

// Build the adapter set, keeping a reference to the Loop adapter so aggregate
// display balances can be read from its active provider (Loop's getHolding()),
// which the CIP-0103 ledgerApi surface does not expose.
function buildAdapters(): { adapters: WalletAdapter[]; loop: LoopAdapter } {
  const loop = new LoopAdapter();
  return {
    adapters: [new ConsoleAdapter(), new NightlyAdapter(), new SendAdapter(), loop],
    loop,
  };
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
  const { adapters, loop } = buildAdapters();
  const client = createPartyLayer({
    app: { name: options.appName },
    network: normalizeNetwork(options.network),
    registryUrl: options.registryUrl,
    channel: options.channel,
    adapters,
    telemetry: { enabled: false },
  });

  // The wallet the current session connected through — decides whether the
  // native aggregate-balance read (Loop's getHolding()) is available.
  let connectedWalletId: string | undefined;
  const finishConnect = (session: Parameters<typeof mapSession>[0]) => {
    const mapped = mapSession(session);
    connectedWalletId = mapped.walletId;
    return mapped;
  };

  return {
    async connect(connectOptions) {
      clearIncompleteLoopSession();
      // The combined picker passes the chosen wallet id — connect straight to it
      // rather than probing the configured list in order.
      if (connectOptions?.walletId) {
        const session = await client.connect({
          ...connectOptions,
          walletId: connectOptions.walletId as WalletId,
        });
        return finishConnect(session);
      }
      const missingWalletAttempts: Array<{ walletId: string; error: unknown }> = [];
      for (const walletId of walletIds) {
        try {
          const session = await client.connect({
            ...connectOptions,
            walletId: walletId as WalletId,
          });
          return finishConnect(session);
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
      connectedWalletId = undefined;
      await client.disconnect();
    },
    async submitTransaction(params: { signedTx: PartyLayerCommandSubmission }) {
      return client.submitTransaction(params);
    },
    async signMessage(params: { message: string; nonce?: string; domain?: string }) {
      return client.signMessage(params);
    },
    async getPrimaryAccount() {
      // PartyLayerClient exposes no direct account method; its CIP-0103 provider
      // bridge answers the mandatory `getPrimaryAccount` request.
      const account = await client
        .asProvider()
        .request<CIP0103Account>({ method: "getPrimaryAccount" });
      return {
        partyId: String(account.partyId),
        publicKey: String(account.publicKey),
        namespace: account.namespace,
        hint: account.hint,
      };
    },
    async ledgerApi(params: PartyLayerLedgerApiParams) {
      return client.ledgerApi(params);
    },
    async getBalances(): Promise<DisplayBalance[]> {
      // Aggregate display balances are Loop-specific: Loop's SDK provider
      // exposes getHolding() (available/locked per instrument) but the adapter
      // does not proxy it through ledgerApi. Reach the connected Loop provider
      // for a read-only snapshot; non-Loop wallets return [] and the caller
      // derives display balances from discovered holdings.
      if (connectedWalletId !== "loop") return [];
      const provider = (loop as unknown as { currentProvider?: LoopBalanceProvider })
        .currentProvider;
      if (!provider?.getHolding) return [];
      const holdings = await provider.getHolding();
      return holdings.map((h) => ({
        instrumentId: { admin: h.instrument_id.admin, id: h.instrument_id.id },
        available: toDisplayNumber(h.total_unlocked_coin),
        locked: toDisplayNumber(h.total_locked_coin),
      }));
    },
  };
}
