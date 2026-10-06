import { handleRoute, ok } from '@/lib/api';
import { requireSession } from '@/lib/auth';

/**
 * GET /api/auth/me — who is signed in.
 *
 * Used by the nav bar to render the display name. It requires a session but is
 * not wrapped in `protectedRoute`, because a 401 here is the *expected* answer
 * for a signed-out visitor and must not read as a server fault.
 */
export const GET = handleRoute(async () => {
  const user = await requireSession();
  return ok(user);
});