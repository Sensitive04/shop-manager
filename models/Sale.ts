import { Schema, type InferSchemaType } from 'mongoose';

import { modelFrom } from '@/lib/model';
import { roundMoney } from '@/lib/money';
import { PAYMENT_METHODS } from '@/types/constants';

/**
 * A completed POS sale.
 *
 * Line items store a *snapshot* of name, SKU, unit price and cost rather than
 * only a product reference. Prices change; a receipt and a historical margin
 * report must keep showing what the customer actually paid.
 */
const saleItemSchema = new Schema(
  {
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    name: { type: String, required: true },
    sku: { type: String, required: true },
    category: { type: String, required: true },
    quantity: {
      type: Number,
      required: true,
      validate: {
        validator: (value: number) => Number.isInteger(value) && value > 0,
        message: 'Quantity must be a positive whole number',
      },
    },
    unitPrice: {
      type: Number,
      required: true,
      set: (value: number) => roundMoney(value),
    },
    /** Cost at time of sale, so margin reporting never drifts. */
    unitCost: {
      type: Number,
      required: true,
      set: (value: number) => roundMoney(value),
    },
    lineTotal: {
      type: Number,
      required: true,
      set: (value: number) => roundMoney(value),
    },
    /** FEFO allocation detail, so a receipt can explain which lots were used. */
    batches: {
      type: [
        new Schema(
          {
            batchId: { type: Schema.Types.ObjectId },
            batchNumber: { type: String },
            expiryDate: { type: Date },
            quantity: { type: Number, required: true },
          },
          { _id: false },
        ),
      ],
      default: undefined,
    },
  },
  { _id: false },
);

const saleSchema = new Schema(
  {
    items: {
      type: [saleItemSchema],
      required: true,
      validate: {
        validator: (value: unknown[]) => Array.isArray(value) && value.length > 0,
        message: 'A sale must contain at least one item',
      },
    },

    subtotal: {
      type: Number,
      required: true,
      min: 0,
      set: (value: number) => roundMoney(value),
    },

    discountType: {
      type: String,
      enum: {
        values: ['none', 'percent', 'fixed'],
        message: '{VALUE} is not a valid discount type',
      },
      default: 'none',
    },
    discountValue: {
      type: Number,
      default: 0,
      min: 0,
      set: (value: number) => roundMoney(value),
    },
    discountAmount: {
      type: Number,
      default: 0,
      min: 0,
      set: (value: number) => roundMoney(value),
    },

    /** What the customer actually paid, after discount. */
    total: {
      type: Number,
      required: true,
      min: 0,
      set: (value: number) => roundMoney(value),
    },

    /** Cost of the goods sold, snapshotted for margin reporting. */
    totalCost: {
      type: Number,
      required: true,
      min: 0,
      set: (value: number) => roundMoney(value),
    },

    paymentMethod: {
      type: String,
      required: true,
      enum: {
        values: PAYMENT_METHODS,
        message: '{VALUE} is not a valid payment method',
      },
    },

    customer: { type: Schema.Types.ObjectId, ref: 'Customer' },

    /** Ledger row created alongside this sale. */
    ledgerEntry: { type: Schema.Types.ObjectId, ref: 'FinancialTransaction' },

    cashier: { type: String, trim: true, maxlength: 60 },
    note: { type: String, trim: true, maxlength: 300 },
  },
  { timestamps: true },
);

saleSchema.index({ createdAt: -1 });
saleSchema.index({ customer: 1, createdAt: -1 });

/** Gross margin for the sale: revenue less the cost of the goods. */
saleSchema.virtual('grossProfit').get(function (this: { total?: number; totalCost?: number }) {
  return roundMoney((this.total ?? 0) - (this.totalCost ?? 0));
});

export type SaleShape = InferSchemaType<typeof saleSchema>;

export const Sale = modelFrom<SaleShape>('Sale', saleSchema);