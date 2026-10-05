import { handleRoute, ok, readJson } from '@/lib/api';
import { ApiError } from '@/lib/errors';
import { toCustomerDto } from '@/lib/serializers';
import { setRecommendations } from '@/lib/services/customers';
import type { LeanCustomer } from '@/types/dto';

/**
 * POST /api/customers/:id/recommendations — replace the tagged product list.
 *
 * Body: `{ productIds: string[] }`
 */
export const POST = handleRoute(
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params;
    const body = (await readJson(request)) as { productIds?: unknown };

    if (!Array.isArray(body?.productIds)) {
      // A malformed body is a client error, so it must travel the error envelope —
      // the client only surfaces failures when `ok === false`.
      throw new ApiError(
        'VALIDATION_ERROR',
        'productIds must be an array of product ids.',
      );
    }

    const updated = await setRecommendations(
      id,
      body.productIds.filter((value): value is string => typeof value === 'string'),
    );

    return ok(toCustomerDto(updated as LeanCustomer));
  },
);