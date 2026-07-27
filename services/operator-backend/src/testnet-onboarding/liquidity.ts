// Testnet-only server-side pool liquidity for faucet-minted parties.
//
// Adding or removing liquidity on this DEX is three transactions and two of
// them are the operator's, exactly as a swap is (see swap.ts):
//
//   1. PoolLiquidityRules_RequestAddLiquidity / _RequestRemoveLiquidity
//      (operator authority) -- builds, in Daml, the THREE allocation specs the
//      LP has to author, and leaves them on a LiquidityAllocationRequest;
//   2. AllocationFactory_Allocate x3        (LP authority) -- the LP authors
//      those specs, locking their deposits (add) or their LP tokens (remove);
//   3. PoolLiquidityRules_SettleAddLiquidity / _SettleRemoveLiquidity
//      (operator authority) -- settles the DvP against the three allocations.
//
// Steps 1 and 3 are POST /v1/pools/{add,remove}-liquidity/{request,settle},
// all four behind DEX_OPERATOR_API_TOKEN because they were built for a trusted
// caller: they take a pool, a party and amounts and submit under the operator's
// own authority. That token cannot be shipped to a browser -- it would grant
// arbitrary operator writes -- so a faucet party, which gets through step 2 via
// POST /v1/testnet/submit, still cannot add or remove liquidity from the UI:
// today the add fails with 401.
//
// Exempting those four operator routes from the token is the wrong fix: it
// would open the operator's whole liquidity surface to anyone, for any party.
// Instead this module drives all three steps server-side for ONE faucet party,
// under the same bounded freedoms swap.ts documents:
//
//   - the party must clear the same faucet-provenance + hosting check the
//     submit relay applies, so an operator / admin / lpRegistrar party is
//     refused before anything is submitted;
//   - the LP step goes through that same relay, so actAs is fixed to the one
//     eligible party and the disclosure is the operator's;
//   - the funding holdings -- the base/quote deposits on an add, the LP tokens
//     on a remove -- are SELECTED here, from holdings owned by that party. A
//     caller-supplied holding cid would let them name someone else's, and a
//     caller-supplied allocation cid would let them settle someone else's;
//   - the LP-mint floor (add) and the base/quote payout floors (remove) default
//     to the operator's own quote, so a liquidity change cannot settle on worse
//     terms than the ones quoted for it;
//   - the pool, amounts and party the operator steps run with come from the
//     validated request and nothing else.
//
// DESIGN DECISION -- how the three allocations are authored.
//
// The dApp authors them as a single CreateAndExercise on the standard
// BatchingUtilityV2. The relay accepts neither that command kind nor that
// template (submit.ts: ExerciseCommand only, on an allowlisted interface), and
// widening its allowlist would hand every anonymous caller a general-purpose
// batch-any-template primitive -- the exact freedom the allowlist exists to
// remove. So this module takes the other option: THREE SEPARATE
// AllocationFactory_Allocate COMMANDS, in one relayed submission, through the
// existing allowlist unchanged.
//
// That is not a workaround, it is the flow the Daml was written for. The settle
// choices bind to EITHER a live LiquidityAllocationRequest or the
// LiquidityAllocationAcceptance evidence, and
// `CantonDex.Dex.PoolLiquidityRules:resolveBinding` /
// `validateAgainstBinding` check only that each supplied allocation's spec is
// one of the specs the binding lists -- never how, or in how many commands, it
// was authored. `CantonDex.Dex.LiquidityAllocationRequest` names this
// explicitly: "The legacy direct-allocation flow never calls accept and binds
// to the still-live request instead." Batching is the stock wallet's
// convenience, not a Daml requirement.
//
// One consequence of that choice is load-bearing here: because nothing calls
// AllocationRequest_Accept on this path, no LiquidityAllocationAcceptance is
// ever created, so the operator-discovery (`updateId`-only) settle path -- which
// recovers an acceptance and drops the request cid -- cannot bind. The three
// created allocation cids therefore have to come off the relay receipt, and a
// receipt that does not carry all three is reported rather than settled around.

import type { DisclosedContract } from "@canton-dex/registry-client";
import type { CreatedEventRef } from "../ledger/index.js";
import * as dec from "../pool/decimal.js";
import type {
  Decimal,
  Party,
  V2AllocationSpecification,
  V2SettlementInfo,
} from "../types.js";
import {
  ALLOCATION_TEMPLATE_SUFFIX,
  allocateCommand,
  selectCoveringHoldings,
  type RegistryHolding,
} from "./swap.js";

/** Which way the liquidity moves. The only two values the route accepts. */
export type TestnetLiquidityAction = "add" | "remove";

/**
 * The number of allocations both liquidity flows are built from: on an add the
 * base deposit, the quote deposit and the LP-mint receipt; on a remove the base
 * payout receipt, the quote payout receipt and the LP-burn sender. The request
 * lists their specs in that order and the settle consumes them in that order.
 */
export const LIQUIDITY_ALLOCATION_COUNT = 3;

/** Response body of POST /v1/testnet/liquidity. */
export interface TestnetLiquidityReceipt {
  /** Update id of the LP's allocation transaction. */
  updateId: string;
  /** LP tokens minted (add) or burned (remove). */
  lpAmount: Decimal;
  /** Base deposited (add) or paid out (remove). */
  baseAmount: Decimal;
  /** Quote deposited (add) or paid out (remove). */
  quoteAmount: Decimal;
}

