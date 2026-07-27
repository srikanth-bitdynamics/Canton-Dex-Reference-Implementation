// Testnet-only server-side order placement for faucet-minted parties.
//
// Placing a resting order on this DEX is four transactions and two of them are
// the operator's:
//
//   1. create OrderFundingRequest       (trader authority)   -- the trader's
//      signed intent: pair, side, limit price, quantity, expiry;
//   2. OrderFundingRequest_Bind         (operator authority) -- creates the
//      Order (Pending) plus the OrderAllocationRequest that funds it;
//   3. AllocationFactory_Allocate       (trader authority)   -- the trader
//      locks the order's collateral behind the spec that request describes;
//   4. Order_Fund                       (operator authority) -- binds the
//      authored allocation onto the order, Pending -> Funded.
//
// Steps 2 and 4 are POST /v1/orders/bind and POST /v1/orders/fund, both behind
// DEX_OPERATOR_API_TOKEN because they were built for a trusted caller. That
// token cannot be shipped to a browser -- it would grant arbitrary operator
// writes -- so a faucet party stops at step 1.
//
// Step 1 is worse than that: it is a CreateCommand, and the public submit relay
// accepts ExerciseCommand on an allowlisted choice only (see submit.ts). Adding
// creates to that allowlist would let any caller author any template the
// package defines, which is precisely the freedom the relay exists to remove.
// So the relay is left exactly as it is and this module drives all four steps
// server-side for ONE faucet party, the way swap.ts drives a swap:
//
//   - the party must clear the same faucet-provenance + hosting check the
//     submit relay applies, so an operator / admin / lpRegistrar party is
//     refused before anything is submitted;
//   - step 1 submits under the operator's own ledger user with actAs pinned to
//     that one eligible party -- the same authority the participant already
//     granted the faucet when it allocated the party -- and the contract's
//     fields are rebuilt from the validated request, never copied from it;
//   - step 3 goes through the relay unchanged, so its allowlist re-checks the
//     command and actAs is fixed there too;
//   - the collateral holdings are SELECTED here, from holdings owned by that
//     party. A caller-supplied holding cid would let them name someone else's;
//   - the pair must be one this deployment lists under its own asset admin, so
//     the instruments are not the caller's to invent;
//   - the settlement reference is server-generated. It becomes the bind's
//     commandId, which is an idempotency key on the participant: a
//     caller-chosen one would let two callers collide, or one replay another's.
//
// Cancelling is operator-authority only (Order_Cancel is `controller
// operator`), so it is driven here too -- but the order is resolved from the
// operator's own read model and its trader compared to the calling party first.
// A contract id in a request body is a claim about ownership, never a proof of
// one.
//
// Collateral locks WHOLE holdings whose sum covers the amount, for the reason
// spelled out in swap.ts: this path carries no admin authority, so it cannot
// split, and the standard consumes `inputHoldingCids` whole while Registry.V2
// returns the surplus to the owner.

import * as dec from "../pool/decimal.js";
import type {
  Decimal,
  OrderStatus,
  Party,
  Side,
  Time,
  V2AllocationSpecification,
  V2SettlementInfo,
} from "../types.js";

/** The trader's signed order intent; the bind step's target. */
export const ORDER_FUNDING_REQUEST_TEMPLATE_ID =
  "CantonDex.Dex.OrderFundingRequest:OrderFundingRequest";

/** The listing an order's pair has to appear in. */
export const DEX_PAIR_TEMPLATE_ID = "CantonDex.Dex.DexPair:DexPair";

/**
 * Daml `Metadata` on the wire is `{ values: <TextMap Text> }`. The shared V2
 * types model it as a flat record (they are only ever read from choice results,
 * where the participant fills it in), so the empty value is built once here
 * rather than cast at each use.
 */
const EMPTY_META = { values: {} } as unknown as Record<string, string>;

/** Response body of POST /v1/testnet/order. */
export interface TestnetOrderReceipt {
  /** Update id of the trader's collateral-allocation transaction. */
  updateId: string;
  /** The funded order, as Order_Fund re-created it. */
  orderCid: string;
  status: OrderStatus;
}

/** Response body of POST /v1/testnet/order/cancel. */
export interface TestnetOrderCancelReceipt {
  /**
   * Update id of the cancelling transaction. Null only when the deployment's
   * ledger driver cannot report one.
   */
  updateId: string | null;
}

/**
 * Raised when the request cannot be turned into an order: an unlisted pair, a
 * side that is neither Bid nor Ask, a non-positive price or quantity, a party
 * whose unlocked balance does not cover the collateral, or -- on cancel -- an
 * order this deployment does not have open. Mapped to 400.
 */
