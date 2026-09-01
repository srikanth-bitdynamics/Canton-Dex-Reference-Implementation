import { describe, expect, it } from 'vitest';

import {
  assertSwapAuthority,
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

const swapAuthorityFixture = (): Parameters<typeof assertSwapAuthority>[0] => ({
  context: {
    operator: 'op::1',
    lpRegistrar: 'lp::1',
    admin: 'default-ad::1',
    network: 'local',
  },
  pool: {
    contractId: 'pool1234567890',
    baseInstrumentId: { admin: 'ad::1', id: 'Amulet' },
    quoteInstrumentId: { admin: 'ad::1', id: 'USDCx' },
  },
  swapper: 'alice::1220a',
  inputInstrumentId: { admin: 'ad::1', id: 'Amulet' },
  inputAmount: '0.1000000000',
  minOutputAmount: '18.0000000000',
  settlement: {
    executors: ['op::1'],
    id: 'DexPool',
    cid: 'pool1234567890',
    meta: { values: {} },
  },
  allocationSpecs: [
    {
      admin: 'ad::1',
      authorizer: { owner: 'alice::1220a', provider: null, id: '' },
      transferLegSides: [
        {
          transferLegId: 'swap-in',
          side: 'SenderSide',
          otherside: { owner: 'op::1', provider: null, id: '' },
          amount: '0.1000000000',
          instrumentId: 'Amulet',
          meta: { values: {} },
        },
        {
          transferLegId: 'swap-out-0',
          side: 'ReceiverSide',
          otherside: { owner: 'op::1', provider: null, id: '' },
          amount: '19.0000000000',
          instrumentId: 'USDCx',
          meta: { values: {} },
        },
      ],
      settlementDeadline: null,
      nextIterationFunding: null,
      committed: false,
      meta: { values: {} },
    },
  ],
  quoteBinding: {
    expectedPoolId: 'Amulet-USDCx',
    poolStateCid: '#state:0' as never,
    inputSliceCid: '#base:0' as never,
    outputSliceCids: ['#quote:0' as never],
    minOutputAmount: '18.0000000000',
  },
});

// A cross-admin swap: Amulet@cc-admin in, USDCx@usdc-admin out. The swap-in
// sender leg sits on the input-admin spec, the swap-out receiver on the
// output-admin spec.
const crossAdminSwapFixture = (): Parameters<typeof assertSwapAuthority>[0] => {
  const f = swapAuthorityFixture();
  f.pool.baseInstrumentId = { admin: 'cc-admin', id: 'Amulet' };
  f.pool.quoteInstrumentId = { admin: 'usdc-admin', id: 'USDCx' };
  f.inputInstrumentId = { admin: 'cc-admin', id: 'Amulet' };
  const authorizer = { owner: 'alice::1220a', provider: null, id: '' };
  const meta = { values: {} };
  f.allocationSpecs = [
    {
      admin: 'cc-admin',
      authorizer,
      transferLegSides: [
        {
          transferLegId: 'swap-in',
          side: 'SenderSide',
          otherside: { owner: 'op::1', provider: null, id: '' },
          amount: '0.1000000000',
          instrumentId: 'Amulet',
          meta,
        },
      ],
      settlementDeadline: null,
      nextIterationFunding: null,
      committed: false,
      meta,
    },
    {
      admin: 'usdc-admin',
      authorizer,
      transferLegSides: [
        {
          transferLegId: 'swap-out-0',
          side: 'ReceiverSide',
          otherside: { owner: 'op::1', provider: null, id: '' },
          amount: '19.0000000000',
          instrumentId: 'USDCx',
          meta,
        },
      ],
      settlementDeadline: null,
      nextIterationFunding: null,
      committed: false,
      meta,
    },
  ];
  return f;
};

describe('swap authority validation', () => {
  it('accepts an exact terminal input/output allocation', () => {
    expect(() => assertSwapAuthority(swapAuthorityFixture())).not.toThrow();
  });

  it('accepts a cross-admin pair of input + output specs', () => {
    expect(() => assertSwapAuthority(crossAdminSwapFixture())).not.toThrow();
  });

  it('decides side by full identity when base and quote share a symbol', () => {
    // A pool of USD@admin-a / USD@admin-b: a bare-symbol side decision cannot
    // tell them apart, so the swap must key side on the full {admin, id}.
    const f = crossAdminSwapFixture();
    f.pool.baseInstrumentId = { admin: 'admin-a', id: 'USD' };
    f.pool.quoteInstrumentId = { admin: 'admin-b', id: 'USD' };
    // Swap the quote (USD@admin-b) in for the base (USD@admin-a) out.
    f.inputInstrumentId = { admin: 'admin-b', id: 'USD' };
    const authorizer = { owner: 'alice::1220a', provider: null, id: '' };
    const meta = { values: {} };
    f.allocationSpecs = [
      {
        admin: 'admin-b',
        authorizer,
        transferLegSides: [
          {
            transferLegId: 'swap-in',
            side: 'SenderSide',
            otherside: { owner: 'op::1', provider: null, id: '' },
            amount: '0.1000000000',
            instrumentId: 'USD',
            meta,
          },
        ],
        settlementDeadline: null,
        nextIterationFunding: null,
        committed: false,
        meta,
      },
      {
        admin: 'admin-a',
        authorizer,
        transferLegSides: [
          {
            transferLegId: 'swap-out-0',
            side: 'ReceiverSide',
            otherside: { owner: 'op::1', provider: null, id: '' },
            amount: '19.0000000000',
            instrumentId: 'USD',
            meta,
          },
        ],
        settlementDeadline: null,
        nextIterationFunding: null,
        committed: false,
        meta,
      },
    ];
    expect(() => assertSwapAuthority(f)).not.toThrow();
  });

  it('rejects a cross-admin output leg under the wrong admin', () => {
    const fixture = crossAdminSwapFixture();
    // Move the swap-out receiver onto the input-admin spec: the output admin
    // then carries no receiver leg.
    fixture.allocationSpecs[0]!.transferLegSides.push(
      fixture.allocationSpecs[1]!.transferLegSides[0]!,
    );
    fixture.allocationSpecs[1]!.transferLegSides = [];
    expect(() => assertSwapAuthority(fixture)).toThrow(/output legs|unsupported allocation leg/);
  });

  it('rejects output below the trader minimum before wallet signing', () => {
    const fixture = swapAuthorityFixture();
    fixture.allocationSpecs[0]!.transferLegSides[1]!.amount = '17.9999999999';
    expect(() => assertSwapAuthority(fixture)).toThrow(/below the requested slippage minimum/);
  });

  it('rejects changed input, settlement, or allocation authority', () => {
    const changedInput = swapAuthorityFixture();
    changedInput.allocationSpecs[0]!.transferLegSides[0]!.amount = '0.2000000000';
    expect(() => assertSwapAuthority(changedInput)).toThrow(/allocation input/);

    const changedSettlement = swapAuthorityFixture();
    changedSettlement.settlement.executors = ['other::1'];
    expect(() => assertSwapAuthority(changedSettlement)).toThrow(/settlement descriptor/);

    const committed = swapAuthorityFixture();
    committed.allocationSpecs[0]!.committed = true;
    expect(() => assertSwapAuthority(committed)).toThrow(/allocation authority/);
  });
});

describe('ledger helpers', () => {
  it('formats decimals to Canton Numeric 10 wire shape', () => {
    expect(formatDecimal10(290.367100031662)).toBe('290.3671000317');
    expect(formatDecimal10(100)).toBe('100.0000000000');
  });

  it('picks an exact unlocked holding subset for swaps', () => {
    const holdings = [
      holding('h1', 'USDCx', 1000),
      holding('h2', 'USDCx', 12000),
      holding('h3', 'USDCx', 250),
      holding('h4', 'Amulet', 1),
      holding('h5', 'USDCx', 750, true),
    ];
    expect(pickExactHoldingCids(holdings, 'USDCx', 250)).toEqual(['h3']);
    expect(pickExactHoldingCids(holdings, 'USDCx', 1250)).toEqual(['h3', 'h1']);
  });

  it('filters funding helpers by instrument admin when requested', () => {
    const holdings = [
      holding('h1', 'Amulet-USDCx-LP', 100, false, 'lp-admin-a'),
      holding('h2', 'Amulet-USDCx-LP', 100, false, 'lp-admin-b'),
    ];
    expect(pickExactHoldingCids(holdings, 'Amulet-USDCx-LP', 100, 'lp-admin-b')).toEqual([
      'h2',
    ]);
    expect(planSwapFunding(holdings, 'Amulet-USDCx-LP', 150, 'lp-admin-b')).toEqual({
      kind: 'insufficient',
    });
  });

  it('exact picker returns null when no subset sums to the target', () => {
    const holdings = [
      holding('h1', 'USDCx', 1000),
      holding('h2', 'USDCx', 12000),
    ];
    expect(pickExactHoldingCids(holdings, 'USDCx', 100)).toBeNull();
  });

  it('covering picker locks a single smallest covering holding', () => {
    const holdings = [
      holding('h1', 'USDCx', 1000),
      holding('h2', 'USDCx', 12000),
      holding('h3', 'USDCx', 250),
      holding('h4', 'USDCx', 750, true), // locked, ineligible
    ];
    // 100 fits inside h3 (250) — the smallest single holding that covers it.
    expect(pickCoveringHoldingCids(holdings, 'USDCx', 100)).toEqual(['h3']);
  });

  it('covering picker accumulates largest-first when no single holding covers', () => {
    const holdings = [holding('h1', 'Amulet', 0.07), holding('h2', 'Amulet', 0.08)];
    // No single holding covers 0.10; lock both (largest-first), surplus returns
    // as change at settle.
    expect(pickCoveringHoldingCids(holdings, 'Amulet', 0.1)).toEqual(['h2', 'h1']);
  });

  it('covering picker returns null when the total balance is insufficient', () => {
    const holdings = [holding('h1', 'Amulet', 0.03), holding('h2', 'Amulet', 0.04)];
    expect(pickCoveringHoldingCids(holdings, 'Amulet', 0.1)).toBeNull();
  });

  it('plans a split when one unlocked holding covers the target with change', () => {
    const holdings = [
      holding('h1', 'Amulet', 0.3019881945),
      holding('h2', 'Amulet', 0.0329594949),
    ];
    expect(planSwapFunding(holdings, 'Amulet', 0.1)).toEqual({
      kind: 'split',
      sourceHoldingCid: 'h1',
      splitAmount: '0.1000000000',
    });
  });

  it('plans an LP split for partial removals from a single LP holding', () => {
    const holdings = [holding('lp1', 'Amulet-USDCx-LP', 219.0890230021, false, 'lp-admin')];
    expect(planSwapFunding(holdings, 'Amulet-USDCx-LP', '109.5445115011', 'lp-admin')).toEqual(
      {
        kind: 'split',
        sourceHoldingCid: 'lp1',
        splitAmount: '109.5445115011',
      },
    );
  });

  it('plans merge-then-split when fragmented holdings cover the target but no exact subset exists', () => {
    const holdings = [
      holding('h1', 'Amulet', 0.07),
      holding('h2', 'Amulet', 0.08),
      holding('h3', 'Amulet', 0.01),
    ];
    expect(planSwapFunding(holdings, 'Amulet', 0.1)).toEqual({
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
    // Scientific notation must be expanded before conversion to fixed-point.
    expect(() => formatDecimal10(1e21)).not.toThrow();
    expect(formatDecimal10(1e21)).toBe('1000000000000000000000.0000000000');
    expect(formatDecimal10(100)).toBe('100.0000000000');
  });

  it('pickExactHoldingCids round-trips a precise decimal string target', () => {
    const holdings = [
      holding('h1', 'USDCx', 0, false), // amount float ignored when amountRaw set
    ];
    // amountRaw preserves wire precision; the float `amount` is lossy.
    holdings[0]!.amountRaw = '123.4567890123';
    expect(
      pickExactHoldingCids(holdings, 'USDCx', '123.4567890123'),
    ).toEqual(['h1']);
  });

  it('selects funding for very large holdings without overflow', () => {
    const holdings = [holding('big', 'USDCx', 0, false)];
    holdings[0]!.amountRaw = '1000000000000000000000.0000000000'; // 1e21
    expect(
      pickExactHoldingCids(holdings, 'USDCx', '1000000000000000000000'),
    ).toEqual(['big']);
  });
});
