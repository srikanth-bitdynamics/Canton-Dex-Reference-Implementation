// PartyLayer wallet provider (CIP-0103 multi-wallet connector).
//
// PartyLayer (@partylayer/sdk) unifies supported Canton wallets behind one
// connect + signing surface. This provider sits behind the
// `WalletProvider` interface and reuses the shared `composeCommands` translator
// — the wallet only ever sees Daml command trees, never our intents.
//
// PartyLayer's submit result is `TxReceipt { updateId? }` — it does NOT expose
// the transaction tree or created-contract ids. So each submitTransaction is
// updateId-only, and the operator recovers the created `Allocation` cid from
// that update's tree.
//
// PartyLayer's transaction UI also refuses a request carrying more than one
// command atom, so (capability `supportsMultiCommandTransaction` false) this
// provider submits each composed AllocationFactory_Allocate as its own
// single-command request via the shared `submitComposedCommands`, recovers the
// one allocation each creates, and aggregates the cids in canonical order —
// giving the settle orchestration the created cids exactly as before.

import { composeCommands } from "./commands";
import { capabilityFor } from "./capabilities";
import { submitComposedCommands, type PreparedSubmission } from "./sequential-submit";
import {
  discoverHoldingsAcrossRegistries,
  parseHoldingsAcsResponse,
  resolveSpendableHoldings,
  type AcsRequest,
} from "./holdings";
import type { DisplayBalance, Holding, InstrumentId } from "@/types/contracts";
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
  /** Optional so older/fake clients (tests) need not implement it. */
  signMessage?(params: {
    message: string;
    nonce?: string;
    domain?: string;
  }): Promise<{
    signature: string;
    partyId: string;
    message: string;
    nonce?: string;
    domain?: string;
  }>;
  /**
   * The connected party's primary account (CIP-0103 getPrimaryAccount), carrying
   * the public key the backend needs to verify a signMessage off-ledger.
   * Optional so older/fake clients (tests) need not implement it.
   */
  getPrimaryAccount?(): Promise<{
    partyId: string;
    publicKey: string;
    namespace?: string;
    hint?: string;
  }>;
  ledgerApi(params: PartyLayerLedgerApiParams): Promise<PartyLayerLedgerApiResult>;
  /**
   * Enumerate the configured wallet catalog with per-adapter install
   * detection, for the combined picker. Optional so older/fake clients (tests)
   * need not implement it.
   */
  listWallets?(): Promise<PartyLayerWalletInfo[]>;
  /**
   * Optional wallet-native aggregate balances for DISPLAY. Backed by the
   * connected wallet's own balance surface (Loop's getHolding()); returns
   * amounts, never spendable contract ids. Absent when the wallet exposes no
   * native aggregate.
   */
  getBalances?(): Promise<DisplayBalance[]>;
}

/** Retained export: PartyLayer's `ledgerApi` returns a JSON string envelope. */
export function parsePartyLayerHoldings(response: string, owner: Party): Holding[] {
  return parseHoldingsAcsResponse(response, owner);
}

// Submit one prepared request and resolve to its updateId. PartyLayer's receipt
// is updateId-only; a receipt without one cannot drive operator-discovery.
async function submitOne(
  client: PartyLayerClient,
  submission: PreparedSubmission,
): Promise<string> {
  const signedTx: PartyLayerCommandSubmission = {
    commandId: submission.commandId,
    actAs: submission.actAs,
    commands: submission.commands as unknown[],
    ...(submission.disclosedContracts
      ? { disclosedContracts: submission.disclosedContracts }
      : {}),
  };
  const receipt = await client.submitTransaction({ signedTx });
  if (!receipt.updateId) {
    const hashSuffix = receipt.transactionHash
      ? ` (transactionHash=${receipt.transactionHash})`
      : "";
    throw new Error(
      `partylayer-provider: submit returned no updateId${hashSuffix}; operator-discovery requires an updateId`,
    );
  }
  return receipt.updateId;
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
    const client = this.client;
    const party = this.status.account.party;
    const composed = composeCommands(intent, {
      party,
      packagePrefix: this.packagePrefix,
      now: () => new Date(),
    });
    // Until a PartyLayer wallet is proven to accept a multi-atom commands[] in
    // its transaction UI, each AllocationFactory_Allocate is submitted as its own
    // single-command request; the created cid per request is recovered from its
    // updateId and aggregated. Each submitTransaction is still updateId-only.
    return submitComposedCommands({
      intent,
      composed,
      party,
      supportsMultiCommandTransaction:
        capabilityFor(this.id).supportsMultiCommandTransaction,
      submit: (submission) => submitOne(client, submission),
    });
  }

  async signMessage(params: {
    message: string;
    nonce?: string;
    domain?: string;
  }): Promise<{
    signature: string;
    partyId: string;
    message: string;
    nonce?: string;
    domain?: string;
  }> {
    this.client ??= await this.clientFactory();
    if (!this.client.signMessage) {
      throw new Error("partylayer-provider: connected wallet does not support signMessage");
    }
    return this.client.signMessage(params);
  }

  async getPrimaryAccount(): Promise<{
    partyId: string;
    publicKey: string;
    namespace?: string;
    hint?: string;
  }> {
    this.client ??= await this.clientFactory();
    if (!this.client.getPrimaryAccount) {
      throw new Error("partylayer-provider: connected wallet does not expose getPrimaryAccount");
    }
    return this.client.getPrimaryAccount();
  }

  async listHoldings(owner: Party): Promise<Holding[]> {
    const client = this.connectedClientFor(owner);
    return discoverHoldingsAcrossRegistries(
      owner,
      this.packagePrefix,
      this.ledgerRequest(client),
    );
  }

  async resolveSpendableHoldings(
    owner: Party,
    instrument: InstrumentId,
  ): Promise<Holding[]> {
    const client = this.connectedClientFor(owner);
    return resolveSpendableHoldings(
      owner,
      instrument,
      this.packagePrefix,
      this.ledgerRequest(client),
    );
  }

  async getBalances(owner: Party): Promise<DisplayBalance[]> {
    const client = this.connectedClientFor(owner);
    if (!client.getBalances) return [];
    return client.getBalances();
  }

  /** Guarded access to the connected client for a read on `owner`. */
  private connectedClientFor(owner: Party): PartyLayerClient {
    if (this.status.kind !== "connected" || !this.client) {
      throw new Error("partylayer-provider: wallet not connected");
    }
    if (this.status.account.party !== owner) {
      throw new Error("partylayer-provider: can only read holdings for the connected party");
    }
    return this.client;
  }

  /** ACS read transport over the wallet's `ledgerApi` (body serialized). */
  private ledgerRequest(
    client: PartyLayerClient,
  ): (req: AcsRequest) => Promise<unknown> {
    return (req) =>
      client.ledgerApi({
        requestMethod: req.method,
        resource: req.resource,
        ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
      });
  }

  private setStatus(s: WalletConnectionStatus): void {
    this.status = s;
    for (const cb of this.listeners) cb(s);
  }
}
