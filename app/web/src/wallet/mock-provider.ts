// Mock provider for local development.
//
// Behaviour: pretends to be a connected wallet for "trader-demo" (matches
// the seeded operator-backend party). On submit, logs the intent and
// returns a fake WalletResult after a short delay so the UI's toast/
// status progression has something to render. Real signing requires the
// WalletConnect or CIP-0103 provider.
//
// This is the same shape the previous postMessage stub had, now lifted
// behind the WalletProvider interface so the rest of the dApp doesn't
// need to know whether the active wallet is real.

import type {
  WalletAccount,
  WalletConnectionStatus,
  WalletIntent,
  WalletProvider,
  WalletResult,
} from "./types";

const FAKE_DELAY_MS = 600;

export class MockWalletProvider implements WalletProvider {
  readonly id = "mock";
  readonly label = "Mock Wallet (dev)";

  private status: WalletConnectionStatus = { kind: "disconnected" };
  private readonly listeners = new Set<
    (s: WalletConnectionStatus) => void
  >();

  constructor(private readonly party: string = "trader-demo") {}

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
    this.setStatus({ kind: "connecting" });
    await new Promise((r) => setTimeout(r, FAKE_DELAY_MS / 2));
    const account: WalletAccount = {
      party: this.party,
      label: this.label,
    };
    this.setStatus({ kind: "connected", account, providerId: this.id });
    return account;
  }

  async disconnect(): Promise<void> {
    this.setStatus({ kind: "disconnected" });
  }

  async submit(intent: WalletIntent): Promise<WalletResult> {
    if (this.status.kind !== "connected") {
      throw new Error("mock wallet: not connected");
    }
    // eslint-disable-next-line no-console
    console.info("[mock wallet] submit intent", intent);
    await new Promise((r) => setTimeout(r, FAKE_DELAY_MS));
    const id = crypto.randomUUID().slice(0, 8);
    // LP DvP intents author 3 allocations; surface deterministic created cids
    // so the dApp's two-call settle flow has something to forward in dev.
    const createdAllocationCids =
      intent.kind === "add-liquidity" || intent.kind === "remove-liquidity"
        ? [`#mock-alloc-${id}-0:0`, `#mock-alloc-${id}-1:0`, `#mock-alloc-${id}-2:0`]
        : undefined;
    const createdHoldingCids =
      intent.kind === "split-holding"
        ? [`#mock-holding-${id}-0:0`, `#mock-holding-${id}-1:0`]
        : intent.kind === "merge-holdings"
          ? [`#mock-holding-${id}-0:0`]
          : undefined;
    return {
      submittedBy: this.status.account.party,
      primaryCid: `#mock-${id}:0`,
      createdAllocationCids,
      createdHoldingCids,
    };
  }
}
