import { handleRoute, ok, readJson } from '@/lib/api';
import { adjustStock, stockOut } from '@/lib/services/inventory';
import { getProduct } from '@/lib/services/products';
import { adjustStockSchema, stockOutSchema } from '@/lib/validators';

/**
 * POST /api/products/:id/stock-out — remove stock, FEFO by default.
 *
 * PATCH /api/products/:id/stock-out — signed correction, e.g. after a stocktake
 * or a damaged unit.
 */
export const POST = handleRoute(
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params;
    const input = stockOutSchema.parse(await readJson(request));

    await stockOut({
      productId: id,
      quantity: input.quantity,
      ...(input.batchId ? { batchId: input.batchId } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    });

    return ok(await getProduct(id));
  },
);

export const PATCH = handleRoute(
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params;
    const input = adjustStockSchema.parse(await readJson(request));

    await adjustStock({
      productId: id,
      quantity: input.quantity,
      ...(input.reason ? { reason: input.reason } : {}),
    });

    return ok(await getProduct(id));
  },
);