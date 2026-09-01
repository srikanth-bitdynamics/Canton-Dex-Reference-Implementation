// PartyLayer wallet provider (CIP-0103 multi-wallet connector).
//
// PartyLayer (@partylayer/sdk) unifies supported Canton wallets behind one
// connect + signing surface. This provider sits behind the
// `WalletProvider` interface and reuses the shared `composeCommands` translator
// — the wallet only ever sees Daml command trees, never our intents.
//
// PartyLayer's submit result is `TxReceipt { updateId? }` — it does NOT expose
// the transaction tree or created-contract ids. So this provider deliberately
// returns only `primaryCid = updateId` and does NOT populate
// `createdAllocationCids`; settle, swap, and order-fund calls forward
// `{ updateId }`, and the operator recovers the created `Allocation` cids (and,
// for LP, the `LiquidityAllocationAcceptance` cid) from that update's tree.
// All DvP flows support this operator-discovery path, so an updateId-only wallet
// can complete them.

import { composeCommands } from "./commands";
import {
  discoverHoldingsAcrossRegistries,
  parseHoldingsAcsResponse,
} from "./holdings";
import type { Holding } from "@/types/contracts";
import type {
  DetectedWallet,
  Party,
  WalletAccount,
  WalletConnectionStatus,
  WalletIntent,
  WalletProvider,
  WalletResult,
} from "./types";

export interface PartyLayerConnectOptions {
  requiredCapabilities?: string[];
  preferInstalled?: boolean;
  timeoutMs?: number;
  /**
   * Connect directly to this PartyLayer wallet id (`loop`, `console`, …). When
   * omitted, the client tries its configured wallet ids in order. Set by the
   * combined picker, which already chose the wallet.
   */
  walletId?: string;
}

/** One wallet from PartyLayer's catalog, with best-effort install detection. */
export interface PartyLayerWalletInfo {
  walletId: string;
  name: string;
  description?: string;
  /** Vendor / install page. */
  installUrl?: string;
  icon?: string;
  /** From the adapter's `detectInstalled()`; undefined if not probed. */
  installed?: boolean;
}

export interface PartyLayerSession {
  /** The connected party id. */
  partyId: string;
  /** Optional human label the wallet chose. */
  label?: string;
  walletId?: string;
  capabilitiesSnapshot?: string[];
}

export interface PartyLayerTxReceipt {
  updateId?: string;
  transactionHash?: string;
}

export interface PartyLayerCommandSubmission {
  commandId: string;
  actAs: string[];
  commands: unknown[];
  disclosedContracts?: unknown[];
}

export interface PartyLayerLedgerApiParams {
  requestMethod: "GET" | "POST" | "PUT" | "DELETE";
  resource: string;
  body?: string;
}

export interface PartyLayerLedgerApiResult {
  response: string;
}

export const DEFAULT_PARTYLAYER_CONNECT_TIMEOUT_MS = 180_000;

// The subset of `@partylayer/sdk`'s `PartyLayerClient` we use.
export interface PartyLayerClient {
  connect(options?: PartyLayerConnectOptions): Promise<PartyLayerSession>;
  disconnect(): Promise<void>;
  submitTransaction(params: {
    signedTx: PartyLayerCommandSubmission;
  }): Promise<PartyLayerTxReceipt>;
  ledgerApi(params: PartyLayerLedgerApiParams): Promise<PartyLayerLedgerApiResult>;
  /**
   * Enumerate the configured wallet catalog with per-adapter install
   * detection, for the combined picker. Optional so older/fake clients (tests)
   * need not implement it.
   */
  listWallets?(): Promise<PartyLayerWalletInfo[]>;
}

/** Retained export: PartyLayer's `ledgerApi` returns a JSON string envelope. */
export function parsePartyLayerHoldings(response: string, owner: Party): Holding[] {
  return parseHoldingsAcsResponse(response, owner);
}

export class PartyLayerProvider implements WalletProvider {
  readonly id = "partylayer" as const;
  readonly label = "PartyLayer";

  private status: WalletConnectionStatus = { kind: "disconnected" };
  private listeners = new Set<(s: WalletConnectionStatus) => void>();
  private client: PartyLayerClient | null = null;

