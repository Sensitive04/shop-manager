import 'server-only';

import { Types, type ClientSession } from 'mongoose';

import { connectToDatabase, withTransaction } from '@/lib/db';
import { ApiError, InsufficientStockError, NotFoundError } from '@/lib/errors';

import { allocateFefo, type BatchAllocation } from '@/lib/fefo';
import { fromCents, roundMoney, toCents } from '@/lib/money';
import { Product } from '@/models/Product';
import { StockMovement } from '@/models/StockMovement';

type Session = ClientSession | undefined;

/**
 * Inventory service.
 *
 * Owns every mutation of stock. Two invariants hold across all of it:
 *
 *  1. `Product.stockQuantity` always equals the sum of its batch quantities.
 *     It is denormalised so low-stock queries can use an index.
 *  2. Every stock change writes a `StockMovement` audit row recording the level
 *     before and after.
 *
 * Callers that need several of these to be atomic (POS checkout) wrap them in
 * `withTransaction` and pass the session through.
 */

interface BatchState {
  _id: Types.ObjectId;
  batchNumber: string;
  expiryDate: Date;
  costPrice: number;
  quantity: number;
}

interface ProductState {
  _id: Types.ObjectId;
  name: string;
  sku: string;
  category: string;
  sellingPrice: number;
  stockQuantity: number;
  minStockAlert: number;
  batches: BatchState[];
}

function isLowStock(stock: number, minAlert: number): boolean {
  return stock <= minAlert;
}

/** Recompute the denormalised total from the batch array. */
function sumBatches(batches: readonly BatchState[]): number {
  return batches.reduce((sum, batch) => sum + batch.quantity, 0);
}

/* ------------------------------------------------------------------ stock in */

export interface StockInArgs {
  productId: string;
  batchNumber: string;
  expiryDate: Date;
  costPrice: number;
  quantity: number;
  supplier?: string;
  mergeWithExistingBatch?: boolean;
  reference?: string;
}

/**
 * Receive stock. Creates a new batch by default; with `mergeWithExistingBatch`
 * it tops up a lot that already exists on the product.
 */
export async function stockIn(args: StockInArgs, session?: Session) {
  await connectToDatabase();
  const productObjectId = new Types.ObjectId(args.productId);

  const product = await Product.findById(productObjectId, 'name sku batches minStockAlert').session(
    session ?? null,
  ).lean<ProductState | null>();

  if (!product) throw new NotFoundError('Product');

  const batches = [...(product.batches ?? [])];

  const existing = batches.find(
    (batch) =>
      batch.batchNumber.toLowerCase() === args.batchNumber.trim().toLowerCase(),
  );

  let targetId: Types.ObjectId;

  if (existing && args.mergeWithExistingBatch) {
    existing.quantity += args.quantity;
    // A later delivery may arrive at a better price; keep the newest cost.
    existing.costPrice = roundMoney(args.costPrice);
    targetId = existing._id;
  } else {
    const created = {
      _id: new Types.ObjectId(),
      batchNumber: args.batchNumber.trim(),
      expiryDate: args.expiryDate,
      costPrice: roundMoney(args.costPrice),
      quantity: args.quantity,
      ...(args.supplier ? { supplier: args.supplier.trim() } : {}),
      receivedAt: new Date(),
    };
    batches.push(created);
    targetId = created._id;
  }

  const stockAfter = sumBatches(batches);
  const stockBefore = product.stockQuantity ?? sumBatches(product.batches ?? []);

  await Product.updateOne(
    { _id: productObjectId },
    {
      $set: {
        batches: batches.map((batch) => ({ ...batch, _id: batch._id })),
        stockQuantity: stockAfter,
        isLowStock: isLowStock(stockAfter, product.minStockAlert),
      },
    },
    { session },
  );

  const matched = batches.find((batch) => batch._id.equals(targetId));

  await StockMovement.create(
    [
      {
        product: productObjectId,
        productName: product.name,
        type: 'stock-in',
        quantity: args.quantity,
        batchId: targetId,
        ...(matched ? { batchNumber: matched.batchNumber } : {}),
        stockBefore,
        stockAfter,
        unitCost: roundMoney(args.costPrice),
        ...(args.reference ? { reference: args.reference } : {}),
        ...(args.supplier ? { reason: `Received from ${args.supplier.trim()}` } : {}),
      },
    ],
    { session },
  );

  return { stockQuantity: stockAfter, batchId: targetId.toString() };
}

/* ----------------------------------------------------------------- stock out */

/**
 * Remove stock. With no explicit `batchId` the allocation runs FEFO so the
 * soonest-expiring lot is sold first.
 *
 * Throws rather than partially deducting: a caller cannot accidentally commit
 * half a stock-out.
 */
