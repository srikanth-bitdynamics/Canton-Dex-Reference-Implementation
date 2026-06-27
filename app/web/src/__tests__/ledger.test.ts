import { describe, expect, it } from 'vitest';

import {
  formatDecimal,
  formatDecimal10,
  pickCoveringHoldingCids,
  pickExactHoldingCids,
  planSwapFunding,
} from '@/services/ledger';
import type { Holding } from '@/types/contracts';

const holding = (
  contractId: string,
  instrumentId: string,
  amount: number,
  locked = false,
  admin = 'dex-admin',
): Holding => ({
  contractId,
  owner: 'alice',
  admin,
  instrumentId,
  amount,
  locked,
});

describe('ledger helpers', () => {
  it('formats decimals to Canton Numeric 10 wire shape', () => {
    expect(formatDecimal10(290.367100031662)).toBe('290.3671000317');
    expect(formatDecimal10(100)).toBe('100.0000000000');
  });

  it('picks an exact unlocked holding subset for swaps', () => {
    const holdings = [
      holding('h1', 'USDC', 1000),
      holding('h2', 'USDC', 12000),
      holding('h3', 'USDC', 250),
      holding('h4', 'BTC', 1),
      holding('h5', 'USDC', 750, true),
    ];
    expect(pickExactHoldingCids(holdings, 'USDC', 250)).toEqual(['h3']);
    expect(pickExactHoldingCids(holdings, 'USDC', 1250)).toEqual(['h3', 'h1']);
  });

  it('filters funding helpers by instrument admin when requested', () => {
    const holdings = [
      holding('h1', 'BTC-USDC-LP', 100, false, 'lp-admin-a'),
      holding('h2', 'BTC-USDC-LP', 100, false, 'lp-admin-b'),
    ];
    expect(pickExactHoldingCids(holdings, 'BTC-USDC-LP', 100, 'lp-admin-b')).toEqual([
      'h2',
    ]);
    expect(planSwapFunding(holdings, 'BTC-USDC-LP', 150, 'lp-admin-b')).toEqual({
      kind: 'insufficient',
    });
  });

  it('exact picker returns null when no subset sums to the target', () => {
    const holdings = [
      holding('h1', 'USDC', 1000),
      holding('h2', 'USDC', 12000),
    ];
    expect(pickExactHoldingCids(holdings, 'USDC', 100)).toBeNull();
  });

  it('covering picker locks a single smallest covering holding', () => {
    const holdings = [
      holding('h1', 'USDC', 1000),
      holding('h2', 'USDC', 12000),
      holding('h3', 'USDC', 250),
      holding('h4', 'USDC', 750, true), // locked, ineligible
    ];
    // 100 fits inside h3 (250) — the smallest single holding that covers it.
    expect(pickCoveringHoldingCids(holdings, 'USDC', 100)).toEqual(['h3']);
  });

  it('covering picker accumulates largest-first when no single holding covers', () => {
    const holdings = [holding('h1', 'BTC', 0.07), holding('h2', 'BTC', 0.08)];
    // No single holding covers 0.10; lock both (largest-first), surplus returns
    // as change at settle.
    expect(pickCoveringHoldingCids(holdings, 'BTC', 0.1)).toEqual(['h2', 'h1']);
  });

  it('covering picker returns null when the total balance is insufficient', () => {
    const holdings = [holding('h1', 'BTC', 0.03), holding('h2', 'BTC', 0.04)];
    expect(pickCoveringHoldingCids(holdings, 'BTC', 0.1)).toBeNull();
  });

  it('plans a split when one unlocked holding covers the target with change', () => {
    const holdings = [
      holding('h1', 'BTC', 0.3019881945),
      holding('h2', 'BTC', 0.0329594949),
    ];
    expect(planSwapFunding(holdings, 'BTC', 0.1)).toEqual({
      kind: 'split',
      sourceHoldingCid: 'h1',
      splitAmount: '0.1000000000',
    });
  });

  it('plans an LP split for partial removals from a single LP holding', () => {
    const holdings = [holding('lp1', 'BTC-USDC-LP', 219.0890230021, false, 'lp-admin')];
    expect(planSwapFunding(holdings, 'BTC-USDC-LP', '109.5445115011', 'lp-admin')).toEqual(
      {
        kind: 'split',
        sourceHoldingCid: 'lp1',
        splitAmount: '109.5445115011',
      },
    );
  });

  it('plans merge-then-split when fragmented holdings cover the target but no exact subset exists', () => {
    const holdings = [
      holding('h1', 'BTC', 0.07),
      holding('h2', 'BTC', 0.08),
      holding('h3', 'BTC', 0.01),
    ];
    expect(planSwapFunding(holdings, 'BTC', 0.1)).toEqual({
      kind: 'merge-then-split',
      primaryHoldingCid: 'h2',
      otherHoldingCids: ['h1'],
      splitAmount: '0.1000000000',
    });
  });
});

describe('decimal formatting', () => {
  it('formatDecimal never emits scientific notation', () => {
    // Plain numbers pass through untouched.
    expect(formatDecimal(1.5)).toBe('1.5');
    expect(formatDecimal(0)).toBe('0');
    // Large magnitude that String() would render as 1e+21.
    expect(String(1e21)).toMatch(/e/i);
    expect(formatDecimal(1e21)).toBe('1000000000000000000000');
    expect(formatDecimal(1.23e21)).toBe('1230000000000000000000');
    // Small magnitude that String() would render as 1e-7.
    expect(String(1e-7)).toMatch(/e/i);
    expect(formatDecimal(1e-7)).toBe('0.0000001');
    // Negative large magnitude.
    expect(formatDecimal(-1e21)).toBe('-1000000000000000000000');
  });

  it('formatDecimal rejects non-finite amounts', () => {
    expect(() => formatDecimal(NaN)).toThrow();
    expect(() => formatDecimal(Infinity)).toThrow();
  });

  it('formatDecimal10 does not crash at or above 1e21', () => {
    // Previously decimal10Units(value) threw because toFixed/String emitted
    // scientific notation that BigInt() rejected.
    expect(() => formatDecimal10(1e21)).not.toThrow();
    expect(formatDecimal10(1e21)).toBe('1000000000000000000000.0000000000');
    expect(formatDecimal10(100)).toBe('100.0000000000');
  });

  it('pickExactHoldingCids round-trips a precise decimal string target', () => {
    const holdings = [
      holding('h1', 'USDC', 0, false), // amount float ignored when amountRaw set
    ];
    // amountRaw preserves wire precision; the float `amount` is lossy.
    holdings[0]!.amountRaw = '123.4567890123';
    expect(
      pickExactHoldingCids(holdings, 'USDC', '123.4567890123'),
    ).toEqual(['h1']);
  });

  it('selects funding for very large holdings without overflow', () => {
    const holdings = [holding('big', 'USDC', 0, false)];
    holdings[0]!.amountRaw = '1000000000000000000000.0000000000'; // 1e21
    expect(
      pickExactHoldingCids(holdings, 'USDC', '1000000000000000000000'),
    ).toEqual(['big']);
  });
});
