import { protectedRoute, ok, readJson } from '@/lib/api';
import { checkout } from '@/lib/services/sales';
import { checkoutSchema } from '@/lib/validators';

/**
 * POST /api/sales — process a POS checkout.
 *
 * Atomically: deducts stock FEFO, writes the stock audit trail, records the
 * sale, and logs the income to the ledger. Any failure rolls the whole thing
 * back, so stock and books can never disagree.
 *
 * Returns 409 INSUFFICIENT_STOCK with per-line detail when the cart cannot be
 * fulfilled, so the UI can highlight the offending products.
 */
export const POST = protectedRoute(async (request: Request) => {
  const input = checkoutSchema.parse(await readJson(request));

  const result = await checkout({
    items: input.items,
    discountType: input.discountType,
    discountValue: input.discountValue,
    paymentMethod: input.paymentMethod,
    ...(input.customerId ? { customerId: input.customerId } : {}),
    ...(input.cashier ? { cashier: input.cashier } : {}),
    ...(input.note ? { note: input.note } : {}),
  });

  return ok(result, { status: 201 });
});