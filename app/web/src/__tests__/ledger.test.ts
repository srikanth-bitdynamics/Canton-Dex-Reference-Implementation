import { describe, expect, it } from 'vitest';

import { formatDecimal10, pickExactHoldingCids } from '@/services/ledger';
import type { Holding } from '@/types/contracts';

const holding = (
  contractId: string,
  instrumentId: string,
  amount: number,
  locked = false,
): Holding => ({
  contractId,
  owner: 'alice',
  admin: 'dex-admin',
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

  it('refuses non-exact swap funding rather than over-locking holdings', () => {
    const holdings = [
      holding('h1', 'USDC', 1000),
      holding('h2', 'USDC', 12000),
    ];
    expect(pickExactHoldingCids(holdings, 'USDC', 100)).toBeNull();
  });
});
