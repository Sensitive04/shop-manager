import { protectedRoute, ok } from '@/lib/api';
import { lowStockProducts } from '@/lib/services/products';

/**
 * GET /api/products/low-stock — every active product at or below its reorder
 * point, most depleted first.
 */
export const GET = protectedRoute(async () => {
  const products = await lowStockProducts();
  return ok(products);
});