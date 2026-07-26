// Testnet-only server-side swap for faucet-minted parties.
//
// A swap on this DEX is three transactions and two of them are the operator's:
//
//   1. PoolRules_RequestSwap       (operator authority) -- builds, in Daml, the
//      exact allocation spec the trader has to author;
//   2. AllocationFactory_Allocate  (trader authority)   -- the trader locks
//      their input holdings behind that spec;
//   3. PoolRules_Swap              (operator authority) -- settles the trade
//      against the authored allocation.
//
// Steps 1 and 3 are POST /v1/pools/swap/request and POST /v1/pools/swap, both
// behind DEX_OPERATOR_API_TOKEN because they were built for a trusted caller:
// they take a pool, a party and amounts and submit under the operator's own
// authority. That token cannot be shipped to a browser -- it would grant
// arbitrary operator writes -- so a faucet party, which gets through step 2 via
// POST /v1/testnet/submit, still cannot finish a swap from the UI.
//
// Exempting those two operator routes from the token is the wrong fix: it would
// open the operator's whole swap surface to anyone, for any party. Instead this
// module drives all three steps server-side for ONE faucet party. That is
// honest about what the deployment already is -- the operator hosts that party
// and signs for it -- and it keeps the freedoms bounded here rather than in the
// caller:
//
//   - the party must clear the same faucet-provenance + hosting check the
//     submit relay applies, so an operator / admin / lpRegistrar party is
//     refused before anything is submitted;
//   - the trader step goes through that same relay, so actAs is fixed to the
//     one eligible party and the disclosure is the operator's;
//   - the input holdings are SELECTED here, from holdings owned by that party.
//     A caller-supplied holding cid would let them name someone else's;
//   - the price floor defaults to the operator's own quote, so a swap cannot
//     settle at a worse price than the one quoted for it;
//   - the pool, amounts and party the operator steps run with come from the
//     validated request and nothing else.
//
// Funding locks WHOLE holdings whose sum covers the amount. It never splits:
// `CantonDex.Registry.V2:Holding` is `signatory admin, owner` and Holding_Split
// is `controller admin, owner`, and this path carries no admin authority. The
// standard consumes `inputHoldingCids` whole and Registry.V2 returns the
// surplus to the owner via `authorizerChangeCids`, so any fraction funds
// without one.

import type { DisclosedContract } from "@canton-dex/registry-client";
import type { CreatedEventRef } from "../ledger/index.js";
import * as dec from "../pool/decimal.js";
import type {
  Decimal,
  Party,
  V2AllocationSpecification,
  V2SettlementInfo,
} from "../types.js";

/**
 * AllocationFactory is a token-standard interface in the splice
 * allocation-instruction-v2 package (not this app's package), so the exercise
 * targets the interface id directly -- the same id the dApp's command builder
 * uses, and the one the relay's allowlist keys on.
 */
export const ALLOCATION_FACTORY_INTERFACE_ID =
  "#splice-api-token-allocation-instruction-v2:Splice.Api.Token.AllocationInstructionV2:AllocationFactory";

/** The template whose creates are the allocations a settle binds to. */
const ALLOCATION_TEMPLATE_SUFFIX = "CantonDex.Registry.V2:Allocation";

/** Response body of POST /v1/testnet/swap. */
export interface TestnetSwapReceipt {
  /** Update id of the trader's allocation transaction. */
  updateId: string;
  inputAmount: Decimal;
  /** The operator's quote for this input, in the pool's other instrument. */
  outputAmount: Decimal;
  /**
   * The allocation the settle consumed. Null only when the relay committed the
   * allocation but reported no created events, in which case the settle bound
   * to it by `updateId` instead (operator-discovery).
   */
  allocationCid: string | null;
}

/**
 * Raised when the request cannot be turned into a swap: an unknown pool, an
 * instrument the pool does not trade, a non-positive amount, or a party whose
 * unlocked balance does not cover it. Mapped to 400.
 */
export class TestnetSwapRejectedError extends Error {
  constructor(
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "TestnetSwapRejectedError";
  }
}

/** A `CantonDex.Registry.V2:Holding` as the ACS query returns it. */
export interface RegistryHolding {
  contractId: string;
  admin: string;
  owner: string;
  instrumentId: string;
  amount: string;
  locked?: boolean;
}