/**
 * Raised when the request cannot be turned into a liquidity change: an unknown
 * pool, a missing or non-positive amount, or a party whose unlocked balance --
 * of the deposit instruments, or of the pool's LP token -- does not cover it.
 * Mapped to 400.
 */
export class TestnetLiquidityRejectedError extends Error {
  constructor(
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "TestnetLiquidityRejectedError";
  }
}

/**
 * One of the three allocations, paired with everything the LP's command for it
 * needs. Every field is server-decided: the factory and its registry extraArgs
 * come from the operator's own registry, and `inputHoldingCids` from holdings
 * the ledger says this party owns.
 */
export interface LiquidityAllocationLeg {
  /** Pool-admin factory for the deposit/payout legs, lpRegistrar's for the LP leg. */
  factoryCid: string;
  extraArgs: unknown;
  /** Server-selected holdings to lock whole. Empty on a receipt-only leg. */
  inputHoldingCids: string[];
}

export interface LiquidityAllocateCommandsInput {
  /** The specs the request built, in the canonical order the settle expects. */
  allocations: V2AllocationSpecification[];
  settlement: V2SettlementInfo;
  /** Per-spec factory + funding, same order and length as `allocations`. */
  legs: LiquidityAllocationLeg[];
  party: Party;
  requestedAt: string;
}

/**
 * The LP-authority commands of a liquidity change: one
 * AllocationFactory_Allocate per requested spec, in the request's own order, in
 * the shape swap.ts builds for the single-allocation case. They are handed to
 * the relay unvalidated on purpose -- the relay's allowlist re-checks each one
 * like any caller's command, so this builder gets no privilege the browser path
 * does not have.
 *
 * Only the two deposit specs of an add and the burn spec of a remove carry
 * holdings; the receipt specs are authored with an empty `inputHoldingCids`,
 * because their author is the RECEIVER of the leg and has nothing to lock.
 */
export function liquidityAllocateCommands(
  input: LiquidityAllocateCommandsInput,
): unknown[] {
  if (input.allocations.length !== input.legs.length) {
    throw new TestnetLiquidityRejectedError(
      "the pool returned an unexpected number of allocation specs",
      { expected: input.legs.length, got: input.allocations.length },
    );
  }
  return input.allocations.map((allocation, i) => {
    const leg = input.legs[i]!;
    return allocateCommand({
      factoryCid: leg.factoryCid,
      settlement: input.settlement,
      allocation,
      inputHoldingCids: leg.inputHoldingCids,
      party: input.party,
      requestedAt: input.requestedAt,
      extraArgs: leg.extraArgs,
    });
  });
}

/**
 * The allocations the LP's transaction created, in node order -- the same read
 * the dApp does on a wallet result, extended from swap.ts's single allocation
 * to the three a liquidity DvP settles against.
 */
export function createdAllocationCids(
  createdEvents: CreatedEventRef[],
): string[] {
  return createdEvents
    .filter((e) => e.templateId.endsWith(ALLOCATION_TEMPLATE_SUFFIX))
    .map((e) => e.contractId);
}

/** Sum of a list of Daml Decimal strings, as a Daml Decimal string. */
export function sumDecimals(amounts: Decimal[]): Decimal {
  return dec.formatDecimal(
    amounts.reduce((total, a) => total + dec.parseDecimal(a), 0n),
  );
}

/** Disclosed contracts of both registries a liquidity DvP touches, deduped. */
export function liquidityDisclosure(
  depositDisclosure: DisclosedContract[],
  lpDisclosure: DisclosedContract[],
): DisclosedContract[] {
  const all = [...depositDisclosure, ...lpDisclosure];
  return all.filter(
    (d, i) => all.findIndex((o) => o.contractId === d.contractId) === i,
  );
}

/** Which holdings one leg may draw on. Every field is server-decided. */
export interface LiquidityFundingCriteria {
  owner: Party;
  admin: Party;
  instrumentId: string;
}

/**
 * Pick the holdings that fund one leg, or refuse with the exact shortfall.
 *
 * Delegates the selection itself to swap.ts's `selectCoveringHoldings`, so
 * there is one definition of "holdings this party may spend" across both public
 * testnet write paths: unlocked, this owner's, this admin's, this instrument's,
 * locked whole because neither path carries the admin authority a split needs.
 */
export function selectLiquidityFunding(
  holdings: RegistryHolding[],
  criteria: LiquidityFundingCriteria,
  amount: Decimal,
): string[] {
  const selection = selectCoveringHoldings(
    holdings,
    criteria,
    dec.parseDecimal(amount),
  );
  if (!selection.cids || selection.cids.length === 0) {
    throw new TestnetLiquidityRejectedError(
      `insufficient unlocked ${criteria.instrumentId} balance: ` +
        `have ${dec.formatDecimal(selection.available)}, need ${amount}`,
      {
        instrumentId: criteria.instrumentId,
        available: dec.formatDecimal(selection.available),
        required: amount,
      },
    );
  }
  return selection.cids;
}
