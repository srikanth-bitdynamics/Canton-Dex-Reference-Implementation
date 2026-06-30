// Runtime validation of registry HTTP responses.
//
// Registry responses cross a trust boundary: the operator backend feeds them
// into ledger submissions (factory cids, disclosed contracts) and serves them
// to clients (credentials, instrument config). Previously each response was
// cast with `as T` and trusted blind (finding R-1) — a malformed or hostile
// registry could inject the wrong shape and have it reach the ledger or a
// client unchecked. These validators reject anything that does not match the
// declared shape, with a typed RegistryError("malformed", ...).

import {
  ChoiceContextRef,
  Credential,
  CredentialRequirement,
  DisclosedContract,
  FactoryRefs,
  InstrumentConfiguration,
  RegistryError,
  TransferPreapproval,
} from "./types.js";

function fail(detail: string): never {
  throw new RegistryError("malformed", detail, false);
}

function obj(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    fail(`${what}: expected object, got ${Array.isArray(v) ? "array" : typeof v}`);
  }
  return v as Record<string, unknown>;
}

function str(o: Record<string, unknown>, field: string, what: string): string {
  const v = o[field];
  if (typeof v !== "string") fail(`${what}.${field}: expected string, got ${typeof v}`);
  return v as string;
}

function strOrNull(
  o: Record<string, unknown>,
  field: string,
  what: string,
): string | null {
  const v = o[field];
  if (v === null) return null;
  if (typeof v !== "string") fail(`${what}.${field}: expected string|null, got ${typeof v}`);
  return v;
}

function bool(o: Record<string, unknown>, field: string, what: string): boolean {
  const v = o[field];
  if (typeof v !== "boolean") fail(`${what}.${field}: expected boolean, got ${typeof v}`);
  return v;
}

function arr(o: Record<string, unknown>, field: string, what: string): unknown[] {
  const v = o[field];
  if (!Array.isArray(v)) fail(`${what}.${field}: expected array, got ${typeof v}`);
  return v;
}

function strArray(o: Record<string, unknown>, field: string, what: string): string[] {
  return arr(o, field, what).map((x, i) => {
    if (typeof x !== "string") fail(`${what}.${field}[${i}]: expected string, got ${typeof x}`);
    return x;
  });
}

function disclosedContract(v: unknown, what: string): DisclosedContract {
  const o = obj(v, what);
  const dc: DisclosedContract = {
    contractId: str(o, "contractId", what),
    templateId: str(o, "templateId", what),
    createdEventBlob: str(o, "createdEventBlob", what),
  };
  if (o.contractKeyHash !== undefined) {
    if (typeof o.contractKeyHash !== "string") {
      fail(`${what}.contractKeyHash: expected string, got ${typeof o.contractKeyHash}`);
    }
    dc.contractKeyHash = o.contractKeyHash;
  }
  if (o.synchronizerId !== undefined) {
    if (typeof o.synchronizerId !== "string") {
      fail(`${what}.synchronizerId: expected string, got ${typeof o.synchronizerId}`);
    }
    dc.synchronizerId = o.synchronizerId;
  }
  return dc;
}

function credentialRequirement(v: unknown, what: string): CredentialRequirement {
  const o = obj(v, what);
  return {
    issuer: str(o, "issuer", what),
    property: str(o, "property", what),
    value: str(o, "value", what),
  };
}

export function validateInstrumentConfiguration(v: unknown): InstrumentConfiguration {
  const w = "InstrumentConfiguration";
  const o = obj(v, w);
  return {
    contractId: str(o, "contractId", w) as InstrumentConfiguration["contractId"],
    admin: str(o, "admin", w),
    instrumentId: str(o, "instrumentId", w),
    holderRequirements: arr(o, "holderRequirements", w).map((x) =>
      credentialRequirement(x, `${w}.holderRequirements[]`),
    ),
    issuerRequirements: arr(o, "issuerRequirements", w).map((x) =>
      credentialRequirement(x, `${w}.issuerRequirements[]`),
    ),
    isin: strOrNull(o, "isin", w),
    cusip: strOrNull(o, "cusip", w),
    description: str(o, "description", w),
  };
}

export function validateFactoryRefs(v: unknown): FactoryRefs {
  const w = "FactoryRefs";
  const o = obj(v, w);
  return {
    allocationFactoryCid: str(o, "allocationFactoryCid", w) as FactoryRefs["allocationFactoryCid"],
    settlementFactoryCid: str(o, "settlementFactoryCid", w) as FactoryRefs["settlementFactoryCid"],
    disclosure: arr(o, "disclosure", w).map((x) =>
      disclosedContract(x, `${w}.disclosure[]`),
    ),
  };
}

export function validateChoiceContextRef(v: unknown): ChoiceContextRef {
  const w = "ChoiceContextRef";
  const o = obj(v, w);
  const ctx = obj(o.context, `${w}.context`);
  if (typeof ctx.values !== "object" || ctx.values === null || Array.isArray(ctx.values)) {
    fail(`${w}.context.values: expected object`);
  }
  return {
    context: { values: ctx.values as Record<string, unknown> },
    disclosure: arr(o, "disclosure", w).map((x) =>
      disclosedContract(x, `${w}.disclosure[]`),
    ),
  };
}

export function validateCredentials(v: unknown): Credential[] {
  const w = "Credential[]";
  if (!Array.isArray(v)) fail(`${w}: expected array, got ${typeof v}`);
  return v.map((x): Credential => {
    const o = obj(x, "Credential");
    return {
      contractId: str(o, "contractId", "Credential") as Credential["contractId"],
      issuer: str(o, "issuer", "Credential"),
      holder: str(o, "holder", "Credential"),
      property: str(o, "property", "Credential"),
      value: str(o, "value", "Credential"),
    };
  });
}

export function validatePreapprovals(v: unknown): TransferPreapproval[] {
  const w = "TransferPreapproval[]";
  if (!Array.isArray(v)) fail(`${w}: expected array, got ${typeof v}`);
  return v.map((x): TransferPreapproval => {
    const o = obj(x, "TransferPreapproval");
    return {
      contractId: str(o, "contractId", "TransferPreapproval") as TransferPreapproval["contractId"],
      receiver: str(o, "receiver", "TransferPreapproval"),
      admin: str(o, "admin", "TransferPreapproval"),
      instrumentIds: strArray(o, "instrumentIds", "TransferPreapproval"),
    };
  });
}
