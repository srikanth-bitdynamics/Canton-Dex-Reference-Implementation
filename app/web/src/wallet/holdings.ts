// Cross-registry holding discovery, shared by every wallet provider that can
// read the ledger.
//
// A trader funds a trade from whatever registry issued the asset — Canton Coin
// (Amulet), USDCx, or the DEX's own Registry.V2. Discovery therefore queries
// the token-standard HoldingV2 INTERFACE, which every compliant registry
// implements, so a foreign-registry holding is found regardless of which
// registry issued it. The DEX's own Registry.V2 template is queried too, in
// case a participant surfaces it without the interface view. Results are keyed
// by contract id and deduped across both reads.

import type { Holding } from "@/types/contracts";
import type { Party } from "./types";

export const HOLDING_V2_INTERFACE_ID =
  "#splice-api-token-holding-v2:Splice.Api.Token.HoldingV2:Holding";

/**
 * A Ledger API read routed through a provider's own transport. `/v2/state/acs`
 * shorthand is not part of the Canton JSON Ledger API: holdings are read from
 * `/v2/state/active-contracts` against a `/v2/state/ledger-end` offset, exactly
 * as the generated client does. `body` is a plain object; a transport whose
 * ledgerApi takes a string body serializes it.
 */
export interface AcsRequest {
  method: "GET" | "POST";
  resource: string;
  body?: unknown;
}

/**
 * The per-party cumulative filters that discover every fundable holding: the
 * token-standard Holding interface (its view requested) across all registries,
 * then the DEX's own Registry.V2 template for a participant that surfaces it
 * without the interface view.
 */
function holdingCumulativeFilters(packagePrefix: string): unknown[] {
  return [
    {
      identifierFilter: {
        InterfaceFilter: {
          value: {
            interfaceId: HOLDING_V2_INTERFACE_ID,
            includeInterfaceView: true,
            includeCreatedEventBlob: false,
          },
        },
      },
    },
    {
      identifierFilter: {
        TemplateFilter: {
          value: {
            templateId: `${packagePrefix}:CantonDex.Registry.V2:Holding`,
            includeCreatedEventBlob: false,
          },
        },
      },
    },
  ];
}

/** Active-contracts request body for one cumulative filter and one party. */
function activeContractsBody(
  owner: Party,
  activeAtOffset: number,
  cumulative: unknown,
): Record<string, unknown> {
  return {
    verbose: false,
    activeAtOffset,
    filter: {
      filtersByParty: {
        [owner]: { cumulative: [cumulative] },
      },
    },
  };
}

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

  // Prefer the requested HoldingV2 interface view: it is the standard, admin-
  // aware shape ({admin,id} instrument, structured account) served for every
  // registry. A registry-specific createArgument is only the fallback for a
  // participant that returns the DEX template without the interface view.
  return (
    interfacePayload ??
    asRecord(event.createArgument) ??
    asRecord(event.createArguments) ??
    asRecord(event.create_argument) ??
    asRecord(event.create_arguments) ??
    asRecord(event.payload) ??
    asRecord(event.view) ??
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
    // Preserve the exact wire string for precise funding-cid selection.
    ...(typeof payload.amount === "string" ? { amountRaw: payload.amount } : {}),
    locked,
  };
}

/**
 * Normalize an ACS response into holdings. Accepts the raw JSON string, a
 * `{ response: <json string> }` envelope (CIP-0103 `ledgerApi`), or an
 * already-parsed object — so every provider's read transport can share it.
 */
export function parseHoldingsAcsResponse(response: unknown, owner: Party): Holding[] {
  const parsed = normalizeAcsResponse(response);
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

function normalizeAcsResponse(response: unknown): unknown {
  if (typeof response === "string") return JSON.parse(response);
  const record = asRecord(response);
  if (record && typeof record.response === "string") {
    return JSON.parse(record.response);
  }
  return response;
}

/** Ledger-end offset from a `/v2/state/ledger-end` response. */
function parseLedgerEndOffset(response: unknown): number {
  const record = asRecord(normalizeAcsResponse(response));
  const offset = record?.offset;
  if (typeof offset === "number" && Number.isFinite(offset)) return offset;
  if (typeof offset === "string" && offset.trim() !== "" && Number.isFinite(Number(offset))) {
    return Number(offset);
  }
  throw new Error("ledger-end response has no numeric offset");
}

export function dedupeHoldings(holdings: Holding[]): Holding[] {
  const byCid = new Map<string, Holding>();
  for (const holding of holdings) byCid.set(holding.contractId, holding);
  return [...byCid.values()];
}

/**
 * Discover the owner's fundable holdings across every registry through a
 * provider's own ledger-read transport. Reads the ledger-end offset, then
 * queries `/v2/state/active-contracts` at that offset for each cumulative
 * filter (the HoldingV2 interface, then the DEX template), per-party. `request`
 * returns whatever the provider's `ledgerApi`/`canton_ledgerApi` transport
 * yields (string, envelope, or object); it is parsed uniformly. A filter that
 * fails is tolerated as long as one succeeds — a participant may not host the
 * DEX template, or may not expose the interface — but if every read fails the
 * last error is rethrown.
 */
export async function discoverHoldingsAcrossRegistries(
  owner: Party,
  packagePrefix: string,
  request: (req: AcsRequest) => Promise<unknown>,
): Promise<Holding[]> {
  const endResponse = await request({ method: "GET", resource: "/v2/state/ledger-end" });
  const activeAtOffset = parseLedgerEndOffset(endResponse);

  const holdings: Holding[] = [];
  let successfulReads = 0;
  let lastError: unknown = null;

  for (const cumulative of holdingCumulativeFilters(packagePrefix)) {
    try {
      const response = await request({
        method: "POST",
        resource: "/v2/state/active-contracts",
        body: activeContractsBody(owner, activeAtOffset, cumulative),
      });
      successfulReads += 1;
      holdings.push(...parseHoldingsAcsResponse(response, owner));
    } catch (err) {
      lastError = err;
    }
  }

  if (successfulReads === 0 && lastError) throw lastError;
  return dedupeHoldings(holdings);
}
