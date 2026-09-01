// Static asset metadata used by Glyph, AssetChip, and display helpers.
//
// What's static and what's not:
//   - `decimals` and `glyph` are presentation constants tied to the
//     instrument's spec. They're static here intentionally.
//   - `price` is NOT here. Prices are live, sourced from the operator
//     backend's `/v1/prices` (pool-derived or configured feed) via the
//     `useAssetPricesUsd` hook. Anything that wants a USD value reads
//     from that hook and falls back to "—" when no source has a price.

export interface AssetMeta {
  sym: string;
  name: string;
  decimals: number;
  glyph: 'eth' | 'usd' | 'cc';
}

export const ASSETS: Record<string, AssetMeta> = {
  Amulet: { sym: 'CC', name: 'Canton Coin', decimals: 4, glyph: 'cc' },
  USDCx: { sym: 'USDCx', name: 'USDCx', decimals: 2, glyph: 'usd' },
  ETH: { sym: 'ETH', name: 'Ether', decimals: 6, glyph: 'eth' },
  CC: { sym: 'CC', name: 'Canton Coin', decimals: 4, glyph: 'cc' },
};

export const GLYPH_LABEL: Record<string, string> = {
  Amulet: 'C',
  USDCx: '$',
  ETH: 'Ξ',
  CC: 'C',
};

// Friendly display symbol for an instrument id. Identity stays the id;
// this maps ids to user-facing labels, defaulting to the id when unmapped.
const INSTRUMENT_LABELS: Record<string, string> = {
  Amulet: 'CC',
  USDCx: 'USDCx',
};

export function instrumentLabel(id: string): string {
  return INSTRUMENT_LABELS[id] ?? id;
}

// Full-identity key for an instrument. Two registries may both issue an asset
// called `USDC`, so balances, price maps, and any per-instrument lookup must
// key by {admin, id} rather than the display symbol alone.
export function instrumentKey(instrument: { admin: string; id: string }): string {
  return `${instrument.admin}::${instrument.id}`;
}
