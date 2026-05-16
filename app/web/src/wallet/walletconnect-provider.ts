// WalletConnect provider via Reown AppKit's UniversalConnector.
//
// Why UniversalConnector and not the EVM/Solana adapters: Canton is
// CAIP-compatible but not EVM. We declare a custom CAIP namespace
// `canton` and let the UniversalConnector handle the WalletConnect v2
// pairing and session lifecycle. The dApp sends `session.request`
// calls with Canton-specific JSON-RPC methods that map to CIP-0103.
//
// Environment configuration:
//   VITE_WC_PROJECT_ID       — Reown / WalletConnect Cloud project id (required)
//   VITE_CANTON_NETWORK_ID   — CAIP network id, e.g. "canton:devnet" (default: canton:devnet)
//   VITE_CANTON_LEDGER_URL   — Validator JSON Ledger API URL for non-signing reads
//
// Method-string note:
//   The Canton WalletConnect namespace methods follow CIP-0103 verb names
//   prefixed with `canton_`. The exact strings depend on the wallets we
//   target; we use the CIP-0103 canonical names. Confirm against each
//   wallet's supported method list at session-propose time and adjust
//   the METHODS constant below.

import type {
  WalletAccount,
  WalletConnectionStatus,
  WalletIntent,
  WalletProvider,
  WalletResult,
} from "./types";

// CIP-0103 method names exposed by Canton wallets over WalletConnect.
// Listed for session permissions; the wallet must support these to
// be selectable. Confirm against the wallets you target.
const METHODS = [
  "canton_listAccounts",
  "canton_getPrimaryAccount",
  "canton_signMessage",
  "canton_prepareExecute",
  "canton_ledgerApi",
] as const;

const APP_METADATA = {
  name: "Canton DEX",
  description:
    "Token-standard-native reference DEX for Canton (PR 108 deliverable).",
  url: typeof window !== "undefined" ? window.location.origin : "",
  icons: [],
};

type AppKitUniversalConnector = {
  connect(): Promise<unknown>;
  disconnect(): Promise<void>;
  request<T>(args: { method: string; params?: unknown }): Promise<T>;
  on(event: string, cb: (...args: unknown[]) => void): void;
  off(event: string, cb: (...args: unknown[]) => void): void;
};

export class WalletConnectProvider implements WalletProvider {
  readonly id = "walletconnect";
  readonly label = "WalletConnect";

  private connector: AppKitUniversalConnector | null = null;
  private status: WalletConnectionStatus = { kind: "disconnected" };
  private readonly listeners = new Set<
    (s: WalletConnectionStatus) => void
  >();

  constructor(
    private readonly projectId: string,
    private readonly networkId: string,
  ) {}

  getStatus(): WalletConnectionStatus {
    return this.status;
  }

  onStatusChange(cb: (s: WalletConnectionStatus) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private setStatus(next: WalletConnectionStatus): void {
    this.status = next;
    for (const cb of this.listeners) cb(next);
  }

  async connect(): Promise<WalletAccount> {
    if (this.status.kind === "connected") return this.status.account;
    if (!this.projectId) {
      const msg =
        "VITE_WC_PROJECT_ID is not set. Get one at https://cloud.reown.com and add it to .env.local";
      this.setStatus({ kind: "error", message: msg });
      throw new Error(msg);
    }

    this.setStatus({ kind: "connecting" });
    try {
      // Lazy-import: AppKit pulls in the whole modal infra and we do
      // not need it on every page load.
      const mod = await import("@reown/appkit-universal-connector");
      const customNetwork = {
        id: this.networkId,
        chainNamespace: "canton" as const,
        caipNetworkId: this.networkId as `${string}:${string}`,
        name: "Canton Network",
        nativeCurrency: { name: "Canton Coin", symbol: "CC", decimals: 10 },
        rpcUrls: { default: { http: [] as string[] } },
      };
      this.connector = (await mod.UniversalConnector.init({
        projectId: this.projectId,
        metadata: APP_METADATA,
        networks: [
          {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            chains: [customNetwork as any],
            methods: [...METHODS],
            events: [],
            namespace: "canton",
          },
        ],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)) as unknown as AppKitUniversalConnector;

      await this.connector.connect();

      const accounts = await this.connector.request<{ party: string }[]>({
        method: "canton_listAccounts",
      });
      const primary = accounts[0];
      if (!primary) {
        throw new Error("wallet returned no accounts");
      }
      const account: WalletAccount = {
        party: primary.party,
        label: this.label,
      };
      this.setStatus({
        kind: "connected",
        account,
        providerId: this.id,
      });
      return account;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.setStatus({ kind: "error", message: msg });
      throw e;
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.connector?.disconnect();
    } catch {
      // Best-effort; we always reset our local state.
    }
    this.connector = null;
    this.setStatus({ kind: "disconnected" });
  }

  async submit(intent: WalletIntent): Promise<WalletResult> {
    if (this.status.kind !== "connected" || !this.connector) {
      throw new Error("wallet not connected");
    }
    // The dApp does NOT construct Daml command trees here. CIP-0103's
    // canton_prepareExecute takes the dApp's intent (verb + params) and
    // the wallet builds the correct Daml commands. This keeps the
    // contract knowledge on the wallet/registry side and the dApp
    // boundary minimal.
    //
    // For wallets that require a fully-formed Daml command tree, we
    // would translate `intent` into commands here. Today we forward the
    // intent verbatim under a Canton-namespaced method and let the
    // wallet's CIP-0103 implementation handle translation.
    const result = await this.connector.request<WalletResult>({
      method: "canton_prepareExecute",
      params: [intent],
    });
    return result;
  }
}
