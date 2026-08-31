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
  const p =
    payload && typeof payload === "object"
      ? (payload as {
          tradeLegs?: Array<{ leg?: TransferLeg } | null> | null;
          transferLegs?: Array<TransferLeg | null> | null;
          policyReceipt?: { acceptedDealer?: string | null } | null;
        })
      : {};
  const rawLegs =
    p.tradeLegs && p.tradeLegs.length
      ? p.tradeLegs.map((tl) => tl?.leg)
      : p.transferLegs;
  const legs: TransferLeg[] = (rawLegs ?? []).filter(
    (l): l is TransferLeg => !!l && typeof l === "object",
  );
  const legParties = [
    ...new Set(
      legs.flatMap((l) => [l.sender?.owner, l.receiver?.owner]).filter(Boolean),
    ),
  ] as string[];

  const acceptedDealer = p.policyReceipt?.acceptedDealer ?? null;
  const dealer = acceptedDealer;
  const trader = acceptedDealer
    ? (legParties.find((x) => x !== acceptedDealer) ?? null)
    : (legs[0]?.sender?.owner ?? null);
  const counterparty = legParties.find((x) => x !== trader) ?? null;
  return { trader, dealer, counterparty };
}
