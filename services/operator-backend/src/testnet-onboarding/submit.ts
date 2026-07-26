// Testnet-only command relay for faucet-minted parties.
//
// The parties this faucet hands out live on the operator's participant, so the
// tester's browser has no ledger credentials of its own: something server-side
// has to submit for them. `/v1/wallet/submit` is deliberately NOT that thing --
// it forwards arbitrary commands under the operator's JWT and is gated by
// DEX_OPERATOR_API_TOKEN, which cannot be shipped to a browser. This relay is
// the narrow public alternative, and it is narrow on purpose:
//
//   - actAs is server-controlled. The submission acts as exactly the one party
//     the caller named AND the eligibility check accepted; `actAs`, `readAs`
//     and `userId` are never read from the request body.
//   - Only ExerciseCommand, only on an allowlisted (interface/template, choice)
//     pair -- the choices a trader legitimately needs to fund and settle a
//     trade. A CreateCommand, or any other choice, is rejected before the
//     participant is touched.
//   - The number of commands per submission is capped, so one request cannot
//     turn into an unbounded transaction.
//   - Disclosure is attached by the caller of this module from the operator's
//     own registry (see the HTTP layer), never taken from the request body: a
//     caller-supplied blob would let anyone hand the participant a contract of
//     their choosing.
//
// The allowlist bounds what may be ATTEMPTED. It grants nothing: authority is
// still only the tester's own party, so a choice that additionally needs the
// admin's authority (Holding_Split / Holding_Merge are `controller admin,
// owner` in CantonDex.Registry.V2) is still rejected on-ledger.

import { randomUUID } from "node:crypto";

import type { DisclosedContract } from "@canton-dex/registry-client";
import type { CreatedEventRef } from "../ledger/index.js";
import { rootLogger } from "../lib/logger.js";

const log = rootLogger.child({ component: "testnet-submit" });

/** Upper bound on commands in one submission. */
export const MAX_COMMANDS_PER_SUBMIT = 8;

/**
 * The (interface/template, choice) pairs a tester may exercise, keyed by the
 * trailing `Module:Entity` of the id so both wire forms of a template id --
 * `#package-name:Module:Entity` and `<packageId>:Module:Entity` -- resolve to
 * the same entry.
 *
 * Everything a trader needs is here and nothing else: author an allocation,
 * answer an allocation request, and normalize holdings. Notably absent are the
 * operator's and the admin's own choices (Registry_Mint, PoolRules_*,
 * Order_*), which is the point -- a caller cannot borrow this endpoint to
 * drive the DEX's privileged flows.
 */
const ALLOWED_CHOICES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    "Splice.Api.Token.AllocationInstructionV2:AllocationFactory",
    new Set(["AllocationFactory_Allocate"]),
  ],
  [
    "Splice.Api.Token.AllocationRequestV2:AllocationRequest",
    new Set(["AllocationRequest_Accept", "AllocationRequest_Reject"]),
  ],
  ["CantonDex.Registry.V2:Holding", new Set(["Holding_Split", "Holding_Merge"])],
]);

/** A command that passed the allowlist, rebuilt from validated fields only. */
export interface AllowedExerciseCommand {
  ExerciseCommand: {
    templateId: string;
    contractId: string;
    choice: string;
    choiceArgument: Record<string, unknown>;
  };
}

/** Response body of POST /v1/testnet/submit. */
export interface TestnetSubmitReceipt {
  updateId: string;
  createdEvents: CreatedEventRef[];
}

/** Raised when a command is not one this endpoint accepts (mapped to 400). */
export class TestnetCommandRejectedError extends Error {
  constructor(
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "TestnetCommandRejectedError";
  }
}

/** Raised when the named party is not one this faucet hosts (mapped to 403). */
export class TestnetPartyIneligibleError extends Error {
  constructor(
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "TestnetPartyIneligibleError";
  }
}

/**
 * Raised when the faucet is on but this deployment has no participant to relay
 * to -- the in-memory dev server (mapped to 501).
 */
export class TestnetSubmitUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestnetSubmitUnavailableError";
  }
}

/**
 * Raised when the participant refused the submission, or committed it but
 * would not serve its transaction tree (mapped to 502).
 *
 * The participant's response text is logged server-side and NEVER put on the
 * wire: it can quote the submitted payload back, and this endpoint is public.
 * What the caller gets is the HTTP status and, when one can be recognized,
 * Canton's error id (e.g. CONTRACT_NOT_FOUND) -- enough to act on, and free of
 * both the command payload and any token.
 */
