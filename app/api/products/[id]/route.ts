import { handleRoute, ok, readJson } from '@/lib/api';
import {
  deactivateProduct,
  getProduct,
  reactivateProduct,
  updateProduct,
} from '@/lib/services/products';
import { updateProductSchema } from '@/lib/validators';

/**
 * GET    /api/products/:id — single product with its batches.
 * PATCH  /api/products/:id — update descriptive/pricing fields.
 * DELETE /api/products/:id — soft delete (deactivate).
 *
 * `?restore=true` on DELETE re-activates a previously removed product.
 *
 * Next.js 16: route context params are a Promise and must be awaited.
 */
export const GET = handleRoute(
  async (_request: Request, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params;
    return ok(await getProduct(id));
  },
);

export const PATCH = handleRoute(
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params;
    const input = updateProductSchema.parse(await readJson(request));
    return ok(await updateProduct(id, input));
  },
);

export const DELETE = handleRoute(
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params;
    const restore = new URL(request.url).searchParams.get('restore') === 'true';
    return ok(restore ? await reactivateProduct(id) : await deactivateProduct(id));
  },
);