import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { disconnectFromDatabase } from '@/lib/db';
import { checkout } from '@/lib/services/sales';
import { createProduct } from '@/lib/services/products';
import { adjustStock, stockIn, stockOut } from '@/lib/services/inventory';
import { FinancialTransaction } from '@/models/FinancialTransaction';
import { Product } from '@/models/Product';
import { Sale } from '@/models/Sale';
import { StockMovement } from '@/models/StockMovement';
import { addDays } from '@/lib/dates';
import { toCents } from '@/lib/money';

/**
 * Inventory and checkout integration tests.
 *
 * These run against a real single-node replica set (started by lib/db.ts via
 * mongodb-memory-server) rather than a mock, because the behaviour under test —
 * transactional all-or-nothing checkout and FEFO across several writes — only
 * exists in a real database.
 */

const COSTS = { soon: 8, later: 10 };

async function clearAll() {
  await Promise.all([
    Product.deleteMany({}),
    Sale.deleteMany({}),
    StockMovement.deleteMany({}),
    FinancialTransaction.deleteMany({}),
  ]);
}

/** Two batches of one product: a near-expiry lot and a long-dated one. */
async function makeProduct(overrides: { sellingPrice?: number } = {}) {
  return createProduct({
    name: 'Test Serum',
    sku: 'TST-SER-001',
    category: 'Serum',
    sellingPrice: overrides.sellingPrice ?? 20,
    minStockAlert: 3,
    batches: [
      {
        batchNumber: 'SOON',
        expiryDate: addDays(new Date(), 20),
        costPrice: COSTS.soon,
        quantity: 4,
        supplier: 'Supplier',
      },
      {
        batchNumber: 'LATER',
        expiryDate: addDays(new Date(), 200),
        costPrice: COSTS.later,
        quantity: 6,
        supplier: 'Supplier',
      },
    ],
  });
}

beforeAll(async () => {
  // lib/db.ts boots the replica set on first connect.
  const { connectToDatabase, supportsTransactions } = await import('@/lib/db');
  await connectToDatabase();
  // A checkout that silently loses atomicity is worse than a failing suite.
  expect(await supportsTransactions()).toBe(true);
});

afterAll(async () => {
  await disconnectFromDatabase();
});

beforeEach(async () => {
  await clearAll();
});

describe('stock movements', () => {
  it('keeps the denormalised total equal to the sum of the batches', async () => {
    const product = await makeProduct();

    const stored = await Product.findById(product.id).lean();
    const batchSum = (stored?.batches ?? []).reduce((sum, b) => sum + b.quantity, 0);

    expect(stored?.stockQuantity).toBe(10);
    expect(stored?.stockQuantity).toBe(batchSum);
  });

  it('writes an audit row for every stock-in and stock-out', async () => {
    const product = await makeProduct();

    // Opening stock already produced two rows (one per batch).
    expect(await StockMovement.countDocuments({ product: product.id })).toBe(2);

    await stockIn({
      productId: product.id,
      batchNumber: 'THIRD',
      expiryDate: addDays(new Date(), 300),
      costPrice: 9,
      quantity: 5,
      supplier: 'Supplier',
    });
    await stockOut({ productId: product.id, quantity: 3 });

    const movements = await StockMovement.find({ product: product.id })
      .sort({ occurredAt: 1, createdAt: 1 })
      .lean();

    expect(movements.map((m) => m.type)).toEqual([
      'stock-in',
      'stock-in',
      'stock-in',
      'stock-out',
    ]);
    // Signed: an outbound movement is negative so the trail is self-summing.
    expect(movements.at(-1)?.quantity).toBe(-3);
  });

  it('consumes the soonest-expiring batch first', async () => {
    const product = await makeProduct();

    await stockOut({ productId: product.id, quantity: 3 });

    const stored = await Product.findById(product.id).lean();
    const byBatchNumber = new Map(
      (stored?.batches ?? []).map((b) => [b.batchNumber, b.quantity]),
    );

    expect(byBatchNumber.get('SOON')).toBe(1);
    expect(byBatchNumber.get('LATER')).toBe(6);
    expect(stored?.stockQuantity).toBe(7);
  });

  it('spills a stock-out across batches when the first runs out', async () => {
    const product = await makeProduct();

    await stockOut({ productId: product.id, quantity: 6 });

    const stored = await Product.findById(product.id).lean();
    const byBatchNumber = new Map(
      (stored?.batches ?? []).map((b) => [b.batchNumber, b.quantity]),
    );

    expect(byBatchNumber.get('SOON')).toBe(0);
    expect(byBatchNumber.get('LATER')).toBe(4);
    expect(stored?.stockQuantity).toBe(4);
  });

  it('refuses a stock-out larger than the total on hand, changing nothing', async () => {
    const product = await makeProduct();

    await expect(stockOut({ productId: product.id, quantity: 11 })).rejects.toMatchObject({
      code: 'INSUFFICIENT_STOCK',
    });

    const stored = await Product.findById(product.id).lean();
    expect(stored?.stockQuantity).toBe(10);
  });

  it('requires an expiry date and cost price when stock is added back', async () => {
    const product = await makeProduct();

    await expect(adjustStock({ productId: product.id, quantity: 2 })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });

    // A bare correction with no lot would break the batch-sum invariant.
    expect((await Product.findById(product.id).lean())?.stockQuantity).toBe(10);
  });

  it('adds corrected stock back as its own lot, preserving the invariant', async () => {
    const product = await makeProduct();

    await adjustStock({
      productId: product.id,
      quantity: 3,
      expiryDate: addDays(new Date(), 365),
      costPrice: 11,
      reason: 'Stocktake surplus',
    });

    const stored = await Product.findById(product.id).lean();
    const batchSum = (stored?.batches ?? []).reduce((sum, b) => sum + b.quantity, 0);

    expect(stored?.stockQuantity).toBe(13);
    expect(stored?.stockQuantity).toBe(batchSum);
    expect(stored?.batches).toHaveLength(3);
  });

  it('routes a negative adjustment through FEFO', async () => {
    const product = await makeProduct();

    await adjustStock({ productId: product.id, quantity: -2, reason: 'Damaged' });

    const stored = await Product.findById(product.id).lean();
    const soon = stored?.batches.find((b) => b.batchNumber === 'SOON');

    expect(soon?.quantity).toBe(2);
    expect(stored?.stockQuantity).toBe(8);
  });
});