export class TestnetLedgerError extends Error {
  constructor(
    public readonly code: "ledger_rejected" | "tree_fetch_failed",
    message: string,
    public readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = "TestnetLedgerError";
  }
}

export interface RelaySubmitRequest {
  /** The single party the submission acts as. Server-decided, never body-read. */
  party: string;
  commands: AllowedExerciseCommand[];
  /** Registry disclosure, resolved server-side by the caller. */
  disclosedContracts: DisclosedContract[];
}

/**
 * Submits an already-validated command list for a hosted party. Split out from
 * the service so the JSON API recipe is swappable and tests can drive the whole
 * route without a participant.
 */
export interface TestnetCommandRelay {
  submit(req: RelaySubmitRequest): Promise<TestnetSubmitReceipt>;
}

// === command validation ====================================================

/**
 * Validate the caller's `commands` against the allowlist. Returns commands
 * rebuilt from the validated fields, so anything else the caller attached to a
 * command object is dropped rather than forwarded.
 */
export function validateCommands(raw: unknown): AllowedExerciseCommand[] {
  if (!Array.isArray(raw)) {
    throw new TestnetCommandRejectedError("commands must be an array");
  }
  if (raw.length === 0) {
    throw new TestnetCommandRejectedError("commands must not be empty");
  }
  if (raw.length > MAX_COMMANDS_PER_SUBMIT) {
    throw new TestnetCommandRejectedError(
      `at most ${MAX_COMMANDS_PER_SUBMIT} commands per submission`,
      { max: MAX_COMMANDS_PER_SUBMIT, got: raw.length },
    );
  }
  return raw.map((cmd, index) => validateCommand(cmd, index));
}

function validateCommand(raw: unknown, index: number): AllowedExerciseCommand {
  const cmd = asObject(raw, `commands[${index}]`);
  const kinds = Object.keys(cmd);
  if (kinds.length !== 1) {
    throw new TestnetCommandRejectedError(
      `commands[${index}] must carry exactly one command kind`,
      { index, kinds },
    );
  }
  const kind = kinds[0]!;
  if (kind !== "ExerciseCommand") {
    // CreateCommand / CreateAndExerciseCommand would let a caller author any
    // template the package defines; only exercising an allowlisted choice on an
    // existing contract is in scope here.
    throw new TestnetCommandRejectedError(
      `${kind} is not accepted on this endpoint; only ExerciseCommand on an allowlisted choice is`,
      { index, kind },
    );
  }

  const exercise = asObject(cmd[kind], `commands[${index}].ExerciseCommand`);
  const templateId = requireString(exercise, "templateId", index);
  const contractId = requireString(exercise, "contractId", index);
  const choice = requireString(exercise, "choice", index);
  const choiceArgument = asObject(
    exercise.choiceArgument,
    `commands[${index}].ExerciseCommand.choiceArgument`,
  );

  const entity = entityKey(templateId);
  const allowed = ALLOWED_CHOICES.get(entity);
  if (!allowed || !allowed.has(choice)) {
    throw new TestnetCommandRejectedError(
      `choice ${choice} on ${entity} is not allowed on this endpoint`,
      { index, choice, entity },
    );
  }

  return {
    ExerciseCommand: { templateId, contractId, choice, choiceArgument },
  };
}

/** The `Module:Entity` tail of a template or interface id. */
function entityKey(templateId: string): string {
  return templateId.split(":").slice(-2).join(":");
}

function asObject(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new TestnetCommandRejectedError(`${what} must be a JSON object`);
  }
  return v as Record<string, unknown>;
}

function requireString(
  o: Record<string, unknown>,
  field: string,
  index: number,
): string {
  const v = o[field];
  if (typeof v !== "string" || v.length === 0) {
    throw new TestnetCommandRejectedError(
      `commands[${index}].ExerciseCommand.${field} must be a non-empty string`,
      { index, field },
    );
  }
  return v;
}

// === JSON API relay ========================================================

export interface JsonApiCommandRelayConfig {
  /** Base URL of the JSON Ledger API, e.g. http://localhost:7575 */
  baseUrl: string;
  /** Bearer JWT the operator backend submits under. */
  token: string;
  /** The backend's own ledger user id (CANTON_USER_ID). */
  userId?: string;
  /** Synchronizer id, required by submit-and-wait on shared synchronizers. */
  synchronizerId?: string;
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
}

/** How long the transaction tree is chased before giving up (read-after-write). */
const TREE_FETCH_ATTEMPTS = 4;
const TREE_FETCH_BACKOFF_MS = 150;

