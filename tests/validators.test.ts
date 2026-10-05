import { describe, expect, it } from 'vitest';

import {
  adjustStockSchema,
  checkoutSchema,
  createCustomerSchema,
  createProductSchema,
  createTransactionSchema,
  customerQuerySchema,
  productQuerySchema,
  stockInSchema,
  transactionQuerySchema,
  updateProductSchema,
} from '@/lib/validators';

/**
 * Regression tests for the input layer.
 *
 * The bug these guard against: a query schema whose *filter* field was declared
 * as required. `transactionQuerySchema` once required `paymentMethod` and
 * `customerQuerySchema` required `skinType`, so every unfiltered list request —
 * `/api/transactions?limit=100`, `/api/customers` — failed with
 * VALIDATION_ERROR and the pages rendered an error instead of data. Each schema
 * below is therefore parsed with `{}` to prove it accepts an empty query.
 */

describe('query schemas accept an empty query', () => {
  it('parses products with no filters', () => {
    expect(() => productQuerySchema.parse({})).not.toThrow();
  });

  it('parses customers with no filters', () => {
    expect(() => customerQuerySchema.parse({})).not.toThrow();
  });

  it('parses transactions with no filters', () => {
    expect(() => transactionQuerySchema.parse({})).not.toThrow();
  });

  it('parses a summary request carrying only a date range', () => {
    const parsed = transactionQuerySchema.parse({ from: '2026-01-01', to: '2026-01-31' });

    expect(parsed.from).toBeInstanceOf(Date);
    expect(parsed.to).toBeInstanceOf(Date);
    expect(parsed.type).toBeUndefined();
    expect(parsed.paymentMethod).toBeUndefined();
  });

  it('widens a date-only `to` to the end of that local day', () => {
    const parsed = transactionQuerySchema.parse({ to: '2026-01-31' });
    const end = parsed.to as Date;

    // Local, not UTC: the report must cover the whole of the 31st as the
    // shopkeeper experienced it.
    expect(end.getDate()).toBe(31);
    expect(end.getMonth()).toBe(0);
    expect(end.getHours()).toBe(23);
    expect(end.getMinutes()).toBe(59);
    expect(end.getSeconds()).toBe(59);
    expect(end.getMilliseconds()).toBe(999);
  });

  it('leaves a full ISO timestamp alone', () => {
    const parsed = transactionQuerySchema.parse({ to: '2026-01-31T09:30:00.000Z' });

    expect(parsed.to?.toISOString()).toBe('2026-01-31T09:30:00.000Z');
  });

  it('still rejects an unparseable date', () => {
    expect(() => transactionQuerySchema.parse({ from: 'the first of never' })).toThrow();
    expect(() => transactionQuerySchema.parse({ to: '2026-02-31' })).toThrow();
  });

  it('still rejects an unknown filter value', () => {
    expect(() => transactionQuerySchema.parse({ type: 'refund' })).toThrow();
    expect(() => customerQuerySchema.parse({ skinType: 'Albino' })).toThrow();
  });

  it('coerces paging and boolean-ish query strings', () => {
    const parsed = productQuerySchema.parse({ page: '3', limit: '50', lowStock: 'true' });

    expect(parsed.page).toBe(3);
    expect(parsed.limit).toBe(50);
    expect(parsed.lowStock).toBe('true');
  });

  it('rejects out-of-range paging', () => {
    expect(() => productQuerySchema.parse({ page: '0' })).toThrow();
    expect(() => productQuerySchema.parse({ limit: '9999' })).toThrow();
  });
});

describe('product input', () => {
  it('accepts a product with no opening batches', () => {
    const parsed = createProductSchema.parse({
      name: '  Vitamin C Serum  ',
      sku: 'VC-30',
      category: 'Serum',
      sellingPrice: '24.50',
      minStockAlert: '3',
    });

    expect(parsed.name).toBe('Vitamin C Serum');
    expect(parsed.sellingPrice).toBe(24.5);
    expect(parsed.minStockAlert).toBe(3);
    expect(parsed.batches).toBeUndefined();
  });

  it('rejects a malformed SKU and a missing category', () => {
    expect(() =>
      createProductSchema.parse({
        name: 'X',
        sku: 'has spaces',
        category: 'Serum',
        sellingPrice: 1,
        minStockAlert: 0,
      }),
    ).toThrow();

    expect(() =>
      createProductSchema.parse({
        name: 'X',
        sku: 'OK-1',
        sellingPrice: 1,
        minStockAlert: 0,
      }),
    ).toThrow();
  });

  it('requires at least one field on update', () => {
    expect(() => updateProductSchema.parse({})).toThrow();
    expect(() => updateProductSchema.parse({ sellingPrice: 30 })).not.toThrow();
  });
});

