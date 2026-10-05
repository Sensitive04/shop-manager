import { handleRoute, ok } from '@/lib/api';
import { connectToDatabase, supportsTransactions } from '@/lib/db';

/**
 * GET /api/health — liveness plus a real database round-trip.
 *
 * Used by the Docker healthcheck and by `depends_on: condition: service_healthy`.
 * `transactional: false` is reported rather than treated as a failure, because a
 * standalone mongod still serves reads and writes — it just cannot run the
 * atomic POS checkout, and the operator needs to see that.
 */
export const GET = handleRoute(async () => {
  await connectToDatabase();

  const [transactional] = await Promise.all([supportsTransactions()]);

  return ok({ status: 'ok', transactional, uptimeSeconds: Math.round(process.uptime()) });
});
