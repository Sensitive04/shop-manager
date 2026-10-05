/**
 * Canonical domain enumerations.
 *
 * These arrays are the single source of truth: Mongoose schemas, Zod validators
 * and the UI all derive from them, so adding a value in one place propagates.
 */

export const PRODUCT_CATEGORIES = [
  'Cleanser',
  'Serum',
  'Sunscreen',
  'Moisturizer',
  'Toner',
] as const;
export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];

export const TRANSACTION_TYPES = ['income', 'outcome'] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

/**
 * Ledger categories are partitioned by transaction type so that, for example, a
 * POS-generated income row can never be filed under "Rent".
 */
export const INCOME_CATEGORIES = ['Sales'] as const;
export type IncomeCategory = (typeof INCOME_CATEGORIES)[number];

export const OUTCOME_CATEGORIES = [
  'Supplier Restock',
  'Rent',
  'Utilities',
  'Packaging',
  'Miscellaneous',
] as const;
export type OutcomeCategory = (typeof OUTCOME_CATEGORIES)[number];

export const TRANSACTION_CATEGORIES = [
  ...INCOME_CATEGORIES,
  ...OUTCOME_CATEGORIES,
] as const;
export type TransactionCategory = (typeof TRANSACTION_CATEGORIES)[number];

export const PAYMENT_METHODS = [
  'Cash',
  'Bank Transfer',
  'Mobile Payment',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const SKIN_TYPES = [
  'Oily',
  'Dry',
  'Combination',
  'Sensitive',
  'Acne-Prone',
] as const;
export type SkinType = (typeof SKIN_TYPES)[number];

export const STOCK_MOVEMENT_TYPES = [
  'stock-in',
  'stock-out',
  'adjustment',
] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

/**
 * Skin-type affinities used to suggest products when tagging recommendations.
 * Purely advisory: the UI pre-filters by category, never auto-applies.
 */
export const SKIN_TYPE_AFFINITIES: Record<SkinType, ProductCategory[]> = {
  Oily: ['Cleanser', 'Toner', 'Sunscreen'],
  Dry: ['Moisturizer', 'Cleanser', 'Toner'],
  Combination: ['Cleanser', 'Serum', 'Moisturizer'],
  Sensitive: ['Cleanser', 'Moisturizer', 'Sunscreen'],
  'Acne-Prone': ['Cleanser', 'Serum', 'Toner'],
};