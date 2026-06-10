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
import { LiquidityAllocationUnsupportedError } from "./types";

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
    "Token-standard-native reference DEX for Canton.",
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

const LS_LAST_PARTY = "canton-dex:wc:last-party";
const CONNECT_TIMEOUT_MS = 60_000;
const SUBMIT_TIMEOUT_MS = 30_000;
// Idempotent reads may be retried; submits must NOT.
const READ_RETRIES = 2;

/**
 * Raised when a submit times out: we cannot tell whether the wallet authorized
 * the transaction or not, so the caller must NOT auto-retry (that risks a
 * duplicate authorization). The user should check their wallet.
 */
export class WalletStatusUnknownError extends Error {
  constructor(label: string) {
    super(
      `${label}: status unknown — the request may or may not have been ` +
        `authorized. Check your wallet before retrying to avoid a duplicate ` +
        `submission.`,
    );
    this.name = "WalletStatusUnknownError";
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function withRetry<T>(fn: () => Promise<T>, attempts: number, label: string): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      // Only retry transient errors (network, relay). Reject user-cancel.
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.toLowerCase().includes("rejected") || msg.toLowerCase().includes("cancel")) {
        throw e;
      }
      // eslint-disable-next-line no-console
      console.warn(`[wc] ${label} attempt ${i + 1}/${attempts} failed:`, msg);
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
  throw lastErr;
}

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
      this.connector = (await withTimeout(mod.UniversalConnector.init({
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
      } as any), CONNECT_TIMEOUT_MS, "UniversalConnector.init")) as unknown as AppKitUniversalConnector;

      await withTimeout(this.connector.connect(), CONNECT_TIMEOUT_MS, "wc connect");

      // canton_listAccounts is an idempotent read, so it is safe to retry on a
      // transient relay timeout.
      const conn = this.connector;
      const accounts = await withRetry(
        () =>
          withTimeout(
            conn.request<{ party: string }[]>({ method: "canton_listAccounts" }),
            CONNECT_TIMEOUT_MS,
            "canton_listAccounts",
          ),
        READ_RETRIES,
        "canton_listAccounts",
      );
      const primary = accounts[0];
      if (!primary) {
        throw new Error("wallet returned no accounts");
      }
      const account: WalletAccount = {
        party: primary.party,
        label: this.label,
      };
      if (typeof window !== "undefined") {
        window.localStorage.setItem(LS_LAST_PARTY, primary.party);
      }
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
    if (intent.kind === "add-liquidity" || intent.kind === "remove-liquidity") {
      // canton_prepareExecute returns the wallet's own WalletResult; it does
      // not surface the created allocation cids the DvP /settle needs.
      throw new LiquidityAllocationUnsupportedError(this.id);
    }
    const conn = this.connector;
    // Idempotency key threaded to the wallet so that IF it dedupes on
    // commandId, a user-driven retry can't double-authorize. We still do NOT
    // auto-retry submits ourselves.
    const commandId = `wc-${intent.kind}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 10)}`;
    // The dApp does NOT construct Daml command trees here. CIP-0103's
    // canton_prepareExecute takes the dApp's intent and the wallet
    // builds the correct Daml commands.
    //
    // Submits are NOT retried on timeout: a timed-out submit may already have
    // been authorized by the wallet, so retrying risks a duplicate. On timeout
    // we surface a "status unknown — check your wallet" error instead.
    try {
      return await withTimeout(
        conn.request<WalletResult>({
          method: "canton_prepareExecute",
          params: [{ ...intent, commandId }],
        }),
        SUBMIT_TIMEOUT_MS,
        "canton_prepareExecute",
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("timed out")) {
        throw new WalletStatusUnknownError("canton_prepareExecute");
      }
      throw e;
    }
  }
}
