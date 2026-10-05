import { handleRoute, ok } from '@/lib/api';
import { summarize } from '@/lib/services/ledger';
import { transactionQuerySchema } from '@/lib/validators';

/**
 * GET /api/transactions/summary?from=&to=
 *
 * Income, outcome, net and the category / payment-method breakdowns for a
 * period. Used by the ledger header and the dashboard.
 */
export const GET = handleRoute(async (request: Request) => {
  const url = new URL(request.url);
  const query = transactionQuerySchema.parse(Object.fromEntries(url.searchParams));

  return ok(
    await summarize({
      ...(query.from ? { from: query.from } : {}),
      ...(query.to ? { to: query.to } : {}),
    }),
  );
});