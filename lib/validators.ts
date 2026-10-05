import { z } from 'zod';

import { endOfDay, isDateOnly, parseDateInput } from '@/lib/dates';
import {
  INCOME_CATEGORIES,
  OUTCOME_CATEGORIES,
  PAYMENT_METHODS,
  PRODUCT_CATEGORIES,
  SKIN_TYPES,
  TRANSACTION_TYPES,
} from '@/types/constants';

/**
 * Shared input primitives.
 *
 * Zod 4 note: error customisation uses the unified `error` key —
 * `required_error`/`invalid_type_error`/`errorMap` were removed. String-format
 * validators such as `z.email()` moved to the top level.
 */

const trimmedString = (max: number) =>
  z
    .string({ error: 'This field is required' })
    .trim()
    .max(max, { error: `Must be ${max} characters or fewer` });

/** Money from a form field arrives as a string; coerce then bound it. */
const moneyField = z
  .union([z.number(), z.string()])
  .transform((value) => (typeof value === 'number' ? value : Number(value.trim())))
  .pipe(
    z
      .number({ error: 'Enter a valid amount' })
      .refine((value) => Number.isFinite(value), { error: 'Enter a valid amount' }),
  );

const positiveMoney = moneyField.refine((value) => value > 0, {
  error: 'Must be greater than zero',
});

const nonNegativeMoney = moneyField.refine((value) => value >= 0, {
  error: 'Cannot be negative',
});

const wholeNumber = (min: number) =>
  z
    .union([z.number(), z.string()])
    .transform((value) => (typeof value === 'number' ? value : Number(value.trim())))
    .pipe(
      z
        .number({ error: 'Enter a whole number' })
        .refine((value) => Number.isInteger(value), { error: 'Must be a whole number' })
        .refine((value) => value >= min, { error: `Must be at least ${min}` }),
    );

/** ObjectId-shaped string. */
export const objectId = z
  .string({ error: 'Required' })
  .trim()
  .regex(/^[a-f\d]{24}$/i, { error: 'Not a valid id' });

/** ISO date string or epoch millis. */
export const dateInput = z
  .union([z.string(), z.number(), z.date()])
  .transform((value) => parseDateInput(value))
  .pipe(z.date({ error: 'Enter a valid date' }));

/**
 * Upper bound of a reporting period, inclusive.
 *
 * A date-only value means "through the end of that day", so it is widened to the
 * local end of day rather than left at UTC midnight — otherwise a report filtered
 * to 31 January silently omits most of that day west of Greenwich. Anything that
 * already states an instant (a full ISO timestamp, epoch millis, a Date) is
 * respected exactly, because widening it would move the caller's own bound.
 */
export const dateInputEndOfDay = z
  .union([z.string(), z.number(), z.date()])
  .transform((value) => {
    const parsed = parseDateInput(value);
    // Widen only a date-only value, which names a day rather than an instant. An
    // impossible date stays invalid here and is rejected by the pipe below.
    return typeof value === 'string' && isDateOnly(value) ? endOfDay(parsed) : parsed;
  })
  .pipe(z.date({ error: 'Enter a valid date' }));

export const productCategory = z.enum(PRODUCT_CATEGORIES, {
  error: 'Choose a valid category',
});
export const paymentMethod = z.enum(PAYMENT_METHODS, {
  error: 'Choose a payment method',
});
export const skinType = z.enum(SKIN_TYPES, { error: 'Choose a skin type' });

export { nonNegativeMoney, positiveMoney, trimmedString, wholeNumber };

/* ------------------------------------------------------------------ products */

const batchInput = z.object({
  batchNumber: trimmedString(60),
  expiryDate: dateInput,
  costPrice: positiveMoney,
  quantity: wholeNumber(1),
  supplier: trimmedString(120).optional(),
});

export const createProductSchema = z.object({
  name: trimmedString(160),
  sku: trimmedString(40).pipe(
    z
      .string()
      .min(2, { error: 'SKU must be at least 2 characters' })
      .regex(/^[A-Za-z0-9._-]+$/, {
        error: 'Use letters, numbers, dots, dashes or underscores only',
      }),
  ),
  category: productCategory,
  brand: trimmedString(80).optional(),
  size: trimmedString(40).optional(),
  sellingPrice: nonNegativeMoney,
  minStockAlert: wholeNumber(0),
  /** Optional opening stock, recorded as the product's first batch. */
  batches: z.array(batchInput).max(50).optional(),
  notes: trimmedString(500).optional(),
});

export type CreateProductInput = z.infer<typeof createProductSchema>;

export const updateProductSchema = createProductSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    error: 'Provide at least one field to update',
  });

export type UpdateProductInput = z.infer<typeof updateProductSchema>;

/* ------------------------------------------------------------------- batches */

export const stockInSchema = z.object({
  batchNumber: trimmedString(60),
  expiryDate: dateInput,
  costPrice: positiveMoney,
  quantity: wholeNumber(1),
  supplier: trimmedString(120).optional(),
  /** Combine with an existing lot instead of creating a new one. */
  mergeWithExistingBatch: z.boolean().optional().default(false),
});