/**
 * Real-participant relay: submit-and-wait, then follow the transaction tree for
 * the created contracts. The DvP settle path needs the created Allocation cids,
 * and submit-and-wait returns only an updateId, which is why the tree call is
 * not optional.
 */
export class JsonApiCommandRelay implements TestnetCommandRelay {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: JsonApiCommandRelayConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async submit(req: RelaySubmitRequest): Promise<TestnetSubmitReceipt> {
    // The command id is server-generated. A caller-chosen one is an
    // idempotency key on the participant: two callers picking the same value
    // would collide, and one caller could replay another's.
    const commandId = `testnet-submit-${randomUUID()}`;
    const envelope = {
      commandId,
      // Canton 3 calls this `userId`; older builds read `applicationId`.
      ...(this.config.userId
        ? { userId: this.config.userId, applicationId: this.config.userId }
        : {}),
      // The security-critical line: exactly the one eligible party, never a
      // list the caller supplied.
      actAs: [req.party],
      readAs: [],
      commands: req.commands,
      disclosedContracts: req.disclosedContracts,
      ...(this.config.synchronizerId
        ? { synchronizerId: this.config.synchronizerId }
        : {}),
    };

    const res = await this.fetchImpl(
      `${this.baseUrl}/v2/commands/submit-and-wait`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.token}`,
        },
        body: JSON.stringify(envelope),
      },
    );
    const text = await res.text();
    if (!res.ok) {
      // Logged in full here, summarized on the wire (see TestnetLedgerError).
      log.warn("participant rejected a testnet submission", {
        commandId,
        status: res.status,
        response: text,
      });
      throw new TestnetLedgerError(
        "ledger_rejected",
        "the ledger rejected this submission",
        { ledgerStatus: res.status, ledgerErrorCode: ledgerErrorCode(text) },
      );
    }
    const body = JSON.parse(text) as { updateId?: string };
    if (!body.updateId) {
      throw new Error("participant returned no updateId for the submission");
    }
    return {
      updateId: body.updateId,
      createdEvents: await this.createdEvents(body.updateId, req.party),
    };
  }

  /**
   * Created contracts of the committed transaction. A failure here is NOT
   * softened into an empty list: to the caller that reads as "the settlement
   * created no allocations" on a transaction that did, so it is surfaced
   * distinctly with the updateId to recover from.
   */
  private async createdEvents(
    updateId: string,
    party: string,
  ): Promise<CreatedEventRef[]> {
    const url = new URL(
      `${this.baseUrl}/v2/updates/transaction-tree-by-id/${encodeURIComponent(updateId)}`,
    );
    url.searchParams.append("parties", party);

    let res: Response | undefined;
    for (let attempt = 0; attempt < TREE_FETCH_ATTEMPTS; attempt++) {
      res = await this.fetchImpl(url.toString(), {
        headers: { Authorization: `Bearer ${this.config.token}` },
      });
      if (res.ok) break;
      // The tree can lag the submit-and-wait completion; back off and retry.
      await new Promise((resolve) =>
        setTimeout(resolve, TREE_FETCH_BACKOFF_MS * (attempt + 1)),
      );
    }
    if (!res || !res.ok) {
      const treeStatus = res?.status ?? null;
      log.warn(
        "testnet submission committed but its created-event tree could not be fetched",
        { updateId, treeStatus },
      );
      throw new TestnetLedgerError(
        "tree_fetch_failed",
        "the transaction committed but its created events could not be fetched",
        { updateId, treeStatus },
      );
    }

    const tree = (await res.json()) as {
      transaction?: {
        eventsById?: Record<
          string,
          {
            CreatedTreeEvent?: {
              value?: { nodeId?: number; contractId?: string; templateId?: string };
            };
          }
        >;
      };
    };
    return Object.values(tree.transaction?.eventsById ?? {})
      .map((event) => event.CreatedTreeEvent?.value)
      .filter(
        (v): v is { nodeId?: number; contractId: string; templateId?: string } =>
          typeof v?.contractId === "string",
      )
      .sort((a, b) => (a.nodeId ?? 0) - (b.nodeId ?? 0))
      .map((v) => ({ contractId: v.contractId, templateId: v.templateId ?? "" }));
  }
}

/**
 * Canton's error id out of a participant error body (`CONTRACT_NOT_FOUND`,
 * `DAML_AUTHORIZATION_ERROR`, ...). Returns undefined when none is recognized,
 * which is the safe direction: the caller gets a status and nothing else rather
 * than a slice of their own payload echoed back.
 */
function ledgerErrorCode(text: string): string | undefined {
  return /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/.exec(text)?.[1];
}
