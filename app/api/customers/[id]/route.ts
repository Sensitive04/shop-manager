import { Types } from 'mongoose';

import { protectedRoute, ok, readJson } from '@/lib/api';
import { connectToDatabase } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';
import { toCustomerDto } from '@/lib/serializers';
import { Customer } from '@/models/Customer';
import { customerStats, updateCustomer } from '@/lib/services/customers';
import { updateCustomerSchema } from '@/lib/validators';
import type { LeanCustomer } from '@/types/dto';

/**
 * GET   /api/customers/:id — profile with recommended products and spend stats.
 * PATCH /api/customers/:id — update the profile.
 */
export const GET = protectedRoute(
  async (_request: Request, context: { params: Promise<{ id: string }> }) => {
    await connectToDatabase();
    const { id } = await context.params;

    if (!Types.ObjectId.isValid(id)) throw new NotFoundError('Customer');

    const customer = await Customer.findById(id)
      .populate('recommendedProducts', 'name sku')
      .lean<LeanCustomer | null>();

    if (!customer) throw new NotFoundError('Customer');

    const stats = await customerStats(id);

    return ok({
      ...toCustomerDto(customer),
      stats: {
        totalSpent: stats.totalSpent,
        orderCount: stats.orderCount,
        lastPurchaseAt: stats.lastPurchaseAt
          ? stats.lastPurchaseAt.toISOString()
          : null,
      },
    });
  },
);

export const PATCH = protectedRoute(
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params;
    const input = updateCustomerSchema.parse(await readJson(request));
    return ok(toCustomerDto((await updateCustomer(id, input)) as LeanCustomer));
  },
);