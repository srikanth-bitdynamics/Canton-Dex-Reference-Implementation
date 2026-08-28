// Normalized Token Standard V2 registry HTTP shapes. The wire names follow the
// upstream OpenAPI (`factoryId`, `choiceContextData`, `disclosedContracts`);
// callers use the normalized names below when constructing Ledger API commands.

export type Party = string;
export type ContractId<_T> = string & { readonly __brand: unique symbol };
export type Decimal = string;
export type Time = string;

export interface FactoryRefs {
  allocationFactoryCid: ContractId<"AllocationFactory">;
  settlementFactoryCid: ContractId<"SettlementFactory">;
  disclosure: DisclosedContract[];
}

/** Daml JSON encoding of a choice argument, with empty `extraArgs`. */
export type ChoiceArguments = Record<string, unknown>;

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

/** One operation-specific factory response from a V2 registry. */
export interface FactoryChoiceContextRef extends ChoiceContextRef {
  factoryCid: ContractId<"TokenStandardFactory">;
}

/**
 * The backend depends on this operation-specific surface rather than on a
 * concrete HTTP client. Fixed self-registries can implement the same contract
 * without inventing non-standard discovery endpoints.
 */
export interface RegistryDiscovery {
  getAllocationFactory(
    admin: Party,
    choiceArguments: ChoiceArguments,
  ): Promise<FactoryChoiceContextRef>;
  getSettlementFactory(
    admin: Party,
    choiceArguments: ChoiceArguments,
  ): Promise<FactoryChoiceContextRef>;
  getAllocationCancelContext(
    admin: Party,
    allocationId: string,
    meta?: Record<string, string>,
  ): Promise<ChoiceContextRef>;
  getAllocationWithdrawContext(
    admin: Party,
    allocationId: string,
    meta?: Record<string, string>,
  ): Promise<ChoiceContextRef>;
}

export type RegistryErrorKind =
  | "factory-stale"
  | "not-found"
  | "transport"
  | "auth"
  | "unsupported"
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