  constructor(
    private readonly packagePrefix: string,
    // Lazily build the real client so the @partylayer dependency is only loaded
    // when this provider is actually selected. In tests a fake client is passed.
    private readonly clientFactory: () => Promise<PartyLayerClient>,
    private readonly connectTimeoutMs: number = DEFAULT_PARTYLAYER_CONNECT_TIMEOUT_MS,
  ) {}

  async connect(walletId?: string): Promise<WalletAccount> {
    this.setStatus({ kind: "connecting" });
    try {
      this.client ??= await this.clientFactory();
      const session = await this.client.connect({
        requiredCapabilities: ["submitTransaction", "ledgerApi"],
        preferInstalled: true,
        timeoutMs: this.connectTimeoutMs,
        // When the combined picker chose a specific wallet, connect straight to
        // it; otherwise the client tries its configured wallet ids in order.
        ...(walletId ? { walletId } : {}),
      });
      const account: WalletAccount = { party: session.partyId, label: session.label };
      this.setStatus({ kind: "connected", account, providerId: this.id });
      return account;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        await this.client?.disconnect();
      } catch {
        /* best-effort cleanup after a failed connection attempt */
      }
      this.setStatus({ kind: "error", message });
      throw err;
    }
  }

  /**
   * PartyLayer's wallet catalog (Loop, Console, Nightly, Send, …) with
   * best-effort install detection, mapped into the combined picker's shape.
   * Loading the PartyLayer SDK here (via the lazy client factory) is acceptable
   * because discovery is user-initiated (they opened the Connect picker).
   */
  async listWallets(): Promise<readonly DetectedWallet[]> {
    this.client ??= await this.clientFactory();
    if (!this.client.listWallets) return [];
    const wallets = await this.client.listWallets();
    return wallets.map((w): DetectedWallet => {
      const isLoop = /loop/i.test(w.walletId) || /loop/i.test(w.name);
      return {
        id: `partylayer:${w.walletId}`,
        providerId: this.id,
        walletId: w.walletId,
        name: w.name,
        description: w.description,
        icon: w.icon,
        installed: w.installed,
        installUrl: w.installUrl,
        badge: isLoop ? "Loop" : "Hosted",
      };
    });
  }

  async disconnect(): Promise<void> {
    try {
      await this.client?.disconnect();
    } catch {
      /* already disconnected */
    }
    this.setStatus({ kind: "disconnected" });
  }

  getStatus(): WalletConnectionStatus {
    return this.status;
  }

  onStatusChange(cb: (s: WalletConnectionStatus) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  async submit(intent: WalletIntent): Promise<WalletResult> {
    if (this.status.kind !== "connected" || !this.client) {
      throw new Error("partylayer-provider: wallet not connected");
    }
    const party = this.status.account.party;
    const composed = composeCommands(intent, {
      party,
      packagePrefix: this.packagePrefix,
      now: () => new Date(),
    });
    const signedTx: PartyLayerCommandSubmission = {
      commandId: composed.commandId,
      actAs: composed.actAs,
      commands: composed.commands as unknown[],
      ...(composed.disclosedContracts
        ? { disclosedContracts: composed.disclosedContracts }
        : {}),
    };
    const receipt = await this.client.submitTransaction({
      signedTx,
    });
    const updateId = receipt.updateId;
    if (!updateId) {
      const hashSuffix = receipt.transactionHash
        ? ` (transactionHash=${receipt.transactionHash})`
        : "";
      throw new Error(
        `partylayer-provider: submit returned no updateId${hashSuffix}; operator-discovery requires an updateId`,
      );
    }
    // updateId-only by design. createdAllocationCids is intentionally
    // omitted: the operator recovers the created cids from the updateId for all
    // DvP flows (LP add/remove, swap, order funding) via operator-discovery.
    return {
      submittedBy: party,
      primaryCid: updateId,
      auxiliaryCids: { updateId },
    };
  }

  async listHoldings(owner: Party): Promise<Holding[]> {
    if (this.status.kind !== "connected" || !this.client) {
      throw new Error("partylayer-provider: wallet not connected");
    }
    if (this.status.account.party !== owner) {
      throw new Error("partylayer-provider: can only read holdings for the connected party");
    }
    const client = this.client;
    return discoverHoldingsAcrossRegistries(owner, this.packagePrefix, (req) =>
      client.ledgerApi({
        requestMethod: req.method,
        resource: req.resource,
        ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
      }),
    );
  }

  private setStatus(s: WalletConnectionStatus): void {
    this.status = s;
    for (const cb of this.listeners) cb(s);
  }
}
