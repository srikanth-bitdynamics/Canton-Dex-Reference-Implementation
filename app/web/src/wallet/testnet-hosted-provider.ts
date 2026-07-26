// Testnet-only hosted-party provider.
//
// connect() asks the operator backend to allocate a fresh party on this
// deployment's own participant (POST /v1/testnet/party) and uses the returned
// party id as the connected party. It exists so a visitor whose wallet party is
// hosted somewhere else can still exercise the DEX end to end: the pools'
// counter-asset is issued by this deployment's test registry, and that registry
// can only issue holdings to parties this validator hosts.
//
// This is NOT a self-custody wallet. The party lives on the operator's
// participant and the operator signs for it, so writes are relayed through the
// backend's /v1/wallet/submit endpoint — the same transport the token-standard
// relay uses. The provider is registered only when VITE_ENABLE_TESTNET_PARTY=1,
// and the backend routes only exist when DEX_TESTNET_ONBOARDING=1, so it cannot
// appear in a mainnet build.
//
// Result shape: full-tree AND updateId. The relay returns the transaction's
// created events, so DvP intents get their real `createdAllocationCids`; the
// `updateId` is also surfaced so any flow can fall back to operator-discovery
// (and so a backend that does not return created events still settles).

import {
  composeCommands,
  extractCreatedAllocationCids,
  extractLiquidityAcceptanceCid,
  type ComposedCommands,
} from "./commands";
import type {
  TestnetAirdrop,
  TestnetPartyResult,
} from "@/services/operator-api";
import type {
  DisclosedContract,
  WalletAccount,
  WalletConnectionStatus,
  WalletIntent,
  WalletProvider,
  WalletResult,
} from "./types";

const LS_KEY = "canton-dex:testnet-hosted:session";
// The menu label is an invitation ("Create testnet party"); once connected the
// wallet pill should say what the party IS, not what the button did.
const CONNECTED_LABEL = "Testnet party (demo)";
const SUBMIT_TIMEOUT_MS = 60_000;
const SYNCHRONIZER_ID =
  (import.meta.env.VITE_CANTON_SYNCHRONIZER as string | undefined) ?? "";
const USER_ID =
  (import.meta.env.VITE_CANTON_USER_ID as string | undefined) ??
  "ledger-api-user";
const ALLOCATION_TEMPLATE_SUFFIX = "CantonDex.Registry.V2:Allocation";
const HOLDING_TEMPLATE_SUFFIX = "CantonDex.Registry.V2:Holding";

/** The one operator-backend call this provider needs (injected for tests). */
export interface TestnetPartyClient {
  createTestnetParty(req: { label?: string }): Promise<TestnetPartyResult>;
}

interface PersistedSession {
  party: string;
  airdrops: TestnetAirdrop[];
}

interface RelaySubmitResponse {
  updateId: string;
  completionOffset?: number;
  // The relay follows the transaction tree and returns its created contracts,
  // so DvP intents can recover the allocation cids the settle needs.
  createdEvents?: Array<{ contractId: string; templateId: string }>;
}

export class TestnetHostedProvider implements WalletProvider {
  readonly id = "testnet-hosted";
  readonly label = "Create testnet party";

  private status: WalletConnectionStatus = { kind: "disconnected" };
  private readonly listeners = new Set<(s: WalletConnectionStatus) => void>();
  private session: PersistedSession | null = null;