describe('checkout', () => {
  it('deducts stock, records the sale and books the income in one go', async () => {
    const product = await makeProduct({ sellingPrice: 25 });

    const result = await checkout({
      items: [{ productId: product.id, quantity: 2 }],
      paymentMethod: 'Cash',
    });

    expect(result.total).toBe(50);
    expect(result.totalCost).toBe(COSTS.soon * 2);
    expect(result.grossProfit).toBe(50 - COSTS.soon * 2);
    expect(result.atomic).toBe(true);

    const stored = await Product.findById(product.id).lean();
    expect(stored?.stockQuantity).toBe(8);

    const sale = await Sale.findById(result.saleId).lean();
    expect(sale?.total).toBe(50);
    expect(sale?.items).toHaveLength(1);
    expect(sale?.items[0]?.batches?.[0]?.batchNumber).toBe('SOON');

    // The ledger row is created by checkout, not by a separate call.
    const transaction = await FinancialTransaction.findById(result.transactionId).lean();
    expect(transaction?.type).toBe('income');
    expect(transaction?.category).toBe('Sales');
    expect(transaction?.amount).toBe(50);
  });

  it('splits a sale across batches and snapshots the cost of each', async () => {
    const product = await makeProduct({ sellingPrice: 25 });

    const result = await checkout({
      items: [{ productId: product.id, quantity: 5 }],
      paymentMethod: 'Cash',
    });

    // 4 from the $8 lot + 1 from the $10 lot = $42 of cost.
    expect(result.totalCost).toBe(42);
    expect(result.grossProfit).toBe(125 - 42);

    const sale = await Sale.findById(result.saleId).lean();
    const batches = sale?.items[0]?.batches ?? [];

    expect(batches).toHaveLength(2);
    expect(batches[0]).toMatchObject({ batchNumber: 'SOON', quantity: 4 });
    expect(batches[1]).toMatchObject({ batchNumber: 'LATER', quantity: 1 });
  });

  it('treats duplicate cart lines as one combined line', async () => {
    const product = await makeProduct({ sellingPrice: 10 });

    // 4 + 4 = 8 units against 10 on hand. Planned separately the first line
    // would pass and the second would only be caught after the first had already
    // written to stock.
    const result = await checkout({
      items: [
        { productId: product.id, quantity: 4 },
        { productId: product.id, quantity: 4 },
      ],
      paymentMethod: 'Cash',
    });

    expect(result.total).toBe(80);
    expect((await Product.findById(product.id).lean())?.stockQuantity).toBe(2);

    const sale = await Sale.findById(result.saleId).lean();
    expect(sale?.items).toHaveLength(1);
    expect(sale?.items[0]?.quantity).toBe(8);
  });

  it('rolls back entirely when any line is short of stock', async () => {
    const product = await makeProduct({ sellingPrice: 25 });

    await expect(
      checkout({
        items: [{ productId: product.id, quantity: 50 }],
        paymentMethod: 'Cash',
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });

    // No partial write, no orphan receipt, no ledger entry.
    expect((await Product.findById(product.id).lean())?.stockQuantity).toBe(10);
    expect(await Sale.countDocuments({})).toBe(0);
    expect(await FinancialTransaction.countDocuments({})).toBe(0);
  });

  it('rejects an unknown product without writing anything', async () => {
    const unknown = '507f1f77bcf86cd799439011';

    await expect(
      checkout({ items: [{ productId: unknown, quantity: 1 }], paymentMethod: 'Cash' }),
    ).rejects.toBeDefined();

    expect(await Sale.countDocuments({})).toBe(0);
  });

  it('applies a percentage discount in integer cents', async () => {
    const product = await makeProduct({ sellingPrice: 33.33 });

    const result = await checkout({
      items: [{ productId: product.id, quantity: 3 }],
      discountType: 'percent',
      discountValue: 10,
      paymentMethod: 'Mobile Payment',
    });

    // Subtotal 99.99, 10% = 9.999 which must round to 10.00, not 9.99 or 10.01.
    expect(toCents(result.subtotal)).toBe(9999);
    expect(toCents(result.discountAmount)).toBe(1000);
    expect(toCents(result.total)).toBe(8999);
  });

  it('never discounts below zero', async () => {
    const product = await makeProduct({ sellingPrice: 10 });

    const result = await checkout({
      items: [{ productId: product.id, quantity: 1 }],
      discountType: 'fixed',
      discountValue: 500,
      paymentMethod: 'Cash',
    });

    expect(result.total).toBe(0);
    expect(result.discountAmount).toBe(10);
  });

  it('prices from the stored product, ignoring what the caller sends', async () => {
    const product = await makeProduct({ sellingPrice: 30 });

    const result = await checkout({
      // An extra `unitPrice` is not part of the schema and must not be honoured.
      items: [{ productId: product.id, quantity: 2, unitPrice: 1 } as never],
      paymentMethod: 'Cash',
    });

    expect(result.total).toBe(60);
  });
});
