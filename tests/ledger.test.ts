import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { disconnectFromDatabase } from '@/lib/db';
import { recordTransaction, summarize } from '@/lib/services/ledger';
import { checkout } from '@/lib/services/sales';
import { createProduct } from '@/lib/services/products';
import { endOfDay, parseLocalDate, startOfDay, toDateInputValue } from '@/lib/dates';
import { transactionQuerySchema } from '@/lib/validators';
import { FinancialTransaction } from '@/models/FinancialTransaction';
import { Sale } from '@/models/Sale';
import { Product } from '@/models/Product';
import { StockMovement } from '@/models/StockMovement';

/**
 * Ledger integration tests.
 *
 * Runs against the same in-process replica set the inventory suite uses, because
 * the bug this guards was a *reporting* bug: a `to` date of 31 January was parsed
 * as UTC midnight and then widened with `setHours(23, 59, …)`, which lands on
 * 30 January in any negative-offset timezone. A shop filtering its ledger to
 * "this month" would silently lose the last day. Unit tests can prove the helper
 * is right; only a real query proves the filter is wired to it.
 */

/** Parse a query the way the route does, so the test covers the real path. */
function parseRange(search: Record<string, string>) {
  return transactionQuerySchema.parse(search);
}

async function clearAll() {
  await Promise.all([
    Product.deleteMany({}),
    Sale.deleteMany({}),
    StockMovement.deleteMany({}),
    FinancialTransaction.deleteMany({}),
  ]);
}

/** A local wall-clock instant on the given calendar day. */
function at(day: Date, hours: number, minutes = 0): Date {
  const date = new Date(day);
  date.setHours(hours, minutes, 0, 0);
  return date;
}

beforeAll(async () => {
  const { connectToDatabase } = await import('@/lib/db');
  await connectToDatabase();
});

afterAll(async () => {
  await disconnectFromDatabase();
});

beforeEach(async () => {
  await clearAll();
});

describe('ledger period filters', () => {
  it('includes an entry recorded late on the final day of the range', async () => {
    const day = new Date();
    const dayOnly = toDateInputValue(day);

    await recordTransaction({
      type: 'outcome',
      amount: 42,
      category: 'Rent',
      paymentMethod: 'Cash',
      // 23:30 local — the entry that a UTC-midnight `to` bound used to drop.
      occurredAt: at(day, 23, 30),
    });

    const { from, to } = parseRange({ from: dayOnly, to: dayOnly });
    const summary = await summarize({ from, to });

    expect(summary.outcome).toBe(42);
    expect(summary.count).toBe(1);
  });

  it('excludes entries outside the range', async () => {
    const day = new Date();
    const yesterday = toDateInputValue(new Date(day.getTime() - 24 * 60 * 60 * 1000));
    const dayOnly = toDateInputValue(day);

    await recordTransaction({
      type: 'outcome',
      amount: 10,
      category: 'Utilities',
      paymentMethod: 'Cash',
      occurredAt: at(new Date(day.getTime() - 24 * 60 * 60 * 1000), 12),
    });
    await recordTransaction({
      type: 'outcome',
      amount: 20,
      category: 'Rent',
      paymentMethod: 'Cash',
      occurredAt: at(day, 12),
    });

    const inside = await summarize(parseRange({ from: dayOnly, to: dayOnly }));
    expect(inside.outcome).toBe(20);
    expect(inside.count).toBe(1);

    const spanning = await summarize(parseRange({ from: yesterday, to: dayOnly }));
    expect(spanning.outcome).toBe(30);
    expect(spanning.count).toBe(2);
  });

  it('keeps the whole of the first day too, not just the current instant', async () => {
    const day = new Date();
    const dayOnly = toDateInputValue(day);

    await recordTransaction({
      type: 'income',
      amount: 15,
      category: 'Sales',
      paymentMethod: 'Cash',
      occurredAt: at(day, 0, 5),
    });

    const summary = await summarize(parseRange({ from: dayOnly, to: dayOnly }));

    expect(summary.income).toBe(15);
  });

  it('separates income from outcome in the same period', async () => {
    const day = new Date();
    const dayOnly = toDateInputValue(day);

    await recordTransaction({
      type: 'outcome',
      amount: 100,
      category: 'Rent',
      paymentMethod: 'Bank Transfer',
      occurredAt: at(day, 9),
    });
    await recordTransaction({
      type: 'income',
      amount: 250,
      category: 'Sales',
      paymentMethod: 'Cash',
      occurredAt: at(day, 10),
    });

    const summary = await summarize(parseRange({ from: dayOnly, to: dayOnly }));

    expect(summary.income).toBe(250);
    expect(summary.outcome).toBe(100);
    expect(summary.net).toBe(150);
    expect(summary.byCategory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'Rent', total: 100 }),
        expect.objectContaining({ category: 'Sales', total: 250 }),
      ]),
    );
  });

  it('returns zeroes rather than throwing when nothing matches', async () => {
    const summary = await summarize(parseRange({ from: '1990-01-01', to: '1990-01-31' }));

    expect(summary.income).toBe(0);
    expect(summary.outcome).toBe(0);
    expect(summary.net).toBe(0);
    expect(summary.count).toBe(0);
  });

  it('bounds a single day exactly, hour by hour', async () => {
    const day = parseLocalDate('2026-03-15') as Date;
    const { from, to } = parseRange({ from: '2026-03-15', to: '2026-03-15' });

    // The widened bounds must still describe one whole local day.
    expect(startOfDay(from as Date).toDateString()).toBe(endOfDay(to as Date).toDateString());
    expect(day.getDate()).toBe(15);

    await recordTransaction({
      type: 'outcome',
      amount: 7,
      category: 'Packaging',
      paymentMethod: 'Cash',
      occurredAt: at(day, 23, 59),
    });

    const summary = await summarize({ from, to });
    expect(summary.count).toBe(1);
  });
});

