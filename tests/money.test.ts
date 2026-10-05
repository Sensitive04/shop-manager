import { describe, expect, it } from 'vitest';

import {
  formatMoney,
  fromCents,
  multiplyCents,
  roundMoney,
  sumCents,
  toCents,
} from '@/lib/money';

/**
 * These helpers exist because float arithmetic in a retail ledger produces totals
 * that are a cent out and impossible to explain. The tests pin the rounding
 * behaviour that makes the totals exact.
 */

describe('toCents / fromCents', () => {
  it.each([
    [0, 0],
    [12.5, 1250],
    [0.01, 1],
    [19.99, 1999],
    [-4.25, -425],
  ])('converts %s to %s cents', (amount, cents) => {
    expect(toCents(amount)).toBe(cents);
  });

  it('round-trips', () => {
    expect(fromCents(toCents(123.45))).toBe(123.45);
  });
});

describe('roundMoney', () => {
  it('avoids the float artefact that breaks naive toFixed', () => {
    // 1.005 is really 1.00499999... in binary, so toFixed(2) gives "1.00".
    expect((1.005).toFixed(2)).toBe('1.00');
    expect(roundMoney(1.005)).toBe(1.01);
  });

  it.each([
    [2.675, 2.68],
    [1.0049999, 1.0],
    [0.005, 0.01],
    [0.1 + 0.2, 0.3],
    // Ties round half up, toward positive infinity — the same direction
    // Math.round uses, and the same direction multiplyCents uses.
    [-1.005, -1.0],
  ])('rounds %s to %s', (input, expected) => {
    expect(roundMoney(input)).toBe(expected);
  });
});

describe('multiplyCents', () => {
  it('applies a percentage discount in integer space', () => {
    // 33% off a $43.30 subtotal is $14.29, not $14.289.
    expect(multiplyCents(4330, 0.33)).toBe(1429);
  });

  it('rounds a repeating factor half-up', () => {
    expect(multiplyCents(1000, 0.005)).toBe(5);
    expect(multiplyCents(333, 1 / 3)).toBe(111);
  });
});

describe('sumCents', () => {
  it('stays exact where naive float addition drifts', () => {
    const naive = [0.1, 0.2, 0.3].reduce((a, b) => a + b, 0);
    expect(naive).not.toBe(0.3);

    expect(fromCents(sumCents([10, 20, 30]))).toBe(0.6);
  });

  it('returns 0 for an empty list', () => {
    expect(sumCents([])).toBe(0);
  });
});

describe('formatMoney', () => {
  it('formats as currency with two decimals', () => {
    expect(formatMoney(1234.5)).toBe('$1,234.50');
  });

  it('rounds before formatting, so the display matches the stored total', () => {
    expect(formatMoney(1.005)).toBe('$1.01');
  });

  it('honours the currency code', () => {
    expect(formatMoney(10, 'EUR')).toBe('€10.00');
  });
});