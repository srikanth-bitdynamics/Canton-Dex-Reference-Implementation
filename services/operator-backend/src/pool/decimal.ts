// Exact fixed-point decimal arithmetic matching Daml's `Decimal` (10
// fractional digits, round-half-even) for the DvP liquidity quotes
// (DEX-53). The pool add/remove flows need the operator-computed amounts to
// agree with the on-ledger Daml computation to the last digit — IEEE-754
// doubles cannot do this once amounts exceed ~15 significant digits (a
// large pool's reserves easily do), so we work in scaled BigInt.
//
// Representation: a value `v` is stored as the BigInt `round(v * 1e10)`.
// All ops below preserve that scale and use round-half-even, the same mode
// Daml `Decimal` mul/div use, so results match `*` / `/` on-ledger.

export const DECIMALS = 10;
export const SCALE = 10n ** BigInt(DECIMALS);

/** Parse a non-negative Daml Decimal string into scaled BigInt. */
export function parseDecimal(s: string): bigint {
  const str = s.trim();
  const neg = str.startsWith("-");
  const body = neg ? str.slice(1) : str;
  const [intPart, fracPartRaw = ""] = body.split(".");
  // Pad/truncate the fractional part to exactly DECIMALS digits.
  const frac = (fracPartRaw + "0".repeat(DECIMALS)).slice(0, DECIMALS);
  const scaled = BigInt(intPart || "0") * SCALE + BigInt(frac || "0");
  return neg ? -scaled : scaled;
}

/** Format a scaled BigInt back to a fixed 10dp Daml Decimal string. */
export function formatDecimal(x: bigint): string {
  const neg = x < 0n;
  const abs = neg ? -x : x;
  const intPart = abs / SCALE;
  const frac = (abs % SCALE).toString().padStart(DECIMALS, "0");
  return `${neg ? "-" : ""}${intPart.toString()}.${frac}`;
}

// Round-half-even of `num / den` (den > 0), returning the integer quotient.
function divRoundHalfEven(num: bigint, den: bigint): bigint {
  const neg = num < 0n;
  const n = neg ? -num : num;
  let q = n / den;
  const r = n % den;
  const twice = 2n * r;
  if (twice > den) {
    q += 1n;
  } else if (twice === den) {
    if (q % 2n === 1n) q += 1n; // round to even
  }
  return neg ? -q : q;
}

/** a * b at 10dp, round-half-even (matches Daml `*`). */
export function mul(a: bigint, b: bigint): bigint {
  return divRoundHalfEven(a * b, SCALE);
}

/** a / b at 10dp, round-half-even (matches Daml `/`). */
export function div(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error("decimal div by zero");
  return divRoundHalfEven(a * SCALE, b);
}

// Integer square root (floor) of a non-negative BigInt, via Newton.
function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("isqrt of negative");
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/**
 * sqrt at 10dp, FLOORED (always <= the true root). Conservative on purpose:
 * the on-ledger add bound permits a sub-dust shortfall, and flooring keeps
 * the quote from ever exceeding the fair share by more than rounding.
 * For scaled `a` (= v·1e10), sqrt(v)·1e10 = sqrt(a·1e10).
 */
export function sqrt(a: bigint): bigint {
  if (a < 0n) throw new Error("sqrt of negative");
  return isqrt(a * SCALE);
}

export function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
