// Testnet-only server-side RFQ for faucet-minted parties.
//
// An RFQ round trip is four authorities: the TRADER creates the Rfq, each
// DEALER creates its RfqQuote, the OPERATOR accepts (producing a MatchedTrade
// and a signed PolicyReceipt), and then both counterparties author allocations
// which the operator and the instrument admin settle.
//
// Two of those are CreateCommands, and the relay (submit.ts) accepts only
// ExerciseCommand on an allowlisted interface. That restriction is the point:
// admitting CreateCommand would hand any anonymous visitor the ability to
// author ANY template in the package. So this module does what swap.ts and
// liquidity.ts do for their flows -- drives the whole thing server-side for
// ONE eligible party, under bounded freedoms:
//
//   - the party must clear the same faucet-provenance + hosting check the
//     relay applies, so an operator / admin / lpRegistrar party is refused
//     before anything is submitted;
//   - the PAIR is resolved against this deployment's own listed pairs and the
//     Rfq's `pair` string is built from them, so a caller cannot name
//     "BTC/USDC" and mint legs referencing instruments with no config
//     (Rfq_Accept splits that text literally into leg instrument ids);
//   - the DEALERS come from the operator's own registry table, never the
//     request body, and their tier comes from that table's `trusted` flag --
//     which is what makes Rfq.daml's "Operator-assigned tier" true here;
//   - the PRICE is derived from the operator's own mid for the pair, so a
//     caller cannot induce a quote at a price of their choosing;
//   - the HOLDINGS that fund each side are selected server-side from holdings
//     the ledger says that party owns;
//   - accepting is refused unless the RFQ's own trader is the calling party.
//
// THE RELAY ALLOWLIST IS NOT WIDENED. The two creates are submitted by the
// operator with actAs fixed to a party the operator itself chose; the only
// command that still travels through the relay is AllocationFactory_Allocate,
// which was already allowlisted.

import * as dec from "../pool/decimal.js";
import type {
  Decimal,
  DealerTier,
  Party,
  Time,
  V2Account,
  V2AllocationSpecification,
  V2SettlementInfo,
  V2TransferLeg,
  V2TransferLegSide,
} from "../types.js";

/** Which way the trader wants to trade. The only two values the route takes. */
export type TestnetRfqSide = "RFQ_Buy" | "RFQ_Sell";

export function isRfqSide(v: unknown): v is TestnetRfqSide {
  return v === "RFQ_Buy" || v === "RFQ_Sell";
}

/** The dealer-signed quote the operator posts on each whitelisted dealer's behalf. */
export const RFQ_QUOTE_TEMPLATE_ID = "CantonDex.Dex.Rfq:RfqQuote";

/** The per-counterparty allocation ask MatchedTrade_RequestAllocations creates. */
export const TRADE_ALLOCATION_REQUEST_TEMPLATE_ID =
  "CantonDex.Dex.MatchedTrade:TradeAllocationRequest";

/**
 * Daml `Metadata` on the wire is `{ values: <TextMap Text> }`. The shared V2
 * types model it as a flat record (they are only ever read from choice results,
 * where the participant fills it in), so the empty value is built once here
 * rather than cast at each use. Same reason as order.ts's copy.
 */
const EMPTY_META = { values: {} } as unknown as Record<string, string>;

/** V2 `Account` for a bare party, the shape `Utils.basicAccount` produces. */
export function basicAccount(owner: Party): V2Account {
  // `id` is NON-optional in HoldingV2.daml: omit it and the participant refuses
  // the whole command with "Missing non-optional fields: Set(id)".
  return { owner, provider: null, id: "" };
}

/**
 * Raised when a request cannot be turned into an RFQ: an unknown pair, a
 * non-positive size, an absent dealer set, or an accept that does not belong
 * to the calling party. Mapped to 400.
 */
export class TestnetRfqRejectedError extends Error {
  constructor(
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "TestnetRfqRejectedError";
  }
}

/** Response body of POST /v1/testnet/rfq. */
export interface TestnetRfqReceipt {
  rfqId: string;
  rfqCid: string;
  /** The pair string the server built, so the caller can see what it got. */
  pair: string;
  expiresAt: Time;
  quotes: Array<{ dealer: Party; quoteCid: string; price: Decimal; tier: string }>;
}

/** Response body of POST /v1/testnet/rfq/accept. */
export interface TestnetRfqAcceptReceipt {
  tradeCid: string;
  acceptedDealer: Party;
  acceptedRank: number;
  consideredCount: number;
  /** Update id of the counterparties' allocation submission. */
  updateId: string;
}

/**
 * The quote a demo dealer posts.
 *
 * Derived from the operator's own mid so no caller can influence it. A trusted
 * dealer quotes tighter than a whitelisted one, which gives the ranking
 * something to separate beyond the tier itself, and the sign follows the side:
 * the trader buys above mid and sells below it, so the spread is always
 * against the trader, as it would be from a real market maker.
 *
 * Exported for tests: this is arithmetic, and it should be pinned as such.
 */
export function dealerQuotePrice(
  mid: Decimal,
  side: TestnetRfqSide,
  spreadBps: number,
): Decimal {
  const m = dec.parseDecimal(mid);
  // bps of mid, as a scaled-integer operation so the result stays exact at the
  // 10dp Daml Decimal scale rather than going through IEEE-754.
  const delta = (m * BigInt(Math.round(spreadBps))) / 10_000n;
  return dec.formatDecimal(side === "RFQ_Buy" ? m + delta : m - delta);
}

/**
 * The per-dealer spread, in basis points. Trusted dealers quote tighter.
 * Deterministic per dealer so repeated RFQs from the same deployment produce a
 * stable, explainable book rather than noise.
 */
export function dealerSpreadBps(index: number, trusted: boolean): number {
  return (trusted ? 5 : 15) + index * 2;
}

