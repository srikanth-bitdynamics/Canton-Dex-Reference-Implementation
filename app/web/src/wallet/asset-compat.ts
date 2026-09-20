// Wallet-compat funding fallback registry.
//
// Maps a Token-Standard instrument identity {admin, id} to the concrete Daml
// Holding template a wallet can query when its generic HoldingV2-interface ACS
// query returns nothing. This exists solely so an external wallet whose
// interface-query path is incomplete (e.g. Loop) can still surface real,
// lockable Holding contract ids for FUNDING.
//
// This mapping lives in the wallet layer only. Pool/trading/DEX logic must
// never read it — funding-cid resolution is the one and only consumer.

import type { InstrumentId } from "@/types/contracts";

interface AssetCompatEntry {
  instrument: InstrumentId;
  /** Concrete Holding template id, package-name-prefixed. */
  holdingTemplateId: string;
}

export const UTILITY_HOLDING_TEMPLATE =
  "#utility-registry-holding-v0:Utility.Registry.Holding.V0.Holding:Holding";

const ASSET_COMPAT: AssetCompatEntry[] = [
  {
    instrument: {
      admin: "DSO::1220f22a8b8f2d813c25b9a684dc4dd52b532a0174d8e73a13cdf2baabfff7518337",
      id: "Amulet",
    },
    holdingTemplateId: "#splice-amulet:Splice.Amulet:Amulet",
  },
  {
    instrument: {
      admin: "decentralized-usdc-interchain-rep::122049e2af8a725bd19759320fc83c638e7718973eac189d8f201309c512d1ffec61",
      id: "USDCx",
    },
    holdingTemplateId: UTILITY_HOLDING_TEMPLATE,
  },
];

/**
 * The concrete Holding template for an instrument, or undefined when no
 * wallet-compat fallback is registered (in which case the interface query is
 * the only funding path and an empty result stays empty).
 */
export function concreteHoldingTemplate(instrument: {
  admin: string;
  id: string;
}): string | undefined {
  return ASSET_COMPAT.find(
    (e) => e.instrument.admin === instrument.admin && e.instrument.id === instrument.id,
  )?.holdingTemplateId;
}
