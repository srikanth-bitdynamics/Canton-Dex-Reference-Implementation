// Runtime validation for write-route JSON bodies.
//
// Write POSTs previously cast JSON straight to the service's parameter type
// via `Parameters<...>[0]` with no runtime check, so a malformed amount or a
// bogus party id reached the ledger submitter untouched. These helpers do a
// shallow shape check and throw a typed validation error (mapped to 400 by
// the router) before the body is handed to a service.
//
// The checks are intentionally conservative — format-level, not semantic.
// On-ledger choices remain the source of truth; this just rejects obviously
// bad input early with a clear error.

export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

// Daml Decimal string: optional sign, digits, optional fractional part.
// Up to 10 fractional digits (Daml Decimal scale). No exponent form.
const DECIMAL_RE = /^-?\d+(\.\d{1,10})?$/;

// Party id format.
//
// Real Canton party ids are "<hint>::<fingerprint>" where the fingerprint is a
// hex namespace key (e.g. "alice::1220ab…"). Accepting any non-whitespace
// string lets a caller pass an arbitrary label the operator would then actAs
// on a shared token (finding B-2). By default we require the canonical
// "hint::hexfingerprint" form so a client cannot smuggle in a bare label.
//
// The in-memory dev-server uses bare hints ("trader-demo"); set
// DEX_ALLOW_BARE_PARTIES=1 (only meaningful alongside DEX_DEV_OPEN) to relax
// the check there. Production (token configured) always enforces the strict form.
const STRICT_PARTY_RE = /^[A-Za-z0-9_-]+::[0-9a-fA-F]{8,}$/;
const BARE_PARTY_RE = /^\S+$/;

function allowBareParties(): boolean {
  return process.env.DEX_ALLOW_BARE_PARTIES === "1";
}

function partyMatches(v: unknown): v is string {
  if (typeof v !== "string") return false;
  if (STRICT_PARTY_RE.test(v)) return true;
  return allowBareParties() && BARE_PARTY_RE.test(v);
}

// Contract id: non-empty, no whitespace. Canton cids look like "<hash>:<idx>"
// or the dev "#<n>:0"; we keep this permissive and only reject empty/spaces.
const CID_RE = /^\S+$/;

function asObject(o: unknown): Record<string, unknown> {
  if (typeof o !== "object" || o === null || Array.isArray(o)) {
    throw new ValidationError("expected a JSON object body");
  }
  return o as Record<string, unknown>;
}

export function requireFields(o: unknown, fields: string[]): Record<string, unknown> {
  const obj = asObject(o);
  for (const f of fields) {
    if (obj[f] === undefined || obj[f] === null) {
      throw new ValidationError(`missing required field: ${f}`, { field: f });
    }
  }
  return obj;
}

export function validateDecimal(o: Record<string, unknown>, field: string): void {
  const v = o[field];
  if (typeof v !== "string" || !DECIMAL_RE.test(v)) {
    throw new ValidationError(`field ${field} must be a Daml Decimal string`, {
      field,
      value: v,
    });
  }
}

export function validateParty(o: Record<string, unknown>, field: string): void {
  const v = o[field];
  if (!partyMatches(v)) {
    throw new ValidationError(
      `field ${field} must be a canonical Canton party id (hint::fingerprint)`,
      { field, value: v },
    );
  }
}

export function validateCid(o: Record<string, unknown>, field: string): void {
  const v = o[field];
  if (typeof v !== "string" || !CID_RE.test(v)) {
    throw new ValidationError(`field ${field} must be a contract id`, {
      field,
      value: v,
    });
  }
}

export function isDecimalString(v: unknown): v is string {
  return typeof v === "string" && DECIMAL_RE.test(v);
}

export function isPartyString(v: unknown): v is string {
  return partyMatches(v);
}

export function isCidString(v: unknown): v is string {
  return typeof v === "string" && CID_RE.test(v);
}

// Per-route validation specs. Each spec lists required fields plus a typed
// check for the load-bearing ones (amounts/parties/cids). Routes not listed
// here fall back to required-field presence only.
export interface RouteSpec {
  required: string[];
  /** At least one of these fields must be present (e.g. poolCid OR poolId). */
  anyOf?: string[];
  decimals?: string[];
  parties?: string[];
  cids?: string[];
}

