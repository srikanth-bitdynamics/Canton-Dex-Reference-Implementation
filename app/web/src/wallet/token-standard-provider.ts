// Token Standard V2 wallet provider.
//
// Canton-native wallet that:
//   1. Connects to a Canton participant via the JSON Ledger API
//   2. Selects holdings for trader-authority intents
//   3. Composes V2 Token Standard command trees (AllocationFactory_Allocate
//      + AllocationRequest_Accept, etc.) using the registry's factory CIDs
//   4. Submits the command tree via the participant's command service
//
// This is the recommended provider for Canton-native deployments. It
// bypasses the WalletConnect relay and signs directly with a JWT issued
// for the trader's party.
//
// The actual Daml command composition is delegated to the operator
// backend's /v1/wallet/compose endpoint, which knows the package hashes,
// disclosed contracts, and choice arguments. The provider's job is to:
//   - hold the user's connection state
//   - pick holdings (greedy by amount)
//   - send the composed command tree to the participant
//
// Why split composition from signing: the registry factory CIDs, package
// hash, and disclosed-contract list change per environment. Centralizing
// that knowledge in the operator backend keeps the frontend wallet code
// small and lets us iterate on V2 details without redeploying the dApp.

import type {
  WalletAccount,
  WalletConnectionStatus,
  WalletIntent,
  WalletProvider,
  WalletResult,
} from "./types";

const LS_KEY = "canton-dex:token-standard:session";
const SUBMIT_TIMEOUT_MS = 60_000;

interface PersistedSession {
  ledgerUrl: string;
  token: string;
  party: string;
  userId: string;
}

interface HoldingsResponse {
  holdings: Array<{
    contractId: string;
    payload: { owner: string; instrumentId: string; amount: string; locked: boolean };
  }>;
}

export class TokenStandardProvider implements WalletProvider {
  readonly id = "token-standard";
  readonly label = "Canton Wallet (Token Standard V2)";

  private status: WalletConnectionStatus = { kind: "disconnected" };
  private readonly listeners = new Set<(s: WalletConnectionStatus) => void>();
  private session: PersistedSession | null = null;

  constructor(
    private readonly defaultLedgerUrl: string,
    private readonly defaultToken: string,
    private readonly apiBase: string,
  ) {
    const stored = typeof window !== "undefined" ? window.localStorage.getItem(LS_KEY) : null;
    if (stored) {
      try {
        this.session = JSON.parse(stored) as PersistedSession;
        this.status = {
          kind: "connected",
          account: { party: this.session.party, label: this.label },
          providerId: this.id,
        };
      } catch {
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
      const body = (await res.json()) as { primaryParty?: string; userId?: string };
      const party = body.primaryParty;
      const userId = body.userId ?? "ledger-api-user";
      if (!party) throw new Error("ledger did not return a primary party for the token");

      this.session = {
        ledgerUrl: this.defaultLedgerUrl,
        token: this.defaultToken,
        party,
        userId,
      };
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
    if (typeof window !== "undefined") window.localStorage.removeItem(LS_KEY);
    this.setStatus({ kind: "disconnected" });
  }

  /**
   * Greedy holding selection: walk owner's non-locked holdings of
   * `instrumentId` and pick the smallest set whose sum >= required amount.
   * Returns the picked CIDs in selection order.
   */
  private async selectHoldings(
    instrumentId: string,
    requiredAmount: string,
  ): Promise<string[]> {
    if (!this.session) throw new Error("not connected");
    const url = new URL(`/v1/holdings?owner=${encodeURIComponent(this.session.party)}`, this.apiBase);
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`holdings query failed: ${res.status}`);
    const body = (await res.json()) as HoldingsResponse["holdings"];
    const need = Number(requiredAmount);
    const sorted = body
      .filter((h) => h.payload.instrumentId === instrumentId && !h.payload.locked)
      .sort((a, b) => Number(b.payload.amount) - Number(a.payload.amount));
    const picked: string[] = [];
    let running = 0;
    for (const h of sorted) {
      picked.push(h.contractId);
      running += Number(h.payload.amount);
      if (running >= need) break;
    }
    if (running < need) {
      throw new Error(
        `insufficient ${instrumentId}: have ${running}, need ${need} (consider merging holdings)`,
      );
    }
    return picked;
  }

  async submit(intent: WalletIntent): Promise<WalletResult> {
    if (this.status.kind !== "connected" || !this.session) {
      throw new Error("token-standard: not connected");
    }

    // Fill in holding CIDs the dApp didn't supply.
    let enriched: WalletIntent = intent;
    if (intent.kind === "request-swap" && intent.inputHoldingCids.length === 0) {
      enriched = {
        ...intent,
        inputHoldingCids: (await this.selectHoldings(
          intent.inputInstrumentId,
          intent.inputAmount,
        )) as ReadonlyArray<string> as typeof intent.inputHoldingCids,
      };
    } else if (intent.kind === "add-liquidity") {
      const base = intent.baseHoldingCids.length === 0
        ? await this.selectHoldings(intent.poolId.split("-")[0] ?? "", intent.baseAmount)
        : (intent.baseHoldingCids as unknown as string[]);
      const quote = intent.quoteHoldingCids.length === 0
        ? await this.selectHoldings(intent.poolId.split("-")[1] ?? "", intent.quoteAmount)
        : (intent.quoteHoldingCids as unknown as string[]);
      enriched = {
        ...intent,
        baseHoldingCids: base as typeof intent.baseHoldingCids,
        quoteHoldingCids: quote as typeof intent.quoteHoldingCids,
      };
    }

    // Compose + submit through the backend's wallet endpoint. The backend
    // resolves factory CIDs, package hash, disclosed contracts, and signs
    // as the trader using the token configured for the participant.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SUBMIT_TIMEOUT_MS);
    try {
      const res = await fetch(new URL("/v1/wallet/execute", this.apiBase).toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.session.token}`,
        },
        body: JSON.stringify({
          party: this.session.party,
          userId: this.session.userId,
          intent: enriched,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`wallet execute failed: ${res.status} ${text}`);
      }
      return (await res.json()) as WalletResult;
    } finally {
      clearTimeout(timer);
    }
  }
}
