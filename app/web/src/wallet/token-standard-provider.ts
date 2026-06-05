// Token Standard V2 wallet provider — Canton-native, no backend hop.
//
// The provider holds the user's JWT (from env or a per-user signing
// session) and submits Daml commands directly to the participant's
// JSON Ledger API at `/v2/commands/submit-and-wait`. The dApp never
// signs as the trader; this provider IS the signing surface for
// trader-authority actions.
//
// What each intent maps to on-ledger:
//
//   place-order             →  CreateCommand OrderFundingRequest
//   accept-allocation-request → AllocationFactory_Allocate + AllocationRequest_Accept
//   request-swap            →  AllocationFactory_Allocate (operator settles via PoolRules_Swap)
//   add-liquidity           →  3× AllocationFactory_Allocate from a LiquidityAllocationRequest
//   remove-liquidity        →  3× AllocationFactory_Allocate from a LiquidityAllocationRequest
//   post-rfq-quote          →  CreateCommand RfqQuote
//   accept-rfq              →  Exercise Rfq_Accept (joint trader + operator)
//
// Connection lifecycle:
//   - connect() validates the ledger URL, fetches the user's primary
//     party via /v2/users/current, stores session in localStorage.
//   - reload() re-reads the localStorage session so reloads don't
//     drop the user.
//   - disconnect() clears the session.
//
// Session storage is intentionally narrow — just party + token + url.
// The party never changes during a session; the JWT is short-lived
// and refreshed via the wallet's auth flow (out of scope here).

import type {
  DisclosedContract,
  WalletAccount,
  WalletConnectionStatus,
  WalletIntent,
  WalletProvider,
  WalletResult,
} from "./types";
import {
  composeCommands,
  extractCreatedAllocationCids,
  extractLiquidityAcceptanceCid,
} from "./commands";

const LS_KEY = "canton-dex:token-standard:session";
const SUBMIT_TIMEOUT_MS = 60_000;
const SYNCHRONIZER_ID =
  ((typeof window !== "undefined" &&
    (window as { __CANTON_SYNCHRONIZER__?: string }).__CANTON_SYNCHRONIZER__) ||
    (import.meta.env.VITE_CANTON_SYNCHRONIZER as string | undefined)) ?? "";
const PACKAGE_PREFIX =
  (import.meta.env.VITE_CANTON_DEX_PACKAGE_ID as string | undefined) ??
  "#canton-dex-trading";

interface PersistedSession {
  ledgerUrl: string;
  token: string;
  party: string;
  userId: string;
}

interface SubmitAndWaitResponse {
  updateId: string;
  completionOffset: number;
  // Added by the operator backend's /v1/wallet/submit: the
  // transaction's created contracts, so DvP intents can recover the
  // allocation cids the settle needs. Absent on older backends.
  createdEvents?: Array<{ contractId: string; templateId: string }>;
}

function requireCreatedEvent(
  createdEvents: Array<{ contractId: string; templateId: string }> | undefined,
  suffix: string,
  kind: string,
): string {
  const cid = createdEvents?.find((e) => e.templateId.endsWith(suffix))?.contractId;
  if (!cid) {
    throw new Error(`wallet did not return the created ${kind} cid`);
  }
  return cid;
}

function template(name: string): string {
  return `${PACKAGE_PREFIX}:${name}`;
}

export class TokenStandardProvider implements WalletProvider {
  readonly id = "token-standard";
  readonly label = "Canton Wallet (Token Standard V2)";

  private status: WalletConnectionStatus = { kind: "disconnected" };
  private readonly listeners = new Set<(s: WalletConnectionStatus) => void>();
  private session: PersistedSession | null = null;

