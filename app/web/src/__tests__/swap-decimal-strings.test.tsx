// The operator backend serves swap amounts as exact decimal strings, never
// numbers. Handing one straight to a display helper fails two ways, and only
// one of them is loud: `.toFixed` throws, while `toLocaleString` quietly
// returns the raw string because String carries that method too. Both were
// live — the Portfolio page threw, the Trade page showed 10 dp where it asked
// for 4. Parse at the boundary.

import { describe, it, expect } from 'vitest';

import { fmt } from '@/primitives/format';

describe('decimal strings must be parsed before formatting', () => {
  it('fmt ignores its digit options when handed a string', () => {
    const raw = '0.0500000000';
    expect(fmt(raw as unknown as number, 4)).toBe(raw);
    expect(fmt(Number(raw), 4)).toBe('0.0500');
  });

  it('a parsed amount formats to the requested precision', () => {
    expect(fmt(Number('4369.7442973800'))).toBe('4,369.74');
  });

  it('a malformed amount degrades to a dash rather than NaN', () => {
    expect(fmt(Number('not-a-decimal'))).toBe('–');
  });
});
