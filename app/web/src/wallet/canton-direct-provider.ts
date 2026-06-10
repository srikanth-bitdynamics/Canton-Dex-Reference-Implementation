// Direct Canton ledger wallet provider.
//
// Lightweight fallback for testnet/dev. Submits intents to the Canton
// JSON Ledger API directly using a bearer token, without WalletConnect
// pairing flow. The operator backend translates the intent into the
// concrete Daml command tree; this provider just signs and submits.
//
// Use cases:
//   - Dev sessions where the user already has a JWT and a participant URL
//   - Manual validation against a controlled testnet
//   - Smoke testing the dApp without a wallet round-trip
//
// NOT suitable for end users: relies on the user trusting a long-lived
// JWT stored in localStorage. The Token Standard provider should be the
// default for real wallets.

import type {
  WalletAccount,
  WalletConnectionStatus,
  WalletIntent,
  WalletProvider,
  WalletResult,
} from "./types";
import { LiquidityAllocationUnsupportedError } from "./types";

const LS_KEY = "canton-dex:direct:session";

interface PersistedSession {
  ledgerUrl: string;
  token: string;
  party: string;
}

export class CantonDirectProvider implements WalletProvider {
  readonly id = "canton-direct";
  readonly label = "Direct Canton (advanced)";

  private status: WalletConnectionStatus = { kind: "disconnected" };
  private readonly listeners = new Set<(s: WalletConnectionStatus) => void>();
  private session: PersistedSession | null = null;

  constructor(
    private readonly defaultLedgerUrl: string,
    private readonly defaultToken: string,
  ) {
    // Auto-restore prior session on construction so a page reload keeps
    // the user signed in. Dev-only: in prod we never rehydrate a persisted
    // bearer-token session (DEX-117).
    const stored =
      import.meta.env.DEV && typeof window !== "undefined"
        ? window.localStorage.getItem(LS_KEY)
        : null;
    if (stored) {
      try {
        this.session = JSON.parse(stored) as PersistedSession;
        this.status = {
          kind: "connected",
          account: { party: this.session.party, label: this.label },
          providerId: this.id,
        };
      } catch {
        // Stored session was tampered — drop it.
        window.localStorage.removeItem(LS_KEY);
      }
    }
  }

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
    // DEX-117: never read/persist a long-lived bearer token outside dev.
    if (!import.meta.env.DEV) {
      const msg =
        "canton-direct is a dev-only provider and is disabled in production builds";
      // eslint-disable-next-line no-console
      console.error(`[wallet] ${msg}`);
      this.setStatus({ kind: "error", message: msg });
      throw new Error(msg);
    }
    if (!this.defaultLedgerUrl || !this.defaultToken) {
      const msg = "VITE_CANTON_LEDGER_URL and VITE_CANTON_AUTH_TOKEN must be set";
      this.setStatus({ kind: "error", message: msg });
      throw new Error(msg);
    }
    this.setStatus({ kind: "connecting" });
    try {
      const res = await fetch(new URL("/v2/users/current", this.defaultLedgerUrl).toString(), {
        headers: { Authorization: `Bearer ${this.defaultToken}` },
      });
      if (!res.ok) throw new Error(`ledger /v2/users/current returned ${res.status}`);
      const body = (await res.json()) as { primaryParty?: string; party?: string };
      const party = body.primaryParty ?? body.party;
      if (!party) throw new Error("ledger did not return a primary party");
      this.session = { ledgerUrl: this.defaultLedgerUrl, token: this.defaultToken, party };
      window.localStorage.setItem(LS_KEY, JSON.stringify(this.session));
      const account: WalletAccount = { party, label: this.label };
      this.setStatus({ kind: "connected", account, providerId: this.id });
      return account;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.setStatus({ kind: "error", message: msg });
      throw e;
    }
  }

  async disconnect(): Promise<void> {
    this.session = null;
    window.localStorage.removeItem(LS_KEY);
    this.setStatus({ kind: "disconnected" });
  }

  async submit(intent: WalletIntent): Promise<WalletResult> {
    if (this.status.kind !== "connected" || !this.session) {
      throw new Error("canton-direct: not connected");
    }
    if (intent.kind === "add-liquidity" || intent.kind === "remove-liquidity") {
      // Operator-relay path cannot surface the created allocation cids the
      // DvP /settle needs; LP DvP requires a CIP-0103 wallet (SDK provider).
      throw new LiquidityAllocationUnsupportedError(this.id);
    }
    // The Direct provider forwards the intent verbatim to the operator
    // backend's intent-execution endpoint. The backend resolves it into
    // a Daml command tree and signs as the trader (using the same
    // direct bearer token under the hood). This is the simplest path
    // for testnet smoke flows.
    const res = await fetch(new URL("/v1/wallet/execute", this.session.ledgerUrl).toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.session.token}`,
      },
      body: JSON.stringify({ party: this.session.party, intent }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`wallet execute failed: ${res.status} ${text}`);
    }
    return (await res.json()) as WalletResult;
  }
}
