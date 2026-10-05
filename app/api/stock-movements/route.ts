import { Types } from 'mongoose';

import { handleRoute, ok } from '@/lib/api';
import { connectToDatabase } from '@/lib/db';
import { toStockMovementDto } from '@/lib/serializers';
import { StockMovement } from '@/models/StockMovement';
import type { LeanStockMovement } from '@/types/dto';

/**
 * GET /api/stock-movements — the stock audit trail.
 *
 * Filterable by product and movement type, newest first, with product names
 * resolved so the table does not need a second lookup per row.
 */
export const GET = handleRoute(async (request: Request) => {
  await connectToDatabase();

  const url = new URL(request.url);
  const productId = url.searchParams.get('productId');
  const type = url.searchParams.get('type');
  const page = Number(url.searchParams.get('page') ?? '1');
  const limit = Math.min(Number(url.searchParams.get('limit') ?? '50') || 50, 200);

  const filter: Record<string, unknown> = {};

  if (productId && Types.ObjectId.isValid(productId)) {
    filter.product = new Types.ObjectId(productId);
  }
  if (type === 'stock-in' || type === 'stock-out' || type === 'adjustment') {
    filter.type = type;
  }

  const safePage = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1;
  const skip = (safePage - 1) * limit;

  const [rows, total] = await Promise.all([
    StockMovement.find(filter)
      .sort({ occurredAt: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean<LeanStockMovement[]>(),
    StockMovement.countDocuments(filter),
  ]);

  return ok({
    items: rows.map(toStockMovementDto),
    page: safePage,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  });
});