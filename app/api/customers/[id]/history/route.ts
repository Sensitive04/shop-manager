import { protectedRoute, ok } from '@/lib/api';
import { toSaleDto } from '@/lib/serializers';
import { customerHistory } from '@/lib/services/customers';
import type { LeanSale } from '@/types/dto';

/**
 * GET /api/customers/:id/history — the customer's purchase history, newest
 * first, so the assistant can see what they already own before recommending.
 */
export const GET = protectedRoute(
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params;

    const limitParam = new URL(request.url).searchParams.get('limit');
    const parsed = limitParam === null ? NaN : Number(limitParam);
    const limit = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 20;

    const sales = await customerHistory(id, limit);
    return ok(sales.map((sale) => toSaleDto(sale as LeanSale)));
  },
);