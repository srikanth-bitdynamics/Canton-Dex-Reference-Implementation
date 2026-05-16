// JsonApiLedger -- LedgerSubmitter implementation that talks to a
// real Canton participant via the JSON Ledger API.
//
// This is the production driver. Tests can use it to drive against a
// live `daml start` (or a deployed Canton participant); the in-memory
// driver in `in-memory.ts` is the fast unit-test path.
//
// JSON API reference:
//   https://docs.daml.com/json-api/ (general)
//   POST /v2/commands/submit-and-wait     (sync command submission)
//   POST /v2/state/active-contracts       (ACS snapshot)
//   GET  /v2/updates/flats (SSE)          (live event stream)
//
// Path versions (v1 vs v2) and exact field names vary with Canton
// release. The shapes here target Canton 3.x JSON API; the wire
// envelope is centralized so swapping Canton versions touches one
// file. The authentication header (Bearer token) is required for any
// non-trivial deployment.

import type { ContractId, Party, DisclosedContract } from "@canton-dex/registry-client";

import {
  LedgerCommand,
  LedgerError,
  LedgerEvent,
  LedgerSubmitter,
  SubmitRequest,
  SubscriptionFilter,
} from "./index.js";

export interface JsonApiConfig {
  /** Base URL of the JSON Ledger API, e.g. http://localhost:7575 */
  baseUrl: string;
  /** Bearer JWT issued by the participant. */
  token: string;
  /** Application id (Canton 3 also calls this userId) passed in submissions. */
  applicationId: string;
  /**
   * Optional: prepend this package id (or `#package-name`) onto any
   * bare 2-segment template id (e.g. "CantonDex.Dex.Pool:Pool") seen in
   * commands or filters. Canton's JSON API requires fully-qualified
   * template ids; the rest of the operator-backend code is written
   * against the bare form to stay in-memory-test-compatible.
   */
  templateIdPrefix?: string;
  /** Optional: synchronizer id required by submit-and-wait on shared synchronizers. */
  synchronizerId?: string;
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
}

