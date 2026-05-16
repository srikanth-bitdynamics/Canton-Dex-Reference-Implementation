// In-memory ledger driver for tests. Implements just enough of the
// LedgerSubmitter interface to drive operator backend modules from
// Node tests. NOT a substitute for Daml Script -- enforces no
// authorization. Tests verify happy-path workflow shape.

import {
  LedgerCommand,
  LedgerError,
  LedgerEvent,
  LedgerSubmitter,
  SubmitRequest,
  SubscriptionFilter,
} from "./index.js";

interface AcsEntry {
  contractId: string;
  templateId: string;
  payload: unknown;
  observers: Set<string>;
}

export type ChoiceHandler<R> = (ctx: {
  self: AcsEntry;
  arg: unknown;
  actAs: Set<string>;
  acs: ReadonlyMap<string, AcsEntry>;
  create: (templateId: string, payload: unknown, observers: string[]) => string;
  archive: (contractId: string) => void;
}) => R;

export class InMemoryLedger implements LedgerSubmitter {
  private readonly acs = new Map<string, AcsEntry>();
  private nextCid = 1;
  private readonly choiceHandlers = new Map<string, ChoiceHandler<unknown>>();
  private readonly createHandlers = new Map<
    string,
    (payload: unknown) => { observers: string[] }
  >();

  registerCreateHandler(
    templateId: string,
    handler: (payload: unknown) => { observers: string[] },
  ): void {
    this.createHandlers.set(templateId, handler);
  }

  registerChoice<R>(
    templateOrInterface: string,
    choice: string,
    handler: ChoiceHandler<R>,
  ): void {
    this.choiceHandlers.set(
      `${templateOrInterface}::${choice}`,
      handler as ChoiceHandler<unknown>,
    );
  }

  async submit<R>(req: SubmitRequest): Promise<R> {
    const actAs = new Set(req.actAs);
    return this.executeCommand<R>(req.command, actAs);
  }

  async query<T>(filter: SubscriptionFilter): Promise<T[]> {
    const out: T[] = [];
    for (const e of this.acs.values()) {
      if (!this.matchesFilter(e, filter)) continue;
      out.push(e.payload as T);
    }
    return out;
  }

  async *subscribe<T>(
    filter: SubscriptionFilter,
  ): AsyncIterable<LedgerEvent<T>> {
    for (const e of this.acs.values()) {
      if (this.matchesFilter(e, filter)) {
        yield {
          kind: "created",
          contractId: e.contractId as never,
          payload: e.payload as T,
        };
      }
    }
  }

  private executeCommand<R>(cmd: LedgerCommand, actAs: Set<string>): R {
    if (cmd.kind === "create") {
      return this.executeCreate(cmd.templateId, cmd.argument, actAs) as R;
    }
    if (cmd.kind === "exercise" || cmd.kind === "exerciseInterface") {
      return this.executeExercise(
        cmd.kind === "exercise" ? cmd.templateId : cmd.interfaceId,
        cmd.contractId,
        cmd.choice,
        cmd.argument,
        actAs,
      ) as R;
    }
    if (cmd.kind === "createAndExercise") {
      const cid = this.executeCreate(cmd.templateId, cmd.argument, actAs);
      return this.executeExercise(
        cmd.templateId,
        cid,
        cmd.choice,
        cmd.choiceArgument,
        actAs,
      ) as R;
    }
    throw new LedgerError("validation", "unknown command kind", false);
  }

  private executeCreate(
    templateId: string,
    payload: unknown,
    _actAs: Set<string>,
  ): string {
    const handler = this.createHandlers.get(templateId);
    const observers = handler ? handler(payload).observers : [];
    return this.create(templateId, payload, observers);
  }

  private executeExercise(
    templateId: string,
    contractId: string,
    choice: string,
    arg: unknown,
    actAs: Set<string>,
  ): unknown {
    const self = this.acs.get(contractId);
    if (!self) {
      throw new LedgerError("contention", `archived: ${contractId}`, true);
    }
    const handler = this.choiceHandlers.get(`${templateId}::${choice}`);
    if (!handler) {
      throw new LedgerError(
        "validation",
        `no handler: ${templateId}::${choice}`,
        false,
      );
    }
    return handler({
      self,
      arg,
      actAs,
      acs: this.acs,
      create: (t, p, o) => this.create(t, p, o),
      archive: (cid) => this.archive(cid),
    });
  }

  private create(
    templateId: string,
    payload: unknown,
    observers: string[],
  ): string {
    const cid = `#${this.nextCid++}:0`;
    // Stamp the cid into the payload's `contractId` field if present.
    // The Daml-LF JSON wire form keeps the cid as metadata on the
    // event, but our typed payloads carry a `contractId` slot for
    // caller convenience -- fill it so query() returns objects whose
    // contractId field actually matches the cid.
    // Always stamp the cid into the payload so query() returns objects
    // whose contractId field matches the entry. Production wire formats
    // carry the cid as event metadata; the InMemoryLedger inlines it.
    const stamped =
      payload && typeof payload === "object"
        ? { ...(payload as Record<string, unknown>), contractId: cid }
        : payload;
    const entry: AcsEntry = {
      contractId: cid,
      templateId,
      payload: stamped,
      observers: new Set(observers),
    };
    this.acs.set(cid, entry);
    return cid;
  }

  private archive(contractId: string): void {
    this.acs.delete(contractId);
  }

  private matchesFilter(e: AcsEntry, f: SubscriptionFilter): boolean {
    if (f.templateId && e.templateId !== f.templateId) return false;
    if (!e.observers.has(f.observingParty)) return false;
    return true;
  }
}
