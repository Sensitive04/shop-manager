import { protectedRoute, ok } from '@/lib/api';
import {
  DEFAULT_EXPIRY_WINDOW_DAYS,
  expiringProducts,
} from '@/lib/services/products';

/**
 * GET /api/products/expiring?days=30
 *
 * Products holding at least one batch that expires inside the window, soonest
 * expiry first. Expired lots are always included regardless of the window.
 */
export const GET = protectedRoute(async (request: Request) => {
  const url = new URL(request.url);
  const raw = url.searchParams.get('days');
  const parsed = raw === null ? NaN : Number(raw);
  const days =
    Number.isFinite(parsed) && parsed >= 0
      ? Math.min(Math.floor(parsed), 3650)
      : DEFAULT_EXPIRY_WINDOW_DAYS;

  const products = await expiringProducts(days);
  return ok({ items: products, days });
});