export async function stockOut(
  args: {
    productId: string;
    quantity: number;
    batchId?: string;
    reason?: string;
    reference?: string;
  },
  session?: Session,
) {
  await connectToDatabase();
  const productObjectId = new Types.ObjectId(args.productId);

  const product = await Product.findById(productObjectId, 'name sku batches stockQuantity minStockAlert')
    .session(session ?? null)
    .lean<ProductState | null>();

  if (!product) throw new NotFoundError('Product');

  const batches = [...(product.batches ?? [])];
  const stockBefore = product.stockQuantity ?? sumBatches(batches);

  let allocations: BatchAllocation[];

  if (args.batchId) {
    // Explicit lot: verify it exists and holds enough before touching anything.
    const target = batches.find((batch) => batch._id.toString() === args.batchId);
    if (!target) throw new NotFoundError('Batch');
    if (target.quantity < args.quantity) {
      throw new InsufficientStockError(
        `Batch ${target.batchNumber} only has ${target.quantity} unit(s) in stock.`,
        [{ path: 'quantity', message: `Only ${target.quantity} available in this batch.` }],
      );
    }
    allocations = [{ batchId: args.batchId, quantity: args.quantity }];
  } else {
    const result = allocateFefo(
      batches.map((batch) => ({
        id: batch._id.toString(),
        expiryDate: batch.expiryDate,
        quantity: batch.quantity,
      })),
      args.quantity,
    );

    if (result.shortfall > 0) {
      throw new InsufficientStockError(
        `Only ${result.allocated} of ${args.quantity} unit(s) available for ${product.name}.`,
        [
          {
            path: 'quantity',
            message: `Not enough stock. ${result.allocated} available, ${args.quantity} requested.`,
          },
        ],
      );
    }
    allocations = result.allocations;
  }

  // Apply every allocation before persisting, so the in-memory copy and the
  // stored document are always consistent with each other.
  const movements: Record<string, unknown>[] = [];

  for (const allocation of allocations) {
    const batch = batches.find((candidate) => candidate._id.toString() === allocation.batchId);
    if (!batch) continue; // Defensive; allocateFefo only emits real batch ids.

    batch.quantity -= allocation.quantity;

    movements.push({
      product: productObjectId,
      productName: product.name,
      type: 'stock-out',
      quantity: -allocation.quantity,
      batchId: batch._id,
      batchNumber: batch.batchNumber,
      stockBefore: 0, // Recomputed below.
      stockAfter: 0,
      unitCost: roundMoney(batch.costPrice),
      ...(args.reference ? { reference: args.reference } : {}),
      ...(args.reason ? { reason: args.reason.trim() } : {}),
    });
  }

  const stockAfter = sumBatches(batches);

  // Walk the movements in allocation order, tracking the running level so the
  // audit trail reads as a sequential history rather than N identical rows.
  let running = stockBefore;
  for (const movement of movements) {
    movement.stockBefore = running;
    running += movement.quantity as number;
    movement.stockAfter = running;
  }

  await Product.updateOne(
    { _id: productObjectId },
    {
      $set: {
        batches: batches.map((batch) => ({ ...batch, _id: batch._id })),
        stockQuantity: stockAfter,
        isLowStock: isLowStock(stockAfter, product.minStockAlert),
      },
    },
    { session },
  );

  if (movements.length > 0) {
    await StockMovement.create(movements, { session });
  }

  return { stockQuantity: stockAfter, allocations };
}

/* -------------------------------------------------------------- adjustments */

/**
 * Signed stock correction, e.g. after a damaged unit or a stocktake.
 *
 * Negative quantities delegate to `stockOut` so FEFO and the audit trail apply
 * exactly as they would for a sale.
 *
 * Positive corrections are *not* a bare `$inc` on the denormalised total: that
 * would silently break the batch-sum invariant and skew weighted average cost.
 * Instead the units land in their own synthetic lot, which needs an expiry date
 * and a cost price from the caller. Validation enforces both.
 */
export async function adjustStock(
  args: {
    productId: string;
    quantity: number;
    reason?: string;
    expiryDate?: Date;
    costPrice?: number;
  },
  session?: Session,
) {
  if (args.quantity === 0) {
    throw new ApiError('VALIDATION_ERROR', 'Enter a non-zero adjustment.');
  }

  if (args.quantity < 0) {
    return stockOut(
      {
        productId: args.productId,
        quantity: Math.abs(args.quantity),
        ...(args.reason ? { reason: args.reason } : {}),
      },
      session,
    );
  }

  if (!args.expiryDate || args.costPrice === undefined) {
    throw new ApiError(
      'VALIDATION_ERROR',
      'Adding stock back needs an expiry date and a cost price.',
    );
  }

  await connectToDatabase();
  const productObjectId = new Types.ObjectId(args.productId);

  const product = await Product.findById(productObjectId, 'name batches stockQuantity minStockAlert')
    .session(session ?? null)
    .lean<ProductState | null>();

  if (!product) throw new NotFoundError('Product');

  const batches = [...(product.batches ?? [])];
  const stockBefore = product.stockQuantity ?? sumBatches(product.batches ?? []);

  const created = {
    _id: new Types.ObjectId(),
    // Unique enough to identify the correction in the audit trail, and clearly not
    // a supplier lot so nobody mistakes it for a delivery.
    batchNumber: `ADJ-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}`,
    expiryDate: args.expiryDate,
    costPrice: roundMoney(args.costPrice),
    quantity: args.quantity,
    supplier: 'Stock adjustment',
    receivedAt: new Date(),
  };

  batches.push(created);
  const stockAfter = sumBatches(batches);

  await Product.updateOne(
    { _id: productObjectId },
    {
      $set: {
        batches: batches.map((batch) => ({ ...batch, _id: batch._id })),
        stockQuantity: stockAfter,
        isLowStock: isLowStock(stockAfter, product.minStockAlert),
      },
    },
    { session },
  );

  await StockMovement.create(
    [
      {
        product: productObjectId,
        productName: product.name,
        type: 'adjustment',
        quantity: args.quantity,
        batchId: created._id,
        batchNumber: created.batchNumber,
        stockBefore,
        stockAfter,
        unitCost: created.costPrice,
        ...(args.reason ? { reason: args.reason.trim() } : {}),
      },
    ],
    { session },
  );

  return { stockQuantity: stockAfter, batchId: created._id.toString() };
}

