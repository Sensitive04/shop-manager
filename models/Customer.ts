import { Schema, type InferSchemaType } from 'mongoose';

import { modelFrom } from '@/lib/model';
import { SKIN_TYPES } from '@/types/constants';

/**
 * Customer profile with skin-type driven product recommendations.
 *
 * Purchase history is deliberately *not* embedded here — it is derived by
 * querying the Sale collection, so a regular customer's history cannot grow the
 * document without bound.
 */
const customerSchema = new Schema(
  {
    name: {
      type: String,
      required: [true, 'Customer name is required'],
      trim: true,
      maxlength: 120,
    },
    phone: {
      type: String,
      // Optional: walk-in profiles exist for recommendation tracking and carry no
      // contact details. The sparse unique index below tolerates the absence.
      trim: true,
      maxlength: 32,
    },
    skinType: {
      type: String,
      required: [true, 'Skin type is required'],
      enum: {
        values: SKIN_TYPES,
        message: '{VALUE} is not a valid skin type',
      },
    },

    notes: { type: String, trim: true, maxlength: 500 },

    /** Products recommended for this customer, typically by the shop assistant. */
    recommendedProducts: {
      type: [{ type: Schema.Types.ObjectId, ref: 'Product' }],
      default: [],
    },

    /** Walk-ins are tracked for the recommendation list but need no contact details. */
    isWalkIn: { type: Boolean, default: false },
  },
  { timestamps: true },
);

// Sparse: only customers with a phone number participate in the uniqueness
// constraint, so an optional walk-in profile cannot collide with another.
customerSchema.index({ phone: 1 }, { unique: true, sparse: true });
customerSchema.index({ skinType: 1 });
customerSchema.index({ name: 1 });

export type CustomerShape = InferSchemaType<typeof customerSchema>;

export const Customer = modelFrom<CustomerShape>('Customer', customerSchema);