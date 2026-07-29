// Exact fixed-point decimal helper tests. The point of this module
// is that the LP quote stays accurate at magnitudes where IEEE-754 doubles
// lose the low digits — so the large-magnitude sqrt case is the headline.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseDecimal, formatDecimal, mul, div, sqrt, ceilMulDiv, SCALE } from "../src/pool/decimal.js";

describe("decimal: parse/format round-trip", () => {
  it("pads and truncates to 10dp", () => {
    assert.equal(formatDecimal(parseDecimal("10")), "10.0000000000");
    assert.equal(formatDecimal(parseDecimal("10.5")), "10.5000000000");
    assert.equal(formatDecimal(parseDecimal("0.12345678901234")), "0.1234567890");
  });
});

describe("decimal: mul/div round-half-even", () => {
  it("multiplies at 10dp", () => {
    assert.equal(formatDecimal(mul(parseDecimal("1.5"), parseDecimal("2"))), "3.0000000000");
  });
  it("divides at 10dp", () => {
    assert.equal(formatDecimal(div(parseDecimal("1"), parseDecimal("3"))), "0.3333333333");
  });
  it("rounds half to even", () => {
    // 0.00000000005 * 1 rounds to even (…0), 0.00000000015 to …2.
    assert.equal(formatDecimal(div(parseDecimal("0.0000000001"), parseDecimal("2"))), "0.0000000000");
    assert.equal(formatDecimal(div(parseDecimal("0.0000000003"), parseDecimal("2"))), "0.0000000002");
  });
});

describe("decimal: ceilMulDiv rounds once off the exact product", () => {
  const d = (s: string) => parseDecimal(s);
  it("matches Daml PM.ceilMulDiv on the ratio-matched deposit cases", () => {
    // 1e-10 * 1e10 / 1000 = 0.001 exactly.
    assert.equal(formatDecimal(ceilMulDiv(d("0.0000000001"), d("10000000000"), d("1000"))), "0.0010000000");
    // Ceiling the quotient first would return 1e-10 * 1e10 = 1.0 here.
    assert.equal(formatDecimal(ceilMulDiv(d("0.0000000001"), d("1000000000000"), d("1000000000000"))), "0.0000000001");
    assert.equal(formatDecimal(ceilMulDiv(d("5"), d("200000"), d("10"))), "100000.0000000000");
  });
  it("rounds up, never below the exact value", () => {
    // 1/3 * 1 = 0.333… ceils to the next unit rather than truncating.
    assert.equal(formatDecimal(ceilMulDiv(d("1"), d("1"), d("3"))), "0.3333333334");
    assert.equal(formatDecimal(ceilMulDiv(d("1"), d("1"), d("4"))), "0.2500000000");
  });
  it("is zero when either factor is zero", () => {
    assert.equal(ceilMulDiv(0n, d("5"), d("2")), 0n);
    assert.equal(ceilMulDiv(d("5"), 0n, d("2")), 0n);
  });
});

describe("decimal: sqrt is exact-floor at any magnitude", () => {
  it("small perfect/again-rounded squares", () => {
    assert.equal(formatDecimal(sqrt(parseDecimal("4"))), "2.0000000000");
    // sqrt(2_000_000) = 1414.213562373095..., floored to 10dp.
    assert.equal(formatDecimal(sqrt(parseDecimal("2000000"))), "1414.2135623730");
  });

  it("large add (the #2 case) stays within the 1e-6 on-ledger dust bound", () => {
    // base*quote ≈ 1.22e29; a binary-float quote undershot the true root by
    // ~0.0106 here — far outside 1e-6. The bigint quote must be the exact
    // 10dp floor, i.e. within one 1e-10 ULP of the true root.
    const base = parseDecimal("123456789012345.1234567890");
    const quote = parseDecimal("987654321098765.9876543210");
    const product = mul(base, quote);
    const q = sqrt(product); // scaled-by-1e10 LP quote

    // q is the floor of the true root of `product` (scaled): q² <= product < (q+ULP)².
    // In scaled terms sqrt(product) := isqrt(product * SCALE); check the
    // floor property on that integer directly.
    const radicand = product * SCALE;
    assert.ok(q * q <= radicand, "q is at or below the true root");
    assert.ok((q + 1n) * (q + 1n) > radicand, "q is the exact floor (no precision loss)");

    // The shortfall from the true real root is at most one 10dp ULP (1e-10),
    // comfortably inside the 1e-6 dust the Daml settle allows.
    const ULP = 1n; // 1e-10 in scaled units
    const dust = SCALE / 1_000_000n; // 1e-6 in scaled units
    assert.ok(ULP <= dust, "ULP shortfall is within dust");
  });
});
