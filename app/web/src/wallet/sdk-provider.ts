// CIP-0103 dApp-standard wallet provider backed by
// `@canton-network/dapp-sdk`.
//
// Trust model — the point of this provider:
//
//   The dApp NEVER holds signing authority for trader-authority
//   writes. We compose Daml command trees (via `./commands`), hand
//   them to the SDK as `PrepareExecuteParams`, and the wallet's own
//   participant signs and submits. The dApp doesn't see the signature
//   and doesn't talk to the participant. This closes the boundary
//   that token-standard-provider / canton-direct-provider violate by
//   routing through the operator-backend's session.
//
// Design rules baked in:
//
//   1. Discovery is the SDK's job. We pass no wallet id at any point;
//      `sdk.init()` registers default + announced + injected adapters
//      and `sdk.connect()` opens a wallet picker. Adding a second
//      wallet becomes config (gateway URL, adapter), not code.
//
//   2. Commands come from `composeCommands()`. This provider does not
//      construct `CreateCommand` / `ExerciseCommand` directly. The
//      audit boundary stays in one file (`./commands`).
//
//   3. Single SDK singleton. The SDK exports a module-level `sdk`
//      singleton and helper functions that delegate to it; concurrent
//      `init()` calls share the same in-flight promise. We hold no
//      additional state beyond the cached status + primary party.
//
// Env vars:
//
//   VITE_ENABLE_SDK             — `"1"` enables the provider in the
//                                 registry (default off so the existing
//                                 providers keep working during the
//                                 cutover).
//   VITE_CANTON_DEX_PACKAGE_ID  — package qualifier for our Daml
//                                 templates. Either the deployed package
//                                 hash or a `#canton-dex-trading`
//                                 reference (CIP-0103 lets wallets
//                                 resolve the name at submission time).
//
// The provider is intentionally thin. All SDK quirks live behind the
// SDK's typed surface; everything we do is async + idempotent + retry-
// safe.

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

import { composeCommands } from "./commands";
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

  // -- lifecycle -----------------------------------------------------

  async connect(): Promise<WalletAccount> {
    this.setStatus({ kind: "connecting" });
    try {
      // SDK quirk: init is idempotent; concurrent callers share the
      // in-flight promise. First call wins on adapter selection — we
      // pass no overrides so the SDK uses its default gateways +
      // discovers injected/announced wallets.
      if (!this.initialised) {
        await sdkInit();
        this.initialised = true;
        this.wireEvents();
      }

      const conn = await sdkConnect();
      if (!conn.isConnected) {
        throw new Error(
          `sdk-provider: wallet refused connect (${conn.reason ?? "no reason"})`,
        );
      }
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
    try {
      await sdkDisconnect();
    } catch {
      // SDK may throw if already disconnected; we still flip local state.
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

  // -- submission ----------------------------------------------------

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
    // PrepareExecuteParams accepts `commands: JsCommands` which is
    // `{[key: string]: any}` on the wire — pass-through. The wallet
    // decodes + displays the command tree, the user approves, the
    // wallet signs + submits via its own participant. Two-stage
    // prepare/execute is handled inside the SDK; we use the
    // `*AndWait` variant so the result carries the resolved update.
    const result = await prepareExecuteAndWait({
      commandId: composed.commandId,
      commands: composed.commands as unknown as Record<string, unknown>,
      actAs: composed.actAs,
    });
    // The SDK surfaces an update via `tx`. Shape varies by event but
    // every variant carries an updateId / contractId we can pluck.
    const tx = result.tx as { updateId?: string; contractId?: string };
    return {
      submittedBy: party,
      primaryCid: tx.updateId ?? tx.contractId ?? composed.commandId,
    };
  }

  // -- internals -----------------------------------------------------

  private async primaryAccount(): Promise<WalletAccount> {
    const accounts: Wallet[] = await sdkListAccounts();
    if (accounts.length === 0) {
      throw new Error("sdk-provider: wallet returned no accounts");
    }
    const primary = accounts.find((w) => w.primary) ?? accounts[0];
    return {
      party: primary.partyId,
      label: primary.hint || primary.partyId,
    };
  }

  private setStatus(s: WalletConnectionStatus): void {
    this.status = s;
    for (const cb of this.listeners) cb(s);
  }

  private wireEvents(): void {
    // SDK forwards wallet-side disconnects / account switches via
    // these listeners. We reflect them into our own status so the UI
    // updates without polling.
    this.statusListener = (e: StatusEvent) => {
      // StatusEvent carries `provider` (current selected provider id)
      // plus an `isConnected`-shaped payload through the underlying
      // ConnectResult. If the wallet drops, surface as disconnected.
      const conn = (e as unknown as { isConnected?: boolean }).isConnected;
      if (conn === false && this.status.kind === "connected") {
        this.setStatus({ kind: "disconnected" });
      }
    };
    this.accountsListener = (e: AccountsChangedEvent) => {
      // AccountsChangedEvent = Wallet[]. If the primary party changes
      // mid-session, re-emit a connected status with the new party so
      // pages re-render against it.
      const primary = e.find((w) => w.primary) ?? e[0];
      if (!primary) return;
      if (
        this.status.kind === "connected" &&
        this.status.account.party !== primary.partyId
      ) {
        this.setStatus({
          kind: "connected",
          account: {
            party: primary.partyId,
            label: primary.hint || primary.partyId,
          },
          providerId: this.id,
        });
      }
    };
    void onStatusChanged(this.statusListener);
    void onAccountsChanged(this.accountsListener);
  }

  // Currently unused but kept for symmetry; tests + future teardown
  // hooks may want to detach listeners on hot-reload.
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
