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
  glyph: 'btc' | 'eth' | 'usdc' | 'cc';
}

export const ASSETS: Record<string, AssetMeta> = {
  BTC: { sym: 'BTC', name: 'Bitcoin', decimals: 6, glyph: 'btc' },
  ETH: { sym: 'ETH', name: 'Ether', decimals: 6, glyph: 'eth' },
  USDC: { sym: 'USDC', name: 'USD Coin', decimals: 2, glyph: 'usdc' },
  CC: { sym: 'CC', name: 'Canton Coin', decimals: 4, glyph: 'cc' },
  // DEX-* are demo instruments seeded by scripts/bootstrap-registry.ts
  // for live testnet validation. Treat them as their underlying assets
  // for glyph + decimals purposes.
  'DEX-BTC': { sym: 'DEX-BTC', name: 'Demo Bitcoin', decimals: 6, glyph: 'btc' },
  'DEX-ETH': { sym: 'DEX-ETH', name: 'Demo Ether', decimals: 6, glyph: 'eth' },
  'DEX-USDC': { sym: 'DEX-USDC', name: 'Demo USD Coin', decimals: 2, glyph: 'usdc' },
};

export const GLYPH_LABEL: Record<string, string> = {
  BTC: '₿',
  ETH: 'Ξ',
  USDC: '$',
  CC: 'C',
  'DEX-BTC': '₿',
  'DEX-ETH': 'Ξ',
  'DEX-USDC': '$',
};
