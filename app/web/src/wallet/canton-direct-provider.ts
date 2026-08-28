// Disabled Direct Canton experiment.
//
// A participant JSON Ledger API can accept concrete Daml commands, but it does
// not expose the DEX-specific `/v1/wallet/execute` intent endpoint that an older
// version of this class called. Keeping a participant bearer token in browser
// localStorage would also be an unsafe public-deployment pattern. The provider
// registry therefore does not register this class, and both connect and submit
// fail closed. Use the dapp SDK, PartyLayer, or WalletConnect for a real wallet;
// use the development operator relay when explicitly testing backend signing.

import type {
  WalletAccount,
  WalletConnectionStatus,
  WalletIntent,
  WalletProvider,
  WalletResult,
} from "./types";

export const CANTON_DIRECT_DISABLED_MESSAGE =
  "Direct Canton is intentionally unavailable: the participant API accepts concrete Daml commands, not DEX wallet intents. Use a supported external wallet or the DEV-only operator relay.";

export class CantonDirectProvider implements WalletProvider {
  readonly id = "canton-direct";
  readonly label = "Direct Canton (disabled)";

  private status: WalletConnectionStatus = { kind: "disconnected" };
  private readonly listeners = new Set<(s: WalletConnectionStatus) => void>();

  constructor(
    // Preserve the old constructor shape for downstream imports while making
    // it impossible to retain either credential.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _defaultLedgerUrl = "",
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _defaultToken = "",
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
    this.setStatus({ kind: "error", message: CANTON_DIRECT_DISABLED_MESSAGE });
    throw new Error(CANTON_DIRECT_DISABLED_MESSAGE);
  }

  async disconnect(): Promise<void> {
    this.setStatus({ kind: "disconnected" });
  }

  async submit(_intent: WalletIntent): Promise<WalletResult> {
    throw new Error(CANTON_DIRECT_DISABLED_MESSAGE);
  }
}
