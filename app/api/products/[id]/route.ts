import { protectedRoute, ok, readJson } from '@/lib/api';
import {
  deactivateProduct,
  getProduct,
  purgeProduct,
  reactivateProduct,
  updateProduct,
} from '@/lib/services/products';
import { updateProductSchema } from '@/lib/validators';

/**
 * GET    /api/products/:id — single product with its batches.
 * PATCH  /api/products/:id — update descriptive/pricing fields.
 * DELETE /api/products/:id — soft delete (deactivate).
 *
 * `?restore=true` re-activates a previously deactivated product.
 * `?purge=true` deletes it permanently, and is refused with 409 if it has ever
 * been sold — see `purgeProduct`. It answers with `{ purged: true }` rather than
 * a product DTO, since nothing remains to serialise.
 *
 * The three operations are mutually exclusive by construction: each flag selects
 * exactly one, and `purge` wins over `restore` so a stale link containing both
 * cannot silently resurrect a product the operator meant to destroy.
 *
 * Next.js 16: route context params are a Promise and must be awaited.
 */
export const GET = protectedRoute(
  async (_request: Request, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params;
    return ok(await getProduct(id));
  },
);

export const PATCH = protectedRoute(
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params;
    const input = updateProductSchema.parse(await readJson(request));
    return ok(await updateProduct(id, input));
  },
);

export const DELETE = protectedRoute(
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params;
    const params = new URL(request.url).searchParams;

    if (params.get('purge') === 'true') return ok(await purgeProduct(id));
    if (params.get('restore') === 'true') return ok(await reactivateProduct(id));

    return ok(await deactivateProduct(id));
  },
);