/* --------------------------------------------------------------- read models */

export interface CheckoutLinePlan {
  productId: string;
  name: string;
  sku: string;
  category: string;
  requestedQuantity: number;
  unitPrice: number;
  /** Cost taken from each allocated batch, for margin reporting. */
  unitCost: number;
  lineTotal: number;
  totalCost: number;
  allocations: {
    batchId: string;
    batchNumber: string;
    expiryDate: Date;
    quantity: number;
    costPrice: number;
  }[];
}

/**
 * Work out how a set of cart lines will be fulfilled, without writing
 * anything. Used by checkout to validate stock up front and price the sale from
 * live data rather than trusting prices sent by the browser.
 *
 * Throws `InsufficientStockError` listing every offending line at once, so the
 * cashier sees all the problems in one pass instead of one per attempt.
 */
export async function planCheckout(
  items: { productId: string; quantity: number }[],
  session?: Session,
): Promise<CheckoutLinePlan[]> {
  await connectToDatabase();

  // Aggregate first: a cart that lists the same product twice must be planned as
  // one combined line, otherwise each duplicate would pass its own FEFO check and
  // together they could oversell the product.
  const requested = new Map<string, number>();
  for (const item of items) {
    requested.set(item.productId, (requested.get(item.productId) ?? 0) + item.quantity);
  }
  const lines = [...requested.entries()].map(([productId, quantity]) => ({
    productId,
    quantity,
  }));

  const ids = lines.map((line) => new Types.ObjectId(line.productId));
  const products = await Product.find({ _id: { $in: ids }, active: true })
    .session(session ?? null)
    .lean<ProductState[]>();

  const byId = new Map(products.map((product) => [product._id.toString(), product]));
  const plans: CheckoutLinePlan[] = [];
  const issues: { path: string; message: string }[] = [];

  for (const line of lines) {
    const product = byId.get(line.productId);

    if (!product) {
      issues.push({
        path: `items.${line.productId}`,
        message: 'Product not found or no longer available.',
      });
      continue;
    }

    const result = allocateFefo(
      product.batches.map((batch) => ({
        id: batch._id.toString(),
        expiryDate: batch.expiryDate,
        quantity: batch.quantity,
      })),
      line.quantity,
    );

    if (result.shortfall > 0) {
      issues.push({
        path: `items.${line.productId}`,
        message: `${product.name}: only ${result.allocated} in stock, ${line.quantity} requested.`,
      });
      continue;
    }

    // Priced from the live document just read, never from the client payload.
    const sellingPrice = product.sellingPrice;

    // Weighted cost across the batches actually being consumed.
    const allocations = result.allocations.map((allocation) => {
      const batch = product.batches.find(
        (candidate) => candidate._id.toString() === allocation.batchId,
      );
      return {
        batchId: allocation.batchId,
        batchNumber: batch?.batchNumber ?? 'Unknown batch',
        expiryDate: batch?.expiryDate ?? new Date(),
        quantity: allocation.quantity,
        costPrice: batch?.costPrice ?? 0,
      };
    });

    const totalCostCents = allocations.reduce(
      (sum, allocation) => sum + toCents(allocation.costPrice) * allocation.quantity,
      0,
    );

    plans.push({
      productId: product._id.toString(),
      name: product.name,
      sku: product.sku,
      category: product.category,
      requestedQuantity: line.quantity,
      unitPrice: sellingPrice,
      unitCost: roundMoney(fromCents(totalCostCents) / line.quantity),
      lineTotal: roundMoney(sellingPrice * line.quantity),
      totalCost: fromCents(totalCostCents),
      allocations,
    });
  }

  if (issues.length > 0) {
    throw new InsufficientStockError('Some items are not available in that quantity.', issues);
  }

  return plans;
}

/** Run `fn` atomically when the deployment supports transactions. */
export { withTransaction };