/** Which holdings a swap may draw on. Every field is server-decided. */
export interface HoldingCriteria {
  owner: Party;
  admin: Party;
  instrumentId: string;
}

export interface CoveringSelection {
  /** Holdings to lock, or null when the unlocked balance is short. */
  cids: string[] | null;
  /** Unlocked balance considered, so a shortfall can be reported exactly. */
  available: bigint;
}

/**
 * Pick unlocked holdings of `criteria.owner` whose amounts SUM TO AT LEAST
 * `target` (a scaled-BigInt decimal). Not an exact-subset search: the
 * AllocationFactory accepts an over-collateralised lock (it only checks
 * `have >= needed`) and the settle returns the surplus as fresh unlocked
 * change, so covering is enough and splitting -- which this path has no
 * authority for -- is never needed.
 *
 * Prefers the single smallest holding that already covers the target (one
 * piece, least surplus locked); otherwise accumulates largest-first for the
 * fewest pieces.
 *
 * The `owner` filter is the load-bearing one: it is what stops a swap from
 * being funded with a holding that is not the swapper's.
 */
export function selectCoveringHoldings(
  holdings: RegistryHolding[],
  criteria: HoldingCriteria,
  target: bigint,
): CoveringSelection {
  const candidates = holdings
    .filter(
      (h) =>
        h.owner === criteria.owner &&
        h.admin === criteria.admin &&
        h.instrumentId === criteria.instrumentId &&
        h.locked !== true,
    )
    .map((h) => ({ contractId: h.contractId, units: dec.parseDecimal(h.amount) }))
    .filter((h) => h.units > 0n);
  const available = candidates.reduce((sum, h) => sum + h.units, 0n);
  if (target <= 0n) return { cids: [], available };

  // One holding that covers the target on its own: take the smallest such, to
  // lock (and hand back) the least surplus.
  const singleCover = candidates
    .filter((h) => h.units >= target)
    .sort((a, b) => (a.units < b.units ? -1 : a.units > b.units ? 1 : 0))[0];
  if (singleCover) return { cids: [singleCover.contractId], available };

  const descending = [...candidates].sort((a, b) =>
    a.units > b.units ? -1 : a.units < b.units ? 1 : 0,
  );
  const cids: string[] = [];
  let accumulated = 0n;
  for (const holding of descending) {
    cids.push(holding.contractId);
    accumulated += holding.units;
    if (accumulated >= target) return { cids, available };
  }
  return { cids: null, available };
}

export interface AllocateCommandInput {
  factoryCid: string;
  settlement: V2SettlementInfo;
  allocation: V2AllocationSpecification;
  /** Server-selected holdings of `party`, locked whole. */
  inputHoldingCids: string[];
  party: Party;
  requestedAt: string;
  extraArgs: unknown;
}

/**
 * The single trader-authority command of a swap, in the exact shape the dApp
 * composes for the same step. It is handed to the relay unvalidated on purpose:
 * the relay's allowlist re-checks it like any caller's command, so this builder
 * gets no privilege the browser path does not have.
 */
export function allocateCommand(input: AllocateCommandInput): unknown {
  return {
    ExerciseCommand: {
      templateId: ALLOCATION_FACTORY_INTERFACE_ID,
      contractId: input.factoryCid,
      choice: "AllocationFactory_Allocate",
      choiceArgument: {
        settlement: input.settlement,
        allocation: input.allocation,
        requestedAt: input.requestedAt,
        inputHoldingCids: input.inputHoldingCids,
        actors: [input.party],
        extraArgs: input.extraArgs,
      },
    },
  };
}

/**
 * The allocation the trader's transaction created, out of the relay receipt --
 * the same read the dApp does on a wallet result. Undefined when the relay
 * reported no created events, which is the caller's cue to bind the settle to
 * the `updateId` instead.
 */
export function createdAllocationCid(
  createdEvents: CreatedEventRef[],
): string | undefined {
  return createdEvents.find((e) =>
    e.templateId.endsWith(ALLOCATION_TEMPLATE_SUFFIX),
  )?.contractId;
}

/**
 * Disclosed contracts, unique by contract id. A registry may legitimately
 * return the same contract from both the factory refs and the choice context,
 * and the participant rejects a submission that discloses one twice.
 */
export function dedupeDisclosure(all: DisclosedContract[]): DisclosedContract[] {
  return all.filter(
    (d, i) => all.findIndex((o) => o.contractId === d.contractId) === i,
  );
}
