// CIP-0103 wallet provider backed by @canton-network/dapp-sdk.
// Composes commands via ./commands and delegates signing+submit to the wallet.

import {
  init as sdkInit,
  connect as sdkConnect,
  disconnect as sdkDisconnect,
  listAccounts as sdkListAccounts,
  prepareExecuteAndWait,
  onStatusChanged,
  onAccountsChanged,
  removeOnStatusChanged,
  removeOnAccountsChanged,
  type StatusEvent,
  type AccountsChangedEvent,
  type Wallet,
} from "@canton-network/dapp-sdk";

import {
  composeCommands,
  extractCreatedAllocationCids,
  extractLiquidityAcceptanceCid,
} from "./commands";
import type {
  WalletAccount,
  WalletConnectionStatus,
  WalletIntent,
  WalletProvider,
  WalletResult,
} from "./types";

export class SdkProvider implements WalletProvider {
  readonly id = "sdk" as const;
  readonly label = "Canton wallet (CIP-0103)";

  private status: WalletConnectionStatus = { kind: "disconnected" };
  private listeners = new Set<(s: WalletConnectionStatus) => void>();
  private initialised = false;
  private statusListener: ((e: StatusEvent) => void) | null = null;
  private accountsListener: ((e: AccountsChangedEvent) => void) | null = null;

  constructor(private readonly packagePrefix: string) {}

  async connect(): Promise<WalletAccount> {
    this.setStatus({ kind: "connecting" });
    try {
      if (!this.initialised) {
        await sdkInit();
        this.initialised = true;
      }
      const conn = await sdkConnect();
      if (!conn.isConnected) {
        throw new Error(`sdk-provider: wallet refused connect (${conn.reason ?? "no reason"})`);
      }
      // SDK rejects status/account subscriptions before connect resolves.
      if (this.statusListener === null) this.wireEvents();
      const account = await this.primaryAccount();
      this.setStatus({ kind: "connected", account, providerId: this.id });
      return account;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus({ kind: "error", message: msg });
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    try { await sdkDisconnect(); } catch { /* already disconnected */ }
    this.setStatus({ kind: "disconnected" });
  }

  getStatus(): WalletConnectionStatus {
    return this.status;
  }

  onStatusChange(cb: (s: WalletConnectionStatus) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  async submit(intent: WalletIntent): Promise<WalletResult> {
    if (this.status.kind !== "connected") {
      throw new Error("sdk-provider: wallet not connected");
    }
    const party = this.status.account.party;
    const composed = composeCommands(intent, {
      party,
      packagePrefix: this.packagePrefix,
      now: () => new Date(),
    });
    const result = await prepareExecuteAndWait({
      commandId: composed.commandId,
      commands: composed.commands as unknown as Record<string, unknown>,
      actAs: composed.actAs,
    });
    const tx = result.tx as {
      updateId?: string;
      contractId?: string;
      createdEvents?: Array<{ contractId: string; templateId?: string }>;
      events?: Array<{ created?: { contractId: string; templateId?: string } }>;
    };
    const liquidityAcceptanceCid = extractLiquidityAcceptanceCid(tx);
    return {
      submittedBy: party,
      primaryCid: tx.updateId ?? tx.contractId ?? composed.commandId,
      createdAllocationCids: extractCreatedAllocationCids(intent, tx),
      auxiliaryCids: liquidityAcceptanceCid ? { liquidityAcceptanceCid } : undefined,
    };
  }

  private async primaryAccount(): Promise<WalletAccount> {
    const accounts: Wallet[] = await sdkListAccounts();
    if (accounts.length === 0) {
      throw new Error("sdk-provider: wallet returned no accounts");
    }
    const primary = accounts.find((w) => w.primary) ?? accounts[0];
    return { party: primary.partyId, label: primary.hint || primary.partyId };
  }

  private setStatus(s: WalletConnectionStatus): void {
    this.status = s;
    for (const cb of this.listeners) cb(s);
  }

  private wireEvents(): void {
    this.statusListener = (e: StatusEvent) => {
      const conn = (e as unknown as { isConnected?: boolean }).isConnected;
      if (conn === false && this.status.kind === "connected") {
        this.setStatus({ kind: "disconnected" });
      }
    };
    this.accountsListener = (e: AccountsChangedEvent) => {
      const primary = e.find((w) => w.primary) ?? e[0];
      if (!primary) return;
      if (this.status.kind === "connected" && this.status.account.party !== primary.partyId) {
        this.setStatus({
          kind: "connected",
          account: { party: primary.partyId, label: primary.hint || primary.partyId },
          providerId: this.id,
        });
      }
    };
    void onStatusChanged(this.statusListener);
    void onAccountsChanged(this.accountsListener);
  }

  async destroy(): Promise<void> {
    if (this.statusListener) {
      await removeOnStatusChanged(this.statusListener);
      this.statusListener = null;
    }
    if (this.accountsListener) {
      await removeOnAccountsChanged(this.accountsListener);
      this.accountsListener = null;
    }
  }
}
