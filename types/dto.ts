import type { ProductShape } from '@/models/Product';
import type { StockMovementShape } from '@/models/StockMovement';
import type { FinancialTransactionShape } from '@/models/FinancialTransaction';
import type { CustomerShape } from '@/models/Customer';
import type { SaleShape } from '@/models/Sale';

/**
 * Client-facing DTOs.
 *
 * Deliberately separate from the Mongoose shapes: ObjectIds are serialised to
 * hex strings, Dates to ISO strings, and nothing exposes a Mongo document to
 * the React tree. Every query uses `.lean()` and passes through a mapper here,
 * so the wire format is explicit and stable.
 */

type Id = string;
type Iso = string;

export interface BatchDto {
  id: Id;
  batchNumber: string;
  expiryDate: Iso;
  costPrice: number;
  quantity: number;
  supplier?: string;
  receivedAt: Iso;
}

export type StockStatus = 'out-of-stock' | 'low-stock' | 'ok';

export interface ProductDto {
  id: Id;
  name: string;
  sku: string;
  category: string;
  brand?: string;
  size?: string;
  sellingPrice: number;
  minStockAlert: number;
  stockQuantity: number;
  averageCostPrice: number;
  retailValue: number;
  stockCostValue: number;
  /** Soonest expiry among batches still holding stock, if any. */
  nearestExpiry: Iso | null;
  /** Negative once expired. */
  daysToNearestExpiry: number | null;
  stockStatus: StockStatus;
  batches: BatchDto[];
  active: boolean;
  notes?: string;
  createdAt: Iso;
  updatedAt: Iso;
}

export interface StockMovementDto {
  id: Id;
  productId: Id;
  productName: string;
  type: string;
  quantity: number;
  batchNumber?: string;
  stockBefore: number;
  stockAfter: number;
  reference?: string;
  reason?: string;
  unitCost?: number;
  occurredAt: Iso;
}

export interface TransactionDto {
  id: Id;
  type: string;
  amount: number;
  /** Positive for income, negative for outcome. */
  signedAmount: number;
  category: string;
  paymentMethod: string;
  referenceNote?: string;
  saleId?: Id;
  productBreakdown?: {
    productId: Id;
    name: string;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
  }[];
  occurredAt: Iso;
  createdAt: Iso;
}

export interface TransactionSummaryDto {
  income: number;
  outcome: number;
  net: number;
  count: number;
  byCategory: { category: string; type: string; total: number; count: number }[];
  byPaymentMethod: { paymentMethod: string; total: number }[];
}

export interface CustomerDto {
  id: Id;
  name: string;
  phone?: string;
  skinType: string;
  notes?: string;
  isWalkIn: boolean;
  recommendedProducts: { id: Id; name: string; sku: string }[];
  /** Present on the detail endpoint only. */
  stats?: {
    totalSpent: number;
    orderCount: number;
    lastPurchaseAt: Iso | null;
  };
  createdAt: Iso;
  updatedAt: Iso;
}

export interface SaleItemDto {
  productId: Id;
  name: string;
  sku: string;
  category: string;
  quantity: number;
  unitPrice: number;
  unitCost: number;
  lineTotal: number;
  batches: { batchId?: Id; batchNumber: string; expiryDate: Iso; quantity: number }[];
}

export interface SaleDto {
  id: Id;
  items: SaleItemDto[];
  subtotal: number;
  discountType: string;
  discountValue: number;
  discountAmount: number;
  total: number;
  totalCost: number;
  grossProfit: number;
  paymentMethod: string;
  customer?: { id: Id; name: string; phone?: string; skinType: string };
  cashier?: string;
  note?: string;
  createdAt: Iso;
}

/** Result of POST /api/sales — returned after the sale is committed. */
export interface CheckoutResultDto {
  saleId: Id;
  transactionId: Id;
  subtotal: number;
  discountAmount: number;
  total: number;
  totalCost: number;
  grossProfit: number;
  /** False when the deployment cannot run transactions; see lib/db.ts. */
  atomic: boolean;
}

export interface DashboardDto {
  today: { sales: number; income: number; outcome: number; net: number; orders: number };
  inventory: {
    productCount: number;
    lowStockCount: number;
    outOfStockCount: number;
    expiringSoonCount: number;
    stockCostValue: number;
    retailValue: number;
  };
  topProducts: {
    productId: Id;
    name: string;
    sku: string;
    quantitySold: number;
    revenue: number;
  }[];
  recentSales: SaleDto[];
  lowStockProducts: ProductDto[];
  expiringProducts: ProductDto[];
}

/* --------------------------------------------------------------- lean inputs */

type Lean<T> = Omit<T, never> & { _id: unknown; createdAt: Date; updatedAt: Date };

/**
 * Lean sub-document shape.
 *
 * Note the `null` unions: Mongoose types unset optional *subdocument* paths as
 * `string | null | undefined` rather than just `undefined`, so the serializers
 * must narrow them explicitly.
 */
export type LeanBatch = {
  _id?: unknown;
  batchNumber: string;
  expiryDate: Date;
  costPrice: number;
  quantity: number;
  supplier?: string | null;
  receivedAt: Date;
};

export type LeanProduct = Lean<ProductShape> & {
  batches?: LeanBatch[];
};

export type LeanStockMovement = Lean<StockMovementShape> & { product: unknown };
export type LeanFinancialTransaction = Lean<FinancialTransactionShape> & { sale?: unknown };
export type LeanCustomer = Lean<CustomerShape> & { recommendedProducts?: unknown };
export type LeanSale = Lean<SaleShape> & { customer?: unknown };