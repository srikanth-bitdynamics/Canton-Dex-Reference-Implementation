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

// Seed: Canton Coin (Amulet). The DSO admin is resolved from scan; the concrete
// template is Splice's Amulet.
//
// USDCx is intentionally absent: its concrete Holding template is not yet
// known and MUST be discovered from the registry's metadata before a wallet
// lacking the interface-query path can fund USDCx. Do not guess it.
const ASSET_COMPAT: AssetCompatEntry[] = [
  {
    instrument: {
      admin: "DSO::1220f22a8b8f2d813c25b9a684dc4dd52b532a0174d8e73a13cdf2baabfff7518337",
      id: "Amulet",
    },
    holdingTemplateId: "#splice-amulet:Splice.Amulet:Amulet",
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
