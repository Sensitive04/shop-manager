import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { addDays } from '@/lib/dates';
import { disconnectFromDatabase } from '@/lib/db';
import { createCustomer, setRecommendations } from '@/lib/services/customers';
import {
  createProduct,
  deactivateProduct,
  listProducts,
  purgeProduct,
  reactivateProduct,
} from '@/lib/services/products';
import { checkout } from '@/lib/services/sales';
import { Customer } from '@/models/Customer';
import { Product } from '@/models/Product';
import { Sale } from '@/models/Sale';
import { StockMovement } from '@/models/StockMovement';

/**
 * Product removal tests.
 *
 * The distinction these guard is not obvious from the code: soft delete hides a
 * product but keeps it, and hard delete removes it but is only allowed when no
 * sale references it. Getting that backwards either strands a SKU forever or
 * quietly rewrites recorded revenue, so both halves are tested against a real
 * database rather than mocked out.
 */

async function clearAll() {
  await Promise.all([
    Product.deleteMany({}),
    Customer.deleteMany({}),
    Sale.deleteMany({}),
    StockMovement.deleteMany({}),
  ]);
}

/** A product with opening stock, so a `stock-in` movement exists to clean up. */
async function makeProduct(sku = 'PURGE-TST-001') {
  return createProduct({
    name: 'Purge Test Serum',
    sku,
    category: 'Serum',
    sellingPrice: 20,
    minStockAlert: 3,
    batches: [
      {
        batchNumber: 'LOT-A',
        expiryDate: addDays(new Date(), 120),
        costPrice: 8,
        quantity: 5,
      },
    ],
  });
}

beforeAll(async () => {
  const { connectToDatabase, supportsTransactions } = await import('@/lib/db');
  await connectToDatabase();
  expect(await supportsTransactions()).toBe(true);
});

afterAll(async () => {
  await disconnectFromDatabase();
});

beforeEach(async () => {
  await clearAll();
});

describe('deactivateProduct', () => {
  it('hides the product from the default catalogue listing', async () => {
    const product = await makeProduct();
    await deactivateProduct(product.id);

    const listed = await listProducts({ page: 1, limit: 25 });
    expect(listed.items.map((item) => item.id)).not.toContain(product.id);
  });

  it('still lists it when inactive products are explicitly requested', async () => {
    const product = await makeProduct();
    await deactivateProduct(product.id);

    // `includeInactive` is the parsed query-string value, so it is the *string*
    // 'true' — the service compares against `'true'`, not a boolean.
    const listed = await listProducts({ page: 1, limit: 25, includeInactive: 'true' });
    expect(listed.items.map((item) => item.id)).toContain(product.id);
  });

  it('keeps the document, its stock and its movements', async () => {
    const product = await makeProduct();
    await deactivateProduct(product.id);

    // The reason soft delete exists: a product referenced by history must remain.
    expect(await Product.countDocuments({ _id: product.id })).toBe(1);
    expect(await StockMovement.countDocuments({ product: product.id })).toBeGreaterThan(0);
  });

  it('removes it from the low-stock and expiry queues', async () => {
    const product = await makeProduct('PURGE-TST-LOW');
    await deactivateProduct(product.id);

    const { lowStockProducts, expiringProducts } = await import('@/lib/services/products');
    expect((await lowStockProducts()).map((item) => item.id)).not.toContain(product.id);
    expect((await expiringProducts(3650)).map((item) => item.id)).not.toContain(product.id);
  });

  it('round-trips through reactivateProduct', async () => {
    const product = await makeProduct();
    await deactivateProduct(product.id);
    const restored = await reactivateProduct(product.id);

    expect(restored.active).toBe(true);
    const listed = await listProducts({ page: 1, limit: 25 });
    expect(listed.items.map((item) => item.id)).toContain(product.id);
  });

  it('throws NOT_FOUND for a malformed id', async () => {
    await expect(deactivateProduct('not-an-object-id')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('purgeProduct', () => {
  it('removes a product that was never sold', async () => {
    const product = await makeProduct();
    await purgeProduct(product.id);

    expect(await Product.countDocuments({ _id: product.id })).toBe(0);
  });

  it('deletes the stock movements it created', async () => {
    // Opening stock writes a `stock-in` audit row, so even a product that was only
    // created has movements. Leaving them behind would be a stock trail leading
    // to a product that no longer exists.
    const product = await makeProduct();
    expect(await StockMovement.countDocuments({ product: product.id })).toBeGreaterThan(0);

    await purgeProduct(product.id);

    expect(await StockMovement.countDocuments({ product: product.id })).toBe(0);
  });

  it('unlinks the product from customer recommendations', async () => {
    const product = await makeProduct();
    const customer = await createCustomer({
      name: 'Test Walk-in',
      skinType: 'Dry',
      phone: undefined,
      isWalkIn: true,
    });
    await setRecommendations(customer.id, [product.id]);

    expect((await Customer.findById(customer.id).lean())?.recommendedProducts).toHaveLength(1);

    await purgeProduct(product.id);

    expect((await Customer.findById(customer.id).lean())?.recommendedProducts).toHaveLength(0);
  });

  it('frees the unique SKU for reuse, which soft delete cannot', async () => {
    const product = await makeProduct('REUSE-ME');

    // Soft delete alone keeps the index entry, so the replacement fails.
    await deactivateProduct(product.id);
    await expect(makeProduct('REUSE-ME')).rejects.toThrow();

    await purgeProduct(product.id);
    const replacement = await makeProduct('REUSE-ME');
    expect(replacement.sku).toBe('REUSE-ME');
  });

  it('leaves other products and their movements untouched', async () => {
    const keep = await makeProduct('KEEP-001');
    const drop = await makeProduct('DROP-001');

    await purgeProduct(drop.id);

    expect(await Product.countDocuments({ _id: keep.id })).toBe(1);
    expect(await StockMovement.countDocuments({ product: keep.id })).toBeGreaterThan(0);
  });

  it('refuses a product that has been sold, and says to deactivate instead', async () => {
    const product = await makeProduct();
    await checkout({
      items: [{ productId: product.id, quantity: 1 }],
      paymentMethod: 'Cash',
    });

    await expect(purgeProduct(product.id)).rejects.toMatchObject({
      code: 'CONFLICT',
      status: 409,
    });
    expect(await Product.countDocuments({ _id: product.id })).toBe(1);
  });

  it('keeps refusing after a sale even if the product is deactivated first', async () => {
    // Deactivating then purging must not become a way around the guard.
    const product = await makeProduct();
    await checkout({ items: [{ productId: product.id, quantity: 1 }], paymentMethod: 'Cash' });
    await deactivateProduct(product.id);

    await expect(purgeProduct(product.id)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('leaves the sale and its ledger entry intact when it refuses', async () => {
    const product = await makeProduct();
    const sale = await checkout({
      items: [{ productId: product.id, quantity: 1 }],
      paymentMethod: 'Cash',
    });

    await expect(purgeProduct(product.id)).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(await Sale.countDocuments({ _id: sale.saleId })).toBe(1);
  });

  it('throws NOT_FOUND for an id that does not exist', async () => {
    const missing = new (await import('mongoose')).Types.ObjectId().toString();
    await expect(purgeProduct(missing)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('throws NOT_FOUND for a malformed id', async () => {
    await expect(purgeProduct('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('is not idempotent — a second purge reports NOT_FOUND', async () => {
    // Explicit, so a double-click cannot be mistaken for two successful deletes.
    const product = await makeProduct();
    await purgeProduct(product.id);
    await expect(purgeProduct(product.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});