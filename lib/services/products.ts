import 'server-only';

import { Types, type QueryFilter } from 'mongoose';

import { connectToDatabase, withTransaction } from '@/lib/db';
import { ConflictError, NotFoundError } from '@/lib/errors';
import { expiryCutoff } from '@/lib/dates';
import { toProductDto } from '@/lib/serializers';
import { Customer } from '@/models/Customer';
import { Product, type ProductShape } from '@/models/Product';
import { Sale } from '@/models/Sale';
import { StockMovement } from '@/models/StockMovement';
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
 *
 * Note this leaves the SKU reserved by the unique index. That is the reason a
 * product created purely for testing cannot simply be reused: see
 * {@link purgeProduct} for the escape hatch.
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

/**
 * Hard delete, for a product that was never really sold.
 *
 * Soft deletion is the right default, but it is the wrong tool for a row created
 * while trying something out: the document lingers, and because `sku` carries a
 * unique index the deactivated record permanently reserves that SKU, so creating a
 * replacement with the same one fails with a duplicate-key error. This removes it
 * for real.
 *
 * The guard is a sale count, and only a sale count. Sales are the one reference
 * that cannot be reconstructed — losing them would silently change recorded
 * revenue and margin — so a product with any sale history is refused and must go
 * through {@link deactivateProduct} instead.
 *
 * Everything else is disposable and cleaned up here rather than left dangling:
 *
 *   - `batches` are embedded, so removing the product removes them with it.
 *   - `StockMovement` rows exist even for a product that was only created, because
 *     opening stock writes a `stock-in` audit row on create (see `createProduct`).
 *   - `Customer.recommendedProducts` is an array of ids that would otherwise point
 *     at nothing.
 *
 * All three writes run in one transaction: a purge that deleted the product but
 * failed to remove its audit rows would leave a stock trail leading nowhere.
 */
export async function purgeProduct(productId: string): Promise<{ purged: true }> {
  await connectToDatabase();

  if (!Types.ObjectId.isValid(productId)) throw new NotFoundError('Product');

  return withTransaction(async (session) => {
    // `withTransaction` passes `undefined` when the deployment cannot run
    // transactions. Mongoose wants `null` on query `.session()` but
    // `undefined` in an options object, so both forms are derived here — matching
    // how `lib/services/inventory.ts` handles the same optional session.
    const querySession = session ?? null;
    const writeOptions = session ? { session } : {};

    // Existence and sale history are checked together, before any write.
    const product = await Product.findById(productId)
      .select('sku name')
      .session(querySession)
      .lean<{ sku: string; name: string } | null>();
    if (!product) throw new NotFoundError('Product');

    const saleCount = await Sale.countDocuments({ 'items.product': productId }).session(querySession);
    if (saleCount > 0) {
      throw new ConflictError(
        `${product.name} has been sold ${saleCount} time${saleCount === 1 ? '' : 's'} and cannot be deleted permanently — deactivate it instead to keep the sales history.`,
      );
    }

    await Promise.all([
      Product.deleteOne({ _id: productId }, writeOptions),
      StockMovement.deleteMany({ product: productId }, writeOptions),
      Customer.updateMany(
        { recommendedProducts: productId },
        { $pull: { recommendedProducts: productId } },
        writeOptions,
      ),
    ]);

    return { purged: true as const };
  });
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