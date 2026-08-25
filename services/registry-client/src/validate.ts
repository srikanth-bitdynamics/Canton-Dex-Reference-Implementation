// Runtime validation of registry HTTP responses.
//
// Registry responses cross a trust boundary: the operator backend feeds them
// into ledger submissions as factory cids, choice context, and disclosed
// contracts. These validators reject responses that do not match the declared
// integration shape.

import {
  ChoiceContextRef,
  DisclosedContract,
  FactoryRefs,
  RegistryError,
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

function arr(o: Record<string, unknown>, field: string, what: string): unknown[] {
  const v = o[field];
  if (!Array.isArray(v)) fail(`${what}.${field}: expected array, got ${typeof v}`);
  return v;
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
