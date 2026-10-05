import { handleRoute, ok, readJson } from '@/lib/api';
import { stockIn } from '@/lib/services/inventory';
import { getProduct } from '@/lib/services/products';
import { stockInSchema } from '@/lib/validators';

/**
 * POST /api/products/:id/batches — receive stock into a batch.
 *
 * Returns the updated product so the inventory table can refresh in place
 * without a second round trip.
 */
export const POST = handleRoute(
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params;
    const input = stockInSchema.parse(await readJson(request));

    await stockIn({
      productId: id,
      batchNumber: input.batchNumber,
      expiryDate: input.expiryDate,
      costPrice: input.costPrice,
      quantity: input.quantity,
      ...(input.supplier ? { supplier: input.supplier } : {}),
      ...(input.mergeWithExistingBatch !== undefined
        ? { mergeWithExistingBatch: input.mergeWithExistingBatch }
        : {}),
    });

    return ok(await getProduct(id), { status: 201 });
  },
);