describe('ledger integrity', () => {
  it('rejects Sales as a manual outcome', async () => {
    await expect(
      recordTransaction({
        type: 'outcome',
        amount: 10,
        category: 'Sales',
        paymentMethod: 'Cash',
      }),
    ).rejects.toThrow();
  });

  it('rejects an outcome as a manual income', async () => {
    await expect(
      recordTransaction({
        type: 'income',
        amount: 10,
        category: 'Rent',
        paymentMethod: 'Cash',
      }),
    ).rejects.toThrow();
  });

  it('logs POS income automatically so the till and the ledger agree', async () => {
    const product = await createProduct({
      name: 'Ledger Serum',
      sku: 'LDG-001',
      category: 'Serum',
      sellingPrice: 30,
      minStockAlert: 1,
      batches: [
        {
          batchNumber: 'B1',
          expiryDate: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
          costPrice: 10,
          quantity: 5,
          supplier: 'Supplier',
        },
      ],
    });

    const result = await checkout({
      items: [{ productId: product.id, quantity: 2 }],
      paymentMethod: 'Cash',
    });

    const rows = await FinancialTransaction.find({ sale: result.saleId }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe('income');
    expect(rows[0]?.category).toBe('Sales');
    expect(rows[0]?.amount).toBe(60);

    const summary = await summarize({});
    expect(summary.income).toBe(60);
    expect(summary.net).toBe(60);
  });

  it('records a zero-value sale for a fully discounted basket', async () => {
    const product = await createProduct({
      name: 'Clearance Cream',
      sku: 'CLR-001',
      category: 'Moisturizer',
      sellingPrice: 20,
      minStockAlert: 0,
      batches: [
        {
          batchNumber: 'B1',
          expiryDate: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
          costPrice: 5,
          quantity: 3,
          supplier: 'Supplier',
        },
      ],
    });

    const result = await checkout({
      items: [{ productId: product.id, quantity: 1 }],
      discountType: 'percent',
      discountValue: 100,
      paymentMethod: 'Cash',
    });

    expect(result.total).toBe(0);

    const summary = await summarize({});
    expect(summary.income).toBe(0);
    expect(summary.count).toBe(1);
  });
});
