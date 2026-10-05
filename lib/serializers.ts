import 'server-only';

import { daysUntil, toDate } from '@/lib/dates';
import type {
  BatchDto,
  CustomerDto,
  LeanBatch,
  LeanCustomer,
  LeanFinancialTransaction,
  LeanProduct,
  LeanSale,
  LeanStockMovement,
  ProductDto,
  SaleDto,
  StockMovementDto,
  StockStatus,
  TransactionDto,
} from '@/types/dto';

/**
 * Lean document -> DTO mappers.
 *
 * Every API response funnels through one of these. Serialising explicitly
 * (rather than returning Mongoose documents) keeps `_id`, `__v` and internal
 * schema bookkeeping out of the wire format, and means the client never has to
 * know about BSON.
 */

function id(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' && value !== null && '_id' in value) {
    return String((value as { _id: unknown })._id);
  }
  return String(value);
}

function iso(value: unknown): string {
  const date = toDate(value);
  // Fall back to the epoch rather than emitting "Invalid Date" into the UI.
  return (date ?? new Date(0)).toISOString();
}

function optionalIso(value: unknown): string | undefined {
  const date = toDate(value);
  return date ? date.toISOString() : undefined;
}

/** Projected form used by `Product.populate('recommendedProducts')`. */
function refSummary(value: unknown): { id: string; name: string; sku: string } | null {
  if (!value || typeof value !== 'object') return null;
  const populated = value as { _id?: unknown; name?: unknown; sku?: unknown };
  if (typeof populated.name !== 'string') return null;
  return {
    id: id(populated._id ?? value),
    name: populated.name,
    sku: typeof populated.sku === 'string' ? populated.sku : '',
  };
}

export function toBatchDto(batch: LeanBatch): BatchDto {
  return {
    id: id(batch._id),
    batchNumber: batch.batchNumber,
    expiryDate: iso(batch.expiryDate),
    costPrice: batch.costPrice,
    quantity: batch.quantity,
    ...(batch.supplier ? { supplier: batch.supplier } : {}),
    receivedAt: iso(batch.receivedAt),
  };
}

/** Determine the alert bucket for a product row. */
export function stockStatus(stock: number, minAlert: number): StockStatus {
  if (stock <= 0) return 'out-of-stock';
  if (stock <= minAlert) return 'low-stock';
  return 'ok';
}

export function toProductDto(product: LeanProduct, now = new Date()): ProductDto {
  const batches = (product.batches ?? [])
    .map(toBatchDto)
    .sort((a, b) => a.expiryDate.localeCompare(b.expiryDate));

  // Only batches that still hold stock count towards the nearest expiry.
  const inStock = batches.filter((batch) => batch.quantity > 0);
  const nearest = inStock[0];

  const stockQuantity =
    product.stockQuantity ??
    batches.reduce((sum, batch) => sum + batch.quantity, 0);

  const { units, cost } = batches.reduce(
    (acc, batch) => {
      if (batch.quantity <= 0) return acc;
      acc.units += batch.quantity;
      acc.cost += batch.costPrice * batch.quantity;
      return acc;
    },
    { units: 0, cost: 0 },
  );

  const notes = product.notes;
  const brand = product.brand;
  const size = product.size;

  return {
    id: id(product._id),
    name: product.name,
    sku: product.sku,
    category: product.category,
    ...(brand ? { brand } : {}),
    ...(size ? { size } : {}),
    sellingPrice: product.sellingPrice,
    minStockAlert: product.minStockAlert,
    stockQuantity,
    averageCostPrice: units === 0 ? 0 : Number((cost / units).toFixed(2)),
    retailValue: Number((stockQuantity * product.sellingPrice).toFixed(2)),
    stockCostValue: Number(cost.toFixed(2)),
    nearestExpiry: nearest?.expiryDate ?? null,
    daysToNearestExpiry: nearest
      ? daysUntil(now, new Date(nearest.expiryDate))
      : null,
    stockStatus: stockStatus(stockQuantity, product.minStockAlert),
    batches,
    active: product.active ?? true,
    ...(notes ? { notes } : {}),
    createdAt: iso(product.createdAt),
    updatedAt: iso(product.updatedAt),
  };
}

