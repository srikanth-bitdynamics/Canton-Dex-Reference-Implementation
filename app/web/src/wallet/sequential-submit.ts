// Submit composed allocation commands through an external wallet, splitting into
// one wallet request per command when the wallet cannot authorize a multi-atom
// commands[] in a single transaction.
//
// Loop / PartyLayer's transaction UI refuses a request carrying more than one
// command atom ("Unsupported transaction request. This request contains N
// commands.") and disables Confirm. So when the provider's capability
// `supportsMultiCommandTransaction` is false, each AllocationFactory_Allocate is
// submitted as its OWN single-command wallet request, in canonical order. Each
// such request creates exactly one allocation, whose cid is recovered from the
// request's updateId; the cids are aggregated in canonical order into the
// returned WalletResult so the settle orchestration in services/ledger.ts sees
// them exactly as if a single multi-command submission had returned them.
//
// The preparatory allocations are locked authorizations that need not be atomic
// with each other; only the final operator settle (PoolRules_Swap /
// PoolLiquidityRules_Settle*) is the atomic point. This is the standard Canton
// DEX external-wallet pattern.

import type { ComposedCommands, DamlCommand } from "./commands";
import { isAllocationAuthoringIntent } from "./commands";
import type { DisclosedContract, Party, WalletIntent, WalletResult } from "./types";
import { recoverCreatedAllocationCid } from "@/services/recover-allocations";

/** One prepared wallet request (one command in the sequential path). */
export interface PreparedSubmission {
  commandId: string;
  actAs: Party[];
  commands: DamlCommand[];
  disclosedContracts?: DisclosedContract[];
}

/**
 * A provider's transport: submit one prepared request through the wallet and
 * resolve to the committed transaction's updateId. Rejects (with the provider's
 * own message) when the wallet cancels, fails, or returns no updateId.
 */
export type SubmitForUpdateId = (submission: PreparedSubmission) => Promise<string>;

export interface SubmitComposedArgs {
  intent: WalletIntent;
  composed: ComposedCommands;
  party: Party;
  /** From capabilityFor(providerId).supportsMultiCommandTransaction. */
  supportsMultiCommandTransaction: boolean;
  submit: SubmitForUpdateId;
  /** Injectable for tests; defaults to the operator-backend recovery call. */
  recover?: (updateId: string, party: Party) => Promise<string>;
}

/**
 * Drive the composed commands through the wallet, one request per command when
 * the wallet cannot take them together. Returns the aggregated WalletResult the
 * ledger orchestration already consumes: `createdAllocationCids` in canonical
 * order for a split allocation-authoring submission, or the updateId-only shape
 * for a single request (operator-discovery).
 */
export async function submitComposedCommands(
  args: SubmitComposedArgs,
): Promise<WalletResult> {
  const {
    intent,
    composed,
    party,
    supportsMultiCommandTransaction,
    submit,
    recover = recoverCreatedAllocationCid,
  } = args;

  const prepared = (commandId: string, commands: DamlCommand[]): PreparedSubmission => ({
    commandId,
    actAs: composed.actAs,
    commands,
    ...(composed.disclosedContracts
      ? { disclosedContracts: composed.disclosedContracts }
      : {}),
  });

  // One wallet request either way: the wallet accepts multi-command arrays, or
  // there is nothing to split. Keep the updateId-only shape (operator-discovery)
  // — identical to the pre-split behavior.
  if (supportsMultiCommandTransaction || composed.commands.length <= 1) {
    const updateId = await submit(prepared(composed.commandId, composed.commands));
    return { submittedBy: party, primaryCid: updateId, auxiliaryCids: { updateId } };
  }

  // Sequential single-command authorization.
  const authoring = isAllocationAuthoringIntent(intent);
  const total = composed.commands.length;
  const cids: string[] = [];
  const updateIds: string[] = [];
  for (let i = 0; i < total; i++) {
    let updateId: string;
    try {
      updateId = await submit(
        prepared(`${composed.commandId}-${i + 1}`, [composed.commands[i]]),
      );
    } catch (err) {
      // Surface which allocation failed. The settleAt deadline on the request is
      // the primary liveness escape: earlier locked authorizations auto-release
      // rather than staging indefinitely.
      // TODO: for prompt recovery of the already-created allocations, the
      // operator can recover + release them by updateId via
      // /v1/pools/recover-dvp-allocations; not wired here to avoid a full
      // workflow-state machine in this pass.
      throw new Error(
        `${intent.kind}: wallet request for allocation ${i + 1} of ${total} failed ` +
          `(${err instanceof Error ? err.message : String(err)}). ` +
          `Any earlier authorizations auto-release at the settle deadline.`,
      );
    }
    updateIds.push(updateId);
    if (authoring) {
      try {
        cids.push(await recover(updateId, party));
      } catch (err) {
        throw new Error(
          `${intent.kind}: authorized allocation ${i + 1} of ${total} but could not ` +
            `recover its contract id (${err instanceof Error ? err.message : String(err)}). ` +
            `Locked authorizations auto-release at the settle deadline.`,
        );
      }
    }
  }

  // Aggregated: the N recovered cids in canonical order drive the operator
  // settle exactly as a single multi-command submission's created events would.
  if (authoring) {
    return { submittedBy: party, primaryCid: cids[0], createdAllocationCids: cids };
  }
  // No allocations to aggregate (e.g. a non-authoring multi-command intent):
  // fall back to the last updateId for operator-discovery.
  const updateId = updateIds[updateIds.length - 1];
  return { submittedBy: party, primaryCid: updateId, auxiliaryCids: { updateId } };
}
