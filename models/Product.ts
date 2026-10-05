import { Schema, type HydratedDocument, type InferSchemaType } from 'mongoose';

import { modelFrom } from '@/lib/model';
import { roundMoney } from '@/lib/money';
import { PRODUCT_CATEGORIES } from '@/types/constants';

/**
 * A single received batch of a product.
 *
 * Skincare stock is bought in batches with distinct lot numbers, expiry dates
 * and often different supplier prices. Tracking expiry per batch is what makes
 * the "expiring soon" view trustworthy, so batches are embedded on the product
 * rather than flattened onto it.
 */
const batchSchema = new Schema(
  {
    batchNumber: {
      type: String,
      required: [true, 'Batch number is required'],
      trim: true,
      maxlength: 60,
    },
    expiryDate: {
      type: Date,
      required: [true, 'Expiry date is required'],
    },
    costPrice: {
      type: Number,
      required: [true, 'Cost price is required'],
      min: [0, 'Cost price cannot be negative'],
      set: (value: number) => roundMoney(value),
    },
    quantity: {
      type: Number,
      required: [true, 'Quantity is required'],
      min: [0, 'Quantity cannot be negative'],
      validate: {
        validator: Number.isInteger,
        message: 'Quantity must be a whole number',
      },
    },
    supplier: { type: String, trim: true, maxlength: 120 },
    receivedAt: { type: Date, default: () => new Date() },
  },
  { _id: true },
);

/**
 * `batches.expiryDate` is indexed on the *product* schema below rather than on
 * the subdocument: a subdocument index would compile to the same
 * `batches.expiryDate` key and Mongoose rejects the duplicate.
 */

export type BatchShape = InferSchemaType<typeof batchSchema>;

const productSchema = new Schema(
  {
    name: {
      type: String,
      required: [true, 'Product name is required'],
      trim: true,
      maxlength: 160,
    },
    sku: {
      type: String,
      required: [true, 'SKU is required'],
      trim: true,
      uppercase: true,
      maxlength: 40,
    },
    category: {
      type: String,
      required: [true, 'Category is required'],
      enum: {
        values: PRODUCT_CATEGORIES,
        message: '{VALUE} is not a valid product category',
      },
    },
    brand: { type: String, trim: true, maxlength: 80 },
    size: { type: String, trim: true, maxlength: 40 },

    sellingPrice: {
      type: Number,
      required: [true, 'Selling price is required'],
      min: [0, 'Selling price cannot be negative'],
      set: (value: number) => roundMoney(value),
    },

    /** Reorder point. Stock at or below this raises the low-stock alert. */
    minStockAlert: {
      type: Number,
      required: true,
      min: [0, 'Minimum stock alert cannot be negative'],
      validate: {
        validator: Number.isInteger,
        message: 'Minimum stock alert must be a whole number',
      },
      default: 5,
    },

    batches: { type: [batchSchema], default: [] },

    /**
     * Denormalised totals, rewritten inside the same transaction as any batch
     * change. Kept on the document so low-stock and stock-value queries can use
     * an index instead of an un-indexable $expr comparison against the batch sum.
     */
    stockQuantity: { type: Number, default: 0, min: 0 },
    isLowStock: { type: Boolean, default: true },

    /** Soft delete: sales and movement history must survive a product removal. */
    active: { type: Boolean, default: true },

    notes: { type: String, trim: true, maxlength: 500 },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

productSchema.index({ sku: 1 }, { unique: true });
productSchema.index({ category: 1, active: 1 });
productSchema.index({ isLowStock: 1, active: 1 });
// Multikey index over the embedded batches; makes the expiring-soon $elemMatch
// query efficient.
productSchema.index({ 'batches.expiryDate': 1 });
productSchema.index({ name: 1 });

/**
 * Batch aggregations.
 *
 * NOTE: these are written as single-pass `reduce` calls over `this.batches`
 * rather than `batches.filter(...).reduce(...)`. `DocumentArray.filter()`
 * returns another DocumentArray, and chaining `reduce()` onto that resolves
 * against Mongoose's heaviest generic overload — enough to blow the TypeScript
 * heap on this schema. Also note `this` is intentionally left un-annotated so
 * `this` is inferred; an explicit `HydratedDocument<ProductShape>` annotation
 * makes type-checking materially more expensive here.
 */

/** Total units held across all batches. */
productSchema.virtual('stockFromBatches').get(function () {
  return (this.batches ?? []).reduce((sum, batch) => sum + (batch?.quantity ?? 0), 0);
});

/** Weighted average cost across in-stock batches, for margin reporting. */
productSchema.virtual('averageCostPrice').get(function () {
  const { units, cost } = (this.batches ?? []).reduce(
    (acc, batch) => {
      const quantity = batch?.quantity ?? 0;
      if (quantity <= 0) return acc;
      acc.units += quantity;
      acc.cost += (batch?.costPrice ?? 0) * quantity;
      return acc;
    },
    { units: 0, cost: 0 },
  );

  return units === 0 ? 0 : roundMoney(cost / units);
});

/** Retail value of everything currently on the shelf. */
productSchema.virtual('retailValue').get(function () {
  return roundMoney((this.stockQuantity ?? 0) * (this.sellingPrice ?? 0));
});

/** Capital tied up in stock, valued at each batch's own cost. */
productSchema.virtual('stockCostValue').get(function () {
  const cost = (this.batches ?? []).reduce(
    (sum, batch) => sum + (batch?.costPrice ?? 0) * (batch?.quantity ?? 0),
    0,
  );
  return roundMoney(cost);
});

export type ProductShape = InferSchemaType<typeof productSchema>;
export type ProductDocument = HydratedDocument<ProductShape>;

export const Product = modelFrom<ProductShape>('Product', productSchema);