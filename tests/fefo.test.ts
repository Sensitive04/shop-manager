import { describe, expect, it } from 'vitest';

import { allocateFefo, nearestExpiry, sortBatchesByExpiry } from '@/lib/fefo';

/**
 * FEFO allocation is the one piece of inventory logic that must never be wrong:
 * an off-by-one here oversells a batch and corrupts the stock count. These cases
 * cover the boundaries that actually bite — partial fills across batches, empty
 * lots, expiry ties and non-integer requests.
 */

const day = (days: number) => new Date(Date.UTC(2026, 0, 1 + days));

const batches = [
  { id: 'late', expiryDate: day(300), quantity: 10 },
  { id: 'soon', expiryDate: day(30), quantity: 4 },
  { id: 'mid', expiryDate: day(120), quantity: 6 },
];

describe('allocateFefo', () => {
  it('takes from the soonest-expiring batch first', () => {
    const result = allocateFefo(batches, 3);

    expect(result.allocations).toEqual([{ batchId: 'soon', quantity: 3 }]);
    expect(result.allocated).toBe(3);
    expect(result.shortfall).toBe(0);
  });

  it('spills into the next batch once the first is exhausted', () => {
    const result = allocateFefo(batches, 7);

    expect(result.allocations).toEqual([
      { batchId: 'soon', quantity: 4 },
      { batchId: 'mid', quantity: 3 },
    ]);
    expect(result.shortfall).toBe(0);
  });

  it('reports a shortfall instead of silently over-allocating', () => {
    const result = allocateFefo(batches, 25);

    expect(result.allocated).toBe(20);
    expect(result.shortfall).toBe(5);
    // 4 + 6 + 10 = 20, and no allocation may exceed its own batch.
    expect(result.allocations.reduce((sum, a) => sum + a.quantity, 0)).toBe(20);
  });

  it('never allocates more than a single batch holds', () => {
    const result = allocateFefo(batches, 4);

    expect(result.allocations).toEqual([{ batchId: 'soon', quantity: 4 }]);
  });

  it('ignores empty and exhausted batches', () => {
    const withEmpty = [
      { id: 'empty-soon', expiryDate: day(10), quantity: 0 },
      { id: 'full', expiryDate: day(200), quantity: 3 },
    ];

    expect(allocateFefo(withEmpty, 2).allocations).toEqual([
      { batchId: 'full', quantity: 2 },
    ]);
  });

  it('breaks expiry ties by the caller’s ordering, so allocation is stable', () => {
    const tied = [
      { id: 'second-registered', expiryDate: day(60), quantity: 5 },
      { id: 'first-registered', expiryDate: day(60), quantity: 5 },
    ];

    expect(allocateFefo(tied, 1).allocations).toEqual([
      { batchId: 'second-registered', quantity: 1 },
    ]);
  });

  it('consumes an expired batch before a healthy one — expiry order wins', () => {
    const withExpired = [
      { id: 'expired', expiryDate: day(-5), quantity: 2 },
      { id: 'healthy', expiryDate: day(400), quantity: 2 },
    ];

    expect(allocateFefo(withExpired, 2).allocations).toEqual([
      { batchId: 'expired', quantity: 2 },
    ]);
  });

  it('floors a fractional request rather than selling part of a unit', () => {
    const result = allocateFefo(batches, 2.9);

    expect(result.allocated).toBe(2);
    expect(result.shortfall).toBe(0);
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])(
    'returns an empty allocation for a non-positive or non-finite request (%s)',
    (requested) => {
      const result = allocateFefo(batches, requested);

      expect(result.allocations).toEqual([]);
      expect(result.allocated).toBe(0);
      expect(result.shortfall).toBe(0);
    },
  );

  it('reports a full shortfall when there is no stock at all', () => {
    expect(allocateFefo([], 3)).toEqual({
      allocations: [],
      shortfall: 3,
      allocated: 0,
    });
  });
});

describe('sortBatchesByExpiry', () => {
  it('orders soonest first without mutating the input', () => {
    const input = [...batches];
    const sorted = sortBatchesByExpiry(input);

    expect(sorted.map((b) => b.id)).toEqual(['soon', 'mid', 'late']);
    expect(input.map((b) => b.id)).toEqual(['late', 'soon', 'mid']);
  });
});

describe('nearestExpiry', () => {
  it('returns the soonest expiry among batches that still hold stock', () => {
    expect(nearestExpiry(batches)).toEqual(day(30));
  });

  it('skips a spent soonest batch', () => {
    const spent = [{ id: 'spent', expiryDate: day(10), quantity: 0 }, ...batches];

    expect(nearestExpiry(spent)).toEqual(day(30));
  });

  it('returns null when nothing is in stock', () => {
    expect(nearestExpiry([{ id: 'empty', expiryDate: day(10), quantity: 0 }])).toBeNull();
  });
});