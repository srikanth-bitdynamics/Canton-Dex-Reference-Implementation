// Number/time formatting. Mirrors `cdex-data.jsx` helpers (fmt, fmtUsd,
// fmtUsdK) and `cdex-primitives.jsx formatExpiresIn`. Single
// implementation for the whole app; pages MUST go through these so the
// numerical look-and-feel stays consistent.

export function fmt(n: number | null | undefined, dp = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '–';
  return n.toLocaleString('en-US', {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}

export function fmtUsd(n: number): string {
  return (
    '$' +
    n.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

export function fmtUsdK(n: number): string {
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + n.toFixed(0);
}

export function formatExpiresIn(totalSeconds: number | null | undefined): string {
  const s = Math.max(0, Math.floor(totalSeconds ?? 0));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m + 'm ' + rem.toString().padStart(2, '0') + 's';
}

/**
 * Constant-product swap output mirror of Pool.daml's Pool_ComputeSwapOut.
 * Used for the dApp's quote panel before round-tripping the operator
 * backend's /v1/swaps/quote endpoint -- gives a snappy preview without
 * a network call. The on-chain choice re-validates against
 * `minOutputAmount`.
 */
export function quoteSwap(
  reserveIn: number,
  reserveOut: number,
  amountIn: number,
  feeBps: number,
): { out: number; priceImpact: number; mid: number } {
  if (!amountIn || amountIn <= 0) {
    return { out: 0, priceImpact: 0, mid: reserveOut / reserveIn };
  }
  const feeMul = (10000 - feeBps) / 10000;
  const dx = amountIn * feeMul;
  const out = (reserveOut * dx) / (reserveIn + dx);
  const mid = reserveOut / reserveIn;
  const exec = out / amountIn;
  const priceImpact = Math.abs(1 - exec / mid);
  return { out, priceImpact, mid };
}
