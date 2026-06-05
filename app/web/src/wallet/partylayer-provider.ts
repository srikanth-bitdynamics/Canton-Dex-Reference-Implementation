// PartyLayer wallet provider (CIP-0103 multi-wallet connector).
//
// PartyLayer (@partylayer/sdk) unifies supported Canton wallets behind one
// connect + signing surface. This provider sits behind the
// `WalletProvider` interface and reuses the shared `composeCommands` translator
// — the wallet only ever sees Daml command trees, never our intents.
//
// DEX-91 (resolved from the published package types): PartyLayer's submit result
// is `TxReceipt { updateId? }` — it does NOT expose the transaction tree or
// created-contract ids. So this provider deliberately returns only
// `primaryCid = updateId` and does NOT populate `createdAllocationCids`; the
// `/settle` (and the swap / order-fund) calls forward `{ updateId }` and the
// operator recovers the created `Allocation` cids (and, for LP, the
// `LiquidityAllocationAcceptance` cid) from that update's tree
// (`recoverCreatedAllocations` / `recoverDvpAllocations`, DEX-92). All DvP flows
// — LP add/remove, swap, and order funding — support this operator-discovery
// path, so an updateId-only wallet can complete them.

import { composeCommands } from "./commands";
import type {
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

// The subset of `@partylayer/sdk`'s `PartyLayerClient` we use.
export interface PartyLayerClient {
  connect(options?: PartyLayerConnectOptions): Promise<PartyLayerSession>;
  disconnect(): Promise<void>;
  submitTransaction(params: {
    signedTx: PartyLayerCommandSubmission;
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
      const session = await this.client.connect({
        requiredCapabilities: ["submitTransaction"],
        preferInstalled: true,
      });
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
    // updateId-only by design (DEX-91). createdAllocationCids is intentionally
    // omitted: the operator recovers the created cids from the updateId for all
    // DvP flows (LP add/remove, swap, order funding) via operator-discovery.
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
