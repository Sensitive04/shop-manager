import { handleRoute, ok, readJson } from '@/lib/api';
import { listProducts, createProduct } from '@/lib/services/products';
import { createProductSchema, productQuerySchema } from '@/lib/validators';

/**
 * GET /api/products — paginated catalogue with search, category and alert
 * filters. `lowStock=true` and `expiringWithinDays` back the inventory tabs.
 *
 * POST /api/products — create a product, optionally with opening stock.
 */
export const GET = handleRoute(async (request: Request) => {
  const url = new URL(request.url);
  const query = productQuerySchema.parse(Object.fromEntries(url.searchParams));

  const result = await listProducts(query);

  return ok({
    items: result.items,
    page: result.page,
    limit: result.limit,
    total: result.total,
    totalPages: Math.max(1, Math.ceil(result.total / result.limit)),
  });
});

export const POST = handleRoute(async (request: Request) => {
  const body = await readJson(request);
  const input = createProductSchema.parse(body);
  const product = await createProduct(input);
  return ok(product, { status: 201 });
});