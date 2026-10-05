import 'server-only';

import { Types } from 'mongoose';

import { connectToDatabase } from '@/lib/db';
import { ConflictError, NotFoundError } from '@/lib/errors';
import { Customer } from '@/models/Customer';
import { Sale } from '@/models/Sale';

import type { CreateCustomerInput, UpdateCustomerInput } from '@/lib/validators';

export async function createCustomer(input: CreateCustomerInput) {
  await connectToDatabase();

  // Surface a duplicate phone number as a readable 409 rather than relying on
  // the driver error text.
  if (input.phone) {
    const existing = await Customer.findOne({ phone: input.phone })
      .lean<{ _id: Types.ObjectId } | null>();
    if (existing) {
      throw new ConflictError(`A customer with phone ${input.phone} already exists.`);
    }
  }

  return Customer.create({
    name: input.name,
    ...(input.phone ? { phone: input.phone } : {}),
    skinType: input.skinType,
    ...(input.notes ? { notes: input.notes } : {}),
    ...(input.isWalkIn !== undefined ? { isWalkIn: input.isWalkIn } : {}),
  });
}

export async function updateCustomer(
  customerId: string,
  input: UpdateCustomerInput,
) {
  await connectToDatabase();
  const objectId = new Types.ObjectId(customerId);

  const update: Record<string, unknown> = {};

  if (input.name !== undefined) update.name = input.name;
  if (input.skinType !== undefined) update.skinType = input.skinType;
  if (input.notes !== undefined) update.notes = input.notes;
  if (input.isWalkIn !== undefined) update.isWalkIn = input.isWalkIn;
  if (input.recommendedProducts !== undefined) {
    update.recommendedProducts = input.recommendedProducts.map(
      (id) => new Types.ObjectId(id),
    );
  }
  if (input.phone !== undefined) {
    update.phone = input.phone;
  }

  const customer = await Customer.findByIdAndUpdate(objectId, update, {
    new: true,
    runValidators: true,
  }).lean();

  if (!customer) throw new NotFoundError('Customer');

  return customer;
}

/**
 * Replace the recommended-products list for a customer.
 *
 * Products are checked for existence so the UI cannot tag something that has
 * since been deleted, and the returned list is populated for display.
 */
export async function setRecommendations(
  customerId: string,
  productIds: string[],
) {
  await connectToDatabase();
  const objectId = new Types.ObjectId(customerId);

  const customer = await Customer.findById(objectId).lean();
  if (!customer) throw new NotFoundError('Customer');

  const uniqueIds = [...new Set(productIds)];

  if (uniqueIds.length > 0) {
    const { Product } = await import('@/models/Product');
    const found = await Product.countDocuments({
      _id: { $in: uniqueIds.map((id) => new Types.ObjectId(id)) },
    });
    if (found !== uniqueIds.length) {
      throw new ConflictError('One or more selected products no longer exist.');
    }
  }

  return Customer.findByIdAndUpdate(
    objectId,
    { recommendedProducts: uniqueIds.map((id) => new Types.ObjectId(id)) },
    { new: true, runValidators: true },
  )
    .populate('recommendedProducts', 'name sku')
    .lean();
}

/** Recent purchases for a customer, newest first. */
export async function customerHistory(customerId: string, limit = 20) {
  await connectToDatabase();
  const objectId = new Types.ObjectId(customerId);

  const customer = await Customer.findById(objectId).lean<{ _id: Types.ObjectId } | null>();
  if (!customer) throw new NotFoundError('Customer');

  return Sale.find({ customer: objectId })
    .sort({ createdAt: -1 })
    .limit(Math.min(limit, 100))
    .lean();
}

/**
 * Lifetime spend for a customer, computed from their sales rather than a
 * denormalised counter so it can never drift.
 */
export async function customerStats(customerId: string) {
  await connectToDatabase();
  const objectId = new Types.ObjectId(customerId);

  const [row] = await Sale.aggregate<{
    totalSpent: number;
    orderCount: number;
    lastPurchaseAt: Date | null;
  }>([
    { $match: { customer: objectId } },
    {
      $group: {
        _id: null,
        totalSpent: { $sum: '$total' },
        orderCount: { $sum: 1 },
        lastPurchaseAt: { $max: '$createdAt' },
      },
    },
  ]);

  return {
    totalSpent: row?.totalSpent ?? 0,
    orderCount: row?.orderCount ?? 0,
    lastPurchaseAt: row?.lastPurchaseAt ?? null,
  };
}