  constructor(
    // Kept for typed parity with other providers — the actual submit
    // path routes through the operator backend's proxy to dodge browser
    // CORS. The user's JWT is the operator backend's JWT in this
    // deployment; for real CIP-0103 wallets, the wallet would hold its
    // own JWT and talk to a participant that allows the dApp's origin.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _defaultLedgerUrl: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _defaultToken: string,
    private readonly apiBase: string,
  ) {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(LS_KEY);
    if (!stored) return;
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
    if (this.status.kind === "connected" && this.session)
      return this.status.account;
    if (!this.apiBase) {
      const msg =
        "Set VITE_API_BASE in .env.local to use the Token Standard provider";
      this.setStatus({ kind: "error", message: msg });
      throw new Error(msg);
    }

    this.setStatus({ kind: "connecting" });
    try {
      // Resolve the user's party. In production a CIP-0103 wallet
      // returns its own party id; on this testnet we use the env-
      // configured default since the shared JWT has no primary party.
      const party =
        (import.meta.env.VITE_CANTON_DEFAULT_PARTY as string | undefined) ??
        null;
      const userId =
        (import.meta.env.VITE_CANTON_USER_ID as string | undefined) ??
        "ledger-api-user";
      if (!party) {
        throw new Error(
          "Set VITE_CANTON_DEFAULT_PARTY in .env.local. In production a CIP-0103 wallet would provide this; on testnet the operator allocates parties up front.",
        );
      }
      // Verify the backend can talk to the ledger (proves the JWT is
      // valid and the participant is reachable).
      const health = await fetch(`${this.apiBase}/v1/status`);
      if (!health.ok) {
        throw new Error(
          `operator backend unreachable: ${health.status}`,
        );
      }
      this.session = {
        ledgerUrl: this.apiBase,
        token: "",
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

  // -- intent dispatch -----------------------------------------------

  async submit(intent: WalletIntent): Promise<WalletResult> {
    if (this.status.kind !== "connected" || !this.session) {
      throw new Error("token-standard: not connected");
    }
    switch (intent.kind) {
      case "place-order":
        return this.placeOrder(intent);
      case "accept-allocation-request":
        return this.acceptAllocationRequest(intent);
      case "request-swap":
      case "split-holding":
      case "merge-holdings":
      case "add-liquidity":
      case "remove-liquidity":
        // DvP swap + LP add/remove: author the allocation(s) via the shared
        // composer and recover their created cids from the submit response
        // The backend's /v1/wallet/submit now follows the transaction
        // tree and returns createdEvents, so the operator-relay path CAN surface
        // the allocation cids the settle needs — no CIP-0103 wallet required.
        return this.submitComposed(intent);
      case "post-rfq-quote":
        return this.postRfqQuote(intent);
      case "accept-rfq":
        return this.acceptRfq(intent);
    }
  }

  private async submitAndWait(
    actAs: string[],
    commandId: string,
    command: Record<string, unknown>,
  ): Promise<SubmitAndWaitResponse> {
    return this.submitCommands(actAs, commandId, [command]);
  }

  private async submitCommands(
    actAs: string[],
    commandId: string,
    commands: Record<string, unknown>[],
    disclosedContracts: DisclosedContract[] = [],
  ): Promise<SubmitAndWaitResponse> {
    if (!this.session) throw new Error("not connected");
    const body = {
      commands,
      userId: this.session.userId,
      actAs,
      commandId,
      synchronizerId: SYNCHRONIZER_ID || undefined,
      disclosedContracts,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SUBMIT_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.apiBase}/v1/wallet/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(
          `wallet/submit ${res.status}: ${text.slice(0, 400)}`,
        );
      }
      return JSON.parse(text) as SubmitAndWaitResponse;
    } finally {
      clearTimeout(timer);
    }
  }

  // DvP intents (add/remove-liquidity): build the allocation commands with
  // the shared composer, submit them, and recover the created Allocation cids
  // from the backend's createdEvents. The settle path needs those
  // cids in command order. Created events are filtered to V2.Allocation so an
  // incidental extra create can't shift the mapping.
  private async submitComposed(intent: WalletIntent): Promise<WalletResult> {
    const party = this.session!.party;
    const composed = composeCommands(intent, {
      party,
      packagePrefix: PACKAGE_PREFIX,
      now: () => new Date(),
    });
    const result = await this.submitCommands(
      composed.actAs,
      composed.commandId,
      composed.commands as unknown as Record<string, unknown>[],
      composed.disclosedContracts,
    );
    const allocationEvents = (result.createdEvents ?? []).filter((e) =>
      e.templateId.endsWith("CantonDex.Registry.V2:Allocation"),
    );
    const holdingEvents = (result.createdEvents ?? []).filter((e) =>
      e.templateId.endsWith("CantonDex.Registry.V2:Holding"),
    );
    const createdAllocationCids = extractCreatedAllocationCids(intent, {
      createdEvents: allocationEvents,
    });
    // The canonical LP accept pairing leaves a LiquidityAllocationAcceptance
    // receipt; the operator settle binds to it once the request is consumed.
    const liquidityAcceptanceCid = extractLiquidityAcceptanceCid({
      createdEvents: result.createdEvents,
    });
    return {
      submittedBy: party,
      primaryCid: result.updateId,
      createdAllocationCids,
      createdHoldingCids:
        holdingEvents.length > 0
          ? holdingEvents.map((e) => e.contractId)
          : undefined,
      auxiliaryCids: liquidityAcceptanceCid ? { liquidityAcceptanceCid } : undefined,
    };
  }

  // -- per-intent handlers -------------------------------------------

  private async placeOrder(intent: Extract<WalletIntent, { kind: "place-order" }>):
    Promise<WalletResult> {
    const party = this.session!.party;
    const result = await this.submitAndWait(
      [party],
      `order-${intent.pair.base}-${intent.pair.quote}-${Date.now()}`,
      {
        CreateCommand: {
          templateId: template("CantonDex.Dex.OrderFundingRequest:OrderFundingRequest"),
          createArguments: {
            trader: party,
            operator: intent.operator,
            admin: intent.admin,
            baseInstrumentId: intent.pair.base,
            quoteInstrumentId: intent.pair.quote,
            side: intent.side,
            limitPrice: intent.limitPrice,
            quantity: intent.quantity,
            expiry: intent.expiry,
          },
        },
      },
    );
    return {
      submittedBy: party,
      primaryCid: requireCreatedEvent(
        result.createdEvents,
        "CantonDex.Dex.OrderFundingRequest:OrderFundingRequest",
        "OrderFundingRequest",
      ),
    };
  }


  private async acceptAllocationRequest(
    intent: Extract<WalletIntent, { kind: "accept-allocation-request" }>,
  ): Promise<WalletResult> {
    const party = this.session!.party;
    const composed = composeCommands(intent, {
      party,
      packagePrefix: PACKAGE_PREFIX,
      now: () => new Date(),
    });
    const result = await this.submitCommands(
      composed.actAs,
      composed.commandId,
      composed.commands as unknown as Record<string, unknown>[],
      composed.disclosedContracts,
    );
    const allocationEvents = (result.createdEvents ?? []).filter((e) =>
      e.templateId.endsWith("CantonDex.Registry.V2:Allocation"),
    );
    const createdAllocationCids = extractCreatedAllocationCids(intent, {
      createdEvents: allocationEvents,
    });
    return {
      submittedBy: party,
      primaryCid: createdAllocationCids?.[0] ?? result.updateId,
      createdAllocationCids,
    };
  }

  private async postRfqQuote(
    intent: Extract<WalletIntent, { kind: "post-rfq-quote" }>,
  ): Promise<WalletResult> {
    const party = this.session!.party;
    const result = await this.submitAndWait(
      [party],
      `rfq-quote-${intent.rfqId}-${Date.now()}`,
      {
        CreateCommand: {
          templateId: template("CantonDex.Dex.Rfq:RfqQuote"),
          createArguments: {
            dealer: party,
            trader: intent.trader,
            operator: intent.operator,
            rfqId: intent.rfqId,
            price: intent.price,
            expiresAt: intent.expiresAt,
            postedAt: intent.postedAt,
            tier: intent.tier,
          },
        },
      },
    );
    return { submittedBy: party, primaryCid: result.updateId };
  }

  private async acceptRfq(
    intent: Extract<WalletIntent, { kind: "accept-rfq" }>,
  ): Promise<WalletResult> {
    const party = this.session!.party;
    // RFQ accept needs joint trader+operator authority. The provider
    // submits as the trader; the operator's authority comes from a
    // pre-deployed delegation. (Today this would need a backend co-sign
    // — surface that as a clear error rather than silently failing.)
    const result = await this.submitAndWait(
      [party, intent.operator],
      `rfq-accept-${intent.rfqCid.slice(0, 12)}-${Date.now()}`,
      {
        ExerciseCommand: {
          templateId: template("CantonDex.Dex.Rfq:Rfq"),
          contractId: intent.rfqCid,
          choice: "Rfq_Accept",
          choiceArgument: {
            acceptedQuoteCid: intent.acceptedQuoteCid,
            consideredQuoteCids: intent.consideredQuoteCids,
            admin: intent.admin,
            currentTime: new Date().toISOString(),
            signature: null,
          },
        },
      },
    );
    return { submittedBy: party, primaryCid: result.updateId };
  }
}
