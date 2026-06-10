// Runtime validation for write-route JSON bodies (DEX-108).
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

// Party id: non-empty, no whitespace. Canton party ids are "hint::fingerprint"
// but dev/in-memory parties are bare hints, so we only reject whitespace/empty.
const PARTY_RE = /^\S+$/;

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
  if (typeof v !== "string" || !PARTY_RE.test(v)) {
    throw new ValidationError(`field ${field} must be a party id`, {
      field,
      value: v,
    });
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
  return typeof v === "string" && PARTY_RE.test(v);
}

export function isCidString(v: unknown): v is string {
  return typeof v === "string" && CID_RE.test(v);
}

// Per-route validation specs. Each spec lists required fields plus a typed
// check for the load-bearing ones (amounts/parties/cids). Routes not listed
// here fall back to required-field presence only.
export interface RouteSpec {
  required: string[];
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
    required: ["fundingRequestCid", "settlementRef"],
    cids: ["fundingRequestCid"],
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
    required: ["poolId", "inputInstrumentId", "inputAmount"],
    decimals: ["inputAmount"],
    cids: ["poolId"],
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
  for (const f of spec.decimals ?? []) validateDecimal(obj, f);
  for (const f of spec.parties ?? []) validateParty(obj, f);
  for (const f of spec.cids ?? []) validateCid(obj, f);
}