export class TestnetOrderRejectedError extends Error {
  constructor(
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "TestnetOrderRejectedError";
  }
}

/** A `CantonDex.Dex.DexPair:DexPair` as the ACS query returns it. */
export interface DexPairListing {
  contractId: string;
  admin: string;
  baseInstrumentId: string;
  quoteInstrumentId: string;
  active?: boolean;
}

export function isOrderSide(v: unknown): v is Side {
  return v === "Bid" || v === "Ask";
}

/**
 * The pair this order rests on, or undefined when the deployment does not list
 * it. `admin` is the server's own asset admin: a pair listed under some other
 * admin is not one this faucet can fund an order for.
 */
export function findListedPair(
  pairs: DexPairListing[],
  criteria: { admin: Party; baseInstrumentId: string; quoteInstrumentId: string },
): DexPairListing | undefined {
  return pairs.find(
    (p) =>
      p.admin === criteria.admin &&
      p.baseInstrumentId === criteria.baseInstrumentId &&
      p.quoteInstrumentId === criteria.quoteInstrumentId &&
      p.active !== false,
  );
}

/** What an order locks: one instrument and one amount. */
export interface CollateralLeg {
  instrumentId: string;
  amount: Decimal;
}

/**
 * The collateral OrderFundingRequest_Bind will ask for, computed the same way
 * the choice computes it: a Bid locks quote at `quantity * limitPrice`, an Ask
 * locks base at `quantity`. The multiply goes through the BigInt decimal module
 * so it agrees with the on-ledger Decimal multiply to the last digit -- a
 * float here would under-fund the request and fail step 3 on-ledger.
 */
export function collateralLeg(input: {
  side: Side;
  baseInstrumentId: string;
  quoteInstrumentId: string;
  limitPrice: Decimal;
  quantity: Decimal;
}): CollateralLeg {
  const quantity = dec.parseDecimal(input.quantity);
  if (input.side === "Bid") {
    return {
      instrumentId: input.quoteInstrumentId,
      amount: dec.formatDecimal(dec.mul(quantity, dec.parseDecimal(input.limitPrice))),
    };
  }
  return {
    instrumentId: input.baseInstrumentId,
    amount: dec.formatDecimal(quantity),
  };
}

export interface FundingRequestInput {
  operator: Party;
  admin: Party;
  /** The order's trader. Server-decided, never body-read. */
  party: Party;
  baseInstrumentId: string;
  quoteInstrumentId: string;
  side: Side;
  limitPrice: Decimal;
  quantity: Decimal;
  expiry: Time | null;
}

/**
 * The create argument of step 1, rebuilt field by field. `trader` is the
 * eligible party and `operator` / `admin` are the server's own, so a caller
 * cannot place an order in someone else's name or against another admin's
 * instruments by attaching those fields to the body.
 */
export function fundingRequestArgument(
  input: FundingRequestInput,
): Record<string, unknown> {
  return {
    operator: input.operator,
    trader: input.party,
    admin: input.admin,
    baseInstrumentId: input.baseInstrumentId,
    quoteInstrumentId: input.quoteInstrumentId,
    side: input.side,
    limitPrice: input.limitPrice,
    quantity: input.quantity,
    expiry: input.expiry,
  };
}

/**
 * The settlement the collateral allocation is authored against. It mirrors the
 * `AllocationRequest` view OrderAllocationRequest projects, whose id is
 * `"DexOrder-" <> settlementRef` (see Order.makeOrderRefFromText).
 */
export function collateralSettlement(
  operator: Party,
  settlementRef: string,
): V2SettlementInfo {
  return {
    executors: [operator],
    id: `DexOrder-${settlementRef}`,
    cid: null,
    meta: EMPTY_META,
  };
}

/**
 * The spec the trader authors: no transfer legs, the whole collateral as
 * next-iteration funding, committed. Same mirror of the OrderAllocationRequest
 * view -- the concrete legs travel with the match flow later, not now.
 */
export function collateralAllocationSpec(input: {
  admin: Party;
  party: Party;
  collateral: CollateralLeg;
  expiry: Time | null;
}): V2AllocationSpecification {
  return {
    admin: input.admin,
    authorizer: { owner: input.party, provider: null, id: "" },
    transferLegSides: [],
    settlementDeadline: input.expiry,
    nextIterationFunding: { [input.collateral.instrumentId]: input.collateral.amount },
    committed: true,
    meta: EMPTY_META,
  };
}
