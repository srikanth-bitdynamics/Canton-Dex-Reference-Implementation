// Development-only operator-signing relay.
//
// Its provider id is `token-standard`, because the commands it composes use
// the Token Standard V2 allocation interfaces. It is NOT a Token
// Standard wallet and it is NOT self-custodial: the browser posts shaped Daml
// commands to the operator backend's `/v1/wallet/submit` route, and that backend
// submits them with its configured ledger credential. The registry exposes this
// class only in Vite DEV builds. Production deployments must use an external
// wallet through the dapp SDK, PartyLayer, or WalletConnect adapters.
//
// What each intent maps to on-ledger:
//
//   place-order             →  CreateCommand OrderFundingRequest
//   fund-order               → AllocationFactory_Allocate
//   request-swap            →  AllocationFactory_Allocate (operator settles via PoolRules_Swap)
//   add-liquidity           →  CreateAndExercise BatchingUtilityV2.ExecuteBatch
//                               (accept + all 3 allocations in one command)
//   remove-liquidity        →  CreateAndExercise BatchingUtilityV2.ExecuteBatch
//                               (accept + all 3 allocations in one command)
//
// Development connection lifecycle:
//   - connect() verifies the operator backend and uses the explicitly
//     configured demo party.
//   - reload() restores only the party and ledger user id from localStorage.
//   - disconnect() clears the session.
//
// No participant JWT is read or stored here. Browser-to-backend write
// authorization is supplied separately by apiAuthHeaders; the backend's ledger
// credential remains server-side.

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
import { apiAuthHeaders } from "../services/api-auth";

const LS_KEY = "canton-dex:token-standard:session";
const SUBMIT_TIMEOUT_MS = 60_000;
const SYNCHRONIZER_ID =
  ((typeof window !== "undefined" &&
    (window as { __CANTON_SYNCHRONIZER__?: string }).__CANTON_SYNCHRONIZER__) ||
    (import.meta.env.VITE_CANTON_SYNCHRONIZER as string | undefined)) ?? "";
const PACKAGE_PREFIX =
  (import.meta.env.VITE_CANTON_DEX_PACKAGE_ID as string | undefined) ??
  "#canton-dex-trading-v2";

interface PersistedSession {
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
  readonly label = "Operator Relay (dev only)";

  private status: WalletConnectionStatus = { kind: "disconnected" };
  private readonly listeners = new Set<(s: WalletConnectionStatus) => void>();
  private session: PersistedSession | null = null;

  constructor(private readonly apiBase: string) {
    if (!import.meta.env.DEV || typeof window === "undefined") return;
    const stored = window.localStorage.getItem(LS_KEY);
    if (!stored) return;
    try {
      const parsed = JSON.parse(stored) as Partial<PersistedSession>;
      if (typeof parsed.party !== "string" || typeof parsed.userId !== "string") {
        throw new Error("invalid operator-relay session");
      }
      // Rewrite the narrow shape so fields from an older implementation are
      // not retained indefinitely in browser storage.
      this.session = { party: parsed.party, userId: parsed.userId };
      window.localStorage.setItem(LS_KEY, JSON.stringify(this.session));
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
    if (!import.meta.env.DEV) {
      const msg =
        "the operator relay is development-only; configure an external wallet for production";
      this.setStatus({ kind: "error", message: msg });
      throw new Error(msg);
    }
    if (!this.apiBase) {
      const msg =
        "Set VITE_API_BASE in .env.local to use the development operator relay";
      this.setStatus({ kind: "error", message: msg });
      throw new Error(msg);
    }

    this.setStatus({ kind: "connecting" });
    try {
      // A real wallet returns its own party. This relay instead uses an
      // explicitly configured demo party whose ledger rights are held by the
      // backend credential.
      const party =
        (import.meta.env.VITE_CANTON_DEFAULT_PARTY as string | undefined) ??
        null;
      const userId =
        (import.meta.env.VITE_CANTON_USER_ID as string | undefined) ??
        "ledger-api-user";
      if (!party) {
        throw new Error(
          "Set VITE_CANTON_DEFAULT_PARTY in .env.local to use the development operator relay.",
        );
      }
      // This checks only that the backend is reachable. The first write is the
      // point at which backend authorization and ledger submission are proven.
      const health = await fetch(`${this.apiBase}/v1/status`);
      if (!health.ok) {
        throw new Error(
          `operator backend unreachable: ${health.status}`,
        );
      }
      this.session = {
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
    if (!import.meta.env.DEV) {
      throw new Error(
        "the operator relay is development-only; configure an external wallet for production",
      );
    }
    if (this.status.kind !== "connected" || !this.session) {
      throw new Error("operator-relay: not connected");
    }
    switch (intent.kind) {
      case "place-order":
        return this.placeOrder(intent);
      case "fund-order":
        return this.fundOrder(intent);
      case "request-swap":
      case "split-holding":
      case "merge-holdings":
      case "add-liquidity":
      case "remove-liquidity":
      case "fund-matched-trade":
        // DvP swap + LP add/remove: compose the allocation command(s), ask the
        // operator backend to submit them, and recover their created cids.
        // The backend's /v1/wallet/submit now follows the transaction
        // tree and returns createdEvents, so this development relay can surface
        // the allocation cids that settle needs.
        return this.submitComposed(intent);
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
        headers: {
          "Content-Type": "application/json",
          ...apiAuthHeaders("/v1/wallet/submit", "POST"),
        },
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
      `order-${intent.pair.base.id}-${intent.pair.quote.id}-${Date.now()}`,
      {
        CreateCommand: {
          templateId: template("CantonDex.Dex.OrderFundingRequest:OrderFundingRequest"),
          createArguments: {
            trader: party,
            operator: intent.operator,
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


  private async fundOrder(
    intent: Extract<WalletIntent, { kind: "fund-order" }>,
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

}