export type StockInInput = z.infer<typeof stockInSchema>;

export const stockOutSchema = z.object({
  quantity: wholeNumber(1),
  /** Leave empty to let FEFO choose the soonest-expiring lot. */
  batchId: objectId.optional(),
  reason: trimmedString(300).optional(),
});

export type StockOutInput = z.infer<typeof stockOutSchema>;

export const adjustStockSchema = z
  .object({
    /** Signed: negative removes, positive adds. */
    quantity: wholeNumber(-100000),
    reason: trimmedString(300).optional(),
    // Required when stock is added back: the correction needs its own lot so the
    // batch-sum invariant and cost-based margin reporting stay correct.
    expiryDate: dateInput.optional(),
    costPrice: nonNegativeMoney.optional(),
  })
  .refine((value) => value.quantity !== 0, {
    error: 'Enter a non-zero adjustment',
    path: ['quantity'],
  })
  .refine(
    (value) =>
      value.quantity < 0 ||
      (value.expiryDate !== undefined && value.costPrice !== undefined),
    {
      error: 'Adding stock back needs an expiry date and a cost price',
      path: ['quantity'],
    },
  );

export type AdjustStockInput = z.infer<typeof adjustStockSchema>;

/* --------------------------------------------------------------- transactions */

export const createTransactionSchema = z
  .object({
    type: z.enum(TRANSACTION_TYPES, { error: 'Choose income or outcome' }),
    amount: positiveMoney,
    category: z.enum([...INCOME_CATEGORIES, ...OUTCOME_CATEGORIES], {
      error: 'Choose a valid category',
    }),
    paymentMethod,
    referenceNote: trimmedString(300).optional(),
    occurredAt: dateInput.optional(),
  })
  .refine(
    (value) =>
      value.type === 'income'
        ? (INCOME_CATEGORIES as readonly string[]).includes(value.category)
        : (OUTCOME_CATEGORIES as readonly string[]).includes(value.category),
    {
      error:
        'Sales can only be recorded as income; operating costs can only be recorded as outcomes.',
      path: ['category'],
    },
  );

export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;

/* ------------------------------------------------------------------ customers */

export const createCustomerSchema = z.object({
  name: trimmedString(120),
  // Optional so walk-in customers can exist without a phone number.
  phone: z
    .union([z.string(), z.number()])
    .optional()
    .transform((value) =>
      value === undefined || value === null ? undefined : String(value).trim(),
    )
    .refine(
      (value) =>
        value === undefined ||
        value === '' ||
        /^[+\d][\d\s()-]{4,30}$/.test(value),
      { error: 'Enter a valid phone number' },
    )
    .refine((value) => value !== '', { error: 'Phone number cannot be empty' }),
  skinType,
  notes: trimmedString(500).optional(),
  isWalkIn: z.boolean().optional().default(false),
});

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;

export const updateCustomerSchema = z
  .object({
    name: trimmedString(120).optional(),
    phone: createCustomerSchema.shape.phone,
    skinType,
    notes: trimmedString(500).optional(),
    isWalkIn: z.boolean().optional(),
    recommendedProducts: z.array(objectId).max(50).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    error: 'Provide at least one field to update',
  });

export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;

/* ---------------------------------------------------------------------- sales */

export const cartLineSchema = z.object({
  productId: objectId,
  quantity: wholeNumber(1),
});

export const checkoutSchema = z.object({
  items: z
    .array(cartLineSchema)
    .min(1, { error: 'Add at least one product to the cart' })
    .max(100, { error: 'A single sale is limited to 100 lines' }),
  discountType: z.enum(['none', 'percent', 'fixed']).optional().default('none'),
  discountValue: nonNegativeMoney.optional().default(0),
  paymentMethod,
  customerId: objectId.optional(),
  cashier: trimmedString(60).optional(),
  note: trimmedString(300).optional(),
});

export type CheckoutInput = z.infer<typeof checkoutSchema>;

/* ------------------------------------------------------------------- queries */

export const productQuerySchema = z.object({
  search: z.string().trim().optional(),
  category: productCategory.optional(),
  lowStock: z.enum(['true', 'false']).optional(),
  expiringWithinDays: z.coerce.number().int().min(0).max(3650).optional(),
  includeInactive: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export type ProductQuery = z.infer<typeof productQuerySchema>;

export const transactionQuerySchema = z.object({
  // Every filter is optional: a bare `/api/transactions` must list everything,
  // and the summary endpoint is called with only a date range.
  type: z.enum(TRANSACTION_TYPES).optional(),
  category: z.enum([...INCOME_CATEGORIES, ...OUTCOME_CATEGORIES]).optional(),
  paymentMethod: paymentMethod.optional(),
  from: dateInput.optional(),
  to: dateInputEndOfDay.optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export type TransactionQuery = z.infer<typeof transactionQuerySchema>;

export const customerQuerySchema = z.object({
  // Optional, like every other filter: the list must load unfiltered first.
  search: z.string().trim().optional(),
  skinType: skinType.optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export type CustomerQuery = z.infer<typeof customerQuerySchema>;