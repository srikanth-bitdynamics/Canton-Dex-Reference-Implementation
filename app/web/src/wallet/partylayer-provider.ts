// PartyLayer wallet provider (CIP-0103 multi-wallet connector).
//
// PartyLayer (@partylayer/sdk) unifies supported Canton wallets behind one
// connect + signing surface. This provider sits behind the
// `WalletProvider` interface and reuses the shared `composeCommands` translator
// — the wallet only ever sees Daml command trees, never our intents.
//
// DEX-91 (resolved from the published package types): PartyLayer's submit result
// is `TxReceipt { updateId? }` — it does NOT expose the transaction tree or
// created-contract ids. So this provider deliberately returns only
// `primaryCid = updateId` and does NOT populate `createdAllocationCids`; the
// `/settle` (and the swap / order-fund) calls forward `{ updateId }` and the
// operator recovers the created `Allocation` cids (and, for LP, the
// `LiquidityAllocationAcceptance` cid) from that update's tree
// (`recoverCreatedAllocations` / `recoverDvpAllocations`, DEX-92). All DvP flows
// — LP add/remove, swap, and order funding — support this operator-discovery
// path, so an updateId-only wallet can complete them.

import { composeCommands } from "./commands";
import type { Holding } from "@/types/contracts";
import type {
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
  ledgerApi(params: PartyLayerLedgerApiParams): Promise<PartyLayerLedgerApiResult>;
}

