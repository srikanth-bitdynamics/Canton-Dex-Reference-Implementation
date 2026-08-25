// Registry HTTP response shapes. A registry may use any on-ledger templates as
// long as its API returns these validated integration fields.

export type Party = string;
export type ContractId<_T> = string & { readonly __brand: unique symbol };
export type Decimal = string;
export type Time = string;

export interface FactoryRefs {
  allocationFactoryCid: ContractId<"AllocationFactory">;
  settlementFactoryCid: ContractId<"SettlementFactory">;
  disclosure: DisclosedContract[];
}

export interface DisclosedContract {
  contractId: string;
  templateId: string;
  contractKeyHash?: string;
  /** Base64 created event passed to the Ledger API as a disclosed contract. */
  createdEventBlob: string;
  synchronizerId?: string;
}

/**
 * Off-ledger choice context for a token-standard factory choice. The
 * registry computes `context.values` (disclosed config, app rights, …);
 * the caller threads it into the choice's `ExtraArgs` and adds
 * `disclosure` to the submission.
 */
export interface ChoiceContextRef {
  context: { values: Record<string, unknown> };
  disclosure: DisclosedContract[];
}

export type RegistryErrorKind =
  | "factory-stale"
  | "transport"
  | "auth"
  // The response did not match the declared integration shape.
  | "malformed";

export class RegistryError extends Error {
  constructor(
    public readonly kind: RegistryErrorKind,
    public readonly detail: string,
    public readonly retryable: boolean,
  ) {
    super(`registry: ${kind}: ${detail}`);
  }
}
