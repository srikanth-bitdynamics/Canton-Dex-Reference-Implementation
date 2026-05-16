// Shapes that mirror the on-ledger registry contracts. Fields come
// straight from the Daml templates in pr5333/CantonDex/Instrument/.
// JSON form follows daml-lf JSON serialization (Decimal as string).

export type Party = string;
export type ContractId<_T> = string & { readonly __brand: unique symbol };
export type Decimal = string;
export type Time = string;

export interface CredentialRequirement {
  issuer: Party;
  property: string;
  value: string;
}

export interface InstrumentConfiguration {
  contractId: ContractId<"InstrumentConfiguration">;
  admin: Party;
  instrumentId: string;
  holderRequirements: CredentialRequirement[];
  issuerRequirements: CredentialRequirement[];
  isin: string | null;
  cusip: string | null;
  description: string;
}

export interface Credential {
  contractId: ContractId<"Credential">;
  issuer: Party;
  holder: Party;
  property: string;
  value: string;
}

export interface Holding {
  contractId: ContractId<"Holding">;
  admin: Party;
  owner: Party;
  instrumentId: string;
  amount: Decimal;
  locked: boolean;
}

export interface TransferPreapproval {
  contractId: ContractId<"TransferPreapproval">;
  receiver: Party;
  admin: Party;
  instrumentIds: string[];
}

export interface FactoryRefs {
  allocationFactoryCid: ContractId<"AllocationFactory">;
  settlementFactoryCid: ContractId<"SettlementFactory">;
  disclosure: DisclosedContract[];
}

export interface DisclosedContract {
  contractId: string;
  templateId: string;
  contractKeyHash?: string;
  payloadBlob: string;
}

export type RegistryErrorKind =
  | "config-not-found"
  | "credential-missing"
  | "factory-stale"
  | "preapproval-revoked"
  | "transport"
  | "auth";

export class RegistryError extends Error {
  constructor(
    public readonly kind: RegistryErrorKind,
    public readonly detail: string,
    public readonly retryable: boolean,
  ) {
    super(`registry: ${kind}: ${detail}`);
  }
}
