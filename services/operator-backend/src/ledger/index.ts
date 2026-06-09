// Ledger I/O abstraction. The operator backend submits commands and
// observes events through this single interface. In production this
// is implemented against the Canton Ledger JSON API or gRPC; for
// tests we use an in-memory implementation that mirrors a Daml-Script
// ACS.
//
// Source-driven guardrail: every transaction the operator submits goes
// through `submit`, so the surface of choices the operator can
// exercise is auditable in one place. We do NOT reach into the ledger
// driver from per-flow modules.

import type { ContractId, Party, DisclosedContract } from "@canton-dex/registry-client";

export interface LedgerSubmitter {
  submit<R>(req: SubmitRequest): Promise<R>;
  subscribe<T>(filter: SubscriptionFilter): AsyncIterable<LedgerEvent<T>>;
  query<T>(filter: SubscriptionFilter): Promise<T[]>;
  /**
   * Created events of a committed transaction, by `updateId`, in node order.
   * Used to recover created contract ids operator-side when a wallet returns
   * only an `updateId` and not the transaction tree (operator-discovery for
   * PartyLayer or any CIP-0103 wallet whose receipt is updateId-only).
   * Optional: implementations that can't serve trees omit it.
   */
  treeCreatedEvents?(updateId: string, party: Party): Promise<CreatedEventRef[]>;
}

/** A created contract surfaced from a transaction tree. */
export interface CreatedEventRef {
  contractId: string;
  templateId: string;
}

export interface SubmitRequest {
  actAs: Party[];
  readAs?: Party[];
  commandId: string;
  command: LedgerCommand;
  disclosure?: DisclosedContract[];
}

export type LedgerCommand =
  | { kind: "create"; templateId: string; argument: unknown }
  | {
      kind: "exercise";
      templateId: string;
      contractId: string;
      choice: string;
      argument: unknown;
    }
  | {
      kind: "exerciseInterface";
      interfaceId: string;
      contractId: string;
      choice: string;
      argument: unknown;
    }
  | {
      kind: "createAndExercise";
      templateId: string;
      argument: unknown;
      choice: string;
      choiceArgument: unknown;
    };

export interface SubscriptionFilter {
  templateId?: string;
  interfaceId?: string;
  observingParty: Party;
}

export type LedgerEvent<T> =
  | { kind: "created"; contractId: ContractId<unknown>; payload: T }
  | { kind: "archived"; contractId: ContractId<unknown> };

export type LedgerErrorKind =
  | "contention"
  | "authorization"
  | "validation"
  | "transport";

export class LedgerError extends Error {
  constructor(
    public readonly kind: LedgerErrorKind,
    public readonly detail: string,
    public readonly retryable: boolean,
    public readonly correlationId?: string,
  ) {
    super(`ledger: ${kind}: ${detail}`);
  }
}
