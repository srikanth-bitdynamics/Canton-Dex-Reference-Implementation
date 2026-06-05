// PartyLayer wallet provider (CIP-0103 multi-wallet connector).
//
// PartyLayer (@partylayer/sdk) unifies Console / Nightly / Send / Cantor8 /
// Bron behind one connect + signing surface. This provider sits behind the
// `WalletProvider` interface and reuses the shared `composeCommands` translator
// — the wallet only ever sees Daml command trees, never our intents.
//
// DEX-91 (resolved from the published package types): PartyLayer's submit result
// is `TxReceipt { updateId? }` — it does NOT expose the transaction tree or
// created-contract ids. So this provider deliberately returns only
// `primaryCid = updateId` and does NOT populate `createdAllocationCids`; the
// `/settle` call forwards `{ updateId }` and the operator recovers the created
// `Allocation` cids + the `LiquidityAllocationAcceptance` cid from that update's
// tree (`recoverDvpAllocations`, DEX-92).
//
// NOTE: operator-discovery is currently wired for **LP add/remove only**.
// swap/order (the one-allocation paths) are NOT yet wired, so those flows reject
// updateId-only wallets with a clear error (see ledger.ts). LP DvP only for now.

import { composeCommands } from "./commands";
import type {
  WalletAccount,
  WalletConnectionStatus,
  WalletIntent,
  WalletProvider,
  WalletResult,
} from "./types";

// The subset of `@partylayer/sdk`'s `PartyLayerClient` we use. Mirrors the real
// API (`createPartyLayer(config).{connect,disconnect,submitTransaction}`) so the
// concrete binding is a thin adapter (added once the dependency is installed).
export interface PartyLayerSession {
  /** The connected party id. */
  partyId: string;
  /** Optional human label the wallet chose. */
  label?: string;
}

export interface PartyLayerTxReceipt {
  updateId?: string;
  transactionHash?: string;
}

export interface PartyLayerClient {
  connect(options?: unknown): Promise<PartyLayerSession>;
  disconnect(): Promise<void>;
  submitTransaction(params: {
    commandId: string;
    actAs: string[];
    commands: unknown[];
  }): Promise<PartyLayerTxReceipt>;
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
  ) {}

  async connect(): Promise<WalletAccount> {
    this.setStatus({ kind: "connecting" });
    try {
      this.client ??= await this.clientFactory();
      const session = await this.client.connect();
      const account: WalletAccount = { party: session.partyId, label: session.label };
      this.setStatus({ kind: "connected", account, providerId: this.id });
      return account;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setStatus({ kind: "error", message });
      throw err;
    }
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
    const receipt = await this.client.submitTransaction({
      commandId: composed.commandId,
      actAs: composed.actAs,
      commands: composed.commands as unknown[],
    });
    const updateId = receipt.updateId ?? receipt.transactionHash;
    if (!updateId) {
      throw new Error("partylayer-provider: submit returned no updateId");
    }
    // updateId-only by design (DEX-91). createdAllocationCids is intentionally
    // omitted: swap/LP DvP recover the created cids operator-side from updateId.
    return {
      submittedBy: party,
      primaryCid: updateId,
      auxiliaryCids: { updateId },
    };
  }

  private setStatus(s: WalletConnectionStatus): void {
    this.status = s;
    for (const cb of this.listeners) cb(s);
  }
}
