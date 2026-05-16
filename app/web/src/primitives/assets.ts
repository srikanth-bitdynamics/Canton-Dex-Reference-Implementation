// Static asset metadata used by Glyph, AssetChip, and quote/swap pages.
// Mirrors the prototype's `cdex-data.jsx ASSETS` map. In production these
// come from the registry-client; for the dApp's first pass we keep them
// as a curated list.

export interface AssetMeta {
  sym: string;
  name: string;
  decimals: number;
  glyph: 'btc' | 'eth' | 'usdc' | 'cc';
  /**
   * Reference price for fiat-display estimates ONLY. The DEX has no
   * on-chain oracle; see docs/pricing-sources.md. These values are
   * presentation-only and never feed into an executable decision.
   */
  price: number;
}

export const ASSETS: Record<string, AssetMeta> = {
  BTC:  { sym: 'BTC',  name: 'Bitcoin',     decimals: 6, glyph: 'btc',  price: 60480.0 },
  ETH:  { sym: 'ETH',  name: 'Ether',       decimals: 6, glyph: 'eth',  price: 2450.0 },
  USDC: { sym: 'USDC', name: 'USD Coin',    decimals: 2, glyph: 'usdc', price: 1.0 },
  CC:   { sym: 'CC',   name: 'Canton Coin', decimals: 4, glyph: 'cc',   price: 0.42 },
};

export const GLYPH_LABEL: Record<string, string> = {
  BTC: '₿',
  ETH: 'Ξ',
  USDC: '$',
  CC: 'C',
};
