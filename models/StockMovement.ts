import { Schema, type InferSchemaType } from 'mongoose';

import { modelFrom } from '@/lib/model';
import { roundMoney } from '@/lib/money';
import { STOCK_MOVEMENT_TYPES } from '@/types/constants';

/**
 * Append-only audit trail of every change to stock.
 *
 * Kept as its own collection rather than embedded on the product so the history
 * is never rewritten and can grow without bloating product documents. Each entry
 * records the resulting level so a discrepancy can be traced without replaying
 * the whole log.
 */
const stockMovementSchema = new Schema(
  {
    product: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },
    productName: { type: String, required: true, trim: true },

    type: {
      type: String,
      required: true,
      enum: {
        values: STOCK_MOVEMENT_TYPES,
        message: '{VALUE} is not a valid movement type',
      },
    },

    /** Signed: positive adds stock, negative removes it. */
    quantity: {
      type: Number,
      required: true,
      validate: {
        validator: (value: number) => Number.isInteger(value) && value !== 0,
        message: 'Quantity must be a non-zero whole number',
      },
    },

    /** Lot this movement applied to, when known. */
    batchNumber: { type: String, trim: true },
    /** Per-batch change, present when FEFO split a sale across several lots. */
    batchId: { type: Schema.Types.ObjectId },

    stockBefore: { type: Number, required: true },
    stockAfter: { type: Number, required: true },

    /** Links a stock-out back to the sale that caused it. */
    reference: { type: String, trim: true, maxlength: 120 },
    reason: { type: String, trim: true, maxlength: 300 },

    unitCost: {
      type: Number,
      min: 0,
      set: (value: number) => roundMoney(value),
    },

    occurredAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true },
);

stockMovementSchema.index({ product: 1, occurredAt: -1 });
stockMovementSchema.index({ occurredAt: -1 });
stockMovementSchema.index({ type: 1, occurredAt: -1 });

export type StockMovementShape = InferSchemaType<typeof stockMovementSchema>;

export const StockMovement = modelFrom<StockMovementShape>(
  'StockMovement',
  stockMovementSchema,
);