export function toStockMovementDto(
  movement: LeanStockMovement,
): StockMovementDto {
  return {
    id: id(movement._id),
    productId: id(movement.product),
    productName: movement.productName,
    type: movement.type,
    quantity: movement.quantity,
    ...(movement.batchNumber ? { batchNumber: movement.batchNumber } : {}),
    stockBefore: movement.stockBefore,
    stockAfter: movement.stockAfter,
    ...(movement.reference ? { reference: movement.reference } : {}),
    ...(movement.reason ? { reason: movement.reason } : {}),
    ...(typeof movement.unitCost === 'number' ? { unitCost: movement.unitCost } : {}),
    occurredAt: iso(movement.occurredAt),
  };
}

export function toTransactionDto(
  transaction: LeanFinancialTransaction,
): TransactionDto {
  const breakdown = transaction.productBreakdown;
  const saleRef = transaction.sale;

  return {
    id: id(transaction._id),
    type: transaction.type,
    amount: transaction.amount,
    signedAmount:
      transaction.type === 'income'
        ? transaction.amount
        : -transaction.amount,
    category: transaction.category,
    paymentMethod: transaction.paymentMethod,
    ...(transaction.referenceNote
      ? { referenceNote: transaction.referenceNote }
      : {}),
    ...(saleRef ? { saleId: id(saleRef) } : {}),
    ...(breakdown && breakdown.length > 0
      ? {
          productBreakdown: breakdown.map((line) => ({
            productId: id(line.product),
            name: line.name,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            lineTotal: line.lineTotal,
          })),
        }
      : {}),
    occurredAt: iso(transaction.occurredAt),
    createdAt: iso(transaction.createdAt),
  };
}

export function toCustomerDto(customer: LeanCustomer): CustomerDto {
  const recommended = Array.isArray(customer.recommendedProducts)
    ? customer.recommendedProducts
        .map(refSummary)
        .filter((value): value is NonNullable<typeof value> => value !== null)
    : [];

  const phone = customer.phone;
  const notes = customer.notes;

  return {
    id: id(customer._id),
    name: customer.name,
    ...(phone ? { phone } : {}),
    skinType: customer.skinType,
    ...(notes ? { notes } : {}),
    isWalkIn: customer.isWalkIn ?? false,
    recommendedProducts: recommended,
    createdAt: iso(customer.createdAt),
    updatedAt: iso(customer.updatedAt),
  };
}

export function toSaleDto(sale: LeanSale): SaleDto {
  const populated = sale.customer as
    | { name?: string; phone?: string; skinType?: string }
    | undefined;

  const customerId =
    populated && typeof populated === 'object' && '_id' in populated
      ? id(populated)
      : typeof sale.customer === 'string'
        ? sale.customer
        : null;

  return {
    id: id(sale._id),
    items: sale.items.map((item) => ({
      productId: id(item.product),
      name: item.name,
      sku: item.sku,
      category: item.category,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      unitCost: item.unitCost,
      lineTotal: item.lineTotal,
      batches: (item.batches ?? []).map((batch) => ({
        ...(batch.batchId ? { batchId: id(batch.batchId) } : {}),
        // Sale items snapshot the lot number, so fall back to an explicit
        // marker rather than emitting `undefined` into a required field.
        batchNumber: batch.batchNumber ?? 'Unknown batch',
        expiryDate: iso(batch.expiryDate),
        quantity: batch.quantity,
      })),
    })),
    subtotal: sale.subtotal,
    discountType: sale.discountType,
    discountValue: sale.discountValue,
    discountAmount: sale.discountAmount,
    total: sale.total,
    totalCost: sale.totalCost,
    grossProfit: Number((sale.total - sale.totalCost).toFixed(2)),
    paymentMethod: sale.paymentMethod,
    ...(customerId
      ? {
          customer: {
            id: customerId,
            name: populated?.name ?? '',
            ...(populated?.phone ? { phone: populated.phone } : {}),
            skinType: populated?.skinType ?? '',
          },
        }
      : {}),
    ...(sale.cashier ? { cashier: sale.cashier } : {}),
    ...(sale.note ? { note: sale.note } : {}),
    createdAt: optionalIso(sale.createdAt) ?? new Date(0).toISOString(),
  };
}