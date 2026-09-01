// Derive the trader / dealer / counterparty of a matched trade from its stored
// payload. Shared by the indexer (which writes the columns) and the
// reindex-derived script (which recomputes them), so the two can never drift
// apart — a drift that once made reindex read `transferLegs` while the indexer
// wrote `tradeLegs`.
//
// Tolerates both payload shapes and malformed entries:
//   - current: `{ tradeLegs: [{ admin, leg }] }`
//   - legacy:  `{ transferLegs: [leg] }`
//   - a non-object payload, or `null` / shapeless leg entries, yield no parties.
//
// The trader does not follow leg direction (leg[0]'s sender flips with the
// side). The venue-signed receipt names the dealer; the trader is the other
// leg party. Both writers put the base leg first, so the pair reads off leg
// order, but the roles never do.

interface TransferLeg {
  sender?: { owner?: string | null } | null;
  receiver?: { owner?: string | null } | null;
}

export interface TradeParties {
  trader: string | null;
  dealer: string | null;
  counterparty: string | null;
}

export function deriveTradeParties(payload: unknown): TradeParties {
  const empty: TradeParties = { trader: null, dealer: null, counterparty: null };
  if (!payload || typeof payload !== "object") return empty;
  const p = payload as {
    tradeLegs?: unknown;
    transferLegs?: unknown;
    policyReceipt?: { acceptedDealer?: string | null } | null;
  };
  // Read whichever leg shape this row carries, guarding against a non-array
  // `tradeLegs`/`transferLegs` field and non-object leg entries.
  const wrapped = Array.isArray(p.tradeLegs) ? p.tradeLegs : null;
  const flat = Array.isArray(p.transferLegs) ? p.transferLegs : null;
  const rawLegs: unknown[] =
    wrapped && wrapped.length
      ? wrapped.map((tl) =>
          tl && typeof tl === "object" ? (tl as { leg?: unknown }).leg : undefined,
        )
      : (flat ?? []);
  const legs: TransferLeg[] = rawLegs.filter(
    (l): l is TransferLeg => !!l && typeof l === "object",
  );
  // Every derived party must be a non-empty string: a JSON payload can carry an
  // object or non-string `owner`/`acceptedDealer`, and binding one of those to
  // SQLite would throw. Anything else collapses to null.
  const isParty = (x: unknown): x is string => typeof x === "string" && x.length > 0;
  const legParties = [
    ...new Set(
      legs.flatMap((l) => [l.sender?.owner, l.receiver?.owner]).filter(isParty),
    ),
  ];

  const dealer = isParty(p.policyReceipt?.acceptedDealer)
    ? p.policyReceipt.acceptedDealer
    : null;
  const firstSender = legs[0]?.sender?.owner;
  const trader = dealer
    ? (legParties.find((x) => x !== dealer) ?? null)
    : (isParty(firstSender) ? firstSender : null);
  const counterparty = legParties.find((x) => x !== trader) ?? null;
  return { trader, dealer, counterparty };
}
