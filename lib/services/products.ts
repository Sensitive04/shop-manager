import 'server-only';

import { Types, type QueryFilter } from 'mongoose';

import { connectToDatabase } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';
import { expiryCutoff } from '@/lib/dates';
import { toProductDto } from '@/lib/serializers';
import { Product, type ProductShape } from '@/models/Product';
import type { CreateProductInput, ProductQuery, UpdateProductInput } from '@/lib/validators';
import type { LeanProduct, ProductDto } from '@/types/dto';

/**
 * Product queries and mutations.
 *
 * `stockQuantity` and `isLowStock` are denormalised onto the product and
 * maintained by the inventory service, so the low-stock filter is a plain
 * indexed comparison rather than an un-indexable `$expr` over the batch array.
 */

export const DEFAULT_EXPIRY_WINDOW_DAYS = 30;

export async function listProducts(
  query: ProductQuery,
): Promise<{ items: ProductDto[]; total: number; page: number; limit: number }> {
  await connectToDatabase();

  // Mongoose 9 renamed `FilterQuery` to `QueryFilter`.
  const filter: QueryFilter<ProductShape> = {};

  if (query.includeInactive !== 'true') {
    filter.active = true;
  }

  if (query.search) {
    // Escape user input before building a regex: an unescaped `(` would
    // otherwise throw or match unexpectedly.
    const escaped = query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(escaped, 'i');
    filter.$or = [{ name: pattern }, { sku: pattern }, { brand: pattern }];
  }

  if (query.category) {
    filter.category = query.category;
  }

  if (query.lowStock === 'true') {
    filter.isLowStock = true;
    filter.active = true;
  }

  if (query.expiringWithinDays !== undefined) {
    const cutoff = expiryCutoff(new Date(), query.expiringWithinDays);
    filter.batches = {
      $elemMatch: { expiryDate: { $lte: cutoff }, quantity: { $gt: 0 } },
    };
  }

  const page = query.page ?? 1;
  const limit = query.limit ?? 25;
  const skip = (page - 1) * limit;

  const [rows, total] = await Promise.all([
    Product.find(filter)
      .sort({ name: 1 })
      .skip(skip)
      .limit(limit)
      .lean<LeanProduct[]>(),
    Product.countDocuments(filter),
  ]);

  const now = new Date();
  return { items: rows.map((row) => toProductDto(row, now)), total, page, limit };
}

export async function getProduct(productId: string): Promise<ProductDto> {
  await connectToDatabase();

  if (!Types.ObjectId.isValid(productId)) throw new NotFoundError('Product');

  const product = await Product.findById(productId).lean<LeanProduct | null>();
  if (!product) throw new NotFoundError('Product');

  return toProductDto(product);
}

export async function createProduct(input: CreateProductInput): Promise<ProductDto> {
  await connectToDatabase();

  const batches = (input.batches ?? []).map((batch) => ({
    batchNumber: batch.batchNumber,
    expiryDate: batch.expiryDate,
    costPrice: batch.costPrice,
    quantity: batch.quantity,
    ...(batch.supplier ? { supplier: batch.supplier } : {}),
    receivedAt: new Date(),
  }));

  const stockQuantity = batches.reduce((sum, batch) => sum + batch.quantity, 0);

  const created = await Product.create({
    name: input.name,
    sku: input.sku.toUpperCase(),
    category: input.category,
    ...(input.brand ? { brand: input.brand } : {}),
    ...(input.size ? { size: input.size } : {}),
    sellingPrice: input.sellingPrice,
    minStockAlert: input.minStockAlert,
    batches,
    stockQuantity,
    isLowStock: stockQuantity <= input.minStockAlert,
    ...(input.notes ? { notes: input.notes } : {}),
  });

  // Opening stock is a real inventory event, so it gets an audit row rather than
  // silently appearing on the product.
  if (stockQuantity > 0) {
    const { StockMovement } = await import('@/models/StockMovement');
    await StockMovement.create(
      batches.map((batch, index) => ({
        product: created._id,
        productName: created.name,
        type: 'stock-in' as const,
        quantity: batch.quantity,
        batchNumber: batch.batchNumber,
        batchId: created.batches[index]?._id,
        stockBefore: 0,
        // Running total so each row shows the level after that batch arrived.
        stockAfter: batches
          .slice(0, index + 1)
          .reduce((sum, current) => sum + current.quantity, 0),
        unitCost: batch.costPrice,
        reason: 'Opening stock',
      })),
    );
  }

  return toProductDto(created.toObject() as LeanProduct);
}