describe('stock input', () => {
  it('defaults mergeWithExistingBatch to false', () => {
    const parsed = stockInSchema.parse({
      batchNumber: 'B1',
      expiryDate: '2027-01-31',
      costPrice: '5.25',
      quantity: '10',
    });

    expect(parsed.mergeWithExistingBatch).toBe(false);
    expect(parsed.expiryDate).toBeInstanceOf(Date);
  });

  it('refuses a zero stock-in', () => {
    expect(() =>
      stockInSchema.parse({
        batchNumber: 'B1',
        expiryDate: '2027-01-31',
        costPrice: 5,
        quantity: 0,
      }),
    ).toThrow();
  });

  it('refuses a zero adjustment', () => {
    expect(() => adjustStockSchema.parse({ quantity: 0 })).toThrow();
  });

  it('allows a negative adjustment without a cost or expiry', () => {
    expect(() => adjustStockSchema.parse({ quantity: -2, reason: 'Damaged' })).not.toThrow();
  });

  it('demands an expiry and cost when adding stock back', () => {
    expect(() => adjustStockSchema.parse({ quantity: 3 })).toThrow();
    expect(() => adjustStockSchema.parse({ quantity: 3, expiryDate: '2027-01-31' })).toThrow();
    expect(() =>
      adjustStockSchema.parse({ quantity: 3, expiryDate: '2027-01-31', costPrice: 4 }),
    ).not.toThrow();
  });
});

describe('checkout input', () => {
  it('defaults discounts off and accepts a bare cart', () => {
    const parsed = checkoutSchema.parse({
      items: [{ productId: '507f1f77bcf86cd799439011', quantity: 2 }],
      paymentMethod: 'Cash',
    });

    expect(parsed.discountType).toBe('none');
    expect(parsed.discountValue).toBe(0);
    expect(parsed.customerId).toBeUndefined();
  });

  it('rejects an empty cart, a bad id and a missing payment method', () => {
    expect(() => checkoutSchema.parse({ items: [], paymentMethod: 'Cash' })).toThrow();
    expect(() =>
      checkoutSchema.parse({ items: [{ productId: 'nope', quantity: 1 }], paymentMethod: 'Cash' }),
    ).toThrow();
    expect(() =>
      checkoutSchema.parse({ items: [{ productId: '507f1f77bcf86cd799439011', quantity: 1 }] }),
    ).toThrow();
  });

  it('rejects a fractional or non-positive quantity', () => {
    const id = '507f1f77bcf86cd799439011';

    expect(() =>
      checkoutSchema.parse({ items: [{ productId: id, quantity: 1.5 }], paymentMethod: 'Cash' }),
    ).toThrow();
    expect(() =>
      checkoutSchema.parse({ items: [{ productId: id, quantity: 0 }], paymentMethod: 'Cash' }),
    ).toThrow();
  });
});

describe('customer input', () => {
  it('allows a walk-in with no phone number', () => {
    const parsed = createCustomerSchema.parse({ name: 'Walk In', skinType: 'Oily' });

    expect(parsed.phone).toBeUndefined();
    expect(parsed.isWalkIn).toBe(false);
  });

  it('accepts a phone number as a string or number', () => {
    expect(createCustomerSchema.parse({ name: 'A', skinType: 'Dry', phone: '+1 555 0100' }).phone)
      .toBe('+1 555 0100');
    expect(createCustomerSchema.parse({ name: 'A', skinType: 'Dry', phone: 15550100 }).phone)
      .toBe('15550100');
  });

  it('rejects an unformatted phone number and an empty one', () => {
    expect(() =>
      createCustomerSchema.parse({ name: 'A', skinType: 'Dry', phone: 'call me' }),
    ).toThrow();
    expect(() => createCustomerSchema.parse({ name: 'A', skinType: 'Dry', phone: '   ' })).toThrow();
  });
});

describe('transaction input', () => {
  it('accepts a valid expense', () => {
    const parsed = createTransactionSchema.parse({
      type: 'outcome',
      amount: '650.00',
      category: 'Rent',
      paymentMethod: 'Bank Transfer',
    });

    expect(parsed.amount).toBe(650);
    expect(parsed.occurredAt).toBeUndefined();
  });

  it('rejects Sales as an outcome and Rent as income', () => {
    expect(() =>
      createTransactionSchema.parse({
        type: 'outcome',
        amount: 10,
        category: 'Sales',
        paymentMethod: 'Cash',
      }),
    ).toThrow();

    expect(() =>
      createTransactionSchema.parse({
        type: 'income',
        amount: 10,
        category: 'Rent',
        paymentMethod: 'Cash',
      }),
    ).toThrow();
  });

  it('rejects a zero manual entry', () => {
    expect(() =>
      createTransactionSchema.parse({
        type: 'income',
        amount: 0,
        category: 'Other Income',
        paymentMethod: 'Cash',
      }),
    ).toThrow();
  });
});