export const WRITE_SPECS: Record<string, RouteSpec> = {
  "POST /v1/pools/swap": {
    required: ["poolCid", "inputInstrumentId", "inputAmount", "minOutputAmount"],
    decimals: ["inputAmount", "minOutputAmount"],
    cids: ["poolCid"],
  },
  "POST /v1/pools/swap/request": {
    required: ["poolCid", "swapper", "inputInstrumentId", "inputAmount"],
    decimals: ["inputAmount"],
    parties: ["swapper"],
    cids: ["poolCid"],
  },
  "POST /v1/pools/add-liquidity/request": {
    required: ["poolCid", "recipient", "baseAmount", "quoteAmount", "requestedAt"],
    decimals: ["baseAmount", "quoteAmount"],
    parties: ["recipient"],
    cids: ["poolCid"],
  },
  "POST /v1/pools/add-liquidity/settle": {
    required: ["poolCid", "recipient", "baseAmount", "quoteAmount", "minLpTokens", "knownTotalLpSupply", "requestedAt"],
    decimals: ["baseAmount", "quoteAmount", "minLpTokens", "knownTotalLpSupply"],
    parties: ["recipient"],
    cids: ["poolCid"],
  },
  "POST /v1/pools/remove-liquidity/request": {
    required: ["poolCid", "holder", "lpTokensToRedeem", "requestedAt"],
    decimals: ["lpTokensToRedeem"],
    parties: ["holder"],
    cids: ["poolCid"],
  },
  "POST /v1/pools/remove-liquidity/settle": {
    required: ["poolCid", "holder", "lpTokensToRedeem", "knownTotalLpSupply", "minBaseOut", "minQuoteOut", "requestedAt"],
    decimals: ["lpTokensToRedeem", "knownTotalLpSupply", "minBaseOut", "minQuoteOut"],
    parties: ["holder"],
    cids: ["poolCid"],
  },
  "POST /v1/orders/bind": {
    // `fundingRequestCid` (full-tree wallet) OR `updateId` (operator-discovery
    // from an updateId-only wallet) — exactly one is supplied, so neither is
    // unconditionally required or cid-validated here; the order service rejects
    // a body carrying neither. Mirrors the orders/fund spec below.
    required: ["settlementRef"],
  },
  "POST /v1/orders/fund": {
    required: ["orderCid"],
    cids: ["orderCid"],
  },
  "POST /v1/rfq": {
    required: ["trader", "rfqId", "pair", "side", "size", "expiresAt", "whitelist", "createdAt"],
    decimals: ["size"],
    parties: ["trader"],
  },
  "POST /v1/rfq/accept": {
    required: ["rfqCid", "acceptedQuoteCid", "consideredQuoteCids", "admin", "now"],
    parties: ["admin"],
    cids: ["rfqCid", "acceptedQuoteCid"],
  },
  "POST /v1/matched-trades/request-allocations": {
    required: ["tradeCid"],
    cids: ["tradeCid"],
  },
  "POST /v1/matched-trades/settle": {
    required: ["tradeCid", "batchesByAdmin", "allocationRequestCids"],
    cids: ["tradeCid"],
  },
  "POST /v1/matched-trades/cancel": {
    required: ["tradeCid", "allocationsByAdmin", "allocationRequestCids"],
    cids: ["tradeCid"],
  },
  "POST /v1/swaps/quote": {
    required: ["inputInstrumentId", "inputAmount"],
    anyOf: ["poolCid", "poolId"],
    decimals: ["inputAmount"],
  },
};

/**
 * Validate a parsed body against the spec for `${method} ${path}`. Throws
 * ValidationError on the first violation. No-op when there is no spec.
 */
export function validateWriteBody(routeKey: string, body: unknown): void {
  const spec = WRITE_SPECS[routeKey];
  if (!spec) return;
  const obj = requireFields(body, spec.required);
  if (spec.anyOf && !spec.anyOf.some((f) => obj[f] !== undefined && obj[f] !== null)) {
    throw new ValidationError(
      `at least one of these fields is required: ${spec.anyOf.join(", ")}`,
      { fields: spec.anyOf },
    );
  }
  for (const f of spec.decimals ?? []) validateDecimal(obj, f);
  for (const f of spec.parties ?? []) validateParty(obj, f);
  for (const f of spec.cids ?? []) validateCid(obj, f);
}
