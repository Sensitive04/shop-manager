import { protectedRoute, ok, readJson } from '@/lib/api';
import { connectToDatabase } from '@/lib/db';
import { toCustomerDto } from '@/lib/serializers';
import { Customer } from '@/models/Customer';
import { createCustomer } from '@/lib/services/customers';
import { createCustomerSchema, customerQuerySchema } from '@/lib/validators';
import type { QueryFilter } from 'mongoose';
import type { LeanCustomer } from '@/types/dto';

/**
 * GET  /api/customers — searchable customer list.
 * POST /api/customers — add a customer profile.
 */
export const GET = protectedRoute(async (request: Request) => {
  await connectToDatabase();

  const url = new URL(request.url);
  const query = customerQuerySchema.parse(Object.fromEntries(url.searchParams));

  const filter: QueryFilter<unknown> = {};

  if (query.search) {
    const escaped = query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(escaped, 'i');
    filter.$or = [{ name: pattern }, { phone: pattern }];
  }
  if (query.skinType) filter.skinType = query.skinType;

  const page = query.page ?? 1;
  const limit = query.limit ?? 25;
  const skip = (page - 1) * limit;

  const [rows, total] = await Promise.all([
    Customer.find(filter)
      .sort({ name: 1 })
      .skip(skip)
      .limit(limit)
      .populate('recommendedProducts', 'name sku')
      .lean<LeanCustomer[]>(),
    Customer.countDocuments(filter),
  ]);

  return ok({
    items: rows.map(toCustomerDto),
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  });
});

export const POST = protectedRoute(async (request: Request) => {
  const input = createCustomerSchema.parse(await readJson(request));
  const created = await createCustomer(input);
  return ok(toCustomerDto(created.toObject() as LeanCustomer), { status: 201 });
});