import 'server-only';

import { Types } from 'mongoose';

import { supportsTransactions, withTransaction } from '@/lib/db';
import { ApiError } from '@/lib/errors';
import { fromCents, multiplyCents, roundMoney, toCents } from '@/lib/money';
import { FinancialTransaction } from '@/models/FinancialTransaction';
import { Sale } from '@/models/Sale';
import type { PaymentMethod } from '@/types/constants';
import type { CheckoutResultDto } from '@/types/dto';

import { planCheckout, stockOut } from './inventory';

/**
 * Sales / checkout service.
 *
 * A completed sale touches four things: the stock on hand, the stock audit
 * trail, the sale receipt and the financial ledger. Those all run inside one
 * transaction so a failure part-way cannot leave stock deducted with no matching
 * income row — which would quietly corrupt both the stock count and the books.
 */

/** Discount maths in integer cents, so a 33% off never loses a cent. */
export function computeDiscount(
  subtotal: number,
  discountType: 'none' | 'percent' | 'fixed',
  discountValue: number,
): number {
  const subtotalCents = toCents(subtotal);

  if (discountType === 'none' || discountValue <= 0) return 0;

  const raw =
    discountType === 'percent'
      ? multiplyCents(subtotalCents, discountValue / 100)
      : toCents(discountValue);

  // A discount can never exceed the subtotal, and negative values are clamped.
  return Math.max(0, Math.min(raw, subtotalCents));
}

export interface CheckoutArgs {
  items: { productId: string; quantity: number }[];
  discountType?: 'none' | 'percent' | 'fixed';
  discountValue?: number;
  /** Typed as the union (not `string`) so it satisfies the schema enum. */
  paymentMethod: PaymentMethod;
  customerId?: string;
  cashier?: string;
  note?: string;
}

/** The service's return shape is the wire DTO; re-exported for the route layer. */
export type CheckoutResult = CheckoutResultDto;

export async function checkout(args: CheckoutArgs): Promise<CheckoutResult> {
  // Resolved before the work starts so the caller can be told up front whether
  // the four writes below are protected by a real transaction.
  const atomic = await supportsTransactions();

  const transactional = await withTransaction<CheckoutResult | undefined>(
    async (session) => {
      // 1. Resolve live pricing and FEFO allocation before writing anything, so
      //    an oversold cart fails without having touched stock.
      const plans = await planCheckout(args.items, session);

      const subtotalCents = plans.reduce(
        (sum, plan) => sum + toCents(plan.unitPrice) * plan.requestedQuantity,
        0,
      );
      const subtotal = fromCents(subtotalCents);
      const discountAmount = fromCents(
        computeDiscount(
          subtotal,
          args.discountType ?? 'none',
          args.discountValue ?? 0,
        ),
      );
      const total = roundMoney(subtotal - discountAmount);
      const totalCost = roundMoney(
        plans.reduce((sum, plan) => sum + plan.totalCost, 0),
      );

      // 2. Deduct stock FEFO, writing an audit row per consumed lot.
      for (const plan of plans) {
        for (const allocation of plan.allocations) {
          await stockOut(
            {
              productId: plan.productId,
              quantity: allocation.quantity,
              batchId: allocation.batchId,
            },
            session,
          );
        }
      }

      // 3. Persist the receipt with a price/cost snapshot per line.
      const createdSales = await Sale.create(
        [
          {
            items: plans.map((plan) => ({
              product: new Types.ObjectId(plan.productId),
              name: plan.name,
              sku: plan.sku,
              category: plan.category,
              quantity: plan.requestedQuantity,
              unitPrice: plan.unitPrice,
              unitCost: plan.unitCost,
              lineTotal: roundMoney(plan.unitPrice * plan.requestedQuantity),
              batches: plan.allocations.map((allocation) => ({
                batchId: new Types.ObjectId(allocation.batchId),
                batchNumber: allocation.batchNumber,
                expiryDate: allocation.expiryDate,
                quantity: allocation.quantity,
              })),
            })),
            subtotal,
            discountType: args.discountType ?? 'none',
            discountValue: args.discountValue ?? 0,
            discountAmount,
            total,
            totalCost,
            paymentMethod: args.paymentMethod,
            ...(args.customerId
              ? { customer: new Types.ObjectId(args.customerId) }
              : {}),
            ...(args.cashier ? { cashier: args.cashier.trim() } : {}),
            ...(args.note ? { note: args.note.trim() } : {}),
          },
        ],
        { session },
      );
      const sale = createdSales[0];
      if (!sale) throw new ApiError('INTERNAL_ERROR', 'Failed to record the sale.');

      // 4. Log the income automatically — this is the whole point of the ledger
      //    being tied to the POS.
      const createdTransactions = await FinancialTransaction.create(
        [
          {
            type: 'income',
            amount: total,
            category: 'Sales',
            paymentMethod: args.paymentMethod,
            sale: sale._id,
            occurredAt: new Date(),
            referenceNote: args.note
              ? `POS sale — ${args.note.trim()}`
              : 'POS sale',
            productBreakdown: plans.map((plan) => ({
              product: new Types.ObjectId(plan.productId),
              name: plan.name,
              quantity: plan.requestedQuantity,
              unitPrice: plan.unitPrice,
              lineTotal: roundMoney(plan.unitPrice * plan.requestedQuantity),
            })),
          },
        ],
        { session },
      );
      const transaction = createdTransactions[0];
      if (!transaction) {
        throw new ApiError('INTERNAL_ERROR', 'Failed to record the sale income.');
      }

      sale.ledgerEntry = transaction._id;
      await sale.save({ session });

      return {
        saleId: sale._id.toString(),
        transactionId: transaction._id.toString(),
        subtotal,
        discountAmount,
        total,
        totalCost,
        grossProfit: roundMoney(total - totalCost),
        atomic,
      };
    },
  );

  if (!transactional) {
    // Unreachable in practice: withTransaction either returns the callback's
    // value or throws. Guarded so the return type stays non-optional.
    throw new ApiError('INTERNAL_ERROR', 'Checkout did not complete.');
  }

  return transactional;
}