/** The Rfq `pair` text for a listed pair. */
export function rfqPairString(base: string, quote: string): string {
  return `${base}/${quote}`;
}

/**
 * Validate and normalise a requested size.
 *
 * Shape first: parseDecimal assumes a well-formed decimal string and would
 * throw on anything else.
 */
export function rfqSize(raw: string | undefined, isDecimalString: (v: unknown) => boolean): Decimal {
  if (!isDecimalString(raw)) {
    throw new TestnetRfqRejectedError("size must be a Daml Decimal string", {
      field: "size",
    });
  }
  if (dec.parseDecimal(raw as string) <= 0n) {
    throw new TestnetRfqRejectedError("size must be positive", { field: "size" });
  }
  return raw as Decimal;
}

/**
 * How long the RFQ stays open, clamped.
 *
 * Load-bearing beyond tidiness: Rfq_Accept sets the MatchedTrade's
 * settlementDeadline to the RFQ's expiry, and Allocation_Settle aborts once
 * that passes. Too short an expiry therefore fails inside the settle, for a
 * reason that looks nothing like the expiry the caller chose.
 */
export const MIN_RFQ_MINUTES = 5;
export const MAX_RFQ_MINUTES = 24 * 60;

export function rfqExpiry(now: Date, minutes: number | undefined): Time {
  const m = Math.min(
    MAX_RFQ_MINUTES,
    Math.max(MIN_RFQ_MINUTES, Math.floor(minutes ?? 60)),
  );
  return new Date(now.getTime() + m * 60_000).toISOString();
}

/**
 * The operator's own mid for a pool, as an exact 10dp Decimal.
 *
 * `quoteReserve / baseReserve` -- the same constant-product spot price
 * PoolPriceSource serves -- but computed through the BigInt decimal module
 * rather than IEEE-754, because this number is multiplied into a quoted price
 * that is then multiplied by size ON-LEDGER to produce the quote leg's amount.
 * A float here would leave the trader short by a few units of the last digit
 * and fail the allocation, not the arithmetic.
 */
export function poolMid(baseReserve: Decimal, quoteReserve: Decimal): Decimal {
  const base = dec.parseDecimal(baseReserve);
  if (base <= 0n) {
    throw new TestnetRfqRejectedError(
      "this deployment has no priceable liquidity for that pair",
      { field: "pair" },
    );
  }
  return dec.formatDecimal(dec.div(dec.parseDecimal(quoteReserve), base));
}

/** The create argument of one demo dealer's quote, rebuilt field by field. */
export function rfqQuoteArgument(input: {
  dealer: Party;
  trader: Party;
  operator: Party;
  rfqId: string;
  price: Decimal;
  expiresAt: Time;
  postedAt: Time;
  tier: DealerTier;
}): Record<string, unknown> {
  return {
    dealer: input.dealer,
    trader: input.trader,
    operator: input.operator,
    rfqId: input.rfqId,
    price: input.price,
    expiresAt: input.expiresAt,
    postedAt: input.postedAt,
    tier: input.tier,
  };
}

/** A `CantonDex.Dex.MatchedTrade:TradeAllocationRequest` as the ACS returns it. */
export interface TradeAllocationRequestContract {
  contractId: string;
  authorizer: V2Account;
  admin: Party;
  settlement: V2SettlementInfo;
  settlementDeadline: Time | null;
  transferLegs: V2TransferLeg[];
}

/**
 * One leg projected onto the authorizer's side, mirroring `Utils.legToSide`.
 * Returns undefined for a leg the authorizer is neither end of, which
 * `Utils.legsToSides` drops via mapOptional -- the spec the authorizer signs
 * has to match the one the settle recomputes, leg for leg and in order.
 */
export function legToSide(
  authorizer: V2Account,
  leg: V2TransferLeg,
): V2TransferLegSide | undefined {
  const isSender = leg.sender.owner === authorizer.owner;
  const isReceiver = leg.receiver.owner === authorizer.owner;
  if (!isSender && !isReceiver) return undefined;
  return {
    transferLegId: leg.transferLegId,
    side: isSender ? "SenderSide" : "ReceiverSide",
    otherside: isSender ? leg.receiver : leg.sender,
    amount: leg.amount,
    instrumentId: leg.instrumentId,
    meta: leg.meta,
  };
}

export function legsToSides(
  authorizer: V2Account,
  legs: V2TransferLeg[],
): V2TransferLegSide[] {
  return legs
    .map((leg) => legToSide(authorizer, leg))
    .filter((s): s is V2TransferLegSide => s !== undefined);
}

/**
 * The spec one counterparty authors for its side of a matched trade.
 *
 * It carries NO `settlement`: that is a sibling argument of
 * AllocationFactory_Allocate, not part of the specification
 * (AllocationV2.daml). The deadline comes from the REQUEST rather than being
 * recomputed, so the spec the authorizer signs is byte-identical to the one
 * SettlementFactory_SettleBatch validates -- and that deadline is the RFQ's own
 * expiry, which Rfq_Accept copied onto the MatchedTrade.
 */
export function tradeAllocationSpec(
  request: TradeAllocationRequestContract,
): V2AllocationSpecification {
  return {
    admin: request.admin,
    authorizer: basicAccount(request.authorizer.owner as Party),
    transferLegSides: legsToSides(request.authorizer, request.transferLegs),
    settlementDeadline: request.settlementDeadline,
    nextIterationFunding: null,
    committed: false,
    meta: EMPTY_META,
  };
}

/** The leg this authorizer has to fund, if any. A receiver locks nothing. */
export function senderSide(
  sides: V2TransferLegSide[],
): V2TransferLegSide | undefined {
  return sides.find((s) => s.side === "SenderSide");
}