export async function updateProduct(
  productId: string,
  input: UpdateProductInput,
): Promise<ProductDto> {
  await connectToDatabase();

  if (!Types.ObjectId.isValid(productId)) throw new NotFoundError('Product');

  const update: Record<string, unknown> = {};
  if (input.name !== undefined) update.name = input.name;
  if (input.sku !== undefined) update.sku = input.sku.toUpperCase();
  if (input.category !== undefined) update.category = input.category;
  if (input.sellingPrice !== undefined) update.sellingPrice = input.sellingPrice;
  if (input.minStockAlert !== undefined) {
    update.minStockAlert = input.minStockAlert;
    // The alert flag depends on the threshold, so recompute it rather than
    // leaving it stale until the next stock movement.
    const current = await Product.findById(productId, 'stockQuantity').lean<{
      stockQuantity?: number;
    } | null>();
    if (current) {
      update.isLowStock = (current.stockQuantity ?? 0) <= input.minStockAlert;
    }
  }
  if (input.brand !== undefined) update.brand = input.brand;
  if (input.size !== undefined) update.size = input.size;
  if (input.notes !== undefined) update.notes = input.notes;

  const product = await Product.findByIdAndUpdate(productId, update, {
    new: true,
    runValidators: true,
  }).lean<LeanProduct | null>();

  if (!product) throw new NotFoundError('Product');

  return toProductDto(product);
}

/**
 * Soft delete. Sales and stock movements reference this product, so the record
 * is deactivated rather than removed — history stays intact and the product can
 * be restored.
 */
export async function deactivateProduct(productId: string): Promise<ProductDto> {
  await connectToDatabase();

  if (!Types.ObjectId.isValid(productId)) throw new NotFoundError('Product');

  const product = await Product.findByIdAndUpdate(
    productId,
    { active: false },
    { new: true },
  ).lean<LeanProduct | null>();

  if (!product) throw new NotFoundError('Product');

  return toProductDto(product);
}

export async function reactivateProduct(productId: string): Promise<ProductDto> {
  await connectToDatabase();

  if (!Types.ObjectId.isValid(productId)) throw new NotFoundError('Product');

  const product = await Product.findByIdAndUpdate(
    productId,
    { active: true },
    { new: true },
  ).lean<LeanProduct | null>();

  if (!product) throw new NotFoundError('Product');

  return toProductDto(product);
}

/** Products at or below their reorder point. */
export async function lowStockProducts(): Promise<ProductDto[]> {
  await connectToDatabase();

  const rows = await Product.find({ active: true, isLowStock: true })
    .sort({ stockQuantity: 1 })
    .lean<LeanProduct[]>();

  const now = new Date();
  return rows.map((row) => toProductDto(row, now));
}

/**
 * Batches expiring within the window, soonest first.
 *
 * `days` is the alert horizon. Expired batches (negative days remaining) are
 * always included, since an expired lot is the most urgent thing on the shelf.
 */
export async function expiringProducts(
  days = DEFAULT_EXPIRY_WINDOW_DAYS,
): Promise<ProductDto[]> {
  await connectToDatabase();

  const cutoff = expiryCutoff(new Date(), days);

  const rows = await Product.find({
    active: true,
    batches: { $elemMatch: { expiryDate: { $lte: cutoff }, quantity: { $gt: 0 } } },
  })
    .sort({ 'batches.expiryDate': 1 })
    .lean<LeanProduct[]>();

  const now = new Date();
  const products = rows.map((row) => toProductDto(row, now));

  // Sort by soonest expiry rather than name, so the most urgent row is first.
  return products.sort((a, b) => {
    if (!a.nearestExpiry) return 1;
    if (!b.nearestExpiry) return -1;
    return a.nearestExpiry.localeCompare(b.nearestExpiry);
  });
}