  constructor(
    private readonly apiBase: string,
    private readonly packagePrefix: string,
    private readonly client: TestnetPartyClient,
  ) {
    // Rehydrate so a page reload keeps the demo party instead of allocating a
    // second one (and burning another slot of the deployment's daily cap).
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(LS_KEY);
    if (!stored) return;
    try {
      this.session = JSON.parse(stored) as PersistedSession;
      this.status = {
        kind: "connected",
        account: { party: this.session.party, label: CONNECTED_LABEL },
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
    return () => {
      this.listeners.delete(cb);
    };
  }

  private setStatus(next: WalletConnectionStatus): void {
    this.status = next;
    for (const cb of this.listeners) cb(next);
  }

  /** Test balances seeded with the current party, if any. */
  getAirdrops(): TestnetAirdrop[] {
    return this.session?.airdrops ?? [];
  }

  async connect(): Promise<WalletAccount> {
    if (this.status.kind === "connected" && this.session)
      return this.status.account;

    this.setStatus({ kind: "connecting" });
    try {
      const result = await this.client.createTestnetParty({});
      if (!result.partyId) {
        throw new Error("the backend returned no party id");
      }
      this.session = { party: result.partyId, airdrops: result.airdrops ?? [] };
      if (typeof window !== "undefined") {
        window.localStorage.setItem(LS_KEY, JSON.stringify(this.session));
      }
      const account: WalletAccount = {
        party: result.partyId,
        label: CONNECTED_LABEL,
      };
      this.setStatus({ kind: "connected", account, providerId: this.id });
      return account;
    } catch (e) {
      this.setStatus({ kind: "error", message: describeConnectError(e) });
      throw e;
    }
  }

  async disconnect(): Promise<void> {
    this.session = null;
    if (typeof window !== "undefined") window.localStorage.removeItem(LS_KEY);
    this.setStatus({ kind: "disconnected" });
  }

  async submit(intent: WalletIntent): Promise<WalletResult> {
    if (this.status.kind !== "connected" || !this.session) {
      throw new Error("testnet-hosted: not connected");
    }
    const party = this.session.party;
    const composed = composeCommands(intent, {
      party,
      packagePrefix: this.packagePrefix,
      now: () => new Date(),
    });
    const result = await this.relaySubmit(composed);
    const created = result.createdEvents ?? [];
    // Only claim created cids when the relay actually reported the tree;
    // otherwise leave them out and let the operator recover them from the
    // updateId rather than failing the count check.
    const createdAllocationCids =
      created.length > 0
        ? extractCreatedAllocationCids(intent, {
            createdEvents: created.filter((e) =>
              e.templateId.endsWith(ALLOCATION_TEMPLATE_SUFFIX),
            ),
          })
        : undefined;
    const holdingCids = created
      .filter((e) => e.templateId.endsWith(HOLDING_TEMPLATE_SUFFIX))
      .map((e) => e.contractId);
    const liquidityAcceptanceCid = extractLiquidityAcceptanceCid({
      createdEvents: created,
    });
    return {
      submittedBy: party,
      primaryCid: createdAllocationCids?.[0] ?? result.updateId,
      createdAllocationCids,
      createdHoldingCids: holdingCids.length > 0 ? holdingCids : undefined,
      auxiliaryCids: {
        updateId: result.updateId,
        ...(liquidityAcceptanceCid ? { liquidityAcceptanceCid } : {}),
      },
    };
  }

  // The operator's participant hosts this party, so the backend relay submits
  // the composed tree on its behalf.
  private async relaySubmit(
    composed: ComposedCommands,
  ): Promise<RelaySubmitResponse> {
    const body = {
      commands: composed.commands,
      userId: USER_ID,
      actAs: composed.actAs,
      commandId: composed.commandId,
      synchronizerId: SYNCHRONIZER_ID || undefined,
      disclosedContracts: (composed.disclosedContracts ??
        []) as DisclosedContract[],
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
        throw new Error(`wallet/submit ${res.status}: ${text.slice(0, 400)}`);
      }
      return JSON.parse(text) as RelaySubmitResponse;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * User-actionable connect errors. The Connect menu renders the status message
 * verbatim, so translate the two states a visitor can actually hit — the route
 * being off and the deployment's daily cap — into plain wording.
 */
function describeConnectError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (raw.startsWith("404")) {
    return "Testnet party creation is not enabled on this deployment.";
  }
  if (raw.startsWith("429")) {
    return "This deployment has reached its daily limit for new testnet parties. Try again later.";
  }
  return `Could not create a testnet party: ${raw}`;
}