export class JsonApiLedger implements LedgerSubmitter {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly config: JsonApiConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async submit<R>(req: SubmitRequest): Promise<R> {
    const envelope = this.toJsonApi(req);
    const res = await this.fetchImpl(
      new URL("/v2/commands/submit-and-wait", this.config.baseUrl).toString(),
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(envelope),
      },
    );
    if (!res.ok) {
      throw await this.errorFor(res);
    }
    const body = (await res.json()) as JsonApiSubmitResponse;
    // The shape of `body.events` (CreatedEvent | ExercisedEvent) varies
    // with the choice; we extract the result via the convention that
    // the operator backend always exercises a single root command and
    // expects its result back.
    return this.extractResult<R>(body, req);
  }

  async query<T>(filter: SubscriptionFilter): Promise<T[]> {
    // Need a concrete `activeAtOffset` for Canton 3 ACS queries. Fetch
    // ledger end first; it's a cheap call.
    const endRes = await this.fetchImpl(
      new URL("/v2/state/ledger-end", this.config.baseUrl).toString(),
      { headers: this.headers() },
    );
    if (!endRes.ok) {
      throw await this.errorFor(endRes);
    }
    const { offset: activeAtOffset } = (await endRes.json()) as { offset: number };

    const qualifiedTid = this.qualifyTemplateId(filter.templateId);
    const cumulative = qualifiedTid
      ? [
          {
            identifierFilter: {
              TemplateFilter: {
                value: {
                  templateId: qualifiedTid,
                  includeCreatedEventBlob: false,
                },
              },
            },
          },
        ]
      : [{ identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } }];

    const envelope = {
      verbose: false,
      activeAtOffset,
      filter: {
        filtersByParty: {
          [filter.observingParty]: { cumulative },
        },
      },
    };
    const res = await this.fetchImpl(
      new URL("/v2/state/active-contracts", this.config.baseUrl).toString(),
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(envelope),
      },
    );
    if (!res.ok) {
      throw await this.errorFor(res);
    }
    const body = (await res.json()) as Canton3AcsEntry[];
    return body
      .map((e) => e.contractEntry?.JsActiveContract?.createdEvent)
      .filter((ev): ev is Canton3CreatedEvent => ev !== undefined)
      .map((ev) => this.payloadOfCanton3<T>(ev));
  }

  async *subscribe<T>(
    filter: SubscriptionFilter,
  ): AsyncIterable<LedgerEvent<T>> {
    // JSON API exposes streaming via /v2/updates/flats (SSE) or
    // websocket. For the production driver we use SSE because the
    // builtin fetch handles it through the body stream; tests can
    // mock it.
    const url = new URL("/v2/updates/flats", this.config.baseUrl);
    url.searchParams.set("party", filter.observingParty);
    if (filter.templateId) url.searchParams.set("templateId", filter.templateId);

    const res = await this.fetchImpl(url.toString(), {
      headers: { ...this.headers(), Accept: "text/event-stream" },
    });
    if (!res.body) {
      throw new LedgerError("transport", "no body on event stream", true);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const data = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("");
        if (!data) continue;
        const ev = JSON.parse(data) as JsonApiUpdate;
        for (const e of this.unpackUpdate<T>(ev)) yield e;
      }
    }
  }

  // === envelope helpers ====================================================

  private toJsonApi(req: SubmitRequest): unknown {
    const cmd = req.command;
    const tid = (id: string) => this.qualifyTemplateId(id) ?? id;
    const command =
      cmd.kind === "create"
        ? { CreateCommand: { templateId: tid(cmd.templateId), createArguments: cmd.argument } }
        : cmd.kind === "exercise"
          ? {
              ExerciseCommand: {
                templateId: tid(cmd.templateId),
                contractId: cmd.contractId,
                choice: cmd.choice,
                choiceArgument: cmd.argument,
              },
            }
          : cmd.kind === "exerciseInterface"
            ? {
                ExerciseByInterfaceCommand: {
                  interfaceId: tid(cmd.interfaceId),
                  contractId: cmd.contractId,
                  choice: cmd.choice,
                  choiceArgument: cmd.argument,
                },
              }
            : {
                CreateAndExerciseCommand: {
                  templateId: tid(cmd.templateId),
                  createArguments: cmd.argument,
                  choice: cmd.choice,
                  choiceArgument: cmd.choiceArgument,
                },
              };
    // Canton 3 JSON API uses `userId` not `applicationId`; keep both
    // for cross-version compatibility (extra keys are ignored).
    return {
      commandId: req.commandId,
      userId: this.config.applicationId,
      applicationId: this.config.applicationId,
      actAs: req.actAs,
      readAs: req.readAs ?? [],
      commands: [command],
      disclosedContracts: req.disclosure ?? [],
      ...(this.config.synchronizerId
        ? { synchronizerId: this.config.synchronizerId }
        : {}),
    };
  }

  /**
   * If `templateIdPrefix` is configured and the given id has only the
   * two-segment shape `Module.Path:Entity`, prepend the prefix so
   * Canton's JSON API can resolve it. Pass-through for ids that already
   * carry a package id or `#package-name` segment.
   */
  private qualifyTemplateId(id?: string): string | undefined {
    if (!id) return id;
    if (!this.config.templateIdPrefix) return id;
    // A qualified id has at least 3 colon-segments (pkgId:Module.Path:Entity).
    if (id.split(":").length >= 3) return id;
    return `${this.config.templateIdPrefix}:${id}`;
  }

  private templateFilter(filter: SubscriptionFilter): unknown {
    if (filter.templateId) {
      return { inclusive: { templateFilters: [{ templateId: filter.templateId }] } };
    }
    return { inclusive: { templateFilters: [] } };
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.token}`,
      "Content-Type": "application/json",
    };
  }

  private payloadOf<T>(entry: AcsEntry): T {
    return {
      ...(entry.contractEntry?.payload ?? {}),
      contractId: entry.contractEntry?.contractId,
    } as T;
  }

  // Canton 3 returns ACS entries as
  //   { contractEntry: { JsActiveContract: { createdEvent: {...} } } }
  // where createdEvent contains contractId + createArgument + signatories etc.
  private payloadOfCanton3<T>(ev: Canton3CreatedEvent): T {
    return {
      ...(ev.createArgument ?? {}),
      contractId: ev.contractId,
    } as T;
  }

  private *unpackUpdate<T>(ev: JsonApiUpdate): IterableIterator<LedgerEvent<T>> {
    if (ev.created) {
      yield {
        kind: "created",
        contractId: ev.created.contractId as ContractId<unknown>,
        payload: { ...ev.created.payload, contractId: ev.created.contractId } as T,
      };
    }
    if (ev.archived) {
      yield {
        kind: "archived",
        contractId: ev.archived.contractId as ContractId<unknown>,
      };
    }
  }

  private extractResult<R>(
    body: JsonApiSubmitResponse,
    req: SubmitRequest,
  ): R {
    // For exercise commands, JSON API returns the choice result under
    // `events[0].exercised.exerciseResult` (Daml-LF JSON form). For
    // create commands, returns the cid.
    const cmd = req.command;
    if (cmd.kind === "create" || cmd.kind === "createAndExercise") {
      const created = body.events?.find(
        (e: { created?: unknown }) => e.created !== undefined,
      ) as { created?: { contractId: string } } | undefined;
      if (!created?.created) {
        throw new LedgerError("validation", "no Created event", false);
      }
      return created.created.contractId as R;
    }
    const exercised = body.events?.find(
      (e: { exercised?: unknown }) => e.exercised !== undefined,
    ) as { exercised?: { exerciseResult: unknown } } | undefined;
    if (!exercised?.exercised) {
      throw new LedgerError("validation", "no Exercised event", false);
    }
    return exercised.exercised.exerciseResult as R;
  }

  private async errorFor(res: Response): Promise<LedgerError> {
    const text = await res.text();
    // Canton uses GRPC-style error codes; the JSON API surfaces them
    // in the response body as { errors: [{ code, message }] }.
    const lower = text.toLowerCase();
    let kind: LedgerError["kind"] = "transport";
    let retryable = false;
    if (lower.includes("contention") || lower.includes("inconsistent")) {
      kind = "contention";
      retryable = true;
    } else if (lower.includes("authoriz") || res.status === 401 || res.status === 403) {
      kind = "authorization";
    } else if (res.status === 400) {
      kind = "validation";
    }
    return new LedgerError(kind, `${res.status}: ${text}`, retryable);
  }
}

// === wire shapes =========================================================

interface JsonApiSubmitResponse {
  events?: Array<{
    created?: { contractId: string; payload: unknown };
    exercised?: { exerciseResult: unknown };
    archived?: { contractId: string };
  }>;
  transactionId?: string;
}

interface AcsEntry {
  templateId?: string;
  contractEntry?: {
    contractId: string;
    payload: Record<string, unknown>;
    signatories: Party[];
    observers: Party[];
  };
}

interface Canton3AcsEntry {
  workflowId?: string;
  contractEntry?: {
    JsActiveContract?: {
      createdEvent?: Canton3CreatedEvent;
    };
  };
}

interface Canton3CreatedEvent {
  contractId: string;
  templateId: string;
  createArgument: Record<string, unknown>;
  signatories: Party[];
  observers: Party[];
  createdAt: string;
}

interface JsonApiUpdate {
  created?: { contractId: string; templateId: string; payload: Record<string, unknown> };
  archived?: { contractId: string; templateId: string };
}