const HOLDING_V2_INTERFACE_ID =
  "#splice-api-token-holding-v2:Splice.Api.Token.HoldingV2:Holding";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function extractContractEvents(value: unknown): unknown[] {
  const root = asRecord(value);
  if (!root) return [];
  const candidates = [
    root.activeContracts,
    root.active_contracts,
    root.contracts,
    root.result,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return Array.isArray(value) ? value : [];
}

function unwrapCreatedEvent(value: unknown): Record<string, unknown> | null {
  const root = asRecord(value);
  if (!root) return null;
  const wrappers = [
    root.CreatedEvent,
    root.createdEvent,
    asRecord(root.contractEntry)?.JsActiveContract &&
      asRecord(asRecord(root.contractEntry)?.JsActiveContract)?.createdEvent,
  ];
  for (const wrapper of wrappers) {
    const event = asRecord(wrapper);
    if (event) return event;
  }
  return root;
}

function contractPayload(event: Record<string, unknown>): Record<string, unknown> | null {
  const interfaceViews =
    asRecord(event.interfaceViews) ?? asRecord(event.interface_views);
  const interfaceView = interfaceViews
    ? Object.values(interfaceViews)
        .map(asRecord)
        .find((view) => !!view)
    : null;
  const interfacePayload =
    asRecord(interfaceView?.viewValue) ??
    asRecord(interfaceView?.view_value) ??
    asRecord(interfaceView?.view);

  return (
    asRecord(event.createArgument) ??
    asRecord(event.createArguments) ??
    asRecord(event.create_argument) ??
    asRecord(event.create_arguments) ??
    asRecord(event.payload) ??
    asRecord(event.view) ??
    interfacePayload ??
    (event.instrumentId || event.instrument_id || event.account ? event : null) ??
    null
  );
}

function contractIdOf(event: Record<string, unknown>): string | null {
  const value = event.contractId ?? event.contract_id ?? event.cid ?? event.id;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseAmount(value: unknown): number {
  if (typeof value === "number") return value;
  const parsed = parseFloat(String(value ?? 0));
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseHoldingPayload(
  contractId: string,
  owner: Party,
  payload: Record<string, unknown>,
): Holding | null {
  const instrument =
    payload.instrumentId ?? payload.instrument_id ?? payload.instrument;
  const instrumentRecord = asRecord(instrument);
  const account = asRecord(payload.account);
  const payloadOwner =
    payload.owner ?? payload.accountOwner ?? payload.account_owner ?? account?.owner;
  if (typeof payloadOwner === "string" && payloadOwner !== owner) return null;

  const instrumentId =
    typeof instrument === "string"
      ? instrument
      : firstString(
          instrumentRecord?.id,
          instrumentRecord?.instrumentId,
          instrumentRecord?.instrument_id,
          payload.instrumentIdText,
          payload.instrument_id_text,
        );
  const admin = firstString(
    payload.admin,
    payload.instrumentAdmin,
    payload.instrument_admin,
    instrumentRecord?.admin,
    instrumentRecord?.instrumentAdmin,
    instrumentRecord?.instrument_admin,
  );
  const resolvedOwner =
    typeof payloadOwner === "string"
      ? payloadOwner
      : typeof account?.owner === "string"
        ? account.owner
        : owner;

  if (!instrumentId || !admin) return null;

  const locked =
    typeof payload.locked === "boolean"
      ? payload.locked
      : payload.lock !== undefined && payload.lock !== null;

  return {
    contractId,
    owner: resolvedOwner,
    admin,
    instrumentId,
    amount: parseAmount(payload.amount),
    locked,
  };
}

function dedupeHoldings(holdings: Holding[]): Holding[] {
  const byCid = new Map<string, Holding>();
  for (const holding of holdings) byCid.set(holding.contractId, holding);
  return [...byCid.values()];
}

export function parsePartyLayerHoldings(response: string, owner: Party): Holding[] {
  const parsed = JSON.parse(response) as unknown;
  return extractContractEvents(parsed)
    .map(unwrapCreatedEvent)
    .filter((event): event is Record<string, unknown> => !!event)
    .map((event) => {
      const contractId = contractIdOf(event);
      const payload = contractPayload(event);
      if (!contractId || !payload) return null;
      return parseHoldingPayload(contractId, owner, payload);
    })
    .filter((holding): holding is Holding => !!holding);
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

  async connect(): Promise<WalletAccount> {
    this.setStatus({ kind: "connecting" });
    try {
      this.client ??= await this.clientFactory();
      const session = await this.client.connect({
        requiredCapabilities: ["submitTransaction", "ledgerApi"],
        preferInstalled: true,
        timeoutMs: this.connectTimeoutMs,
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
    const party = this.status.account.party;
    const composed = composeCommands(intent, {
      party,
      packagePrefix: this.packagePrefix,
      now: () => new Date(),
    });
    const signedTx: PartyLayerCommandSubmission = {
      commandId: composed.commandId,
      actAs: composed.actAs,
      commands: composed.commands as unknown[],
      ...(composed.disclosedContracts
        ? { disclosedContracts: composed.disclosedContracts }
        : {}),
    };
    const receipt = await this.client.submitTransaction({
      signedTx,
    });
    const updateId = receipt.updateId;
    if (!updateId) {
      const hashSuffix = receipt.transactionHash
        ? ` (transactionHash=${receipt.transactionHash})`
        : "";
      throw new Error(
        `partylayer-provider: submit returned no updateId${hashSuffix}; operator-discovery requires an updateId`,
      );
    }
    // updateId-only by design (DEX-91). createdAllocationCids is intentionally
    // omitted: the operator recovers the created cids from the updateId for all
    // DvP flows (LP add/remove, swap, order funding) via operator-discovery.
    return {
      submittedBy: party,
      primaryCid: updateId,
      auxiliaryCids: { updateId },
    };
  }

  async listHoldings(owner: Party): Promise<Holding[]> {
    if (this.status.kind !== "connected" || !this.client) {
      throw new Error("partylayer-provider: wallet not connected");
    }
    if (this.status.account.party !== owner) {
      throw new Error("partylayer-provider: can only read holdings for the connected party");
    }
    const templateId = `${this.packagePrefix}:CantonDex.Registry.V2:Holding`;
    const filters = [
      { interfaceId: HOLDING_V2_INTERFACE_ID },
      { templateId },
    ];
    const holdings: Holding[] = [];
    let successfulReads = 0;
    let lastError: unknown = null;

    for (const filter of filters) {
      try {
        const result = await this.client.ledgerApi({
          requestMethod: "POST",
          resource: "/v2/state/acs",
          body: JSON.stringify(filter),
        });
        successfulReads += 1;
        holdings.push(...parsePartyLayerHoldings(result.response, owner));
      } catch (err) {
        lastError = err;
      }
    }

    if (successfulReads === 0 && lastError) throw lastError;
    return dedupeHoldings(holdings);
  }

  private setStatus(s: WalletConnectionStatus): void {
    this.status = s;
    for (const cb of this.listeners) cb(s);
  }
}
